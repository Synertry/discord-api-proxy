# Custom endpoints

`/custom/*` is reserved for server-side endpoints that process Discord data instead of forwarding a single call (event tallies, analytics, aggregations). The tree ships as a skeleton with no endpoint enabled:

- `src/routes/custom.ts` - the `/custom` router. Mount a feature module with `customRoutes.route('/<scope>/<feature>', featureRoutes)` above the trailing handler; any unmatched `/custom/*` path answers `404 { "error": "Not Found" }` and never reaches Discord.
- `src/custom/shared/paged-messages.ts` - `fetchAllMessages`, the paced, guard-leased cursor pager for reading a whole channel history (1 s minimum gap between calls, `Retry-After` honored, identity blocks reported as `IdentityBlockedError`). Build on it rather than writing a fetch loop.

## Module layout

A feature module lives at `src/custom/<scope>/<feature>/` with:

| File | Contents |
|---|---|
| `handler.ts` | An `OpenAPIHono` sub-app built from `createRoute` definitions |
| `schemas.ts` | Zod request and response schemas |
| `classifier.ts`, `tallier.ts`, `formatter.ts` | Pure logic, as needed |

Each file gets a spec under `test/custom/<scope>/<feature>/`.

## Rules for handlers

- Build outbound headers with `composeRequestHeaders`; never hand-roll a user-agent or super-properties.
- Lease the static guard (`c.var.staticGuard`) or acquire a pool token immediately before each fetch, and settle immediately after with the result of `inspectResponse`.
- Keep at least 1 s between Discord calls on one identity; `fetchAllMessages` already does this.

The `/custom` 404 is a namespace convenience, not an access boundary: any caller holding `AUTH_KEY` can already forward arbitrary paths through the proxy.
