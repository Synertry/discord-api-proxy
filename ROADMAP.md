# ROADMAP

Open work, deliberately deferred decisions, and follow-up items that didn't make a release. Pruned as things ship.

## Token rotator (post-PR-#47)

Multi-token Discord user-token rotator landed in PR #47. v1 covers the proxy, bingo migration, admin API, and per-Discord-bucket cooldown tracking. The list below is what was scoped out of v1 on purpose, plus near-term operational items.

### Operational follow-ups

- [ ] **Production deploy.** Once the bootstrap workflow applies the `TokenPoolDO` migration, future pushes to `production` should resume going through the versioned deploy pipeline. Verify the next non-migration push succeeds.
- [ ] **Production secrets.** Set `AUTH_KEY_ADMIN` via `wrangler secret put AUTH_KEY_ADMIN`. The admin sub-app fail-closes (503) when this is unset, so leaving it unset effectively disables `/admin/*`.
- [ ] **Register handpicked tokens.** Use `/admin/tokens` against the deployed proxy with the operator-only auth key. Start with 2-3 tokens in `default`. Pool cap is 20/slot.
- [ ] **Live validation.** Run a GAS-driven bingo refresh on staging with 3 tokens registered. Measure wall time vs the 5-7 min single-token baseline. That is the receipt for v1.
- [ ] **`/admin/health` watch during first prod refresh.** Confirm `default.active` dips into `cooling` but never to zero (would surface as consumer 429s).

### Deliberately deferred (v2+ candidates)

- [ ] **Per-slot DO sharding.** Pool is a single `idFromName('token-pool-v1')` instance today. The `getPoolStub(env, slot?)` factory pre-bakes the sharding option (one-file flip to `token-pool-default` / `token-pool-premium`). Trigger to ship: ~50 concurrent in-flight requests with P99 RPC latency >50ms, OR DO CPU time pressure. See `.claude/skills/learned/cf-do-rpc-throw-workerd-unhandled-rejection-echo.md` for the result-object pattern any new RPC methods should follow.
- [ ] **Bulk acquire API.** Would help a consumer that needs N tokens for N concurrent sub-fetches inside one proxy request. Bingo is sequential and doesn't need it. Reconsider if a new consumer wants parallel fanout per call.
- [ ] **Egress-IP rotation layer.** Orthogonal to the rotator. Only matters if we ever observe CF-level 1015s from the shared Cloudflare egress IP. Today's per-token-per-bucket rotation is sufficient.
- [ ] **`X-Pool-Token-Label` audit response header.** Security agent flagged it as a nice-to-have for incident response. Defer until a concrete incident asks for it.
- [ ] **Published `@synertry/discord-rotator-types` package.** Cross-codebase consumers currently copy-paste `src/rotator/types.ts`. Publish when there are 2+ active consumers OR the types drift in a way that bites someone.
- [ ] **Smart Placement.** Disabled in v1. Revisit once we have real RPC latency data on the DO path.
- [ ] **Reaction-emoji route inclusion in the rotation allowlist.** v1 keeps `PUT|DELETE /channels/:id/messages/:id/reactions/:emoji/@me` on static tokens because they are authorship endpoints. If a read-only reaction-fetch use case shows up (`GET /channels/:id/messages/:id/reactions/:emoji`), add it to `isRotatableRoute`.

## Cross-cutting tech debt (out of scope for the rotator)

These predate the rotator and are tracked separately. Listed here so they don't fall off the radar.

- [ ] **`[subreq]` middleware logs full URLs including query params.** Token-bearing or PII-bearing query params (search queries, `author_id`, ...) end up in logs. Strip or hash before logging.
- [ ] **`console.log` calls in production paths.** Violates the TypeScript coding standard. Audit and route through a proper logger.

## Process

- One bullet per item, terse. Move to the bottom or remove once shipped.
- Link to the deciding plan / PR / learned skill where useful, so future-you remembers *why* a thing was deferred.
- Architectural decisions and *learnings* (the why-not-shipped reasoning) live in Hindsight, not here. ROADMAP is for *commitments*.
