/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/formatter.spec
 * Tests for the Hear Me Out Discord message formatter.
 *
 * Covers the default vs `showAll` branching for both ranked sections (top 3 cap)
 * and listings (Non-Default Formatting gating, Canonical/Non-default stat lines),
 * the "messengerActivity is never capped" rule, listing truncation with
 * "and N more...", empty-section omission, and markdown escaping on both
 * usernames and `deviationReason` (regression coverage for the formatter escape).
 */

import { describe, it, expect } from 'vitest';
import { formatDiscordMessage } from '../../../../../src/custom/chillzone/events/hear-me-out/formatter';
import type { HearMeOutResult, SubmissionEntry, UserTally, SubmissionClassification } from '../../../../../src/custom/chillzone/events/hear-me-out/types';

/** Fixed Unix timestamp (seconds) for deterministic footer assertions. */
const FIXED_TIMESTAMP = 1771150020;

/** Creates a {@link HearMeOutResult} with empty defaults, allowing partial overrides. */
function makeResult(overrides?: {
	ranked?: Partial<HearMeOutResult['ranked']>;
	listings?: Partial<HearMeOutResult['listings']>;
	stats?: Partial<HearMeOutResult['stats']>;
}): HearMeOutResult {
	return {
		ranked: {
			topVotedSubmissions: [],
			mostSubmissions: [],
			topVotedSubmitters: [],
			messengerActivity: [],
			...overrides?.ranked,
		},
		listings: {
			nonDefault: [],
			formattingErrors: [],
			missingAttribution: [],
			missingVotes: [],
			counts: {},
			...overrides?.listings,
		},
		stats: {
			totalMessages: 0,
			totalCanonical: 0,
			totalNonDefault: 0,
			totalFormattingErrors: 0,
			totalMissingAttribution: 0,
			totalMissingVotes: 0,
			totalReactions: 0,
			uniqueSubmitters: 0,
			uniqueMessengers: 0,
			...overrides?.stats,
		},
	};
}

function makeSubmission(id: string, reactionCount: number, deviationReason: string | null = null, classification: SubmissionClassification = 'canonical'): SubmissionEntry {
	return {
		messageId: id,
		messageLink: `https://discord.com/channels/g/c/${id}`,
		submitter: { userId: '1', username: 'submitter' },
		messenger: { userId: '9', username: 'messenger' },
		reactionCount,
		classification,
		deviationReason,
	};
}

function makeUserTally(userId: string, username: string, count: number): UserTally {
	return { userId, username, count };
}

describe('formatDiscordMessage', () => {
	it('should include header and footer with timestamp', () => {
		const output = formatDiscordMessage(makeResult(), FIXED_TIMESTAMP);
		expect(output).toContain('**__Hear Me Out Tally__**');
		expect(output).toContain(`-# Updated as of <t:${FIXED_TIMESTAMP}>`);
	});

	it('should format top voted submissions as messageLink: reactionCount', () => {
		const result = makeResult({
			ranked: {
				topVotedSubmissions: [makeSubmission('100', 14), makeSubmission('101', 9), makeSubmission('102', 8)],
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('### Top Voted Submissions');
		expect(output).toContain('https://discord.com/channels/g/c/100: 14');
		expect(output).toContain('https://discord.com/channels/g/c/101: 9');
		expect(output).toContain('https://discord.com/channels/g/c/102: 8');
	});

	it('should format user tally sections as username (userId): count', () => {
		const result = makeResult({
			ranked: {
				mostSubmissions: [makeUserTally('1', 'alice', 5), makeUserTally('2', 'bob', 3)],
				topVotedSubmitters: [makeUserTally('1', 'alice', 42)],
				messengerActivity: [makeUserTally('9', 'doz', 30)],
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('### Most Submissions');
		expect(output).toContain('alice (1): 5');
		expect(output).toContain('### Top Voted Submitters');
		expect(output).toContain('alice (1): 42');
		expect(output).toContain('### Messenger Activity');
		expect(output).toContain('doz (9): 30');
	});

	it('should cap prize-tier ranks at top 3 by default', () => {
		const result = makeResult({
			ranked: {
				mostSubmissions: [
					makeUserTally('1', 'alice', 10),
					makeUserTally('2', 'bob', 8),
					makeUserTally('3', 'charlie', 6),
					makeUserTally('4', 'diana', 4),
					makeUserTally('5', 'eve', 2),
				],
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('alice (1): 10');
		expect(output).toContain('bob (2): 8');
		expect(output).toContain('charlie (3): 6');
		expect(output).not.toContain('diana (4): 4');
		expect(output).not.toContain('eve (5): 2');
	});

	it('should uncap prize-tier ranks when showAll is true', () => {
		const result = makeResult({
			ranked: {
				mostSubmissions: [
					makeUserTally('1', 'alice', 10),
					makeUserTally('2', 'bob', 8),
					makeUserTally('3', 'charlie', 6),
					makeUserTally('4', 'diana', 4),
					makeUserTally('5', 'eve', 2),
				],
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP, { showAll: true });
		expect(output).toContain('alice (1): 10');
		expect(output).toContain('diana (4): 4');
		expect(output).toContain('eve (5): 2');
	});

	it('should never cap messengerActivity regardless of showAll', () => {
		const messengers = Array.from({ length: 6 }, (_, i) => makeUserTally(String(i + 1), `m${i + 1}`, 6 - i));
		const result = makeResult({ ranked: { messengerActivity: messengers } });

		const defaultOutput = formatDiscordMessage(result, FIXED_TIMESTAMP);
		const allOutput = formatDiscordMessage(result, FIXED_TIMESTAMP, { showAll: true });
		for (const tally of messengers) {
			expect(defaultOutput).toContain(`${tally.username} (${tally.userId}): ${tally.count}`);
			expect(allOutput).toContain(`${tally.username} (${tally.userId}): ${tally.count}`);
		}
	});

	it('should show up to 5 listing entries with bullet points', () => {
		const entries = Array.from({ length: 5 }, (_, i) => makeSubmission(`${i + 1}`, 0, null, 'formatting-error'));
		const result = makeResult({ listings: { formattingErrors: entries, counts: { formattingErrors: 5 } } });
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('### Formatting Errors');
		expect(output).toContain('- https://discord.com/channels/g/c/1');
		expect(output).toContain('- https://discord.com/channels/g/c/5');
		expect(output).not.toContain('more...');
	});

	it('should truncate listings with more than 5 entries', () => {
		const entries = Array.from({ length: 12 }, (_, i) => makeSubmission(`${i + 1}`, 0, null, 'formatting-error'));
		const result = makeResult({ listings: { formattingErrors: entries, counts: { formattingErrors: 12 } } });
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('- https://discord.com/channels/g/c/5');
		expect(output).not.toContain('- https://discord.com/channels/g/c/6');
		expect(output).toContain('and 7 more...');
	});

	it('should uncap listing entries when showAll is true', () => {
		const entries = Array.from({ length: 12 }, (_, i) => makeSubmission(`${i + 1}`, 0, null, 'formatting-error'));
		const result = makeResult({ listings: { formattingErrors: entries, counts: { formattingErrors: 12 } } });
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP, { showAll: true });
		expect(output).toContain('- https://discord.com/channels/g/c/12');
		expect(output).not.toContain('more...');
	});

	it('should skip empty listing sections', () => {
		const result = makeResult({
			listings: {
				formattingErrors: [makeSubmission('1', 0, null, 'formatting-error')],
				counts: { formattingErrors: 1 },
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('### Formatting Errors');
		expect(output).not.toContain('### Missing Attribution');
		expect(output).not.toContain('### Missing Votes');
	});

	it('should hide Non-Default Formatting listing by default', () => {
		const entries = [makeSubmission('200', 3, 'lowercase verb', 'non-default')];
		const result = makeResult({ listings: { nonDefault: entries, counts: { nonDefault: 1 } } });
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).not.toContain('### Non-Default Formatting');
		expect(output).not.toContain('lowercase verb');
	});

	it('should show Non-Default Formatting listing when showAll is true', () => {
		const entries = [makeSubmission('200', 3, 'lowercase verb', 'non-default')];
		const result = makeResult({ listings: { nonDefault: entries, counts: { nonDefault: 1 } } });
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP, { showAll: true });
		expect(output).toContain('### Non-Default Formatting');
		expect(output).toContain('lowercase verb');
	});

	it('should hide Canonical and Non-default stat lines by default', () => {
		const result = makeResult({
			stats: {
				totalMessages: 50,
				totalCanonical: 20,
				totalNonDefault: 15,
				totalFormattingErrors: 5,
				totalMissingAttribution: 0,
				totalMissingVotes: 0,
				totalReactions: 137,
				uniqueSubmitters: 12,
				uniqueMessengers: 4,
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('Total messages: 50');
		expect(output).not.toContain('Canonical: 20');
		expect(output).not.toContain('Non-default formatting: 15');
		expect(output).toContain('Formatting errors: 5');
		expect(output).toContain('Total reactions: 137');
	});

	it('should show Canonical and Non-default stat lines when showAll is true', () => {
		const result = makeResult({
			stats: {
				totalMessages: 50,
				totalCanonical: 20,
				totalNonDefault: 15,
				totalFormattingErrors: 0,
				totalMissingAttribution: 0,
				totalMissingVotes: 0,
				totalReactions: 137,
				uniqueSubmitters: 12,
				uniqueMessengers: 4,
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP, { showAll: true });
		expect(output).toContain('Canonical: 20');
		expect(output).toContain('Non-default formatting: 15');
	});

	it('should escape markdown in usernames', () => {
		const result = makeResult({
			ranked: {
				mostSubmissions: [makeUserTally('1', '*hax*_user_', 5)],
			},
		});
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('\\*hax\\*\\_user\\_');
		expect(output).not.toContain('*hax*_user_ (1)');
	});

	it('should escape markdown in deviationReason', () => {
		const entries = [makeSubmission('300', 0, 'broken *bold* and `code`', 'formatting-error')];
		const result = makeResult({ listings: { formattingErrors: entries, counts: { formattingErrors: 1 } } });
		const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
		expect(output).toContain('broken \\*bold\\* and \\`code\\`');
		expect(output).not.toContain('broken *bold* and `code`');
	});

	it('should produce header + ranked sections + footer for empty result', () => {
		const output = formatDiscordMessage(makeResult(), FIXED_TIMESTAMP);
		expect(output).toContain('**__Hear Me Out Tally__**');
		expect(output).toContain('### Top Voted Submissions');
		expect(output).toContain(`-# Updated as of <t:${FIXED_TIMESTAMP}>`);
		expect(output).not.toContain('### Formatting Errors');
	});
});
