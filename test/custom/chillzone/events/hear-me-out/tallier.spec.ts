/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/tallier.spec
 * Tests for the Hear Me Out aggregation pipeline.
 *
 * Covers ranking shapes, listing categories, stat counts, the top-10 default
 * truncation, and the rankable vs missing-attribution exclusion.
 */

import { describe, it, expect } from 'vitest';
import { classifyMessages } from '../../../../../src/custom/chillzone/events/hear-me-out/classifier';
import { tally } from '../../../../../src/custom/chillzone/events/hear-me-out/tallier';
import { MOCK_GUILD_ID, MOCK_CHANNEL_ID, USERS, FULL_CHANNEL_MESSAGES } from './fixtures';

function tallyAll() {
	const classified = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
	return tally(classified, { all: true });
}

describe('tally', () => {
	describe('topVotedSubmissions', () => {
		it('ranks submissions by reaction count descending', () => {
			const result = tallyAll();
			const counts = result.ranked.topVotedSubmissions.map((s) => s.reactionCount);
			const sorted = [...counts].sort((a, b) => b - a);
			expect(counts).toEqual(sorted);
		});

		it('excludes submissions with zero reactions', () => {
			const result = tallyAll();
			expect(result.ranked.topVotedSubmissions.every((s) => s.reactionCount > 0)).toBe(true);
		});

		it('includes non-default and formatting-error submissions alongside canonical', () => {
			const result = tallyAll();
			const classifications = new Set(result.ranked.topVotedSubmissions.map((s) => s.classification));
			expect(classifications.has('canonical')).toBe(true);
			expect(classifications.has('non-default')).toBe(true);
			expect(classifications.has('formatting-error')).toBe(true);
		});

		it('excludes missing-attribution from rankings', () => {
			const result = tallyAll();
			expect(result.ranked.topVotedSubmissions.every((s) => s.classification !== 'missing-attribution')).toBe(true);
		});
	});

	describe('mostSubmissions', () => {
		it('counts submissions per submitter, descending by count', () => {
			const result = tallyAll();
			const counts = result.ranked.mostSubmissions.map((u) => u.count);
			const sorted = [...counts].sort((a, b) => b - a);
			expect(counts).toEqual(sorted);
		});

		it('attributes submissions to the submitter, not the messenger', () => {
			const result = tallyAll();
			const userIds = result.ranked.mostSubmissions.map((u) => u.userId);
			expect(userIds).not.toContain(USERS.messenger1.id);
			expect(userIds).not.toContain(USERS.messenger2.id);
			// At least one submitter must be ranked
			expect(userIds.some((id) => id.startsWith('40'))).toBe(true);
		});

		it('does NOT credit submitters of missing-attribution messages or null submitters', () => {
			const result = tallyAll();
			const totalSubmissions = result.ranked.mostSubmissions.reduce((sum, u) => sum + u.count, 0);
			// 17 fixture entries: 4 canonical + 8 non-default + 3 formatting-error = 15 rankable.
			// One formatting-error (PLAIN_TEXT_ATTRIBUTION) has a null submitter and is excluded
			// from mostSubmissions (the override from exceptions.ts is applied in the handler,
			// not here in the pure tallier path).
			expect(totalSubmissions).toBe(14);
		});
	});

	describe('topVotedSubmitters', () => {
		it('sums reaction counts per submitter', () => {
			const result = tallyAll();
			const counts = result.ranked.topVotedSubmitters.map((u) => u.count);
			const sorted = [...counts].sort((a, b) => b - a);
			expect(counts).toEqual(sorted);
		});
	});

	describe('messengerActivity', () => {
		it('counts posts per messenger across ALL classified messages', () => {
			const result = tallyAll();
			const totalPosts = result.ranked.messengerActivity.reduce((sum, u) => sum + u.count, 0);
			expect(totalPosts).toBe(FULL_CHANNEL_MESSAGES.length);
		});

		it('groups by message author', () => {
			const result = tallyAll();
			const userIds = result.ranked.messengerActivity.map((u) => u.userId);
			expect(userIds).toContain(USERS.messenger1.id);
		});
	});

	describe('listings', () => {
		it('groups non-default submissions', () => {
			const result = tallyAll();
			expect(result.listings.nonDefault.length).toBe(8);
			expect(result.listings.nonDefault.every((s) => s.classification === 'non-default')).toBe(true);
		});

		it('groups formatting errors', () => {
			const result = tallyAll();
			expect(result.listings.formattingErrors.length).toBe(3);
			expect(result.listings.formattingErrors.every((s) => s.classification === 'formatting-error')).toBe(true);
		});

		it('groups missing-attribution messages', () => {
			const result = tallyAll();
			expect(result.listings.missingAttribution.length).toBe(2);
		});

		it('lists missing-votes orthogonally to classification', () => {
			const result = tallyAll();
			expect(result.listings.missingVotes.length).toBe(1);
			expect(result.listings.missingVotes[0].classification).toBe('canonical');
		});

		it('emits a sparse counts map (only non-zero entries)', () => {
			const result = tallyAll();
			expect(result.listings.counts).toEqual({
				nonDefault: 8,
				formattingErrors: 3,
				missingAttribution: 2,
				missingVotes: 1,
			});
		});
	});

	describe('stats', () => {
		it('counts each classification', () => {
			const result = tallyAll();
			expect(result.stats.totalMessages).toBe(17);
			expect(result.stats.totalCanonical).toBe(4);
			expect(result.stats.totalNonDefault).toBe(8);
			expect(result.stats.totalFormattingErrors).toBe(3);
			expect(result.stats.totalMissingAttribution).toBe(2);
			expect(result.stats.totalMissingVotes).toBe(1);
		});

		it('counts unique submitters and messengers', () => {
			const result = tallyAll();
			expect(result.stats.uniqueSubmitters).toBeGreaterThan(0);
			expect(result.stats.uniqueMessengers).toBeGreaterThan(0);
		});

		it('sums total reactions across all messages', () => {
			const result = tallyAll();
			// Reactions across 17 fixtures: 5+8+15+4+3+2+5+7+2+1+2+2+1+3+1+1+0 = 62
			expect(result.stats.totalReactions).toBe(62);
		});
	});

	describe('truncation', () => {
		it('caps prize-tier ranks at 10 entries when all=false', () => {
			const classified = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
			const result = tally(classified, { all: false });
			expect(result.ranked.topVotedSubmissions.length).toBeLessThanOrEqual(10);
			expect(result.ranked.mostSubmissions.length).toBeLessThanOrEqual(10);
			expect(result.ranked.topVotedSubmitters.length).toBeLessThanOrEqual(10);
		});

		it('does NOT cap messengerActivity (always full)', () => {
			const classified = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
			const limited = tally(classified, { all: false });
			const all = tally(classified, { all: true });
			expect(limited.ranked.messengerActivity).toEqual(all.ranked.messengerActivity);
		});

		it('returns all entries when all=true', () => {
			const classified = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
			const all = tally(classified, { all: true });
			const limited = tally(classified, { all: false });
			expect(all.ranked.topVotedSubmissions.length).toBeGreaterThanOrEqual(limited.ranked.topVotedSubmissions.length);
		});
	});
});
