# Discord API Proxy

[![CI](https://img.shields.io/github/actions/workflow/status/Synertry/discord-api-proxy/ci.yaml?branch=main&label=CI&logo=github)](https://github.com/Synertry/discord-api-proxy/actions/workflows/ci.yaml)
[![Deploy](https://img.shields.io/github/actions/workflow/status/Synertry/discord-api-proxy/deploy.yaml?branch=production&label=deploy&logo=cloudflareworkers&logoColor=white)](https://github.com/Synertry/discord-api-proxy/actions/workflows/deploy.yaml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflareworkers&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![License: BSL-1.0](https://img.shields.io/badge/license-BSL--1.0-blue.svg)](./LICENSE)

A reverse proxy for the Discord API, deployed as a [Cloudflare Worker](https://developers.cloudflare.com/workers/). Adds authentication, token management, snowflake validation, and a skeleton for server-side business logic endpoints on top of the standard Discord API.
Original motivation was for my Google Sheets to be able to call the Discord API, without my requests being rejected from Discord, because they would detect Google's IP addresses.

## Features

- **Reverse proxy** - forwards any path to `discord.com/api/v10` with the token injected. ([configuration](docs/configuration.md))
- **Bot and user tokens** - picked per request by header or path, with an optional premium slot. ([token pool](docs/token-pool.md))
- **Token pool** - rotates registered user tokens with per-bucket cooldowns in a Durable Object. ([token pool](docs/token-pool.md))
- **Client identity** - one consistent, version-tracked browser fingerprint per user token. ([client identity](docs/client-identity.md))
- **Identity guard** - per-bucket budgets and captcha circuits for user tokens, plus a shared Cloudflare circuit for user and bot requests. ([client identity](docs/client-identity.md#identity-guard))
- **Humanized sends** - optional typing indicator and length-scaled delay before a message. ([configuration](docs/configuration.md#typing-delay))
- **Admin API** - manage pool tokens, fingerprints, and identities behind a separate key. ([token pool](docs/token-pool.md#admin-api))
- **Snowflake validation** - malformed ids answer a Discord-shaped 400 before any upstream call. ([configuration](docs/configuration.md#responses-the-proxy-adds))
- **Uniform 429s** - one JSON envelope that keeps `Retry-After` and guard signals. ([configuration](docs/configuration.md#responses-the-proxy-adds))
- **Custom endpoints** - a `/custom/*` skeleton with a paced, guarded message pager. ([custom endpoints](docs/custom-endpoints.md))
- **Public healthcheck** - unauthenticated `GET /healthcheck` with build metadata. ([configuration](docs/configuration.md#public-endpoints))

## Quick start

Prerequisites: [Bun](https://bun.sh) 1.x. [Wrangler](https://developers.cloudflare.com/workers/wrangler/) is installed as a dev dependency.

```bash
bun install
```

Create `.dev.vars` in the repo root (see [`.dev.vars.example`](.dev.vars.example) for the optional keys):

```env
DISCORD_TOKEN_BOT=your-bot-token
DISCORD_TOKEN_USER=your-user-token
AUTH_KEY=your-api-key
```

Generate `AUTH_KEY` from at least 32 cryptographically random bytes, for example with `openssl rand -base64 32`. If enabling `AUTH_KEY_PREMIUM` or `AUTH_KEY_ADMIN`, generate each separately and never reuse a value across these keys. See [Configuration](docs/configuration.md#secrets) for the consequences of key reuse.

Start the dev server and send a first request:

```bash
bun run dev
curl -H "x-auth-key: your-api-key" -H "X-Proxy-Context: user" http://127.0.0.1:8787/users/@me
```

> [!CAUTION]
> I advise to use an alt account for the user token to avoid any future risks for your main account of being banned by Discord.

## How requests flow

`/healthcheck` and `/admin/*` are mounted before the main pipeline. Everything else passes through:

```
Rate Limit Interceptor -> Auth -> Discord Context -> Snowflake Validator -> Identity -> Subrequest Logger -> Custom Routes -> Proxy Forwarder
```

- `X-Proxy-Context: user|bot` picks the token; without it, `/guilds` paths use the user token and everything else the bot token.
- `AUTH_KEY` selects the default user token, `AUTH_KEY_PREMIUM` the premium one; allow-listed read routes rotate through the registered pool first.
- Pool tokens and static user tokens are leased from the guard immediately before each Discord call and released right after.
- Bot requests check the shared Cloudflare circuit before dispatch and report Cloudflare edge blocks afterward, without user-token budgets, captcha circuits, or leases. Missing bindings or optional circuit RPCs and failed circuit RPCs degrade to unguarded bot handling.

The full diagram and source layout are in [Architecture](docs/architecture.md).

## Headers at a glance

| Header | Direction | Purpose |
|---|---|---|
| `x-auth-key` / `Authorization` | request | `AUTH_KEY` or `AUTH_KEY_PREMIUM`; required. |
| `X-Proxy-Context` | request | `user` or `bot`: force the token type. |
| `X-Proxy-Token` | request | `auto`, `static`, or a pool label. |
| `X-Proxy-Typing` | request | `on`: typing indicator plus humanized delay before a message send. |
| `X-Proxy-Typing-Max-Ms` | request | `1000`-`30000`: longer typing for long messages. |
| `X-Proxy-Block` | response | `bucket`, `capacity`, `captcha`, or `cloudflare` on a proxy-held 429, including pool cooldown and circuit holds. |

Details and status codes: [Configuration](docs/configuration.md).

## Documentation

- [Configuration](docs/configuration.md) - secrets, bindings, headers, and response signals
- [Token pool](docs/token-pool.md) - token selection, `X-Proxy-Token`, and the admin API
- [Client identity](docs/client-identity.md) - fingerprints, the identity guard, and operating rules
- [Architecture](docs/architecture.md) - the middleware pipeline and source layout
- [Custom endpoints](docs/custom-endpoints.md) - building server-side endpoints under `/custom`
- [Deployment](docs/deployment.md) - the CI/CD pipeline and required secrets
- [Roadmap](docs/roadmap.md) - deferred work and accepted gaps

## Development

| Command | Purpose |
|---|---|
| `bun run dev` | Local dev server at `http://127.0.0.1:8787` |
| `bun run test` | Run all tests (`bun run test -- --ui` for the Vitest UI) |
| `bun run lint` | Type-check (`tsc --noEmit`) |
| `bun run cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |

The suite has 564 tests across 30 files and runs inside the Workers runtime via `@cloudflare/vitest-plugin`. Discord API calls are mocked at the fetch level; `TokenPoolDO` runs in the real Durable Object simulation, and tests either inject a mock pool client or exercise the DO directly via `runInDurableObject`.

See [CONTRIBUTING](.github/CONTRIBUTING.md) for the branch and commit conventions.

## Deployment

Pushes to `main` run CI. Promoting to production goes through a `main -> production` PR that a collaborator approves with `/approve`, which fast-forwards `production`; a push to `production` deploys the Worker with Wrangler. The workflows and required secrets are described in [Deployment](docs/deployment.md).

## License

[Boost Software License 1.0](LICENSE).
