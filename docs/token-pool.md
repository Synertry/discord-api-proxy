# Token pool and token selection

## How a token is chosen

1. `X-Proxy-Context: user` forces the user-token branch; `X-Proxy-Context: bot` forces the bot token.
2. Without the header, paths containing `/guilds` use the user token and everything else uses the bot token.

Once the user-token branch is selected:

- **`AUTH_KEY` selects the `default` slot, `AUTH_KEY_PREMIUM` the `premium` slot.** The static token (`DISCORD_TOKEN_USER` / `DISCORD_TOKEN_USER_PREMIUM`) is the default for that slot, and it is guarded (see [Client identity](client-identity.md#identity-guard)), not dispatched bare.
- **On allow-listed read paths** the proxy acquires a registered pool token in the matching slot immediately before dispatch. When no tokens are registered for the slot, or none can serve the request at all (wrong slot, not active, outside its guild list), the request falls through to the guarded static token instead of erroring, so local development works with zero registration. When eligible tokens exist but all of them are cooling down, the proxy answers `429` with the soonest `retryAfter` rather than spending the static token.
- **Premium pool isolation.** `default` callers never see `premium` tokens and vice versa. Premium tokens are handpicked higher-access accounts, not a throughput tier.
- **Message authorship stays static.** `POST /channels/:id/messages` never rotates through the pool, regardless of `X-Proxy-Token`, so every message sent from a slot carries the same identity.

Pool-eligible routes (`src/rotator/bucket.ts`): `GET` on `/guilds/:id/messages/search`, `/channels/:id/messages`, `/channels/:id/messages/:id`, `/guilds/:id/channels`, `/guilds/:id/members`, `/guilds/:id/members/search`, `/guilds/:id/members/:id`, `/guilds/:id/threads/active`, `/channels/:id/threads/archived/public`, `/channels/:id/threads/archived/private`, `/channels/:id`, `/users/:id`.

Each pool token is tracked per Discord rate-limit bucket, and selection is least-recently-used among tokens that are not cooling down. A live 429 on a pool token is retried once, after a backoff, with a freshly acquired token (the same label when pinned); if none is available the original 429 is returned.

## Per-request override: `X-Proxy-Token`

| Value | Behavior |
|---|---|
| absent / `auto` | Least-recently-used rotation across registered pool tokens. |
| `static` | Skip the pool; use the guarded static token for the slot. |
| `<label>` | Pin one registered pool token. `503` if the label is missing, not active, or in the other slot; `429` if that token is cooling down. |

The header is stripped before forwarding. Use it to debug one misbehaving token, to force the static token for predictable extraction, or when a private channel is visible only to the static account.

## Admin API

`/admin/*` is gated by `AUTH_KEY_ADMIN` (sent as `x-auth-key` or `Authorization: Bearer`), fails closed with `503` when that secret is unset, and is not part of the public request pipeline. No response ever includes a token secret. Validation failures answer a deliberately generic `400 { "error": "invalid request" }`, so labels and tokens cannot be enumerated.

| Endpoint | Purpose |
|---|---|
| `POST /admin/tokens` | Register a token: `{ "label", "slot": "default" \| "premium", "tokenSecret", "guildIds"? }`. Labels are 1-64 chars of `A-Z a-z 0-9 . _ -`; at most 20 tokens per slot; a token already in the pool is rejected. `201 { "label", "registeredAt" }`. |
| `GET /admin/tokens` | List registered tokens with label, slot, and status (no secrets). |
| `DELETE /admin/tokens/:label` | Unregister (idempotent). `204`. |
| `POST /admin/tokens/:label/reset` | Clear a token's invalid status and consecutive-401 count. |
| `POST /admin/tokens/:label/fingerprint` | Pin the token's fingerprint profile: `{ "profileId" }`. |
| `GET /admin/health` | Per-slot pool rollup. |
| `GET /admin/fingerprint/profiles` | Known profile ids and the fallback id. |
| `GET /admin/static-fingerprint` | Current fingerprint assignment for each static token. |
| `POST /admin/static-fingerprint` | Assign a static token's fingerprint: `{ "kind": "user-default" \| "user-premium", "profileId" }` or `{ "kind", "custom" }`. |
| `GET /admin/client-versions` | Stored Discord build number and Chrome major records. |
| `POST /admin/client-versions/refresh` | Scrape and store both now. `502` if neither refreshed. |
| `GET /admin/identity` | Preview the composed identity for `?kind=user-default\|user-premium` or `?label=<pool label>` (exactly one). `404` if the kind is not configured or the label is unknown. |
