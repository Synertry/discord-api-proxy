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
- **Per-token fingerprint hygiene** - Each user-token request carries a deterministic browser fingerprint (UA, X-Super-Properties, X-Discord-Locale, ...). Profiles are pinned per token so the same identity is consistent across rotated calls; bot requests carry the Discord-compliant `DiscordBot (...)` UA. A daily cron scrapes Discord's current web `build_number` so the embedded super-properties stay current.
- **Admin API** - `AUTH_KEY_ADMIN`-gated sub-app at `/admin/*` for runtime pool + fingerprint management (register, list, reset, unregister, health, fingerprint profiles, static-token fingerprint mapping, build-number record). Distinct auth chain from `AUTH_KEY` / `AUTH_KEY_PREMIUM`; fail-closed when the admin secret is unset.
- **Public healthcheck** - Unauthenticated `GET /healthcheck` returning service status, build hash, and UTC timestamps. Mounted before the sieve so phone browsers, status pages, and uptime monitors can hit it without a key.
- **Snowflake validation** - Validates Discord IDs in URL paths before forwarding, returning Discord-compatible error responses
- **Rate limit interception** - Reformats 429 responses into a consistent JSON envelope
- **Custom endpoints** - Server-specific business logic that processes Discord data server-side
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
  +-- /admin/*     --> AUTH_KEY_ADMIN-gated sub-app (token pool management)
  |
  v
[Rate Limit Interceptor]  Reformats 429 responses (post-processing)
  |
  v
[Auth Middleware]          Validates x-auth-key or Authorization (AUTH_KEY / AUTH_KEY_PREMIUM); sets authSlot
  |
  v
[Discord Context]          Selects bot/user static token + records discordTokenKind based on authSlot
  |
  v
[Token Rotator]            On allow-listed user-token paths, acquires a token + fingerprint from the DO pool
  |
  v
[Snowflake Validator]      Validates Discord IDs in URL path segments
  |
  v
[Subrequest Logger]        Wraps proxyFetch for streaming visibility
  |
  v
[Custom Routes]            /custom/* - Business logic endpoints
  |
  v
[Proxy Forwarder]          /* - Composes fingerprint or bot UA, forwards to discord.com/api/v10, releases the pool token after fetch
```

> [!NOTE]
> Custom endpoints under `/custom/*` come first; anything unmatched falls through to the proxy forwarder.

### Token Selection

For each request the proxy decides which Discord token to use:

1. `x-proxy-context: user` header - Forces user-token branch
2. `x-proxy-context: bot` header - Forces bot-token branch
3. Path heuristic (default) - Paths containing `/guilds` use user token; everything else uses bot token

Once a user-token branch is selected:

- **`AUTH_KEY` -> `default` slot**, **`AUTH_KEY_PREMIUM` -> `premium` slot.** The static token (`DISCORD_TOKEN_USER` / `DISCORD_TOKEN_USER_PREMIUM`) is the default for that slot.
- **On allow-listed read paths** (`/guilds/:id/messages/search`, `/guilds/:id/members*`, `/channels/:id/messages*`, etc.), the token rotator middleware acquires a registered pool token in the matching slot instead. Empty-slot pools return 503 so operator misconfiguration is visible (no silent downgrade to the static token).
- **Premium pool isolation.** `default` consumers never see `premium` tokens and vice versa - premium tokens are handpicked higher-access accounts, not a throughput tier.

### Fingerprint Hygiene

Each user-token request is decorated with a consistent browser fingerprint header set composed from the assigned profile + current Discord client `build_number`:

- `User-Agent`, `X-Super-Properties` (base64 JSON), `X-Discord-Locale`, `X-Debug-Options`, `Accept`, `Accept-Language`, `Origin`, `Referer`.
- **Pool tokens.** Each registered token is assigned a profile id on first `acquire()` via a stable hash of its label. The assignment is persisted, so a token's identity is consistent across rotated calls and across cold starts. Operators can override the assignment via `POST /admin/tokens/:label/fingerprint`.
- **Static tokens.** `DISCORD_TOKEN_USER` and `DISCORD_TOKEN_USER_PREMIUM` get their own fingerprint identity via `POST /admin/static-fingerprint { kind, profileId }`. The mapping is stored in the same Durable Object as the pool.
- **Bot tokens** carry only `User-Agent: DiscordBot (https://github.com/Synertry/discord-api-proxy, <build hash>)` per Discord's API docs; no super-properties.
- **Build number.** A daily cron (`0 4 * * *` UTC) scrapes `discord.com/login` and persists the current `build_number` to the DO. Stale records (>7 days) fall back to a hardcoded constant. Manual refresh: `POST /admin/build-number/refresh`.

### Project Structure

```
src/
  index.ts                    App factory + middleware sieve + sub-app mounting
  types.ts                    Shared type definitions (Bindings, DiscordUser)
  global.d.ts                 Build-time constants (BUILD_HASH, BUILD_TIMESTAMP)
  middleware/
    auth.ts                   API key authentication (sets authSlot)
    discord-context.ts        Static-token selection + discordTokenKind; looks up static fingerprint
    token-rotator.ts          Pool acquire on allow-listed rotatable paths
    subrequest-logger.ts      Wraps proxyFetch for streaming visibility
    snowflake-validator.ts    Discord ID format validation
  routes/
    proxy.ts                  Catch-all reverse proxy; composes fingerprint or bot UA, releases pool token post-fetch
    custom.ts                 Custom business logic route tree
    admin.ts                  AUTH_KEY_ADMIN sub-app (token pool + fingerprint management)
    healthcheck.ts            Public unauthenticated liveness probe
  rotator/
    do.ts                     TokenPoolDO Durable Object class + RPC methods
    types.ts                  TokenState, AcquireResult, ReleaseInput, etc.
    bucket.ts                 Route -> Discord-bucket lookup
    selection.ts              Pure LRU + cooldown filtering
    validators.ts             Token format + pool-cap + bucket-states housekeeping
    release-input.ts          Parse X-RateLimit-* response headers
    client.ts                 createTokenPoolClient(stub) + getPoolStub(env) factory
  fingerprint/                Pure, runtime-agnostic
    profiles.ts               FingerprintProfile registry + FALLBACK_PROFILE_ID
    compose.ts                composeFingerprint + composeBotUserAgent (pure)
    build-number.ts           selectBuildNumber (pure) + isolated DO read helper
  scheduled/
    build-number-refresh.ts   Daily cron handler scraping discord.com/login
  custom/
    chillzone/events/
      bingo/                  Bingo participant counts (uses the rotator)
      kindness-cascade/       Kindness Cascade tallying module (see its own README)

test/
  env.d.ts                    Cloudflare test type augmentation
  middleware/                 Unit tests for each middleware (incl. token-rotator)
  routes/                     Integration tests for proxy, custom, admin, healthcheck
  rotator/                    DO + pure-function tests via @cloudflare/vitest-pool-workers
  custom/chillzone/events/    Classifier, tallier, formatter, and handler tests
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
bun run test           # Run all 312 tests across 27 suites
bun run test -- --ui   # Open Vitest UI
```

Tests use `@cloudflare/vitest-pool-workers` to run in a Workers-compatible runtime. Discord API calls are mocked at the fetch level. `TokenPoolDO` runs in the real DO simulation; tests inject either a mock pool client (`createApp(mockFetch, mockTokenPool)`) or exercise the DO directly via `runInDurableObject`.

## Deployment

Deployment is handled by a three-stage CI/CD pipeline:

1. **Push to `main`** — [`ci.yaml`](.github/workflows/ci.yaml) runs linting and tests. Dependabot dependency bumps are auto-merged directly to `production`.
2. **Pre-production review** — [`pre-production-review.yaml`](.github/workflows/pre-production-review.yaml) generates a change report and requests reviewer approval via the `status/approved` label.
3. **Deploy** — [`deploy.yaml`](.github/workflows/deploy.yaml) triggers on push to `production`, uploading and promoting the Worker via Wrangler's gradual deployment (`wrangler versions upload` → `wrangler versions deploy`).

[`bootstrap-wrangler-migration.yaml`](.github/workflows/bootstrap-wrangler-migration.yaml) is a `workflow_dispatch`-only job that runs a non-versioned `wrangler deploy`. Cloudflare refuses `wrangler versions upload` when a Worker migration is part of the upload (e.g. introducing a new Durable Object class), so this workflow gets triggered manually from the Actions tab once per migration. Future versioned deploys via `deploy.yaml` resume working after.

### Required Secrets

Set these in your repository settings under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) — create a token with the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | [Cloudflare Dashboard](https://dash.cloudflare.com/) → select your account → copy the **Account ID** from the right sidebar on the overview page |
| `CUSTOM_DOMAIN` | Your Cloudflare Workers custom domain (e.g. `api.example.com`). Injected into `wrangler.jsonc` at deploy time via the `__CUSTOM_DOMAIN__` placeholder |
| `PAT` | [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta) — needs **Contents: Read and write** and **Pull requests: Read and write** permissions for this repo. Required because pushes made with the default `GITHUB_TOKEN` do not trigger downstream workflows |

Set the runtime Wrangler secrets via `wrangler secret put <NAME>` once after the first deploy: `DISCORD_TOKEN_BOT`, `DISCORD_TOKEN_USER`, `AUTH_KEY`, plus optional `DISCORD_TOKEN_USER_PREMIUM` + `AUTH_KEY_PREMIUM` and `AUTH_KEY_ADMIN`.
