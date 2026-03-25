/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/fixtures
 * Shared test fixtures for the Kindness Cascade test suite.
 *
 * Provides mock Discord messages covering every classification path:
 * standard, reply, multi-mention, different-format, missing-votes, invalid, and skipped.
 * All fixtures use deterministic snowflake IDs for reproducible assertions.
 */

import type { DiscordMessage, DiscordMessageAuthor } from '../../../../../src/custom/chillzone/events/kindness-cascade/types';

export const MOCK_GUILD_ID = '206904180185628673';
export const MOCK_CHANNEL_ID = '1234567890123456789';

/** Test users covering senders, recipients, and the event host. */
export const USERS = {
  host: { id: '100000000000000001', username: 'eventhost' } as const,
  sender1: { id: '100000000000000002', username: 'alice' } as const,
  sender2: { id: '100000000000000003', username: 'bob' } as const,
  sender3: { id: '100000000000000004', username: 'charlie' } as const,
  recipient1: { id: '200000000000000001', username: 'diana' } as const,
  recipient2: { id: '200000000000000002', username: 'eve' } as const,
  recipient3: { id: '200000000000000003', username: 'frank' } as const,
} satisfies Record<string, DiscordMessageAuthor>;

/**
 * Creates a mock Discord message with sensible defaults.
 * Only `id` is required; all other fields can be overridden.
 */
export function createMockMessage(overrides: Partial<DiscordMessage> & { id: string }): DiscordMessage {
  return {
    type: 0,
    content: '',
    author: USERS.sender1,
    mentions: [],
    ...overrides,
  };
}

/** Constructs a Discord message URL from guild, channel, and message IDs. */
export function buildMessageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// Host intro message (chronologically first, should be skipped)
export const HOST_INTRO_MESSAGE = createMockMessage({
  id: '1000000000000000001',
  content: 'Welcome to the Kindness Cascade event! Spread love and kindness!',
  author: USERS.host,
});

// Standard message: single mention at start, has reactions
export const STANDARD_MESSAGE = createMockMessage({
  id: '1000000000000000002',
  content: '<@200000000000000001> awww this is so sweet, thank you! You are so kind!',
  author: USERS.sender1,
  mentions: [USERS.recipient1],
  reactions: [{ count: 3, emoji: { id: null, name: '❤️' } }],
});

// Standard message from sender2 to recipient1
export const STANDARD_MESSAGE_2 = createMockMessage({
  id: '1000000000000000003',
  content: '<@200000000000000001> you are amazing and brightened my day!',
  author: USERS.sender2,
  mentions: [USERS.recipient1],
  reactions: [
    { count: 2, emoji: { id: null, name: '❤️' } },
    { count: 1, emoji: { id: null, name: '🥹' } },
  ],
});

// Standard message from sender1 to recipient2 (high votes)
export const STANDARD_MESSAGE_HIGH_VOTES = createMockMessage({
  id: '1000000000000000004',
  content: '<@200000000000000002> this message really touched my heart!',
  author: USERS.sender1,
  mentions: [USERS.recipient2],
  reactions: [{ count: 10, emoji: { id: null, name: '💗' } }],
});

// Reply message: type 19, reply to someone else's message
export const REPLY_MESSAGE = createMockMessage({
  id: '1000000000000000005',
  type: 19,
  content: 'aww thank you so much, this really means a lot!',
  author: USERS.sender3,
  mentions: [],
  message_reference: {
    message_id: STANDARD_MESSAGE.id,
    channel_id: MOCK_CHANNEL_ID,
    guild_id: MOCK_GUILD_ID,
  },
  referenced_message: STANDARD_MESSAGE,
  reactions: [{ count: 5, emoji: { id: null, name: '💕' } }],
});

// Multi-mention message: two mentions at start
export const MULTI_MENTION_MESSAGE = createMockMessage({
  id: '1000000000000000006',
  content: '<@200000000000000001> <@200000000000000002> you both are incredible!',
  author: USERS.sender2,
  mentions: [USERS.recipient1, USERS.recipient2],
  reactions: [{ count: 4, emoji: { id: null, name: '🤍' } }],
});

// Missing votes: valid structure but no reactions
export const MISSING_VOTES_MESSAGE = createMockMessage({
  id: '1000000000000000007',
  content: '<@200000000000000003> you are a wonderful person!',
  author: USERS.sender3,
  mentions: [USERS.recipient3],
});

// Invalid message: no mention at start, not a reply
export const INVALID_MESSAGE = createMockMessage({
  id: '1000000000000000008',
  content: 'this event is so wholesome lol',
  author: USERS.sender1,
});

// Reply with deleted referenced message
export const REPLY_DELETED_REF_MESSAGE = createMockMessage({
  id: '1000000000000000009',
  type: 19,
  content: 'thank you so much!',
  author: USERS.sender2,
  message_reference: {
    message_id: '9999999999999999999',
    channel_id: MOCK_CHANNEL_ID,
  },
  referenced_message: null,
  reactions: [{ count: 2, emoji: { id: null, name: '❤️' } }],
});

// Missing votes reply: type 19 but no reactions
export const MISSING_VOTES_REPLY = createMockMessage({
  id: '1000000000000000010',
  type: 19,
  content: 'this is so sweet!',
  author: USERS.sender1,
  message_reference: {
    message_id: STANDARD_MESSAGE_2.id,
    channel_id: MOCK_CHANNEL_ID,
  },
  referenced_message: STANDARD_MESSAGE_2,
});

// Mention with ! (nickname format)
export const NICKNAME_MENTION_MESSAGE = createMockMessage({
  id: '1000000000000000011',
  content: '<@!200000000000000001> you are the best!',
  author: USERS.sender3,
  mentions: [USERS.recipient1],
  reactions: [{ count: 1, emoji: { id: null, name: '👍' } }],
});

// Different format: mention not at start, has reactions
export const DIFFERENT_FORMAT_MESSAGE = createMockMessage({
  id: '1000000000000000012',
  content: 'I just wanted to say that <@200000000000000001> is such an amazing person!',
  author: USERS.sender2,
  mentions: [USERS.recipient1],
  reactions: [{ count: 2, emoji: { id: null, name: '💖' } }],
});

// Full channel messages in Discord's newest-first order
export const FULL_CHANNEL_MESSAGES: readonly DiscordMessage[] = [
  DIFFERENT_FORMAT_MESSAGE, // newest
  NICKNAME_MENTION_MESSAGE,
  MISSING_VOTES_REPLY,
  REPLY_DELETED_REF_MESSAGE,
  INVALID_MESSAGE,
  MISSING_VOTES_MESSAGE,
  MULTI_MENTION_MESSAGE,
  REPLY_MESSAGE,
  STANDARD_MESSAGE_HIGH_VOTES,
  STANDARD_MESSAGE_2,
  STANDARD_MESSAGE,
  HOST_INTRO_MESSAGE, // oldest (last in Discord's response)
];
