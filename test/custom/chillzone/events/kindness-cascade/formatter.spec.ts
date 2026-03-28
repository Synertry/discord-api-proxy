/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/formatter.spec
 * Tests for the Discord message formatter.
 *
 * Validates the formatted output structure: header/footer, ranked section formatting
 * (submission links vs user tallies), top-3 truncation, listing section rendering with
 * bullet points and "and N more..." truncation, empty section omission, and exclusion
 * of invalid submissions from the formatted output.
 */

import { describe, it, expect } from 'vitest';
import { formatDiscordMessage } from '../../../../../src/custom/chillzone/events/kindness-cascade/formatter';
import type { KindnessCascadeResult } from '../../../../../src/custom/chillzone/events/kindness-cascade/types';

/** Fixed Unix timestamp (seconds) for deterministic footer assertions. */
const FIXED_TIMESTAMP = 1771150020;

/** Creates a {@link KindnessCascadeResult} with empty defaults, allowing partial overrides. */
function makeResult(overrides?: Partial<KindnessCascadeResult>): KindnessCascadeResult {
  return {
    ranked: {
      topVotedKindness: [],
      mostKindnessSent: [],
      mostKindnessReceived: [],
      topVotedSubmitter: [],
      topVotedReceiver: [],
      ...overrides?.ranked,
    },
    listings: {
      replySubmissions: [],
      multiMentionSubmissions: [],
      differentFormatSubmissions: [],
      missingVotes: [],
      invalidSubmissions: [],
      counts: {},
      ...overrides?.listings,
    },
    stats: {
      totalValidMessages: 0,
      totalSenders: 0,
      totalReceivers: 0,
      totalParticipants: 0,
      totalReactions: 0,
      ...overrides?.stats,
    },
  };
}

/** Creates a minimal {@link SubmissionEntry} with the given message ID and reaction count. */
function makeSubmission(id: string, reactionCount: number) {
  return {
    messageLink: `https://discord.com/channels/g/c/${id}`,
    sender: { userId: '1', username: 'sender' },
    recipients: [{ userId: '2', username: 'recipient' }],
    reactionCount,
  };
}

/** Creates a minimal {@link UserTally} for use in ranked category assertions. */
function makeUserTally(userId: string, username: string, count: number) {
  return { userId, username, count };
}

describe('formatDiscordMessage', () => {
  it('should include header and footer with timestamp', () => {
    const output = formatDiscordMessage(makeResult(), FIXED_TIMESTAMP);
    expect(output).toContain('**__Kindness Cascade Tally__**');
    expect(output).toContain(`-# Updated as of <t:${FIXED_TIMESTAMP}>`);
  });

  it('should format top voted kindness as messageLink: reactionCount', () => {
    const result = makeResult({
      ranked: {
        topVotedKindness: [makeSubmission('100', 14), makeSubmission('101', 9), makeSubmission('102', 8)],
        mostKindnessSent: [],
        mostKindnessReceived: [],
        topVotedSubmitter: [],
        topVotedReceiver: [],
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).toContain('### Top Voted Kindness');
    expect(output).toContain('https://discord.com/channels/g/c/100: 14');
    expect(output).toContain('https://discord.com/channels/g/c/101: 9');
    expect(output).toContain('https://discord.com/channels/g/c/102: 8');
  });

  it('should format user tally sections as username (userId): count', () => {
    const result = makeResult({
      ranked: {
        topVotedKindness: [],
        mostKindnessSent: [makeUserTally('1', 'alice', 56), makeUserTally('2', 'bob', 40)],
        mostKindnessReceived: [makeUserTally('3', 'charlie', 22)],
        topVotedSubmitter: [makeUserTally('1', 'alice', 307)],
        topVotedReceiver: [makeUserTally('1', 'alice', 107)],
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).toContain('### Most Kindness Sent');
    expect(output).toContain('alice (1): 56');
    expect(output).toContain('bob (2): 40');
    expect(output).toContain('### Most Kindness Received');
    expect(output).toContain('charlie (3): 22');
    expect(output).toContain('### Top Voted Submitter');
    expect(output).toContain('alice (1): 307');
    expect(output).toContain('### Top Voted Receiver');
    expect(output).toContain('alice (1): 107');
  });

  it('should only show top 3 ranked entries even if more exist', () => {
    const result = makeResult({
      ranked: {
        topVotedKindness: [],
        mostKindnessSent: [
          makeUserTally('1', 'alice', 10),
          makeUserTally('2', 'bob', 8),
          makeUserTally('3', 'charlie', 6),
          makeUserTally('4', 'diana', 4),
          makeUserTally('5', 'eve', 2),
        ],
        mostKindnessReceived: [],
        topVotedSubmitter: [],
        topVotedReceiver: [],
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).toContain('alice (1): 10');
    expect(output).toContain('bob (2): 8');
    expect(output).toContain('charlie (3): 6');
    expect(output).not.toContain('diana (4): 4');
    expect(output).not.toContain('eve (5): 2');
  });

  it('should show up to 5 listing entries with bullet points', () => {
    const submissions = Array.from({ length: 5 }, (_, i) => makeSubmission(`${i + 1}`, 1));
    const result = makeResult({
      listings: {
        replySubmissions: submissions,
        multiMentionSubmissions: [],
        differentFormatSubmissions: [],
        missingVotes: [],
        invalidSubmissions: [],
        counts: { replySubmissions: 5 },
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).toContain('### Reply Submissions');
    expect(output).toContain('- https://discord.com/channels/g/c/1');
    expect(output).toContain('- https://discord.com/channels/g/c/5');
    expect(output).not.toContain('more...');
  });

  it('should truncate listings with more than 5 entries', () => {
    const submissions = Array.from({ length: 21 }, (_, i) => makeSubmission(`${i + 1}`, 1));
    const result = makeResult({
      listings: {
        replySubmissions: submissions,
        multiMentionSubmissions: [],
        differentFormatSubmissions: [],
        missingVotes: [],
        invalidSubmissions: [],
        counts: { replySubmissions: 21 },
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).toContain('### Reply Submissions');
    expect(output).toContain('- https://discord.com/channels/g/c/5');
    expect(output).not.toContain('- https://discord.com/channels/g/c/6');
    expect(output).toContain('and 16 more...');
  });

  it('should skip empty listing sections', () => {
    const result = makeResult({
      listings: {
        replySubmissions: [],
        multiMentionSubmissions: [makeSubmission('1', 2)],
        differentFormatSubmissions: [],
        missingVotes: [],
        invalidSubmissions: [],
        counts: { multiMentionSubmissions: 1 },
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).not.toContain('### Reply Submissions');
    expect(output).toContain('### Multi Mention Submissions');
    expect(output).not.toContain('### Different Format Submissions');
    expect(output).not.toContain('### Missing Votes');
  });

  it('should exclude invalid submissions from formatted output', () => {
    const result = makeResult({
      listings: {
        replySubmissions: [],
        multiMentionSubmissions: [],
        differentFormatSubmissions: [],
        missingVotes: [],
        invalidSubmissions: [makeSubmission('999', 0)],
        counts: { invalidSubmissions: 1 },
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).not.toContain('Invalid');
    expect(output).not.toContain('999');
  });

  it('should produce header + ranked sections + footer for empty result', () => {
    const output = formatDiscordMessage(makeResult(), FIXED_TIMESTAMP);
    expect(output).toContain('**__Kindness Cascade Tally__**');
    expect(output).toContain('### Top Voted Kindness');
    expect(output).toContain(`-# Updated as of <t:${FIXED_TIMESTAMP}>`);
    expect(output).not.toContain('### Reply Submissions');
  });

  it('should render different format submissions listing', () => {
    const result = makeResult({
      listings: {
        replySubmissions: [],
        multiMentionSubmissions: [],
        differentFormatSubmissions: [makeSubmission('500', 3), makeSubmission('501', 2)],
        missingVotes: [],
        invalidSubmissions: [],
        counts: { differentFormatSubmissions: 2 },
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).toContain('### Different Format Submissions');
    expect(output).toContain('- https://discord.com/channels/g/c/500');
    expect(output).toContain('- https://discord.com/channels/g/c/501');
  });

  it('should render stats section with all stat lines', () => {
    const result = makeResult({
      stats: {
        totalValidMessages: 42,
        totalSenders: 10,
        totalReceivers: 15,
        totalParticipants: 20,
        totalReactions: 137,
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    expect(output).toContain('### Stats');
    expect(output).toContain('Total submissions: 42');
    expect(output).toContain('Unique senders: 10');
    expect(output).toContain('Unique receivers: 15');
    expect(output).toContain('Unique participants: 20');
    expect(output).toContain('Total reactions: 137');
  });

  it('should place stats section between header and rankings', () => {
    const result = makeResult({
      stats: { totalValidMessages: 1, totalSenders: 1, totalReceivers: 1, totalParticipants: 1, totalReactions: 1 },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP);
    const headerIdx = output.indexOf('**__Kindness Cascade Tally__**');
    const statsIdx = output.indexOf('### Stats');
    const rankedIdx = output.indexOf('### Top Voted Kindness');
    expect(statsIdx).toBeGreaterThan(headerIdx);
    expect(rankedIdx).toBeGreaterThan(statsIdx);
  });

  it('should show all listing entries when showAll is true', () => {
    const submissions = Array.from({ length: 12 }, (_, i) => makeSubmission(`${i + 1}`, 1));
    const result = makeResult({
      listings: {
        replySubmissions: submissions,
        multiMentionSubmissions: [],
        differentFormatSubmissions: [],
        missingVotes: [],
        invalidSubmissions: [],
        counts: { replySubmissions: 12 },
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP, { showAll: true });
    expect(output).toContain('- https://discord.com/channels/g/c/12');
    expect(output).not.toContain('more...');
  });

  it('should truncate listings at 5 when showAll is false', () => {
    const submissions = Array.from({ length: 8 }, (_, i) => makeSubmission(`${i + 1}`, 1));
    const result = makeResult({
      listings: {
        replySubmissions: submissions,
        multiMentionSubmissions: [],
        differentFormatSubmissions: [],
        missingVotes: [],
        invalidSubmissions: [],
        counts: { replySubmissions: 8 },
      },
    });
    const output = formatDiscordMessage(result, FIXED_TIMESTAMP, { showAll: false });
    expect(output).toContain('- https://discord.com/channels/g/c/5');
    expect(output).not.toContain('- https://discord.com/channels/g/c/6');
    expect(output).toContain('and 3 more...');
  });
});
