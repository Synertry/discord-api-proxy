/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/types
 * Domain and Discord API types for the Hear Me Out tallying pipeline.
 *
 * Key distinction from kindness-cascade: `msg.author` is the event team
 * messenger (one of 5 forwarders), NOT the submitter. The submitter ID is
 * extracted from the message content's "Submitted by <@id>" attribution line.
 *
 * Layers:
 * - Discord API types: subset of Discord's message structure used for fetching
 * - Domain types: classification + entity representations
 * - API response types: structures returned by the tallying endpoint
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

/**
 * Subset of the Discord Message object used by the classifier.
 * @see https://discord.com/developers/docs/resources/message#message-object
 */
export interface DiscordMessage {
	readonly id: string;
	/** Discord message type. Hear Me Out only sees type 0 (DEFAULT) in practice. */
	readonly type: number;
	readonly content: string;
	readonly author: DiscordMessageAuthor;
	/** Users explicitly mentioned via `<@id>` syntax in {@link content}. */
	readonly mentions: readonly DiscordMessageAuthor[];
	readonly reactions?: readonly DiscordReaction[];
	readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Classification outcome for a single Hear Me Out submission.
 *
 * | Value                 | Meaning                                                       |
 * |-----------------------|---------------------------------------------------------------|
 * | `canonical`           | Exact match of `-# Submitted by <@id>` on its own line        |
 * | `non-default`         | Parseable submitter ID, but stylistic deviation from canonical |
 * | `formatting-error`    | Parseable but contains a real mistake (extra `@`, multiple attributions) |
 * | `missing-attribution` | No extractable `<@id>` anywhere in the content                |
 */
export type SubmissionClassification = 'canonical' | 'non-default' | 'formatting-error' | 'missing-attribution';

/** Normalized user reference used throughout the domain layer. */
export interface UserEntity {
	readonly userId: string;
	readonly username: string;
}

/** A Discord message after classification, with messenger + submitter resolved. */
export interface ClassifiedSubmission {
	readonly messageId: string;
	readonly classification: SubmissionClassification;
	/** Author of the Discord message (event team messenger). NEVER the submitter. */
	readonly messenger: UserEntity;
	/** Extracted submitter (the person who DM'd their hear-me-out). Null for `missing-attribution`. */
	readonly submitter: UserEntity | null;
	/** Sum of reaction counts across all emoji types on the message. */
	readonly reactionCount: number;
	/** Convenience flag: true iff `reactionCount > 0`. */
	readonly hasVotes: boolean;
	/** Full Discord message URL: `https://discord.com/channels/{guild}/{channel}/{message}`. */
	readonly messageLink: string;
	/**
	 * Human-readable explanation of WHY the message deviated from canonical, if at all.
	 * Null for `canonical` and `missing-attribution` (the latter has no detectable deviation
	 * to describe - the issue is the absence of an attribution).
	 */
	readonly deviationReason: string | null;
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

/**
 * A submission with metadata. Mirrors {@link ClassifiedSubmission} but with mutable
 * field types to match what Zod schemas produce.
 */
export interface SubmissionEntry {
	messageId: string;
	messageLink: string;
	submitter: UserEntity | null;
	messenger: UserEntity;
	reactionCount: number;
	classification: SubmissionClassification;
	deviationReason: string | null;
}

/**
 * Top-N ranked leaderboards.
 * Default limit is 10; set `all=true` to return every entry.
 */
export interface RankedCategories {
	/** Submissions ranked by individual reaction count (highest first; top 3 = prize winners). */
	topVotedSubmissions: SubmissionEntry[];
	/** Submitters ranked by number of valid submissions they made (bonus prize). */
	mostSubmissions: UserTally[];
	/** Submitters ranked by total reaction votes across all their submissions (analytical). */
	topVotedSubmitters: UserTally[];
	/** Messengers (event team) ranked by post count (analytical, NOT a prize criterion). */
	messengerActivity: UserTally[];
}

/**
 * Categorized submission listings for host review.
 * Each array contains full {@link SubmissionEntry} objects; `counts` provides a sparse
 * map of non-zero category sizes for quick summary.
 */
export interface ListingCategories {
	/** Submissions with stylistic deviations (still counted toward rankings). */
	nonDefault: SubmissionEntry[];
	/** Submissions with real mistakes (still counted toward rankings; loud listing). */
	formattingErrors: SubmissionEntry[];
	/** Messages with no extractable submitter (excluded from rankings; host must intervene). */
	missingAttribution: SubmissionEntry[];
	/** Submissions with zero reactions (orthogonal to other classes). */
	missingVotes: SubmissionEntry[];
	/** Sparse map of `categoryName -> count` for non-zero listing categories. */
	counts: Record<string, number>;
}

/** Aggregate statistics computed across all classified messages. */
export interface Stats {
	totalMessages: number;
	totalCanonical: number;
	totalNonDefault: number;
	totalFormattingErrors: number;
	totalMissingAttribution: number;
	totalMissingVotes: number;
	totalReactions: number;
	uniqueSubmitters: number;
	uniqueMessengers: number;
}

/** Complete result of the Hear Me Out tallying pipeline. */
export interface HearMeOutResult {
	ranked: RankedCategories;
	listings: ListingCategories;
	stats: Stats;
}
