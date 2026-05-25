/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/formatter
 * Renders a {@link HearMeOutResult} into a Discord-formatted plain text message
 * suitable for direct paste into the event channel.
 *
 * Output uses Discord markdown: `**bold**`, `### heading`, `-# subtext`, and
 * `<t:unix>` dynamic timestamps. Usernames are escaped to prevent markdown
 * injection from user-controlled data.
 *
 * Ranked sections show top 3 (matches prize tiers). Listings show up to 5 entries
 * with `and N more...` truncation by default; `showAll` removes the cap.
 */

import type { HearMeOutResult, Stats, SubmissionEntry, UserTally } from './types';

/** Top-N entries shown in ranked sections (matches the prize tiers). */
const TOP_RANKED = 3;

/** Default maximum number of listing entries before truncation. */
const MAX_LISTING_SHOWN = 5;

/**
 * Escapes characters that have special meaning in Discord markdown.
 * Applied to user-controlled strings to prevent formatting corruption.
 */
function escapeDiscordMarkdown(s: string): string {
	return s.replace(/([*_`~\\|>])/g, '\\$1');
}

/** Formats ranked submissions as `{link}: {reactionCount}` lines. */
function formatSubmissionRanked(entries: readonly SubmissionEntry[]): string {
	if (entries.length === 0) return '_(none)_';
	return entries.map((e) => `${e.messageLink}: ${e.reactionCount}`).join('\n');
}

/** Formats ranked user tallies as `{username} ({userId}): {count}` lines. */
function formatUserTallyRanked(entries: readonly UserTally[]): string {
	if (entries.length === 0) return '_(none)_';
	return entries.map((e) => `${escapeDiscordMarkdown(e.username)} (${e.userId}): ${e.count}`).join('\n');
}

/**
 * Formats a listing section with bullet-pointed entries + truncation suffix.
 * Each entry shows `messageLink: deviationReason` (mirroring the ranked
 * sections' `link: count` shape). When no reason exists the colon is omitted.
 * Returns empty string when no entries exist (caller filters those out).
 */
function formatListingSection(title: string, entries: readonly SubmissionEntry[], showAll: boolean): string {
	if (entries.length === 0) return '';

	const lines = [`### ${title}`];
	const shown = showAll ? entries : entries.slice(0, MAX_LISTING_SHOWN);
	for (const entry of shown) {
		const suffix = entry.deviationReason ? `: ${escapeDiscordMarkdown(entry.deviationReason)}` : '';
		lines.push(`- ${entry.messageLink}${suffix}`);
	}
	if (!showAll && entries.length > MAX_LISTING_SHOWN) {
		lines.push(`and ${entries.length - MAX_LISTING_SHOWN} more...`);
	}
	return lines.join('\n');
}

/**
 * Formats the aggregate stats section. `showAll` controls whether the routine
 * Canonical / Non-default lines are surfaced - they're hidden in the default
 * view since they're informational rather than action-needed.
 */
function formatStats(stats: Stats, showAll: boolean): string {
	const lines = ['### Stats', `Total messages: ${stats.totalMessages}`];
	if (showAll) {
		lines.push(`Canonical: ${stats.totalCanonical}`);
		if (stats.totalNonDefault > 0) lines.push(`Non-default formatting: ${stats.totalNonDefault}`);
	}
	if (stats.totalFormattingErrors > 0) lines.push(`Formatting errors: ${stats.totalFormattingErrors}`);
	if (stats.totalMissingAttribution > 0) lines.push(`Missing attribution: ${stats.totalMissingAttribution}`);
	if (stats.totalMissingVotes > 0) lines.push(`Missing votes: ${stats.totalMissingVotes}`);
	lines.push(`Unique submitters: ${stats.uniqueSubmitters}`);
	lines.push(`Unique messengers: ${stats.uniqueMessengers}`);
	lines.push(`Total reactions: ${stats.totalReactions}`);
	return lines.join('\n');
}

/**
 * Assembles the full Discord-formatted tally message.
 *
 * @param result    - The complete tallying result to format.
 * @param timestamp - Unix timestamp (seconds) for the footer; defaults to current time.
 * @param options   - `showAll`: when true, listing sections are not truncated.
 * @returns Plain text string ready to post as a Discord message.
 */
export function formatDiscordMessage(
	result: HearMeOutResult,
	timestamp: number = Math.floor(Date.now() / 1000),
	options?: { readonly showAll?: boolean },
): string {
	const showAll = options?.showAll ?? false;
	const sections: string[] = [];

	sections.push('**__Hear Me Out Tally__**');

	sections.push(formatStats(result.stats, showAll));

	// Ranked sections. Default view caps prize-tier categories at top 3 (matches
	// the 3 prize slots). `showAll` uncaps them so the host can verify ties around
	// the cutoff (e.g. multiple submissions tied at the 3rd-place reaction count).
	// Messenger Activity is always full - the team is small enough that capping
	// would hide useful workload info regardless of view.
	const sliceRanked = <T>(arr: readonly T[]) => (showAll ? arr : arr.slice(0, TOP_RANKED));
	const ranked = [
		`### Top Voted Submissions\n${formatSubmissionRanked(sliceRanked(result.ranked.topVotedSubmissions))}`,
		`### Most Submissions\n${formatUserTallyRanked(sliceRanked(result.ranked.mostSubmissions))}`,
		`### Top Voted Submitters\n${formatUserTallyRanked(sliceRanked(result.ranked.topVotedSubmitters))}`,
		`### Messenger Activity\n${formatUserTallyRanked(result.ranked.messengerActivity)}`,
	].join('\n\n');
	sections.push(ranked);

	// Listings - skip empty categories. The Non-Default Formatting section is hidden
	// in the default view (it's informational rather than action-needed) and only
	// surfaces when the caller explicitly asks for the full audit via showAll.
	const listings = [
		formatListingSection('Formatting Errors', result.listings.formattingErrors, showAll),
		formatListingSection('Missing Attribution', result.listings.missingAttribution, showAll),
		showAll ? formatListingSection('Non-Default Formatting', result.listings.nonDefault, showAll) : '',
		formatListingSection('Missing Votes', result.listings.missingVotes, showAll),
	].filter((s) => s.length > 0);

	if (listings.length > 0) {
		sections.push(listings.join('\n\n'));
	}

	sections.push(`-# Updated as of <t:${timestamp}>`);

	return sections.join('\n\n\n');
}
