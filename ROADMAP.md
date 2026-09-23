# ROADMAP

Open work, deliberately deferred decisions, and follow-up items that didn't make a release. Pruned as things ship.

## Token rotator (post-PR-#47)

Multi-token Discord user-token rotator landed in PR #47. v1 covers the proxy, bingo migration, admin API, and per-Discord-bucket cooldown tracking. v1 operational rollout is complete (token pool registered in prod, bingo refresh validated, `/admin/health` confirmed healthy).

### Deliberately deferred (v2+ candidates)

- [ ] **Per-slot DO sharding.** Pool is a single `idFromName('token-pool-v1')` instance today. The `getPoolStub(env, slot?)` factory pre-bakes the sharding option (one-file flip to `token-pool-default` / `token-pool-premium`). Trigger to ship: ~50 concurrent in-flight requests with P99 RPC latency >50ms, OR DO CPU time pressure. Any new RPC method returns a result object (`{ ok: true, ... } | { ok: false, reason }`) instead of throwing; a thrown error inside a DO RPC surfaces as an unhandled-rejection echo in workerd logs.
- [ ] **Bulk acquire API.** Would help a consumer that needs N tokens for N concurrent sub-fetches inside one proxy request. Bingo is sequential and doesn't need it. Reconsider if a new consumer wants parallel fanout per call.
- [ ] **Egress-IP rotation layer.** Orthogonal to the rotator. Only matters if we ever observe CF-level 1015s from the shared Cloudflare egress IP. Today's per-token-per-bucket rotation is sufficient.
- [ ] **`X-Pool-Token-Label` audit response header.** Flagged during security review as a nice-to-have for incident response. Defer until a concrete incident asks for it.
- [ ] **Published `@synertry/discord-rotator-types` package.** Cross-codebase consumers currently copy-paste `src/rotator/types.ts`. Publish when there are 2+ active consumers OR the types drift in a way that bites someone.
- [ ] **Smart Placement.** Disabled in v1. Revisit once we have real RPC latency data on the DO path.
- [ ] **Reaction-emoji route inclusion in the rotation allowlist.** v1 keeps `PUT|DELETE /channels/:id/messages/:id/reactions/:emoji/@me` on static tokens because they are authorship endpoints. If a read-only reaction-fetch use case shows up (`GET /channels/:id/messages/:id/reactions/:emoji`), add it to `isRotatableRoute`.
- [ ] **Server-side `tokenSecret` uniqueness check.** `TokenPoolDO.register()` keys by `label` only, so the same token registered under two different labels currently succeeds and wastes rotation (both entries share Discord's per-token-per-bucket budget). A cheap O(N) hash-compare at register-time would close it. Pool cap is 20, so the scan is trivial.


## Client identity hardening (post-feat/client-identity)

Realistic per-identity fingerprinting, header allowlisting, and an identity guard for static user tokens landed to close the gap where static `DISCORD_TOKEN_USER`/`_PREMIUM` requests bypassed the pool's rate-limit and abuse-signal protections entirely. See README's Client Identity section for the shipped design.

### Accepted gaps (not emulable from a Cloudflare Worker, or deliberately out of scope)

- [ ] **TLS JA3/JA4 fingerprinting.** Workers don't expose raw TLS ClientHello construction; a real client's TLS fingerprint can't be reproduced short of a `curl_cffi`-style shim, which has no Workers equivalent.
- [ ] **HTTP/2 frame ordering.** Same category as TLS fingerprinting; the runtime owns the transport, not the request code.
- [ ] **Worker egress IP.** Requests originate from Cloudflare's own IP ranges regardless of fingerprint realism. Orthogonal to the token rotator's existing per-token-per-bucket mitigation (see above).
- [ ] **`CF-Worker` / `CF-Connecting-IP` on cross-zone subrequests.** Cloudflare platform behavior on Worker-to-Worker-zone requests; not something request code can suppress.
- [ ] **Per-request grease rotation.** `Sec-CH-UA`'s greased brand is fixed per Chrome major (matching a real client's per-launch, not per-request, grease selection) rather than rotated every call. Matches real client behavior; not a gap unless a specific detection vector is found.

## Cross-cutting tech debt (out of scope for the rotator)

These predate the rotator and are tracked separately. Listed here so they don't fall off the radar.

- [ ] **`[subreq]` middleware logs full URLs including query params.** Token-bearing or PII-bearing query params (search queries, `author_id`, ...) end up in logs. Strip or hash before logging.
- [ ] **`console.log` calls in production paths.** Violates the TypeScript coding standard. Audit and route through a proper logger.

## Closed experiments (do not re-attempt without re-checking)

- **`bun --bun ./node_modules/wrangler/bin/wrangler.js ...` for CI deploy commands** - tried in PR #53, silently broke `wrangler versions upload` (banner prints, exit 0, no upload). Root cause: wrangler's `bin/wrangler.js` entry re-spawns the dist CLI via `process.execPath` with node-only flags (`--no-warnings`, `--experimental-vm-modules`); under Bun the child becomes `bun --no-warnings --experimental-vm-modules .../cli.js` and Bun's Node-API emulation isn't deep enough for the upload path. Reverted to the PR #38 pattern (`actions/setup-node@v6.4.0` + `node ./node_modules/wrangler/bin/wrangler.js ...`) in PR #55. Don't re-attempt without verifying `wrangler versions upload` succeeds on CI first.

## Process

- One bullet per item, terse. Move to the bottom or remove once shipped.
- Link to the deciding plan / PR / learned skill where useful, so future-you remembers *why* a thing was deferred.
- Architectural decisions and *learnings* (the why-not-shipped reasoning) live in the maintainer's private notes, not here. ROADMAP is for *commitments*.
