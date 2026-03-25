/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/classifier.spec
 * Tests for the message classification pipeline.
 *
 * Covers all classification paths: standard, reply, multi-mention,
 * different-format, missing-votes, invalid, and the host-intro skip.
 * Also verifies edge cases like duplicate mentions, nickname format,
 * deleted references, and multiple reaction types.
 */

import { describe, it, expect } from 'vitest';
import { classifyMessage, classifyMessages } from '../../../../../src/custom/chillzone/events/kindness-cascade/classifier';
import {
  MOCK_GUILD_ID,
  MOCK_CHANNEL_ID,
  USERS,
  STANDARD_MESSAGE,
  STANDARD_MESSAGE_2,
  STANDARD_MESSAGE_HIGH_VOTES,
  REPLY_MESSAGE,
  MULTI_MENTION_MESSAGE,
  MISSING_VOTES_MESSAGE,
  INVALID_MESSAGE,
  REPLY_DELETED_REF_MESSAGE,
  MISSING_VOTES_REPLY,
  NICKNAME_MENTION_MESSAGE,
  DIFFERENT_FORMAT_MESSAGE,
  HOST_INTRO_MESSAGE,
  FULL_CHANNEL_MESSAGES,
  buildMessageLink,
  createMockMessage,
} from './fixtures';

describe('classifyMessage', () => {
  /** Shorthand that binds mock guild/channel IDs for concise test calls. */
  const classify = (msg: Parameters<typeof classifyMessage>[0]) => classifyMessage(msg, MOCK_GUILD_ID, MOCK_CHANNEL_ID);

  it('should classify a standard message with a single mention and reactions', () => {
    const result = classify(STANDARD_MESSAGE);
    expect(result.classification).toBe('standard');
    expect(result.sender).toEqual({ userId: USERS.sender1.id, username: USERS.sender1.username });
    expect(result.recipients).toEqual([{ userId: USERS.recipient1.id, username: USERS.recipient1.username }]);
    expect(result.reactionCount).toBe(3);
    expect(result.messageLink).toBe(buildMessageLink(MOCK_GUILD_ID, MOCK_CHANNEL_ID, STANDARD_MESSAGE.id));
  });

  it('should classify a reply message (type 19) with reactions', () => {
    const result = classify(REPLY_MESSAGE);
    expect(result.classification).toBe('reply');
    expect(result.sender).toEqual({ userId: USERS.sender3.id, username: USERS.sender3.username });
    expect(result.recipients).toEqual([{ userId: USERS.sender1.id, username: USERS.sender1.username }]);
    expect(result.reactionCount).toBe(5);
  });

  it('should classify a multi-mention message with reactions', () => {
    const result = classify(MULTI_MENTION_MESSAGE);
    expect(result.classification).toBe('multi-mention');
    expect(result.recipients).toHaveLength(2);
    expect(result.recipients).toEqual([
      { userId: USERS.recipient1.id, username: USERS.recipient1.username },
      { userId: USERS.recipient2.id, username: USERS.recipient2.username },
    ]);
    expect(result.reactionCount).toBe(4);
  });

  it('should classify a message with valid structure but no reactions as missing-votes', () => {
    const result = classify(MISSING_VOTES_MESSAGE);
    expect(result.classification).toBe('missing-votes');
    expect(result.recipients).toEqual([{ userId: USERS.recipient3.id, username: USERS.recipient3.username }]);
    expect(result.reactionCount).toBe(0);
  });

  it('should classify a reply without reactions as missing-votes', () => {
    const result = classify(MISSING_VOTES_REPLY);
    expect(result.classification).toBe('missing-votes');
    expect(result.recipients).toEqual([{ userId: USERS.sender2.id, username: USERS.sender2.username }]);
  });

  it('should classify a message with no mentions and not a reply as invalid', () => {
    const result = classify(INVALID_MESSAGE);
    expect(result.classification).toBe('invalid');
    expect(result.recipients).toEqual([]);
  });

  it('should classify a reply with deleted referenced message as invalid', () => {
    const result = classify(REPLY_DELETED_REF_MESSAGE);
    expect(result.classification).toBe('invalid');
    expect(result.recipients).toEqual([]);
  });

  it('should handle nickname mention format <@!id>', () => {
    const result = classify(NICKNAME_MENTION_MESSAGE);
    expect(result.classification).toBe('standard');
    expect(result.recipients).toEqual([{ userId: USERS.recipient1.id, username: USERS.recipient1.username }]);
  });

  it('should sum multiple reaction emoji counts', () => {
    const result = classify(STANDARD_MESSAGE_2);
    expect(result.reactionCount).toBe(3); // 2 + 1
  });

  it('should classify a message with mention not at start as different-format', () => {
    const result = classify(DIFFERENT_FORMAT_MESSAGE);
    expect(result.classification).toBe('different-format');
    expect(result.recipients).toEqual([{ userId: USERS.recipient1.id, username: USERS.recipient1.username }]);
    expect(result.reactionCount).toBe(2);
  });

  it('should classify embedded mention without reactions as missing-votes', () => {
    const msg = createMockMessage({
      id: '9000000000000000001',
      content: 'hey look at <@200000000000000001> being awesome',
      mentions: [USERS.recipient1],
    });
    const result = classify(msg);
    expect(result.classification).toBe('missing-votes');
  });

  it('should deduplicate recipients when same user is mentioned multiple times', () => {
    const msg = createMockMessage({
      id: '9000000000000000002',
      content: '<@200000000000000001> <@200000000000000001> you rock!',
      mentions: [USERS.recipient1, USERS.recipient1],
      reactions: [{ count: 2, emoji: { id: null, name: '❤️' } }],
    });
    const result = classify(msg);
    expect(result.classification).toBe('standard');
    expect(result.recipients).toHaveLength(1);
  });
});

describe('classifyMessages', () => {
  it('should skip the chronologically first message (host intro)', () => {
    const results = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
    const skipped = results.filter((r) => r.classification === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].messageId).toBe(HOST_INTRO_MESSAGE.id);
  });

  it('should classify all messages in the channel', () => {
    const results = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
    expect(results).toHaveLength(FULL_CHANNEL_MESSAGES.length);
  });

  it('should produce correct classification counts for the full channel', () => {
    const results = classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
    const counts = results.reduce(
      (acc, r) => ({ ...acc, [r.classification]: (acc[r.classification] || 0) + 1 }),
      {} as Record<string, number>,
    );
    expect(counts['skipped']).toBe(1);
    expect(counts['standard']).toBe(4); // STANDARD, STANDARD_2, STANDARD_HIGH_VOTES, NICKNAME_MENTION
    expect(counts['reply']).toBe(1);
    expect(counts['multi-mention']).toBe(1);
    expect(counts['different-format']).toBe(1); // DIFFERENT_FORMAT_MESSAGE
    expect(counts['missing-votes']).toBe(2); // MISSING_VOTES_MESSAGE, MISSING_VOTES_REPLY
    expect(counts['invalid']).toBe(2); // INVALID_MESSAGE, REPLY_DELETED_REF
  });

  it('should handle an empty messages array', () => {
    const results = classifyMessages([], MOCK_GUILD_ID, MOCK_CHANNEL_ID);
    expect(results).toEqual([]);
  });

  it('should handle a single message (the host intro)', () => {
    const results = classifyMessages([HOST_INTRO_MESSAGE], MOCK_GUILD_ID, MOCK_CHANNEL_ID);
    expect(results).toHaveLength(1);
    expect(results[0].classification).toBe('skipped');
  });
});
