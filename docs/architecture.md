# Architecture

The proxy is a [Hono](https://hono.dev) app deployed as a Cloudflare Worker (`src/index.ts`). One Durable Object class, `TokenPoolDO`, backs the rotating token pool, the guard that protects static user tokens, and a shared Cloudflare circuit that also holds bot requests.

## Middleware sieve

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
[Snowflake Validator]      Validates Discord IDs in URL path segments (before identity resolution, so a malformed
                            path never costs a Durable Object round trip)
  |
  v
[Identity Middleware]      Resolves live client versions + a fallback identity (static path); records a
                            PoolPlan on allow-listed routes and constructs one shared StaticGuard, but never
                            itself acquires a pool token or leases the guard - that only happens at the point
                            of each outbound fetch
  |
  v
[Subrequest Logger]        Wraps proxyFetch and prints one [subreq] line per outbound call, with caller data
                            (credential path segments, unknown query keys and values) redacted
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
> Custom endpoints under `/custom/*` come first; an unmatched `/custom/*` path answers `404` and is never forwarded. Everything outside `/custom` falls through to the proxy forwarder.

User-token dispatch acquires a pool token or leases the static guard at the point of use. Bot dispatch instead checks the shared Cloudflare circuit before fetching and reports only Cloudflare response outcomes afterward through optional `TokenPoolClient` RPCs (`checkUpstreamCircuit` and `reportUpstreamOutcome`). A bot edge block can therefore hold all three dispatch paths. Bots have no captcha circuits, budgets, or leases; missing bindings or RPC methods and failed circuit RPCs degrade to unguarded bot handling. Proxy-generated pool cooldown and circuit holds include `X-Proxy-Block`; actual Discord 429 responses remain upstream responses, not proxy holds.

A daily cron (`0 4 * * *` UTC) runs `src/scheduled/client-versions-refresh.ts`, which scrapes the current Chrome stable major and Discord web build number so generated fingerprints stay current. The cron handler does not pass through the sieve.

## Project structure

```
src/
  index.ts                    App factory + middleware sieve + sub-app mounting + cron entry
  types.ts                    Shared type definitions (Bindings, DiscordUser)
  global.d.ts                 Build-time constants (BUILD_HASH, BUILD_TIMESTAMP)
  logger.ts                   createLogger(scope): every server-side log line, prefixed [scope]
  middleware/
    auth.ts                   API key authentication (sets authSlot)
    discord-context.ts        Static-token selection + discordTokenKind
    identity.ts               Resolves versions/fallback identity/PoolPlan/StaticGuard; never acquires/leases itself
    proxy-token-header.ts     Parses X-Proxy-Token (auto | static | <label>)
    snowflake-validator.ts    Discord ID format validation
    subrequest-logger.ts      Wraps proxyFetch for streaming visibility with allow-shape redaction
  routes/
    proxy.ts                  Catch-all reverse proxy; composes headers, fills message bodies, dispatches
                              opt-in typing, leases/releases at the point of each outbound fetch, retries
                              once on a live pool 429
    typing-delay.ts           Humanized typing delay (per-character wait, long-message re-triggers)
    custom.ts                 Custom business logic route tree
    admin.ts                  AUTH_KEY_ADMIN sub-app (token pool, fingerprint, and identity management)
    healthcheck.ts            Public unauthenticated liveness probe
  rotator/
    do.ts                     TokenPoolDO Durable Object class + RPC methods (pool + static guard)
    types.ts                  TokenState, StaticIdentityState, AcquireResult, ReleaseInput, etc.
    budget.ts                 Pure BucketBudget/lease/circuit-precedence logic shared by pool and static guard
    static-guard.ts           StaticGuard: lease-at-point-of-use wrapper over leaseStatic/settleStatic
    bucket.ts                 Route -> Discord-bucket lookup + rotatable-route allowlist
    selection.ts              Pure LRU + cooldown filtering
    signals.ts                inspectResponse: parses X-RateLimit-*, captcha/Cloudflare abuse signals
    token-hash.ts             Hashes a token secret into the guard's identity key (kind-independent)
    release-input.ts          Parse X-RateLimit-* response headers
    validators.ts             Token format + pool-cap + bucket-states housekeeping
    client.ts                 createTokenPoolClient(stub) + getPoolStub(env) factory
  fingerprint/                Pure, runtime-agnostic
    profiles.ts               ProfileTemplate/ResolvedProfile registry, FALLBACK_PROFILE_ID, custom-profile validation
    chromium.ts               Generated Chromium UA/client-hint templates + greased Sec-CH-UA brand list
    session.ts                Deterministic per-identity session field derivation
    compose.ts                composeFingerprint + composeBotUserAgent (pure)
    headers.ts                composeRequestHeaders: the single header composer + inbound allowlist
    versions.ts               ClientVersions resolution (build number + Chrome major, with staleness fallback)
    context-properties.ts     X-Context-Properties defaults per route
    hash.ts                   Shared hashing helper
  scheduled/
    client-versions-refresh.ts  Daily cron handler: dual independent scrape (build number, Chrome major)
  custom/
    shared/
      paged-messages.ts       Shared paced pager: cursor pagination + guard lease-at-point-of-use + 429 retry

test/
  env.d.ts                    Cloudflare test type augmentation
  middleware/                 Unit tests for each middleware
  routes/                     Integration tests for proxy, custom, admin, healthcheck, typing delay
  rotator/                    DO + pure-function tests via @cloudflare/vitest-plugin
  fingerprint/                Header composer, profile registry, session, versions tests
  custom/                     Shared pager tests
  scheduled/                  Client-versions refresh (independent persistence of both records)
```
