/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/schemas
 * Zod schemas for request validation and OpenAPI spec generation.
 *
 * These schemas serve double duty:
 * 1. Runtime validation of incoming query parameters
 * 2. Automatic OpenAPI documentation via `@hono/zod-openapi`
 */

import { z } from '@hono/zod-openapi';

/** Validates a Discord snowflake ID (17–20 digit numeric string). */
const snowflakeSchema = z.string().regex(/^\d{17,20}$/, 'Must be a valid Discord snowflake ID');

/**
 * Query parameters for the Kindness Cascade tallying endpoint.
 *
 * - `guildId` / `channelId` — Target Discord server and channel (required)
 * - `all` — When `'true'`, returns all entries instead of top 10
 * - `formattedMessage` — When `'true'`, returns Discord-formatted `text/plain` instead of JSON
 */
export const kindnessCascadeQuerySchema = z.object({
  guildId: snowflakeSchema,
  channelId: snowflakeSchema,
  all: z.enum(['true', 'false']).optional().default('false'),
  formattedMessage: z.enum(['true', 'false']).optional().default('false'),
});

/** Schema for a normalized user reference (userId + username). */
const userEntitySchema = z.object({
  userId: z.string(),
  username: z.string(),
});

/** Schema for an aggregated user count in a ranked category. */
const userTallySchema = z.object({
  userId: z.string(),
  username: z.string(),
  count: z.number(),
});

/** Schema for a kindness submission with its metadata. */
const submissionEntrySchema = z.object({
  messageLink: z.string(),
  sender: userEntitySchema,
  recipients: z.array(userEntitySchema),
  reactionCount: z.number(),
});

/** Full JSON response schema for the Kindness Cascade tallying endpoint. */
export const kindnessCascadeResponseSchema = z.object({
  ranked: z.object({
    topVotedKindness: z.array(submissionEntrySchema),
    mostKindnessSent: z.array(userTallySchema),
    mostKindnessReceived: z.array(userTallySchema),
    topVotedSubmitter: z.array(userTallySchema),
    topVotedReceiver: z.array(userTallySchema),
  }),
  listings: z.object({
    replySubmissions: z.array(submissionEntrySchema),
    multiMentionSubmissions: z.array(submissionEntrySchema),
    differentFormatSubmissions: z.array(submissionEntrySchema),
    missingVotes: z.array(submissionEntrySchema),
    invalidSubmissions: z.array(submissionEntrySchema),
    counts: z.record(z.string(), z.number()),
  }),
});

/** Error response schema used for 400 and 502 responses. */
export const errorResponseSchema = z.object({
  error: z.string(),
});
