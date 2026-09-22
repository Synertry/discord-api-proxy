/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module scripts/sync-labels
 * Creates or updates GitHub labels with consistent colors and descriptions.
 *
 * Descriptions stay aligned with the comments in `.github/labels.yaml`. Run
 * after adding or renaming a label so the repo's labels match the workflows
 * that depend on them (pr-labeler, pr-test, pre-production-review, review-approval,
 * stale-triage, etc.).
 *
 * Usage:
 *   bun .github/scripts/sync-labels.ts [OWNER/REPO]
 *
 * Defaults to the current `gh` repo if no argument is given.
 *
 * Requires: gh CLI on PATH, authenticated with `repo` scope.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Label = {
  name: string;
  /** Six-character hex without the leading `#`. */
  color: string;
  description: string;
};

const LABELS: Label[] = [
  // --- Area labels (each visually distinct) ---
  {
    name: 'area/config',
    color: 'e4e669',
    description: 'Root configuration files (wrangler.jsonc, tsconfig, prettier, vitest, .dev.vars.example)',
  },
  { name: 'area/IDE', color: 'cccccc', description: 'IDE and editor configuration (.vscode, .idea)' },
  { name: 'area/CI', color: '5319e7', description: 'GitHub workflows, Dependabot, labelers, scripts' },
  { name: 'area/deps', color: '006b75', description: 'Dependency manifests (package.json, bun.lock)' },
  { name: 'area/source', color: '0e8a16', description: 'Worker source code under src/' },
  { name: 'area/tests', color: '1d76db', description: 'Tests under test/' },
  { name: 'area/docs', color: 'c5def5', description: 'Documentation (README, CONTRIBUTING, CODE_OF_CONDUCT)' },
  { name: 'area/license', color: 'fbca04', description: 'License file' },

  // --- Type labels (Conventional Commits) ---
  { name: 'type/build', color: '0075ca', description: 'Changes that affect the build system or external dependencies' },
  { name: 'type/chore', color: 'ededed', description: "Maintenance tasks that don't modify source or test files" },
  { name: 'type/ci', color: '5319e7', description: 'Changes to CI configuration files and scripts' },
  { name: 'type/docs', color: 'c5def5', description: 'Documentation-only changes' },
  { name: 'type/feat', color: 'a2eeef', description: 'A new feature' },
  { name: 'type/fix', color: 'd73a4a', description: 'A bug fix' },
  { name: 'type/perf', color: 'f9d0c4', description: 'A code change that improves performance' },
  { name: 'type/refactor', color: 'd4c5f9', description: 'A code change that neither fixes a bug nor adds a feature' },
  { name: 'type/revert', color: 'b60205', description: 'Reverts a previous commit' },
  { name: 'type/style', color: 'cfd3d7', description: 'Whitespace and formatting changes that do not alter semantics' },
  { name: 'type/test', color: '1d76db', description: 'Adding missing tests or correcting existing tests' },

  // --- Size labels (green-to-red gradient) ---
  { name: 'size/xs', color: '4caf50', description: 'Extra small diff (< 25 lines, 1 file)' },
  { name: 'size/s', color: '8bc34a', description: 'Small diff (< 150 lines, 10 files)' },
  { name: 'size/m', color: 'ffeb3b', description: 'Medium diff (< 600 lines, 25 files)' },
  { name: 'size/l', color: 'ff9800', description: 'Large diff (< 2500 lines, 50 files)' },
  { name: 'size/xl', color: 'f44336', description: 'Extra large diff (>= 5000 lines or 100+ files)' },

  // --- Status labels ---
  { name: 'status/triage', color: 'e4820b', description: 'Needs triage before action can be taken' },
  { name: 'status/pr-test-passed', color: '0e8a16', description: 'Lightweight PR test workflow passed (granted by pr-test.yaml)' },
  { name: 'status/review-needed', color: 'fbca04', description: 'Requires human review before merging' },
  { name: 'status/approval-pending', color: 'fbca04', description: 'Waiting on approver before fast-forward to production' },
  { name: 'status/approved', color: '0e8a16', description: 'Approved for production - triggers fast-forward push' },
  { name: 'status/stale', color: 'aaaaaa', description: 'No activity for 30 days - scheduled for closure' },

  // --- Workflow labels ---
  { name: 'workflow/dependabot', color: '7057ff', description: 'Automated dependency update from Dependabot' },
  { name: 'workflow/auto-pr', color: '7057ff', description: 'Pull request opened by an automated workflow' },
];

/** Resolves the target repo: explicit argv -> `gh repo view`. */
async function resolveRepo(argvRepo: string | undefined): Promise<string> {
  if (argvRepo) return argvRepo;
  try {
    const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    const repo = stdout.trim();
    if (!repo) throw new Error('gh repo view returned an empty repo name; pass OWNER/REPO explicitly');
    return repo;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('empty repo name')) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gh repo view failed: ${message}`);
  }
}

/** Creates or updates a single label via `gh label create --force`. */
async function syncLabel(repo: string, label: Label): Promise<void> {
  try {
    await execFileAsync('gh', [
      'label',
      'create',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description,
      '--repo',
      repo,
      '--force',
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to sync label "${label.name}": ${message}`);
  }
}

async function main(): Promise<void> {
  const argvRepo = process.argv[2];
  const repo = await resolveRepo(argvRepo);
  console.log(`Syncing ${LABELS.length} labels to ${repo}...`);

  let synced = 0;
  let failed = 0;
  for (const label of LABELS) {
    try {
      await syncLabel(repo, label);
      synced++;
      console.log(`  ok  ${label.name}`);
    } catch (err: unknown) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  err ${label.name}: ${message}`);
    }
  }

  console.log(`Done. ${synced} synced, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

await main();
