# Configuration

Everything the proxy reads at runtime (secrets and bindings), every request header it understands, and the signals it sends back.

## Secrets

Locally these live in a gitignored `.dev.vars` at the repo root (see [`.dev.vars.example`](../.dev.vars.example)); in production they are Worker secrets set with `wrangler secret put <NAME>`.

| Name | Required | What it unlocks |
|---|---|---|
| `DISCORD_TOKEN_BOT` | yes | Bot token for bot-context requests (sent as `Bot <token>`). |
| `DISCORD_TOKEN_USER` | yes | User token for user-context requests authenticated with `AUTH_KEY` (the `default` slot). |
| `AUTH_KEY` | yes | Shared secret callers send to use the proxy. If unset, every proxied request answers `503 { "error": "Service misconfigured" }`. |
| `DISCORD_TOKEN_USER_PREMIUM` | no | Second user token (e.g. an account with access to gated channels), used for user-context requests authenticated with `AUTH_KEY_PREMIUM` (the `premium` slot). |
| `AUTH_KEY_PREMIUM` | no | Second caller key that selects the `premium` slot. Set it together with `DISCORD_TOKEN_USER_PREMIUM`: a user-context request with `AUTH_KEY_PREMIUM` while the premium token is unset answers `503` instead of silently falling back to the default token. Bot-context requests always use `DISCORD_TOKEN_BOT`, whichever key matched. |
| `AUTH_KEY_ADMIN` | no | Key for the `/admin/*` sub-app. Independent of the proxy keys: it grants no proxy access, and the proxy keys grant no admin access. When unset, `/admin/*` fails closed with `503`. |

All key comparisons are constant-time.

> [!CAUTION]
> Use an alt account for the user tokens. Automating a user account is against Discord's terms and can get the account banned.

## Bindings

| Binding | Purpose |
|---|---|
| `TOKEN_POOL` | Durable Object namespace for `TokenPoolDO`: the rotating token pool plus the static-token guard. Other Workers can reach the same pool with a binding that sets `"script_name": "discord-api-proxy"`. |
| Cron `0 4 * * *` | Daily refresh of the Chrome stable major and Discord web build number used by generated fingerprints. |

## Request headers

| Header | Values | Effect |
|---|---|---|
| `x-auth-key` or `Authorization` | `AUTH_KEY` or `AUTH_KEY_PREMIUM` (`Authorization` accepts an optional `Bearer ` prefix) | Required on every proxied request; the matched key selects the `default` or `premium` slot. Missing or wrong key: `401 { "error": "Unauthorized" }`. `Authorization` is always replaced before forwarding, never appended. |
| `X-Proxy-Context` | `user`, `bot` | Forces the user or bot token. Without it, paths containing `/guilds` use the user token and everything else uses the bot token. |
| `X-Proxy-Token` | `auto` (default), `static`, `<label>` | On pool-eligible user-token routes: rotate across registered pool tokens, force the guarded static token, or pin one registered token. See [Token pool](token-pool.md). |
| `X-Proxy-Typing` | `on` | On a user-token `POST /channels/:id/messages` with a JSON body under 64 KiB that has `content`: send a typing indicator first, then wait a humanized delay before the message. Ignored for bot-context sends and for bodies it does not read. See below. |
| `X-Proxy-Typing-Max-Ms` | integer `1000`-`30000` | Raises the typing delay cap for long messages. Only checked when the typing path above is active; then an out-of-range value answers `400 { "error": "invalid X-Proxy-Typing-Max-Ms: expected an integer between 1000 and 30000" }` before anything is sent. |

All `X-Proxy-*` request headers are stripped before the request reaches Discord, and only an allowlist of inbound headers is forwarded at all (see [Client identity](client-identity.md)).

### Typing delay

With `X-Proxy-Typing: on` the proxy dispatches `POST /channels/:id/typing`, then waits the way a person typing the reply would: 400-900 ms of reaction time plus 120-180 ms per character, at least 1 s (the per-identity dispatch gap) and at most 8 s (one typing-indicator window). Pasted-looking bodies (a code fence, 4+ line breaks, or 300+ characters) wait 1.5-3 s instead. `X-Proxy-Typing-Max-Ms` lets long messages wait longer; the proxy then re-sends `/typing` at randomized 5-8 s intervals, each through the guard, so the indicator never lapses. If the identity is guard-blocked for the first typing call, typing is skipped (no wait); if a later re-trigger is blocked, re-triggering stops and the rest of the wait is skipped. Either way the message send still goes through its own guard check.

## Responses the proxy adds

| Signal | Meaning |
|---|---|
| `429 { "error": "Too Many Requests", "retryAfter": <seconds or null> }` | Every 429 is rewritten into this envelope. `Retry-After`, `X-RateLimit-*`, and `X-Proxy-*` headers from the original response are preserved. |
| `X-Proxy-Block: bucket` / `capacity` | The guard held the request because that identity's budget for the Discord bucket is spent or fully leased. Ordinary; retry after `retryAfter`. |
| `X-Proxy-Block: captcha` | A captcha challenge was seen for this identity: its circuit is open for 30 minutes. Do not retry sooner and do not switch tokens to route around it. |
| `X-Proxy-Block: cloudflare` | A Cloudflare edge block was seen: every identity is held (they share one egress IP) for the edge response's `Retry-After`, or 10 minutes when it sends none. |
| `400` with Discord's `Invalid Form Body` shape | A path segment that must be a Discord id (after `guilds`, `channels`, `users`, `messages`, ...) is not a 17-20 digit snowflake. Rejected before any Durable Object or Discord call. |
| `404 { "error": "Not Found" }` | Unmatched `/custom/*` path; never forwarded. |

## Public endpoints

`GET /healthcheck` needs no key and returns `{ "status": "ok", "service": "discord-api-proxy", "build": { "hash", "timestamp" }, "time" }` with `Cache-Control: no-store`; `time` is the current time as an ISO-8601 UTC string. It is a liveness probe only; per-slot pool health is `GET /admin/health`.
