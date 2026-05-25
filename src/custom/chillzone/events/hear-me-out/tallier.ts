/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/tallier
 * Aggregates classified submissions into ranked leaderboards + categorized listings.
 *
 * Counts toward rankings: `canonical`, `non-default`, `formatting-error` (i.e.
 * everything with a resolvable submitter ID). Penalizing a submitter for a
 * messenger's typo would be unfair.
 *
 * Excluded from rankings: `missing-attribution` (no submitter to credit) and
 * any submission with zero reactions for the `topVotedSubmissions` rank
 * specifically (a vote count of zero shouldn't appear on a "top voted" list).
 *
 * The `missing-votes` listing is orthogonal to classification: a canonical
 * submission with zero reactions still lands in `missingVotes`, so the host can
 * see which submissions need community attention.
 */

import type { ClassifiedSubmission, SubmissionEntry, UserEntity, UserTally, Stats, HearMeOutResult } from './types';

/** Submissions that have a resolvable submitter (eligible for ranking). */
const RANKABLE: ReadonlySet<ClassifiedSubmission['classification']> = new Set(['canonical', 'non-default', 'formatting-error']);

/** Converts an internal {@link ClassifiedSubmission} to an API-facing {@link SubmissionEntry}. */
function toSubmissionEntry(s: ClassifiedSubmission): SubmissionEntry {
	return {
		messageId: s.messageId,
		messageLink: s.messageLink,
		submitter: s.submitter,
		messenger: s.messenger,
		reactionCount: s.reactionCount,
		classification: s.classification,
		deviationReason: s.deviationReason,
	};
}

/**
 * Sorts user tallies descending by count, breaking ties by username (alphabetical).
 * Optionally truncates to `limit`.
 */
function sortAndTruncate(tallies: UserTally[], limit?: number): UserTally[] {
	const sorted = [...tallies].sort((a, b) => b.count - a.count || a.username.localeCompare(b.username));
	return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

/**
 * Builds a {@link UserTally} array by extracting one or more users per submission
 * via the supplied callback. Each occurrence increments the user's `count` by 1.
 */
function tallyUsers(
	submissions: readonly ClassifiedSubmission[],
	extractUsers: (s: ClassifiedSubmission) => readonly UserEntity[],
	limit?: number,
): UserTally[] {
	const map = new Map<string, { username: string; count: number }>();
	for (const sub of submissions) {
		for (const user of extractUsers(sub)) {
			const existing = map.get(user.userId);
			if (existing) {
				map.set(user.userId, { username: existing.username, count: existing.count + 1 });
			} else {
				map.set(user.userId, { username: user.username, count: 1 });
			}
		}
	}
	return sortAndTruncate(
		[...map.entries()].map(([userId, { username, count }]) => ({ userId, username, count })),
		limit,
	);
}

/**
 * Sums weighted vote counts per user. Unlike {@link tallyUsers} (which counts
 * messages), this sums each submission's `reactionCount` against the extracted
 * user(s) - the right shape for "top voted submitters" style rankings.
 */
function tallyVotes(
	submissions: readonly ClassifiedSubmission[],
	extractUsers: (s: ClassifiedSubmission) => readonly UserEntity[],
	limit?: number,
): UserTally[] {
	const map = new Map<string, { username: string; count: number }>();
	for (const sub of submissions) {
		for (const user of extractUsers(sub)) {
			const existing = map.get(user.userId);
			if (existing) {
				map.set(user.userId, { username: existing.username, count: existing.count + sub.reactionCount });
			} else {
				map.set(user.userId, { username: user.username, count: sub.reactionCount });
			}
		}
	}
	return sortAndTruncate(
		[...map.entries()].map(([userId, { username, count }]) => ({ userId, username, count })),
		limit,
	);
}

/**
 * Ranks submissions by reaction count (descending). Ties broken by message link
 * (lexicographic) for deterministic output. Submissions with zero reactions are
 * dropped - they belong in the `missingVotes` listing, not on a top-voted board.
 */
function rankSubmissions(submissions: readonly ClassifiedSubmission[], limit?: number): SubmissionEntry[] {
	const ranked = submissions.filter((s) => s.reactionCount > 0).map(toSubmissionEntry);
	const sorted = [...ranked].sort((a, b) => b.reactionCount - a.reactionCount || a.messageLink.localeCompare(b.messageLink));
	return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

/** Builds aggregate statistics across all classified messages. */
function computeStats(classified: readonly ClassifiedSubmission[]): Stats {
	const submitters = new Set<string>();
	const messengers = new Set<string>();
	let totalReactions = 0;
	let canonical = 0;
	let nonDefault = 0;
	let formattingErrors = 0;
	let missingAttribution = 0;
	let missingVotes = 0;

	for (const s of classified) {
		messengers.add(s.messenger.userId);
		if (s.submitter) submitters.add(s.submitter.userId);
		totalReactions += s.reactionCount;
		if (!s.hasVotes && RANKABLE.has(s.classification)) missingVotes++;
		switch (s.classification) {
			case 'canonical':
				canonical++;
				break;
			case 'non-default':
				nonDefault++;
				break;
			case 'formatting-error':
				formattingErrors++;
				break;
			case 'missing-attribution':
				missingAttribution++;
				break;
		}
	}

	return {
		totalMessages: classified.length,
		totalCanonical: canonical,
		totalNonDefault: nonDefault,
		totalFormattingErrors: formattingErrors,
		totalMissingAttribution: missingAttribution,
		totalMissingVotes: missingVotes,
		totalReactions,
		uniqueSubmitters: submitters.size,
		uniqueMessengers: messengers.size,
	};
}

/** Groups classified submissions into listing arrays + sparse counts map. */
function buildListings(classified: readonly ClassifiedSubmission[]): HearMeOutResult['listings'] {
	const nonDefault = classified.filter((s) => s.classification === 'non-default').map(toSubmissionEntry);
	const formattingErrors = classified.filter((s) => s.classification === 'formatting-error').map(toSubmissionEntry);
	const missingAttribution = classified.filter((s) => s.classification === 'missing-attribution').map(toSubmissionEntry);
	// Missing votes is orthogonal: include any rankable submission with zero reactions.
	const missingVotes = classified.filter((s) => RANKABLE.has(s.classification) && !s.hasVotes).map(toSubmissionEntry);

	const countEntries: ReadonlyArray<readonly [string, number]> = [
		['nonDefault', nonDefault.length],
		['formattingErrors', formattingErrors.length],
		['missingAttribution', missingAttribution.length],
		['missingVotes', missingVotes.length],
	];
	const counts: Record<string, number> = {};
	for (const [key, count] of countEntries) {
		if (count > 0) counts[key] = count;
	}

	return { nonDefault, formattingErrors, missingAttribution, missingVotes, counts };
}

/**
 * Main tallying entry point. Filters rankable submissions, computes ranked
 * leaderboards + listings + stats.
 *
 * @param classified - All classified messages from the channel.
 * @param options    - `{ all: true }` returns every entry; `{ all: false }` caps at top 10.
 */
export function tally(classified: readonly ClassifiedSubmission[], options: { readonly all: boolean }): HearMeOutResult {
	const rankable = classified.filter((s) => RANKABLE.has(s.classification));
	const limit = options.all ? undefined : 10;

	// `submitter` is non-null for all rankable entries (the classifier guarantees it
	// for canonical / non-default / formatting-error), so the `?? []` fallback is
	// purely defensive and will never fire in practice.
	const submitterExtractor = (s: ClassifiedSubmission): readonly UserEntity[] => (s.submitter ? [s.submitter] : []);
	const messengerExtractor = (s: ClassifiedSubmission): readonly UserEntity[] => [s.messenger];

	return {
		ranked: {
			topVotedSubmissions: rankSubmissions(rankable, limit),
			mostSubmissions: tallyUsers(rankable, submitterExtractor, limit),
			topVotedSubmitters: tallyVotes(rankable, submitterExtractor, limit),
			// Messenger activity covers ALL classified messages (including missing-attribution
			// ones) since "the messenger still posted it" is the relevant fact for that stat.
			// Always returned in full - typically only 5-6 messengers per event, so capping
			// would hide the small team's workload split rather than condense a long list.
			messengerActivity: tallyUsers(classified, messengerExtractor, undefined),
		},
		listings: buildListings(classified),
		stats: computeStats(classified),
	};
}
