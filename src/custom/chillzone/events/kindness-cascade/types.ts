/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/types
 * Domain and Discord API types for the Kindness Cascade tallying pipeline.
 *
 * Organized into three layers:
 * - **Discord API types** — Subset of Discord's message structure used for fetching
 * - **Domain types** — Internal classification and entity representations
 * - **API response types** — Structures returned by the tallying endpoint
 */

// ---------------------------------------------------------------------------
// Discord API types (subset used for tallying)
// ---------------------------------------------------------------------------

/** Minimal Discord user representation returned by the Messages API. */
export interface DiscordMessageAuthor {
  readonly id: string;
  readonly username: string;
}

/** A single emoji reaction on a Discord message. */
export interface DiscordReaction {
  readonly count: number;
  readonly emoji: {
    readonly id: string | null;
    readonly name: string;
  };
}

/** Back-reference from a reply to its parent message. */
export interface DiscordMessageReference {
  readonly message_id?: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
}

/**
 * Subset of the Discord Message object used by the classifier.
 * @see https://discord.com/developers/docs/resources/message#message-object
 */
export interface DiscordMessage {
  readonly id: string;
  /** Discord message type — 0 = DEFAULT, 19 = REPLY. */
  readonly type: number;
  readonly content: string;
  readonly author: DiscordMessageAuthor;
  /** Users explicitly mentioned via `<@id>` syntax in {@link content}. */
  readonly mentions: readonly DiscordMessageAuthor[];
  readonly reactions?: readonly DiscordReaction[];
  readonly message_reference?: DiscordMessageReference;
  /** The full referenced message, or `null` if it was deleted. */
  readonly referenced_message?: DiscordMessage | null;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Classification outcome for a single message.
 *
 * | Value              | Meaning                                                |
 * |--------------------|--------------------------------------------------------|
 * | `standard`         | Single leading mention with reactions                  |
 * | `reply`            | Discord reply (type 19) with reactions                 |
 * | `multi-mention`    | Two or more leading mentions with reactions            |
 * | `different-format` | Mention present but not at the start of the message    |
 * | `missing-votes`    | Valid structure but zero reactions                      |
 * | `invalid`          | No mentions and not a reply, or deleted reference      |
 * | `skipped`          | Host intro message (chronologically first in channel)  |
 */
export type MessageClassification = 'standard' | 'reply' | 'multi-mention' | 'different-format' | 'missing-votes' | 'invalid' | 'skipped';

/** Normalized user reference used throughout the domain layer. */
export interface UserEntity {
  readonly userId: string;
  readonly username: string;
}

/** A Discord message after classification, enriched with sender/recipient info. */
export interface ClassifiedMessage {
  readonly messageId: string;
  readonly classification: MessageClassification;
  readonly sender: UserEntity;
  readonly recipients: readonly UserEntity[];
  /** Total reaction count across all emoji types. */
  readonly reactionCount: number;
  /** Full Discord message URL: `https://discord.com/channels/{guild}/{channel}/{message}`. */
  readonly messageLink: string;
}

// ---------------------------------------------------------------------------
// API response types (mutable to match Zod schema output)
// ---------------------------------------------------------------------------

/** Aggregated count for a single user in a ranked category. */
export interface UserTally {
  userId: string;
  username: string;
  count: number;
}

/** A kindness submission with its metadata and reaction count. */
export interface SubmissionEntry {
  messageLink: string;
  sender: UserEntity;
  recipients: UserEntity[];
  reactionCount: number;
}

/**
 * Top-N ranked leaderboards, sorted descending by count.
 * Default limit is 10; set `all=true` to return every entry.
 */
export interface RankedCategories {
  /** Submissions ranked by individual reaction count (highest single message). */
  topVotedKindness: SubmissionEntry[];
  /** Users ranked by number of kindness messages sent. */
  mostKindnessSent: UserTally[];
  /** Users ranked by number of kindness messages received. */
  mostKindnessReceived: UserTally[];
  /** Users ranked by total reaction votes across all their sent messages. */
  topVotedSubmitter: UserTally[];
  /** Users ranked by total reaction votes across all messages they received. */
  topVotedReceiver: UserTally[];
}

/**
 * Categorized submission listings for edge-case message types.
 * Each array contains full {@link SubmissionEntry} objects; `counts` provides
 * a sparse map of non-zero category sizes for quick summary.
 */
export interface ListingCategories {
  /** Submissions that were Discord replies (type 19). */
  replySubmissions: SubmissionEntry[];
  /** Submissions mentioning two or more recipients. */
  multiMentionSubmissions: SubmissionEntry[];
  /** Submissions where the mention was embedded (not at the start). */
  differentFormatSubmissions: SubmissionEntry[];
  /** Structurally valid submissions that had zero reactions. */
  missingVotes: SubmissionEntry[];
  /** Messages that could not be classified as valid submissions. */
  invalidSubmissions: SubmissionEntry[];
  /** Sparse map of `categoryName → count` for non-zero listing categories. */
  counts: Record<string, number>;
}

/** Aggregate statistics computed from valid (ranked-eligible) messages. */
export interface Stats {
  totalValidMessages: number;
  totalSenders: number;
  totalReceivers: number;
  totalParticipants: number;
  totalReactions: number;
}

/** Complete result of the Kindness Cascade tallying pipeline. */
export interface KindnessCascadeResult {
  ranked: RankedCategories;
  listings: ListingCategories;
  stats: Stats;
}
