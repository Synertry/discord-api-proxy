# Client identity

Every user-token request, whether served by a pool token or the guarded static token, is composed by a single function, `composeRequestHeaders` (`src/fingerprint/headers.ts`), so there is exactly one place that decides what a request looks like to Discord.

## What a request looks like

- **Header set.** `User-Agent`, `Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform`, `X-Super-Properties` (base64 JSON), `X-Discord-Locale`, `X-Discord-Timezone`, `X-Debug-Options`, `Priority`, `Accept*`, `Origin`, `Referer`. Bot tokens carry only `User-Agent: DiscordBot (https://github.com/Synertry/discord-api-proxy, <build hash>)` per Discord's API docs, no super-properties.
- **Inbound allowlist.** Only an explicit allowlist of inbound headers is ever forwarded. Ad hoc headers, `cf-connecting-ip`, `x-forwarded-for`, `cf-ipcountry`, the caller's own `User-Agent`, and similar are dropped. `Authorization` is always set last, so nothing forwarded before it can win. `Host` is stripped.
- **Version tracking.** Generated Chromium profiles derive their User-Agent, client hints, and super-properties from a daily-scraped Chrome stable major and Discord web `build_number` (cron `0 4 * * *` UTC, or on demand with `POST /admin/client-versions/refresh`). Stale records fall back to a hardcoded constant.
- **Session determinism.** Per-identity session fields (`client_launch_id`, `client_heartbeat_session_id`, `launch_signature`) are derived deterministically from the identity key and a time bucket, so repeated calls within a session window look like the same live client, not a fresh login every request.
- **Upstream API version.** Every path, bot and user token alike, goes to `/api/v10`. Discord's developer reference lists v9 and v10 as available with no user-token-specific guidance, and this project follows that reference rather than the web client's undocumented use of v9. API version and client emulation are independent.

## Which fingerprint an identity gets

- **Pool tokens.** Each registered token is assigned a profile id on its first `acquire()` via a stable hash of its label; the assignment persists across cold starts. Override it with `POST /admin/tokens/:label/fingerprint { "profileId": "..." }`.
- **Static tokens.** `DISCORD_TOKEN_USER` and `DISCORD_TOKEN_USER_PREMIUM` get their own identity via `POST /admin/static-fingerprint` with `{ "kind", "profileId" }` (a known template) or `{ "kind", "custom" }` (an operator-captured clone of a real client's headers). A custom profile lets a static token look exactly like the operator's real desktop or mobile client instead of a generated template. `GET /admin/fingerprint/profiles` lists the template ids.
- **Preview.** `GET /admin/identity?kind=user-default|user-premium` or `?label=<pool label>` returns the exact composed headers (token redacted), the decoded super-properties, and the `properties` object a gateway IDENTIFY needs. Tools that open their own gateway connection should fetch this instead of building a fingerprint by hand.

## Identity guard

Static user tokens are protected by the same per-bucket budget tracking the pool uses, plus abuse-signal circuits that are independent of ordinary bucket cooldowns:

- A captcha challenge in a user-token response body opens a **30-minute** circuit on that identity. Captcha circuits and per-bucket budgets remain user-only.
- A Cloudflare edge block from a user or bot response opens the shared Durable Object circuit for pool, static-user, and bot requests, because they share one egress IP. Its duration uses the edge response's numeric `Retry-After`, capped at **1 hour** by `MAX_UPSTREAM_CIRCUIT_MS`; absent or HTTP-date values default to **10 minutes**. A new block never shortens an already-open circuit.
- A blocked request never reaches Discord; it gets a `429` with `X-Proxy-Block: bucket|capacity|captcha|cloudflare` instead (see [Configuration](configuration.md#responses-the-proxy-adds)). Pool cooldown holds carry `bucket`; pool captcha and Cloudflare circuit holds carry `captcha` or `cloudflare`. Actual Discord 429 responses are not relabeled as proxy holds.
- The user-token guard leases atomically immediately before each dispatch and settles immediately after, so concurrent requests on the same identity never oversubscribe its budget. Lease validation happens before any state change, so a forged lease id cannot touch another lease's budget or circuit.
- Bots check the shared Cloudflare circuit before fetching and inspect the response afterward, reporting only Cloudflare outcomes. They do not acquire pool tokens, reserve budgets, use captcha circuits, or create leases. The optional `TokenPoolClient` RPCs are `checkUpstreamCircuit(): Promise<IdentityBlock | null>` and `reportUpstreamOutcome(outcome: ReleaseInput): Promise<void>`.

When no `TOKEN_POOL` binding is available, static user tokens degrade to unguarded dispatch rather than erroring. Bot circuit handling also degrades to unguarded behavior when the binding or optional RPC methods are unavailable or a circuit RPC fails; a failed outcome report does not fail the already-dispatched response.

## Message sends

`POST /channels/:id/messages` with a user token and a JSON body gets `nonce` (a Discord snowflake), `tts: false`, and `flags: 0` filled in when absent (a caller-supplied value is never overwritten), plus a default `X-Context-Properties` header (also set on `POST /users/@me/channels`). Bodies of 64 KiB or more stream through unmodified. Combine with `X-Proxy-Typing: on` for the full typing-then-send sequence.

## Operating rules

- **One account, one fingerprint.** Do not run the proxy and a separately authenticated client (a browser session, a modded desktop client) against the same Discord account at the same time with different-looking fingerprints.
- **Respect guard blocks.** Wait out `captcha` and `cloudflare` circuits; do not retry faster than `retryAfter` and do not switch tokens to route around a circuit.

## Accepted gaps

- **TLS JA3/JA4 fingerprinting, HTTP/2 frame ordering.** Not emulable from a Cloudflare Worker; the runtime owns the transport.
- **Egress IP.** Requests originate from Cloudflare's IP ranges regardless of fingerprint realism.
- **`CF-Worker` / `CF-Connecting-IP` on cross-zone subrequests.** Cloudflare adds `CF-Worker: <zone>` and sets `CF-Connecting-IP` to the Worker's own client IP; request code cannot remove either.

The full list, with rationale, is in the [roadmap](roadmap.md#accepted-gaps-not-emulable-from-a-cloudflare-worker-or-deliberately-out-of-scope).
