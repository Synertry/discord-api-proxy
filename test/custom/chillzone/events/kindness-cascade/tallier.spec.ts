/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/tallier.spec
 * Tests for the tallying/aggregation logic.
 *
 * Validates all five ranked categories (topVotedKindness, mostKindnessSent,
 * mostKindnessReceived, topVotedSubmitter, topVotedReceiver), the top-10
 * truncation behavior, all listing categories, sparse counts, and edge cases
 * like empty input and alphabetical tie-breaking.
 */

import { describe, it, expect } from 'vitest';
import { tally } from '../../../../../src/custom/chillzone/events/kindness-cascade/tallier';
import { classifyMessages } from '../../../../../src/custom/chillzone/events/kindness-cascade/classifier';
import type { ClassifiedMessage } from '../../../../../src/custom/chillzone/events/kindness-cascade/types';
import { MOCK_GUILD_ID, MOCK_CHANNEL_ID, USERS, FULL_CHANNEL_MESSAGES, buildMessageLink } from './fixtures';

/** Classifies the full fixture channel for use across all tally tests. */
function getClassified(): readonly ClassifiedMessage[] {
  return classifyMessages(FULL_CHANNEL_MESSAGES, MOCK_GUILD_ID, MOCK_CHANNEL_ID);
}

describe('tally', () => {
  describe('ranked categories', () => {
    it('should tally most messages sent by sender', () => {
      const result = tally(getClassified(), { all: true });
      const { mostKindnessSent } = result.ranked;

      // sender2 (bob): STANDARD_2, MULTI_MENTION, DIFFERENT_FORMAT = 3
      // sender1 (alice): STANDARD, STANDARD_HIGH_VOTES = 2
      // sender3 (charlie): REPLY, NICKNAME_MENTION = 2
      expect(mostKindnessSent[0]).toEqual({ userId: USERS.sender2.id, username: 'bob', count: 3 });
      expect(mostKindnessSent[1]).toEqual({ userId: USERS.sender1.id, username: 'alice', count: 2 });
      expect(mostKindnessSent[2]).toEqual({ userId: USERS.sender3.id, username: 'charlie', count: 2 });
    });

    it('should tally most messages received by recipient', () => {
      const result = tally(getClassified(), { all: true });
      const { mostKindnessReceived } = result.ranked;

      // recipient1 (diana): STANDARD, STANDARD_2, MULTI_MENTION, NICKNAME_MENTION, DIFFERENT_FORMAT = 5
      // recipient2 (eve): STANDARD_HIGH_VOTES, MULTI_MENTION = 2
      // sender1 (alice): REPLY (recipient of reply to STANDARD_MESSAGE) = 1
      expect(mostKindnessReceived[0]).toEqual({ userId: USERS.recipient1.id, username: 'diana', count: 5 });
      expect(mostKindnessReceived[1]).toEqual({ userId: USERS.recipient2.id, username: 'eve', count: 2 });
      expect(mostKindnessReceived[2]).toEqual({ userId: USERS.sender1.id, username: 'alice', count: 1 });
    });

    it('should rank most votes on a single message', () => {
      const result = tally(getClassified(), { all: true });
      const { topVotedKindness } = result.ranked;

      // STANDARD_HIGH_VOTES has 10 votes (highest)
      expect(topVotedKindness[0].reactionCount).toBe(10);
      expect(topVotedKindness[0].messageLink).toBe(buildMessageLink(MOCK_GUILD_ID, MOCK_CHANNEL_ID, '1000000000000000004'));

      // REPLY_MESSAGE has 5 votes (second)
      expect(topVotedKindness[1].reactionCount).toBe(5);
    });

    it('should tally most total votes sent by one sender', () => {
      const result = tally(getClassified(), { all: true });
      const { topVotedSubmitter } = result.ranked;

      // sender1 (alice): 3 + 10 = 13 (STANDARD + HIGH_VOTES)
      // sender2 (bob): 3 + 4 + 2 = 9 (STANDARD_2 + MULTI_MENTION + DIFFERENT_FORMAT)
      // sender3 (charlie): 5 + 1 = 6 (REPLY + NICKNAME_MENTION)
      expect(topVotedSubmitter[0]).toEqual({ userId: USERS.sender1.id, username: 'alice', count: 13 });
      expect(topVotedSubmitter[1]).toEqual({ userId: USERS.sender2.id, username: 'bob', count: 9 });
      expect(topVotedSubmitter[2]).toEqual({ userId: USERS.sender3.id, username: 'charlie', count: 6 });
    });

    it('should tally most total votes received by one receiver', () => {
      const result = tally(getClassified(), { all: true });
      const { topVotedReceiver } = result.ranked;

      // recipient2 (eve): 10 + 4 = 14 (STANDARD_HIGH_VOTES, MULTI_MENTION)
      // recipient1 (diana): 3 + 3 + 4 + 1 + 2 = 13 (STANDARD, STANDARD_2, MULTI_MENTION, NICKNAME, DIFFERENT_FORMAT)
      // sender1 (alice): 5 (REPLY — alice is the author of the referenced message)
      expect(topVotedReceiver[0]).toEqual({ userId: USERS.recipient2.id, username: 'eve', count: 14 });
      expect(topVotedReceiver[1]).toEqual({ userId: USERS.recipient1.id, username: 'diana', count: 13 });
      expect(topVotedReceiver[2]).toEqual({ userId: USERS.sender1.id, username: 'alice', count: 5 });
    });
  });

  describe('top 10 truncation', () => {
    it('should return top 10 by default', () => {
      const result = tally(getClassified(), { all: false });
      // With only 3 senders, all fit in top 10
      expect(result.ranked.mostKindnessSent.length).toBeLessThanOrEqual(10);
    });

    it('should return all entries when all=true', () => {
      const result = tally(getClassified(), { all: true });
      expect(result.ranked.mostKindnessSent).toHaveLength(3);
    });
  });

  describe('listing categories', () => {
    it('should list reply submissions', () => {
      const result = tally(getClassified(), { all: true });
      expect(result.listings.replySubmissions).toHaveLength(1);
      expect(result.listings.replySubmissions[0].messageLink).toBe(buildMessageLink(MOCK_GUILD_ID, MOCK_CHANNEL_ID, '1000000000000000005'));
    });

    it('should list multi-mention submissions', () => {
      const result = tally(getClassified(), { all: true });
      expect(result.listings.multiMentionSubmissions).toHaveLength(1);
      expect(result.listings.multiMentionSubmissions[0].recipients).toHaveLength(2);
    });

    it('should list messages with missing votes', () => {
      const result = tally(getClassified(), { all: true });
      expect(result.listings.missingVotes).toHaveLength(2);
    });

    it('should list different-format submissions', () => {
      const result = tally(getClassified(), { all: true });
      expect(result.listings.differentFormatSubmissions).toHaveLength(1);
      expect(result.listings.differentFormatSubmissions[0].messageLink).toBe(
        buildMessageLink(MOCK_GUILD_ID, MOCK_CHANNEL_ID, '1000000000000000012'),
      );
    });

    it('should list invalid submissions', () => {
      const result = tally(getClassified(), { all: true });
      expect(result.listings.invalidSubmissions).toHaveLength(2);
    });

    it('should return sparse counts with only non-zero categories', () => {
      const result = tally(getClassified(), { all: true });
      expect(result.listings.counts).toEqual({
        replySubmissions: 1,
        multiMentionSubmissions: 1,
        differentFormatSubmissions: 1,
        missingVotes: 2,
        invalidSubmissions: 2,
      });
    });

    it('should omit zero-count categories from counts', () => {
      const classified: readonly ClassifiedMessage[] = [
        {
          messageId: '1',
          classification: 'standard',
          sender: { userId: '1', username: 'test' },
          recipients: [{ userId: '2', username: 'other' }],
          reactionCount: 1,
          messageLink: 'https://discord.com/channels/g/c/1',
        },
      ];
      const result = tally(classified, { all: true });
      expect(result.listings.counts).toEqual({});
    });
  });

  describe('stats', () => {
    it('should compute aggregate stats from valid messages', () => {
      const result = tally(getClassified(), { all: true });
      const { stats } = result;

      // Valid messages: STANDARD, STANDARD_2, STANDARD_HIGH_VOTES, REPLY, MULTI_MENTION, NICKNAME_MENTION, DIFFERENT_FORMAT = 7
      expect(stats.totalValidMessages).toBe(7);

      // Senders: alice (sender1), bob (sender2), charlie (sender3) = 3
      expect(stats.totalSenders).toBe(3);

      // Receivers: diana (recipient1), eve (recipient2), alice (sender1 via reply) = 3
      expect(stats.totalReceivers).toBe(3);

      // Participants: alice, bob, charlie, diana, eve = 5 unique
      expect(stats.totalParticipants).toBe(5);

      // Reactions: 3 + 3 + 10 + 5 + 4 + 1 + 2 = 28
      expect(stats.totalReactions).toBe(28);
    });

    it('should return zero stats for empty input', () => {
      const result = tally([], { all: true });
      expect(result.stats).toEqual({
        totalValidMessages: 0,
        totalSenders: 0,
        totalReceivers: 0,
        totalParticipants: 0,
        totalReactions: 0,
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty classified messages', () => {
      const result = tally([], { all: true });
      expect(result.ranked.mostKindnessSent).toEqual([]);
      expect(result.ranked.mostKindnessReceived).toEqual([]);
      expect(result.ranked.topVotedKindness).toEqual([]);
      expect(result.ranked.topVotedSubmitter).toEqual([]);
      expect(result.ranked.topVotedReceiver).toEqual([]);
      expect(result.listings.replySubmissions).toEqual([]);
      expect(result.listings.multiMentionSubmissions).toEqual([]);
      expect(result.listings.differentFormatSubmissions).toEqual([]);
      expect(result.listings.missingVotes).toEqual([]);
      expect(result.listings.invalidSubmissions).toEqual([]);
      expect(result.listings.counts).toEqual({});
    });

    it('should sort ties alphabetically by username', () => {
      const classified: readonly ClassifiedMessage[] = [
        {
          messageId: '1',
          classification: 'standard',
          sender: { userId: '1', username: 'zara' },
          recipients: [{ userId: '10', username: 'recipient' }],
          reactionCount: 1,
          messageLink: 'https://discord.com/channels/g/c/1',
        },
        {
          messageId: '2',
          classification: 'standard',
          sender: { userId: '2', username: 'adam' },
          recipients: [{ userId: '10', username: 'recipient' }],
          reactionCount: 1,
          messageLink: 'https://discord.com/channels/g/c/2',
        },
      ];
      const result = tally(classified, { all: true });
      expect(result.ranked.mostKindnessSent[0].username).toBe('adam');
      expect(result.ranked.mostKindnessSent[1].username).toBe('zara');
    });
  });
});
