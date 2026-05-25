/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/schemas
 * Zod schemas for request validation and OpenAPI spec generation.
 */

import { z } from '@hono/zod-openapi';

/** Validates a Discord snowflake ID (17-20 digit numeric string). */
const snowflakeSchema = z.string().regex(/^\d{17,20}$/, 'Must be a valid Discord snowflake ID');

/**
 * Query parameters for the Hear Me Out tallying endpoint.
 *
 * - `guildId` / `channelId`: target Discord server + voting channel (required)
 * - `all`: when `'true'`, returns all entries instead of top 10
 * - `formattedMessage`: when `'true'`, returns Discord-formatted `text/plain` instead of JSON
 */
export const hearMeOutQuerySchema = z.object({
	guildId: snowflakeSchema,
	channelId: snowflakeSchema,
	all: z.enum(['true', 'false']).optional().default('false'),
	formattedMessage: z.enum(['true', 'false']).optional().default('false'),
});

const userEntitySchema = z.object({
	userId: z.string(),
	username: z.string(),
});

const userTallySchema = z.object({
	userId: z.string(),
	username: z.string(),
	count: z.number(),
});

const submissionClassificationSchema = z.enum(['canonical', 'non-default', 'formatting-error', 'missing-attribution']);

const submissionEntrySchema = z.object({
	messageId: z.string(),
	messageLink: z.string(),
	submitter: userEntitySchema.nullable(),
	messenger: userEntitySchema,
	reactionCount: z.number(),
	classification: submissionClassificationSchema,
	deviationReason: z.string().nullable(),
});

const statsSchema = z.object({
	totalMessages: z.number(),
	totalCanonical: z.number(),
	totalNonDefault: z.number(),
	totalFormattingErrors: z.number(),
	totalMissingAttribution: z.number(),
	totalMissingVotes: z.number(),
	totalReactions: z.number(),
	uniqueSubmitters: z.number(),
	uniqueMessengers: z.number(),
});

/** Full JSON response schema for the Hear Me Out tallying endpoint. */
export const hearMeOutResponseSchema = z.object({
	ranked: z.object({
		topVotedSubmissions: z.array(submissionEntrySchema),
		mostSubmissions: z.array(userTallySchema),
		topVotedSubmitters: z.array(userTallySchema),
		messengerActivity: z.array(userTallySchema),
	}),
	listings: z.object({
		nonDefault: z.array(submissionEntrySchema),
		formattingErrors: z.array(submissionEntrySchema),
		missingAttribution: z.array(submissionEntrySchema),
		missingVotes: z.array(submissionEntrySchema),
		counts: z.record(z.string(), z.number()),
	}),
	stats: statsSchema,
});

/** Error response schema used for 400 and 502 responses. */
export const errorResponseSchema = z.object({
	error: z.string(),
});
