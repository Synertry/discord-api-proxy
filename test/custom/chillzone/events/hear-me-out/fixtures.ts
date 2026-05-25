/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/fixtures
 * Shared test fixtures for the Hear Me Out test suite.
 *
 * Covers every classification path observed in the live channel:
 * canonical, non-default variants (missing -#, lowercase, "submission", colon,
 * extra prefix word), formatting-error (extra @, multiple attributions), and
 * missing-attribution. All fixtures use deterministic snowflake IDs.
 */

import type { DiscordMessage, DiscordMessageAuthor } from '../../../../../src/custom/chillzone/events/hear-me-out/types';

export const MOCK_GUILD_ID = '219564597349318656';
export const MOCK_CHANNEL_ID = '1242256641701838868';

/** Test users: messengers (event team) + submitters. */
export const USERS = {
	messenger1: { id: '300000000000000001', username: 'xdozei' } as const,
	messenger2: { id: '300000000000000002', username: 'mcha' } as const,
	messenger3: { id: '300000000000000003', username: 'siren93' } as const,
	submitter1: { id: '400000000000000001', username: 'alice' } as const,
	submitter2: { id: '400000000000000002', username: 'bob' } as const,
	submitter3: { id: '400000000000000003', username: 'charlie' } as const,
	submitter4: { id: '400000000000000004', username: 'diana' } as const,
} satisfies Record<string, DiscordMessageAuthor>;

/** Creates a mock Discord message with sensible defaults. */
export function createMockMessage(overrides: Partial<DiscordMessage> & { id: string }): DiscordMessage {
	return {
		type: 0,
		content: '',
		author: USERS.messenger1,
		mentions: [],
		timestamp: '2026-05-15T20:00:00.000+00:00',
		...overrides,
	};
}

/** Constructs a Discord message URL. */
export function buildMessageLink(guildId: string, channelId: string, messageId: string): string {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// ---------------------------------------------------------------------------
// Canonical
// ---------------------------------------------------------------------------

export const CANONICAL_MESSAGE = createMockMessage({
	id: '1500000000000000001',
	content: 'Patrick Verona is an ABSOLUTE hear me out!\n-# Submitted by <@400000000000000001>',
	author: USERS.messenger1,
	mentions: [USERS.submitter1],
	reactions: [{ count: 5, emoji: { id: null, name: '❤️' } }],
});

export const CANONICAL_MESSAGE_2 = createMockMessage({
	id: '1500000000000000002',
	content: 'Hear her out on this one!\n-# Submitted by <@400000000000000002>',
	author: USERS.messenger1,
	mentions: [USERS.submitter2],
	reactions: [{ count: 8, emoji: { id: null, name: '🔥' } }],
});

export const CANONICAL_MESSAGE_HIGH_VOTES = createMockMessage({
	id: '1500000000000000003',
	content: 'Yes ma’am hear her out!\n-# Submitted by <@400000000000000001>',
	author: USERS.messenger2,
	mentions: [USERS.submitter1],
	reactions: [
		{ count: 12, emoji: { id: null, name: '❤️' } },
		{ count: 3, emoji: { id: null, name: '🔥' } },
	],
});

// ---------------------------------------------------------------------------
// Non-default variants
// ---------------------------------------------------------------------------

/** Missing `-#` subtext prefix. */
export const NON_DEFAULT_NO_SUBTEXT = createMockMessage({
	id: '1500000000000000010',
	content: 'I think we should hear this one out\nSubmitted by <@400000000000000003>',
	author: USERS.messenger1,
	mentions: [USERS.submitter3],
	reactions: [{ count: 4, emoji: { id: null, name: '❤️' } }],
});

/** Lowercase verb. */
export const NON_DEFAULT_LOWERCASE = createMockMessage({
	id: '1500000000000000011',
	content: 'Hear her out fr\n-# submitted by <@400000000000000004>',
	author: USERS.messenger2,
	mentions: [USERS.submitter4],
	reactions: [{ count: 3, emoji: { id: null, name: '❤️' } }],
});

/** "submission" instead of "submitted". */
export const NON_DEFAULT_SUBMISSION_VERB = createMockMessage({
	id: '1500000000000000012',
	content: 'Mean death eaters fr Hear her out\n-# submission by <@400000000000000001>',
	author: USERS.messenger2,
	mentions: [USERS.submitter1],
	reactions: [{ count: 2, emoji: { id: null, name: '❤️' } }],
});

/** Trailing colon after "by". */
export const NON_DEFAULT_TRAILING_COLON = createMockMessage({
	id: '1500000000000000013',
	content: 'I think I can agree with this sussy hear me out\n-# Submitted by: <@400000000000000002>',
	author: USERS.messenger3,
	mentions: [USERS.submitter2],
	reactions: [{ count: 5, emoji: { id: null, name: '❤️' } }],
});

/** Extra word "host" between "by" and the mention. */
export const NON_DEFAULT_EXTRA_WORD = createMockMessage({
	id: '1500000000000000014',
	content: 'Here comes host w another one\n-# submitted by host <@400000000000000003>',
	author: USERS.messenger2,
	mentions: [USERS.submitter3],
	reactions: [{ count: 7, emoji: { id: null, name: '❤️' } }],
});

// ---------------------------------------------------------------------------
// Formatting errors
// ---------------------------------------------------------------------------

/** Extra `@` before the mention. */
export const FORMATTING_ERROR_EXTRA_AT = createMockMessage({
	id: '1500000000000000020',
	content: 'I will def be hearing this one out\nsubmitted by @<@400000000000000001>',
	author: USERS.messenger3,
	mentions: [USERS.submitter1],
	reactions: [{ count: 2, emoji: { id: null, name: '❤️' } }],
});

/** Two attribution lines, ambiguous submitter. */
export const FORMATTING_ERROR_MULTI_ATTRIBUTION = createMockMessage({
	id: '1500000000000000021',
	content: 'A hear me out\n-# Submitted by <@400000000000000001>\n-# Submitted by <@400000000000000002>',
	author: USERS.messenger1,
	mentions: [USERS.submitter1, USERS.submitter2],
	reactions: [{ count: 1, emoji: { id: null, name: '❤️' } }],
});

// ---------------------------------------------------------------------------
// Stage-2 fallback fixtures
// ---------------------------------------------------------------------------

/**
 * Case 1 (mcha.__): `-# <@id>` subtext line, no verb. Recoverable via
 * fallback A -> non-default with submitter inferred.
 */
export const SUBTEXT_MENTION_ONLY = createMockMessage({
	id: '1500000000000000025',
	content: 'Hyphen be barking at this one\n-# <@400000000000000003>',
	author: USERS.messenger2,
	mentions: [USERS.submitter3],
	reactions: [{ count: 2, emoji: { id: null, name: '❤️' } }],
});

/**
 * Case 2 (mcha.__): `-# submitted by @doz` with plain-text reference, no `<@id>`.
 * Falls into fallback B -> formatting-error with submitter null. Exception
 * override (see exceptions.ts) will resolve the submitter post-classification.
 */
export const PLAIN_TEXT_ATTRIBUTION = createMockMessage({
	id: '1500000000000000026',
	content: 'Doz has my attention now\n-# submitted by @doz',
	author: USERS.messenger2,
	mentions: [],
	reactions: [{ count: 2, emoji: { id: null, name: '❤️' } }],
});

/**
 * Case 3 (.charms): "Submitte by" typo (missing 'd'). Lenient verb regex
 * catches it, deviation reason flags the typo. Classified as non-default.
 */
export const VERB_TYPO = createMockMessage({
	id: '1500000000000000027',
	content: 'The ampersand has curves tho\nHear her out\n-# Submitte by <@400000000000000003>',
	author: USERS.messenger3,
	mentions: [USERS.submitter3],
	reactions: [{ count: 1, emoji: { id: null, name: '❤️' } }],
});

/**
 * Case 4 (mariw4ri): inline mention in body, no attribution line at all.
 * Falls into fallback C -> non-default with the sole mention as submitter.
 */
export const INLINE_MENTION_NO_ATTRIBUTION = createMockMessage({
	id: '1500000000000000028',
	content: 'i think we can all agree with <@400000000000000003> hear me out...',
	author: USERS.messenger1,
	mentions: [USERS.submitter3],
	reactions: [{ count: 3, emoji: { id: null, name: '❤️' } }],
});

// ---------------------------------------------------------------------------
// Missing attribution
// ---------------------------------------------------------------------------

/** Plain text post with no `<@id>` reference at all. */
export const MISSING_ATTRIBUTION = createMockMessage({
	id: '1500000000000000030',
	content: 'Just dropping by to say hi to the event',
	author: USERS.messenger1,
	mentions: [],
	reactions: [{ count: 1, emoji: { id: null, name: '❤️' } }],
});

/**
 * Multiple inline mentions without an attribution line — ambiguous which is the
 * submitter, so we defer to manual review (missing-attribution).
 */
export const MULTIPLE_INLINE_MENTIONS = createMockMessage({
	id: '1500000000000000031',
	content: 'who would win? <@400000000000000001> vs <@400000000000000002>',
	author: USERS.messenger1,
	mentions: [USERS.submitter1, USERS.submitter2],
	reactions: [{ count: 1, emoji: { id: null, name: '❤️' } }],
});

// ---------------------------------------------------------------------------
// Missing votes (orthogonal flag)
// ---------------------------------------------------------------------------

/** Canonical format but zero reactions. */
export const MISSING_VOTES = createMockMessage({
	id: '1500000000000000040',
	content: 'A submission nobody reacted to\n-# Submitted by <@400000000000000004>',
	author: USERS.messenger1,
	mentions: [USERS.submitter4],
});

// ---------------------------------------------------------------------------
// Aggregated fixture (full channel sample)
// ---------------------------------------------------------------------------

/** All fixtures in one array, in chronological-ish order, for end-to-end tests. */
export const FULL_CHANNEL_MESSAGES: readonly DiscordMessage[] = [
	CANONICAL_MESSAGE,
	CANONICAL_MESSAGE_2,
	CANONICAL_MESSAGE_HIGH_VOTES,
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
];
