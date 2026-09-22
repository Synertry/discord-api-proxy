/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module scripts/approval-gate
 * Pure validators for the untrusted inputs of the `/approve` fast-forward
 * workflow (`.github/workflows/review-approval.yaml`): the comment body that
 * triggers it, the PR number, the target commit SHA, and the base/head branch
 * names. Every one of these can originate from a GitHub event payload or a
 * manual `workflow_dispatch` input, so none of them are trusted to be
 * shell-safe on their own - the workflow reads them into `env:` and calls
 * this script instead of interpolating `${{ ... }}` directly into `run:`.
 *
 * Used both as a library (imported by `approval-gate.spec.ts`) and as a CLI:
 *   GATE_MODE=comment GATE_VALUE="$COMMENT_BODY" bun .github/scripts/approval-gate.ts
 * Prints `ok=true` or `ok=false` to `$GITHUB_OUTPUT` (or stdout when unset,
 * for local testing) and always exits 0 - the caller inspects the printed
 * value, this script never fails the step itself. Node-only APIs throughout
 * (`node:fs`, `process`, `import.meta.url`) so the file type-checks under the
 * project's existing `@types/node` without a Bun-types dependency.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * True only when the comment's first non-empty line, with a trailing `\r`
 * and trailing spaces/tabs stripped, is exactly `/approve`. Deliberately
 * exact: `/approve now`, `/approved`, `/approve; rm -rf /`, a leading space
 * on that line, and a comment consisting only of blank lines all fail, so the
 * gate cannot be tricked by suffix text riding along with the command or by
 * a loose `startsWith` match. Leading blank lines before the command line are
 * tolerated (comment editors and quote-replies commonly insert one).
 */
export function isApproveCommand(body: string): boolean {
	const firstNonEmpty = body.split(/\r?\n/).find((line) => line.trim().length > 0);
	return (firstNonEmpty ?? '').replace(/[ \t]+$/, '') === '/approve';
}

/** A positive decimal integer, no leading zero, up to 7 digits (GitHub PR numbers never exceed this in practice). */
export function isPrNumber(value: string): boolean {
	return /^[1-9][0-9]{0,6}$/.test(value);
}

/** A full 40-character lowercase hex commit SHA. */
export function isSha(value: string): boolean {
	return /^[0-9a-f]{40}$/.test(value);
}

/** A plausible git branch/ref short name: no `..`, no shell metacharacters, bounded length. */
export function isBranch(value: string): boolean {
	if (value.length < 1 || value.length > 120) return false;
	if (value.includes('..')) return false;
	return /^[A-Za-z0-9._/-]+$/.test(value);
}

/** The only routing this workflow is allowed to fast-forward: main -> production. */
export function isRouting(base: string, head: string): boolean {
	return base === 'production' && head === 'main';
}

type GateMode = 'comment' | 'pr' | 'sha' | 'branch';

function evaluate(mode: string | undefined, value: string): boolean {
	switch (mode as GateMode) {
		case 'comment':
			return isApproveCommand(value);
		case 'pr':
			return isPrNumber(value);
		case 'sha':
			return isSha(value);
		case 'branch':
			return isBranch(value);
		default:
			throw new Error(`Unknown GATE_MODE: ${mode ?? '(unset)'}`);
	}
}

/** Portable "is this module the CLI entry point" check - works under both Node and Bun without Bun-specific types. */
const isCliEntry = typeof process !== 'undefined' && process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCliEntry) {
	const mode = process.env.GATE_MODE;
	const value = process.env.GATE_VALUE ?? '';
	let ok: boolean;
	try {
		ok = evaluate(mode, value);
	} catch (err: unknown) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	const line = `ok=${ok}\n`;
	const githubOutput = process.env.GITHUB_OUTPUT;
	if (githubOutput) {
		appendFileSync(githubOutput, line);
	} else {
		process.stdout.write(line);
	}
}
