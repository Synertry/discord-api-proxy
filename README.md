# Discord API Proxy

[![CI](https://github.com/Synertry/discord-api-proxy/actions/workflows/ci.yaml/badge.svg)](https://github.com/Synertry/discord-api-proxy/actions/workflows/ci.yaml)
[![Deploy](https://github.com/Synertry/discord-api-proxy/actions/workflows/deploy.yaml/badge.svg)](https://github.com/Synertry/discord-api-proxy/actions/workflows/deploy.yaml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![License: BSL-1.0](https://img.shields.io/badge/License-BSL--1.0-blue.svg)](https://www.boost.org/LICENSE_1_0.txt)

A reverse proxy for the Discord API, deployed as a [Cloudflare Worker](https://developers.cloudflare.com/workers/). Adds authentication, token management, snowflake validation, and server-specific business logic endpoints on top of the standard Discord API.
Original motivation was for my Google Sheets to be able to call the Discord API, without my requests being rejected from Discord, because they would detect Google's IP addresses.

## Features

- **Reverse proxy** - Forwards any request to `https://discord.com/api/v10` with automatic token injection
- **Dual static-token slots** - Switches between bot and user tokens based on the endpoint or an explicit header. Optionally routes to a second user token (e.g. a premium alt account) when the request authenticates with `AUTH_KEY_PREMIUM`.
- **Token rotator pool** - On allow-listed user-token paths (search, member lookups, etc.), the request acquires a token from a Durable-Object-backed pool with per-Discord-bucket cooldown tracking. Multiple registered user tokens spread the rate-limit budget transparently. Cross-Worker consumers can share the same pool via the `script_name` DO binding pattern.
- **Client identity hardening** - Every user-token request, pooled or static, carries a realistic, self-consistent, version-tracking Chromium fingerprint (`User-Agent`, `Sec-CH-UA*`, `X-Super-Properties`, `X-Discord-Locale`, `X-Discord-Timezone`, ...) composed by a single header composer; an inbound-header allowlist stops leaking `cf-connecting-ip`/`x-forwarded-for`/`cf-ipcountry` to Discord; a per-identity atomic bucket-lease guard plus captcha/Cloudflare abuse-signal circuits protect static tokens the same way the pool protects rotated ones; client-like message sends (`nonce`/`tts`/`flags` fill, opt-in typing indicator, `X-Context-Properties`). See [Client Identity](#client-identity) below.
- **Admin API** - `AUTH_KEY_ADMIN`-gated sub-app at `/admin/*` for runtime pool + fingerprint + identity management (register, list, reset, unregister, health, fingerprint profiles, static-token fingerprint mapping incl. operator-captured clone profiles, client-versions record, identity preview). Distinct auth chain from `AUTH_KEY` / `AUTH_KEY_PREMIUM`; fail-closed when the admin secret is unset.
- **Public healthcheck** - Unauthenticated `GET /healthcheck` returning service status, build hash, and UTC timestamps. Mounted before the sieve so phone browsers, status pages, and uptime monitors can hit it without a key.
- **Snowflake validation** - Validates Discord IDs in URL paths before forwarding, returning Discord-compatible error responses
- **Rate limit interception** - Reformats 429 responses into a consistent JSON envelope, preserving `X-Proxy-*` guard signals
- **Custom endpoints** - Server-specific business logic that processes Discord data server-side, sharing the same paced pager and header composer as the proxy
- **OpenAPI spec** - Auto-generated via `@hono/zod-openapi` with Swagger UI (admin and healthcheck sub-apps are intentionally not exported to the public doc)

## Tech Stack

| Component        | Technology                                     |
|------------------|------------------------------------------------|
| Runtime          | Cloudflare Workers                             |
| Framework        | [Hono](https://hono.dev) + `@hono/zod-openapi` |
| Language         | TypeScript (strict mode)                       |
| Validation       | Zod                                            |
| Testing          | Vitest + `@cloudflare/vitest-pool-workers`     |
| Package Manager  | Bun                                            |

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed as dev dependency)

### Installation

```bash
bun install
```

### Environment Setup

Create a `.dev.vars` file in the project root with your secrets:

```env
DISCORD_TOKEN_BOT=your-bot-token
DISCORD_TOKEN_USER=your-user-token
AUTH_KEY=your-api-key
```

Optional - add a second user token (e.g. a premium account with access to locked channels) to route gated requests through a separate auth context:

```env
DISCORD_TOKEN_USER_PREMIUM=your-premium-user-token
AUTH_KEY_PREMIUM=your-second-api-key
```

Requests authenticated with `AUTH_KEY_PREMIUM` and using the `x-proxy-context: user` path are proxied with `DISCORD_TOKEN_USER_PREMIUM`; everything else continues to use the default pair. Both premium bindings must be set together - if a user-context request arrives authenticated with `AUTH_KEY_PREMIUM` while `DISCORD_TOKEN_USER_PREMIUM` is unset, the proxy returns 503 rather than silently downgrading to the default user token. Bot-context requests always use `DISCORD_TOKEN_BOT` regardless of which auth key matched.

Optional - enable the admin sub-app at `/admin/*` for runtime token-pool management:

```env
AUTH_KEY_ADMIN=your-admin-key
```

The admin sub-app fail-closes with `503` when `AUTH_KEY_ADMIN` is unset, so leaving it out effectively disables `/admin/*`. The admin key is independent from `AUTH_KEY` / `AUTH_KEY_PREMIUM` - it does not grant proxy access, and proxy keys do not grant admin access.

> [!CAUTION]
> I advise to use an alt account for the user token to avoid any future risks for your main account of being banned by Discord.

### Development

```bash
bun run lint       # Type check (tsc --noEmit)
bun run test       # Run all tests
bun run dev        # Start local dev server via Wrangler
```

## Architecture

### Middleware Sieve

`/admin/*` and `/healthcheck` are mounted **before** the main sieve so they have their own auth chains (or none). Every other request flows through the layered pipeline:

```
Request
  |
  +-- /healthcheck --> Public liveness probe (no auth, returns build metadata)
  |
  +-- /admin/*     --> AUTH_KEY_ADMIN-gated sub-app (token pool + identity management)
  |
  v
[Rate Limit Interceptor]  Reformats 429 responses (post-processing), preserving X-Proxy-* guard signals
  |
  v
[Auth Middleware]          Validates x-auth-key or Authorization (AUTH_KEY / AUTH_KEY_PREMIUM); sets authSlot
  |
  v
[Discord Context]          Selects bot/user static token + records discordTokenKind based on authSlot
  |
  v
[Identity Middleware]      Resolves live client versions + a fallback identity (static path); records a
                            PoolPlan on allow-listed routes and constructs one shared StaticGuard, but never
                            itself acquires a pool token or leases the guard - that only happens at the point
                            of each outbound fetch
  |
  v
[Snowflake Validator]      Validates Discord IDs in URL path segments
  |
  v
[Subrequest Logger]        Wraps proxyFetch for streaming visibility
  |
  v
[Custom Routes]            /custom/* - Business logic endpoints, sharing the paged-messages pager + StaticGuard
  |
  v
[Proxy Forwarder]          /* - Composes the request headers (fingerprint or bot UA), fills message-send bodies,
                            dispatches opt-in typing, forwards to discord.com/api/v10, leases/releases the
                            pool token or static guard immediately around each dispatch, retries once on a live
                            pool 429
```

> [!NOTE]
> Custom endpoints under `/custom/*` come first; anything unmatched falls through to the proxy forwarder.

### Token Selection

For each request the proxy decides which Discord token to use:

1. `x-proxy-context: user` header - Forces user-token branch
2. `x-proxy-context: bot` header - Forces bot-token branch
3. Path heuristic (default) - Paths containing `/guilds` use user token; everything else uses bot token

Once a user-token branch is selected:

- **`AUTH_KEY` -> `default` slot**, **`AUTH_KEY_PREMIUM` -> `premium` slot.** The static token (`DISCORD_TOKEN_USER` / `DISCORD_TOKEN_USER_PREMIUM`) is the default for that slot, and is itself now guarded (see [Client Identity](#client-identity)) rather than dispatched bare.
- **On allow-listed read paths** (`/guilds/:id/messages/search`, `/guilds/:id/members*`, `/channels/:id/messages*`, etc.), the proxy forwarder acquires a registered pool token in the matching slot, immediately before dispatch. When no tokens are registered for the slot, or the pool acquire falls back (`empty-pool`/`no-eligible-token`), the request falls through to the guarded static token instead of erroring - `bun run dev` and ad-hoc extraction scripts work with zero registration.
- **Premium pool isolation.** `default` consumers never see `premium` tokens and vice versa - premium tokens are handpicked higher-access accounts, not a throughput tier.
- **Message authorship stays static-only.** `POST /channels/:id/messages` never rotates through the pool regardless of `X-Proxy-Token`, so every message sent by a given slot always carries the same identity.

#### Per-request override: `X-Proxy-Token`

Override the default LRU selection on a per-request basis with an optional `X-Proxy-Token` request header:

| Value | Behavior |
|---|---|
| absent / `auto` | Default LRU rotation across registered pool tokens (current behavior) |
| `static` | Skip the pool entirely - use the guarded static `DISCORD_TOKEN_USER` / `DISCORD_TOKEN_USER_PREMIUM` on context |
| `<label>` | Pin to that specific registered pool token via `acquireByLabel`. Returns 503 if the label is missing, status is not active, or the slot mismatches; returns 429 if the labeled token is in cooldown |

The header is consumed by the identity middleware and stripped before the request is forwarded to Discord. Auth-gated by the existing `AUTH_KEY` chain; no separate admin auth needed. Use cases: pin a specific token for debugging which one is misbehaving, force-bypass the pool for predictable extraction with the static token, or run `bun run dev` against a single registered local token.

#### Opt-in typing indicator: `X-Proxy-Typing`

Set `X-Proxy-Typing: on` on a `POST /channels/:id/messages` request (with a non-empty `content`) to have the proxy dispatch a `POST .../typing` call first, then wait a humanized delay (`600ms + 55ms/char`, clamped 1-4s, plus jitter) before the actual send - the same rhythm a real client exhibits when a human types a reply. Default is off; the header is stripped before forwarding either way. If the identity is guard-blocked for the typing dispatch, typing is silently skipped (no wait) and the main send still proceeds through its own guard check.

## Client Identity

Every user-token request - whether served by a pool token or the guarded static token - is composed by a single function, `composeRequestHeaders`, so there is exactly one place that decides what a request looks like to Discord:

- **Header set.** `User-Agent`, `Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform`, `X-Super-Properties` (base64 JSON), `X-Discord-Locale`, `X-Discord-Timezone`, `X-Debug-Options`, `Priority`, `Accept*`, `Origin`, `Referer`. Bot tokens carry only `User-Agent: DiscordBot (https://github.com/Synertry/discord-api-proxy, <build hash>)` per Discord's API docs, no super-properties.
- **Inbound allowlist.** Only an explicit allowlist of inbound headers is ever forwarded (`Custom-Client-Header`-style ad hoc headers, `cf-connecting-ip`, `x-forwarded-for`, `cf-ipcountry`, the caller's own `User-Agent`, etc. are all dropped); `Authorization` is always set last so nothing forwarded upstream of it can ever win.
- **Version tracking.** Generated Chromium profiles derive their User-Agent/client hints/super-properties from a daily-scraped Chrome stable major and Discord web `build_number` (`POST /admin/client-versions/refresh`, cron `0 4 * * *` UTC). Stale records fall back to a hardcoded constant.
- **Session determinism.** Per-identity session fields (`client_launch_id`, `client_heartbeat_session_id`, `launch_signature`) are derived deterministically from the identity key and a time bucket, so repeated calls within a session window look like the same live client, not a fresh login every request.
- **Pool tokens.** Each registered token is assigned a profile id on first `acquire()` via a stable hash of its label; the assignment persists across cold starts. Operators can override via `POST /admin/tokens/:label/fingerprint`.
- **Static tokens.** `DISCORD_TOKEN_USER` and `DISCORD_TOKEN_USER_PREMIUM` get their own fingerprint identity via `POST /admin/static-fingerprint { kind, profileId }` (a known template) or `{ kind, custom }` (an operator-captured clone of a real client's headers - see `docs/client-identity-runbook.md`, untracked). Custom profiles let a static token look exactly like the operator's real desktop/mobile client instead of a generated template.
- **Identity guard.** Static tokens are protected by the same class of per-bucket budget tracking the pool uses, plus abuse-signal circuits: a captcha challenge in a response body opens a 30-minute circuit, a Cloudflare edge block opens a 10-minute circuit, both identity-wide and independent of ordinary bucket cooldowns. A blocked request never reaches Discord - it gets a 429 with `X-Proxy-Block: cooldown|circuit|capacity` instead. The guard leases atomically immediately before each dispatch and settles immediately after, so concurrent requests on the same identity never oversubscribe its budget.
- **Message sends look like a client, not a bot script.** `POST /channels/:id/messages` on a user-token JSON body gets `nonce` (Discord snowflake), `tts: false`, and `flags: 0` filled in when absent (never overwriting a caller-supplied value), plus a default `X-Context-Properties` value. Combine with `X-Proxy-Typing: on` for the full send-with-typing sequence.
- **Upstream API version.** Every path - bot and user-token alike - stays on `/api/v10`, unchanged. This is a deliberate operator decision: the official Discord developer reference lists both v9 and v10 as "Available" with no user-token-specific guidance, and this project follows that reference rather than the live web client's/Vencord's/discord.py-self's undocumented internal use of v9. API version and client-emulation headers are independent axes; nothing above changes the version.
- **Accepted gaps.** TLS JA3/JA4 fingerprinting, HTTP/2 frame ordering, and the Worker's own egress IP are not emulable from a Cloudflare Worker and are not attempted. Cross-zone Worker subrequests always add `CF-Worker: <zone>` and set `CF-Connecting-IP` to the Worker's own client IP; both are Cloudflare platform behavior, not removable.

### Project Structure

```
src/
  index.ts                    App factory + middleware sieve + sub-app mounting
  types.ts                    Shared type definitions (Bindings, DiscordUser)
  global.d.ts                 Build-time constants (BUILD_HASH, BUILD_TIMESTAMP)
  middleware/
    auth.ts                   API key authentication (sets authSlot)
    discord-context.ts        Static-token selection + discordTokenKind
    identity.ts                Resolves versions/fallback identity/PoolPlan/StaticGuard; never acquires/leases itself
    subrequest-logger.ts      Wraps proxyFetch for streaming visibility
    snowflake-validator.ts    Discord ID format validation
  routes/
    proxy.ts                  Catch-all reverse proxy; composes headers, fills message bodies, dispatches
                               opt-in typing, leases/releases at the point of each outbound fetch, retries
                               once on a live pool 429
    custom.ts                 Custom business logic route tree
    admin.ts                  AUTH_KEY_ADMIN sub-app (token pool, fingerprint, and identity management)
    healthcheck.ts            Public unauthenticated liveness probe
  rotator/
    do.ts                     TokenPoolDO Durable Object class + RPC methods (pool + static-guard)
    types.ts                  TokenState, StaticIdentityState, AcquireResult, ReleaseInput, etc.
    budget.ts                 Pure BucketBudget/lease/circuit-precedence logic shared by pool and static guard
    static-guard.ts           StaticGuard: lease-at-point-of-use wrapper over leaseStatic/settleStatic
    bucket.ts                 Route -> Discord-bucket lookup + rotatable-route allowlist
    selection.ts              Pure LRU + cooldown filtering
    signals.ts                inspectResponse: parses X-RateLimit-*, captcha/Cloudflare abuse signals
    token-hash.ts              Hashes a token secret into the guard's identity key (kind-independent)
    release-input.ts          Parse X-RateLimit-* response headers
    validators.ts             Token format + pool-cap + bucket-states housekeeping
    client.ts                 createTokenPoolClient(stub) + getPoolStub(env) factory
  fingerprint/                Pure, runtime-agnostic
    profiles.ts               ProfileTemplate/ResolvedProfile registry, FALLBACK_PROFILE_ID, custom-profile validation
    chromium.ts                Generated Chromium UA/client-hint templates + greased Sec-CH-UA brand list
    session.ts                 Deterministic per-identity session field derivation
    compose.ts                 composeFingerprint + composeBotUserAgent (pure)
    headers.ts                 composeRequestHeaders: the single header composer + inbound allowlist
    versions.ts                 ClientVersions resolution (build number + Chrome major, with staleness fallback)
    context-properties.ts      X-Context-Properties defaults per route
    hash.ts                    Shared hashing helper
  scheduled/
    client-versions-refresh.ts Daily cron handler: dual independent scrape (build number, Chrome major)
  custom/
    shared/
      paged-messages.ts        Shared paced pager: cursor pagination + guard lease-at-point-of-use + 429 retry
    chillzone/events/
      bingo/                  Bingo participant counts (own pool client with acquire-backoff + live-429 retry)
      kindness-cascade/       Kindness Cascade tallying module (see its own README)

test/
  env.d.ts                    Cloudflare test type augmentation
  middleware/                 Unit tests for each middleware
  routes/                     Integration tests for proxy, custom, admin, healthcheck
  rotator/                    DO + pure-function tests via @cloudflare/vitest-pool-workers
  fingerprint/                Header composer, profile registry, session, versions tests
  custom/                     Shared pager + per-event classifier/tallier/formatter/handler tests
```

## Custom Endpoints

### Kindness Cascade

Tallies submissions for the ChillZone server's Kindness Cascade event. Fetches all messages from a channel, classifies each one, and returns ranked leaderboards.

```
GET /custom/chillzone/events/kindness-cascade?guildId={id}&channelId={id}
GET /custom/chillzone/events/kindness-cascade?guildId={id}&channelId={id}&formattedMessage=true
```

See [`src/custom/chillzone/events/kindness-cascade/README.md`](src/custom/chillzone/events/kindness-cascade/README.md) for full documentation.

### Cupid's Inbox

```
GET /custom/chillzone/events/cupids-inbox
```

Returns `{ "tally": 0 }`. Placeholder for now. Not yet imported from my private project.

## Testing

```bash
bun run test           # Run all 614 tests across 42 suites
bun run test -- --ui   # Open Vitest UI
```

Tests use `@cloudflare/vitest-pool-workers` to run in a Workers-compatible runtime. Discord API calls are mocked at the fetch level. `TokenPoolDO` runs in the real DO simulation; tests inject either a mock pool client (`createApp(mockFetch, mockTokenPool)`) or exercise the DO directly via `runInDurableObject`.

## Deployment

Deployment is handled by a three-stage CI/CD pipeline:

1. **Push to `main`** - [`ci.yaml`](.github/workflows/ci.yaml) runs linting and tests. Dependabot dependency bumps are auto-merged directly to `production`.
2. **Pre-production review** - [`pre-production-review.yaml`](.github/workflows/pre-production-review.yaml) posts a change report on the `main -> production` PR and labels it `status/review-needed` + `status/approval-pending`.
3. **Approve** - A collaborator with write access comments a bare `/approve` on the PR (or submits a GitHub review approval). [`review-approval.yaml`](.github/workflows/review-approval.yaml) validates the command, the commenter's permissions, and the target SHA through [`approval-gate.ts`](.github/scripts/approval-gate.ts), then fast-forwards `production` to that commit and swaps the labels to `status/approved`.
4. **Deploy** - [`deploy.yaml`](.github/workflows/deploy.yaml) triggers on push to `production`, uploading and promoting the Worker via Wrangler's gradual deployment (`wrangler versions upload` → `wrangler versions deploy`), then posts a deploy notification.

[`bootstrap-wrangler-migration.yaml`](.github/workflows/bootstrap-wrangler-migration.yaml) is a `workflow_dispatch`-only job that runs a non-versioned `wrangler deploy`. Cloudflare refuses `wrangler versions upload` when a Worker migration is part of the upload (e.g. introducing a new Durable Object class), so this workflow gets triggered manually from the Actions tab once per migration. Future versioned deploys via `deploy.yaml` resume working after.

### Required Secrets

Set these in your repository settings under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) - create a token with the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | [Cloudflare Dashboard](https://dash.cloudflare.com/) → select your account → copy the **Account ID** from the right sidebar on the overview page |
| `CUSTOM_DOMAIN` | Your Cloudflare Workers custom domain (e.g. `api.example.com`). Injected into `wrangler.jsonc` at deploy time via the `__CUSTOM_DOMAIN__` placeholder |
| `PAT` | [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta) - needs **Contents: Read and write** and **Pull requests: Read and write** permissions for this repo. Required because pushes made with the default `GITHUB_TOKEN` do not trigger downstream workflows |
| `DISCORD_WEBHOOK_URL` | A Discord channel webhook URL for deploy notifications (Channel Settings → Integrations → Webhooks) |
| `RELAY_AUTH_KEY` / `RELAY_DOMAIN` | Optional. When both are set, deploy notifications are dogfeeded through a [cf-discord-relay](https://github.com/Synertry/cf-discord-relay) instance first and only fall back to `DISCORD_WEBHOOK_URL` on failure |

Set the runtime Wrangler secrets via `wrangler secret put <NAME>` once after the first deploy: `DISCORD_TOKEN_BOT`, `DISCORD_TOKEN_USER`, `AUTH_KEY`, plus optional `DISCORD_TOKEN_USER_PREMIUM` + `AUTH_KEY_PREMIUM` and `AUTH_KEY_ADMIN`.
