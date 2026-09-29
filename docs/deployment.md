# Deployment

Deployment is handled by a three-stage CI/CD pipeline:

1. **Push to `main`** - [`ci.yaml`](../.github/workflows/ci.yaml) runs linting and tests. Dependabot dependency bumps are auto-merged directly to `production`.
2. **Pre-production review** - [`pre-production-review.yaml`](../.github/workflows/pre-production-review.yaml) posts a change report on the `main -> production` PR and labels it `status/review-needed` + `status/approval-pending`.
3. **Approve** - A collaborator with write access comments a bare `/approve` on the PR (or submits a GitHub review approval). [`review-approval.yaml`](../.github/workflows/review-approval.yaml) validates the command, the commenter's permissions, and the target SHA through [`approval-gate.ts`](../.github/scripts/approval-gate.ts), then fast-forwards `production` to that commit and swaps the labels to `status/approved`.
4. **Deploy** - [`deploy.yaml`](../.github/workflows/deploy.yaml) triggers on push to `production`, uploading and promoting the Worker via Wrangler's gradual deployment (`wrangler versions upload` then `wrangler versions deploy`), then posts a deploy notification.

[`bootstrap-wrangler-migration.yaml`](../.github/workflows/bootstrap-wrangler-migration.yaml) is a `workflow_dispatch`-only job that runs a non-versioned `wrangler deploy`. Cloudflare refuses `wrangler versions upload` when a Worker migration is part of the upload (e.g. introducing a new Durable Object class), so this workflow gets triggered manually from the Actions tab once per migration. Versioned deploys via `deploy.yaml` work again afterwards.

## Required secrets

Set these in your repository settings under **Settings > Secrets and variables > Actions**:

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | [Cloudflare Dashboard > My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens) - create a token with the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | [Cloudflare Dashboard](https://dash.cloudflare.com/) > select your account > copy the **Account ID** from the right sidebar on the overview page |
| `CUSTOM_DOMAIN` | Your Cloudflare Workers custom domain (e.g. `api.example.com`). Injected into `wrangler.jsonc` at deploy time via the `__CUSTOM_DOMAIN__` placeholder |
| `PAT` | [GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/tokens?type=beta) - needs **Contents: Read and write** and **Pull requests: Read and write** permissions for this repo. Required because pushes made with the default `GITHUB_TOKEN` do not trigger downstream workflows |
| `DISCORD_WEBHOOK_URL` | A Discord channel webhook URL for deploy notifications (Channel Settings > Integrations > Webhooks) |
| `RELAY_AUTH_KEY` / `RELAY_DOMAIN` | Optional. When both are set, deploy notifications are dogfooded through a [cf-discord-relay](https://github.com/Synertry/cf-discord-relay) instance first and only fall back to `DISCORD_WEBHOOK_URL` on failure |

## Runtime secrets

Set the Worker's runtime secrets via `wrangler secret put <NAME>` once after the first deploy: `DISCORD_TOKEN_BOT`, `DISCORD_TOKEN_USER`, `AUTH_KEY`, plus optional `DISCORD_TOKEN_USER_PREMIUM` + `AUTH_KEY_PREMIUM` and `AUTH_KEY_ADMIN`. See [Configuration](configuration.md) for what each one unlocks.
