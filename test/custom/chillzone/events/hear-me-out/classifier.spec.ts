/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/classifier.spec
 * Tests for the Hear Me Out submission classification pipeline.
 *
 * Covers all four classification outcomes:
 * - canonical
 * - non-default (5 stylistic variations)
 * - formatting-error (extra @, multiple attributions)
 * - missing-attribution
 * Plus the orthogonal missing-votes flag.
 */

import { describe, it, expect } from 'vitest';
import { classifyMessage, classifyMessages } from '../../../../../src/custom/chillzone/events/hear-me-out/classifier';
import {
	MOCK_GUILD_ID,
	MOCK_CHANNEL_ID,
	USERS,
	CANONICAL_MESSAGE,
	CANONICAL_MESSAGE_2,
	NON_DEFAULT_NO_SUBTEXT,
	NON_DEFAULT_LOWERCASE,
	NON_DEFAULT_SUBMISSION_VERB,
	NON_DEFAULT_TRAILING_COLON,
	NON_DEFAULT_EXTRA_WORD,
	FORMATTING_ERROR_EXTRA_AT,
	FORMATTING_ERROR_MULTI_ATTRIBUTION,
	SUBTEXT_MENTION_ONLY,
	PLAIN_TEXT_ATTRIBUTION,
	VERB_TYPO,
	INLINE_MENTION_NO_ATTRIBUTION,
	MISSING_ATTRIBUTION,
	MULTIPLE_INLINE_MENTIONS,
	MISSING_VOTES,
	FULL_CHANNEL_MESSAGES,
	buildMessageLink,
	createMockMessage,
} from './fixtures';

describe('classifyMessage', () => {
	const classify = (msg: Parameters<typeof classifyMessage>[0]) => classifyMessage(msg, MOCK_GUILD_ID, MOCK_CHANNEL_ID);

	describe('canonical', () => {
		it('classifies the canonical `-# Submitted by <@id>` form', () => {
			const result = classify(CANONICAL_MESSAGE);
			expect(result.classification).toBe('canonical');
			expect(result.deviationReason).toBeNull();
		});

		it('uses message author as messenger, mention as submitter', () => {
			const result = classify(CANONICAL_MESSAGE);
			expect(result.messenger).toEqual({ userId: USERS.messenger1.id, username: USERS.messenger1.username });
			expect(result.submitter).toEqual({ userId: USERS.submitter1.id, username: USERS.submitter1.username });
		});

		it('sums reaction counts across emoji types', () => {
			const result = classify(CANONICAL_MESSAGE_2);
			expect(result.reactionCount).toBe(8);
			expect(result.hasVotes).toBe(true);
		});

		it('builds the message link from guild + channel + message ids', () => {
			const result = classify(CANONICAL_MESSAGE);
			expect(result.messageLink).toBe(buildMessageLink(MOCK_GUILD_ID, MOCK_CHANNEL_ID, CANONICAL_MESSAGE.id));
		});
	});

	describe('non-default', () => {
		it('flags missing "-#" subtext prefix', () => {
			const result = classify(NON_DEFAULT_NO_SUBTEXT);
			expect(result.classification).toBe('non-default');
			expect(result.deviationReason).toContain('-#');
			expect(result.submitter?.userId).toBe(USERS.submitter3.id);
		});

		it('flags lowercase verb', () => {
			const result = classify(NON_DEFAULT_LOWERCASE);
			expect(result.classification).toBe('non-default');
			expect(result.deviationReason).toContain('lowercase');
		});

		it('flags "submission" instead of "submitted"', () => {
			const result = classify(NON_DEFAULT_SUBMISSION_VERB);
			expect(result.classification).toBe('non-default');
			expect(result.deviationReason).toContain('submission');
		});

		it('flags trailing colon after "by"', () => {
			const result = classify(NON_DEFAULT_TRAILING_COLON);
			expect(result.classification).toBe('non-default');
			expect(result.deviationReason).toContain('colon');
		});

		it('flags extra prefix word before mention', () => {
			const result = classify(NON_DEFAULT_EXTRA_WORD);
			expect(result.classification).toBe('non-default');
			expect(result.deviationReason).toContain('host');
		});

		it('still resolves the submitter for non-default messages', () => {
			const result = classify(NON_DEFAULT_LOWERCASE);
			expect(result.submitter).toEqual({ userId: USERS.submitter4.id, username: USERS.submitter4.username });
		});
	});

	describe('formatting-error', () => {
		it('flags extra "@" before mention', () => {
			const result = classify(FORMATTING_ERROR_EXTRA_AT);
			expect(result.classification).toBe('formatting-error');
			expect(result.deviationReason).toContain('@');
			expect(result.submitter?.userId).toBe(USERS.submitter1.id);
		});

		it('flags multiple attribution lines as formatting-error', () => {
			const result = classify(FORMATTING_ERROR_MULTI_ATTRIBUTION);
			expect(result.classification).toBe('formatting-error');
			expect(result.deviationReason).toContain('multiple');
			// Falls back to the first attribution's ID for display
			expect(result.submitter?.userId).toBe(USERS.submitter1.id);
		});
	});

	describe('stage-2 fallbacks', () => {
		it('recovers submitter from `-# <@id>` subtext line (no verb) - case 1', () => {
			const result = classify(SUBTEXT_MENTION_ONLY);
			expect(result.classification).toBe('non-default');
			expect(result.submitter?.userId).toBe(USERS.submitter3.id);
			expect(result.deviationReason).toContain('subtext');
		});

		it('flags plain-text @username as formatting-error with submitter null - case 2', () => {
			const result = classify(PLAIN_TEXT_ATTRIBUTION);
			expect(result.classification).toBe('formatting-error');
			expect(result.submitter).toBeNull();
			expect(result.deviationReason).toContain('plain-text');
		});

		it('tolerates "Submitte" verb typo as non-default - case 3', () => {
			const result = classify(VERB_TYPO);
			expect(result.classification).toBe('non-default');
			expect(result.submitter?.userId).toBe(USERS.submitter3.id);
			expect(result.deviationReason).toContain('typo');
			expect(result.deviationReason).toContain('Submitte');
		});

		it('credits sole inline mention when no attribution line exists - case 4', () => {
			const result = classify(INLINE_MENTION_NO_ATTRIBUTION);
			expect(result.classification).toBe('non-default');
			expect(result.submitter?.userId).toBe(USERS.submitter3.id);
			expect(result.deviationReason).toContain('inline mention');
		});

		it('keeps multiple inline mentions ambiguous as missing-attribution', () => {
			const result = classify(MULTIPLE_INLINE_MENTIONS);
			expect(result.classification).toBe('missing-attribution');
			expect(result.submitter).toBeNull();
		});
	});

	describe('missing-attribution', () => {
		it('classifies messages with no extractable submitter or mention', () => {
			const result = classify(MISSING_ATTRIBUTION);
			expect(result.classification).toBe('missing-attribution');
			expect(result.submitter).toBeNull();
			expect(result.deviationReason).toBeNull();
		});
	});

	describe('missing-votes flag', () => {
		it('marks hasVotes=false when reactions are absent', () => {
			const result = classify(MISSING_VOTES);
			expect(result.classification).toBe('canonical');
			expect(result.hasVotes).toBe(false);
			expect(result.reactionCount).toBe(0);
		});
	});

	describe('submitter resolution', () => {
		it('falls back to "unknown" username when ID is not in mentions array', () => {
			const msg = createMockMessage({
				id: '1500000000000000098',
				content: 'hear me out\n-# Submitted by <@400000000000000077>',
				mentions: [], // empty - the submitter ID won't resolve
				reactions: [{ count: 1, emoji: { id: null, name: '❤️' } }],
			});
			const result = classify(msg);
			expect(result.classification).toBe('canonical');
			expect(result.submitter).toEqual({ userId: '400000000000000077', username: 'unknown' });
		});

		it('handles legacy nickname mention format `<@!id>`', () => {
			const msg = createMockMessage({
				id: '1500000000000000097',
				content: 'hear me out\n-# Submitted by <@!400000000000000001>',
				mentions: [USERS.submitter1],
				reactions: [{ count: 1, emoji: { id: null, name: '❤️' } }],
			});
			const result = classify(msg);
			expect(result.classification).toBe('canonical');
			expect(result.submitter?.userId).toBe(USERS.submitter1.id);
		});
	});
});

describe('classifyMessages', () => {
	it('classifies every message in the input array', () => {
		const results = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
		expect(results).toHaveLength(FULL_CHANNEL_MESSAGES.length);
	});

	it('preserves input order', () => {
		const results = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
		for (let i = 0; i < FULL_CHANNEL_MESSAGES.length; i++) {
			expect(results[i].messageId).toBe(FULL_CHANNEL_MESSAGES[i].id);
		}
	});

	it('produces the expected classification distribution on the full fixture', () => {
		const results = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
		const counts = results.reduce<Record<string, number>>((acc, r) => {
			acc[r.classification] = (acc[r.classification] ?? 0) + 1;
			return acc;
		}, {});
		// 3 explicit canonical + 1 missing-votes (also canonical structure) = 4
		// 5 original non-default + SUBTEXT_MENTION_ONLY + VERB_TYPO + INLINE_MENTION_NO_ATTRIBUTION = 8
		// 2 original formatting-error + PLAIN_TEXT_ATTRIBUTION = 3
		// MISSING_ATTRIBUTION + MULTIPLE_INLINE_MENTIONS = 2
		expect(counts).toEqual({
			canonical: 4,
			'non-default': 8,
			'formatting-error': 3,
			'missing-attribution': 2,
		});
	});
});
