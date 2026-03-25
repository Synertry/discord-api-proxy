# Contributing to Discord API Proxy

Thank you for your interest in contributing!

## Branching Strategy

- **`main`**: This is the default branch for all development. Please target this branch for your Pull Requests.
- **`production`**: This is the protected branch for production releases. Changes from `main` are merged here via automated PRs.

## Workflow

1. Fork the repository.
2. Create a feature branch from `main`: `git checkout -b feat/my-feature main`
3. Make your changes.
4. Run tests locally: `bun run test`
5. If logic changes, regenerating types might be needed: `bun run cf-typegen`
6. Push to your fork and submit a PR to the **`main`** branch.

## Code Style

- We use **Prettier** for formatting.
- Run `bun run lint` to check for type errors.
- Commit messages should follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

## CI/CD

When you open a PR to `main`:

- A lightweight `pr-test` workflow will run linting and tests.
- If strictly documentation is changed, some heavy tests may be skipped.

Once merged to `main`:

- The CI pipeline runs.
- If successful, a PR is automatically created to merge `main` into `production`.
