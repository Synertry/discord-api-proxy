/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/tallier
 * Aggregates classified messages into ranked leaderboards and listing groups.
 *
 * Produces two result sections:
 * - **Ranked** — Sorted leaderboards (top-N or all) for votes and activity
 * - **Listings** — Categorized submission lists with sparse counts for edge-case types
 *
 * Only messages with a {@link VALID_CLASSIFICATIONS valid classification} contribute
 * to the ranked leaderboards. Listings include all non-skipped classifications.
 */

import type { ClassifiedMessage, UserEntity, UserTally, SubmissionEntry, KindnessCascadeResult } from './types';

/** Classifications that count toward ranked leaderboards. */
const VALID_CLASSIFICATIONS = new Set(['standard', 'reply', 'multi-mention', 'different-format']);

/** Converts an internal {@link ClassifiedMessage} to an API-facing {@link SubmissionEntry}. */
function toSubmissionEntry(msg: ClassifiedMessage): SubmissionEntry {
  return {
    messageLink: msg.messageLink,
    sender: msg.sender,
    recipients: [...msg.recipients],
    reactionCount: msg.reactionCount,
  };
}

/**
 * Counts how many times each user appears across messages, using a caller-supplied extractor.
 *
 * @param messages     - Messages to aggregate over.
 * @param extractUsers - Callback that pulls the relevant user(s) from each message
 *                       (e.g. sender for "sent", recipients for "received").
 * @param limit        - Optional top-N cap; `undefined` returns all.
 * @returns Sorted {@link UserTally} array (descending by count, then alphabetical).
 */
function tallyUsers(
  messages: readonly ClassifiedMessage[],
  extractUsers: (m: ClassifiedMessage) => readonly UserEntity[],
  limit?: number,
): UserTally[] {
  const map = new Map<string, { readonly username: string; readonly count: number }>();

  for (const msg of messages) {
    for (const user of extractUsers(msg)) {
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
 * Sums weighted vote counts (reaction counts) per user using a caller-supplied extractor.
 *
 * Unlike {@link tallyUsers} which counts *messages*, this sums the *reaction count*
 * associated with each user-message pair — useful for "total votes sent/received" rankings.
 *
 * @param messages       - Messages to aggregate over.
 * @param extractEntries - Callback that yields `{ user, votes }` pairs from each message.
 * @param limit          - Optional top-N cap.
 */
function tallyVotes(
  messages: readonly ClassifiedMessage[],
  extractEntries: (m: ClassifiedMessage) => readonly { readonly user: UserEntity; readonly votes: number }[],
  limit?: number,
): UserTally[] {
  const map = new Map<string, { readonly username: string; readonly count: number }>();

  for (const msg of messages) {
    for (const entry of extractEntries(msg)) {
      const existing = map.get(entry.user.userId);
      if (existing) {
        map.set(entry.user.userId, { username: existing.username, count: existing.count + entry.votes });
      } else {
        map.set(entry.user.userId, { username: entry.user.username, count: entry.votes });
      }
    }
  }

  return sortAndTruncate(
    [...map.entries()].map(([userId, { username, count }]) => ({ userId, username, count })),
    limit,
  );
}

/**
 * Sorts tallies descending by count, breaking ties alphabetically by username.
 * Optionally truncates to the given limit.
 */
function sortAndTruncate(tallies: UserTally[], limit?: number): UserTally[] {
  const sorted = [...tallies].sort((a, b) => b.count - a.count || a.username.localeCompare(b.username));
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

/**
 * Ranks submissions by their individual reaction count (descending).
 * Ties are broken by message link (lexicographic) for deterministic ordering.
 */
function rankSubmissions(messages: readonly ClassifiedMessage[], limit?: number): SubmissionEntry[] {
  const entries = messages.map(toSubmissionEntry);
  const sorted = [...entries].sort((a, b) => b.reactionCount - a.reactionCount || a.messageLink.localeCompare(b.messageLink));
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

/**
 * Main tallying entry point. Filters valid messages, computes all ranked leaderboards
 * and listing groups, and returns a complete {@link KindnessCascadeResult}.
 *
 * @param classified - All classified messages from the channel.
 * @param options    - `{ all: true }` returns every entry; `{ all: false }` caps at top 10.
 */
export function tally(classified: readonly ClassifiedMessage[], options: { readonly all: boolean }): KindnessCascadeResult {
  const validMessages = classified.filter((m) => VALID_CLASSIFICATIONS.has(m.classification));
  const limit = options.all ? undefined : 10;

  return {
    ranked: {
      topVotedKindness: rankSubmissions(validMessages, limit),
      mostKindnessSent: tallyUsers(validMessages, (m) => [m.sender], limit),
      mostKindnessReceived: tallyUsers(validMessages, (m) => m.recipients, limit),
      topVotedSubmitter: tallyVotes(validMessages, (m) => [{ user: m.sender, votes: m.reactionCount }], limit),
      topVotedReceiver: tallyVotes(validMessages, (m) => m.recipients.map((r) => ({ user: r, votes: m.reactionCount })), limit),
    },
    listings: buildListings(classified),
  };
}

/**
 * Groups classified messages by their classification into listing arrays.
 * Derives a sparse `counts` map from the array lengths (only non-zero entries).
 */
function buildListings(classified: readonly ClassifiedMessage[]) {
  const replySubmissions = classified.filter((m) => m.classification === 'reply').map(toSubmissionEntry);
  const multiMentionSubmissions = classified.filter((m) => m.classification === 'multi-mention').map(toSubmissionEntry);
  const differentFormatSubmissions = classified.filter((m) => m.classification === 'different-format').map(toSubmissionEntry);
  const missingVotes = classified.filter((m) => m.classification === 'missing-votes').map(toSubmissionEntry);
  const invalidSubmissions = classified.filter((m) => m.classification === 'invalid').map(toSubmissionEntry);

  const countEntries: ReadonlyArray<readonly [string, number]> = [
    ['replySubmissions', replySubmissions.length],
    ['multiMentionSubmissions', multiMentionSubmissions.length],
    ['differentFormatSubmissions', differentFormatSubmissions.length],
    ['missingVotes', missingVotes.length],
    ['invalidSubmissions', invalidSubmissions.length],
  ];

  // Only include non-zero counts for a sparse summary
  const counts: Record<string, number> = {};
  for (const [key, count] of countEntries) {
    if (count > 0) {
      counts[key] = count;
    }
  }

  return { replySubmissions, multiMentionSubmissions, differentFormatSubmissions, missingVotes, invalidSubmissions, counts };
}
