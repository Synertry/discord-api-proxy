/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/schemas
 * Zod / OpenAPI schemas for the ChillZone Bingo autotally endpoints.
 */

import { z } from '@hono/zod-openapi';

/** Discord snowflake (17-20 digit numeric string). */
const snowflakeSchema = z.string().regex(/^\d{17,20}$/, 'Must be a valid Discord snowflake ID');

/** Path parameters shared by both bingo participant endpoints. */
export const bingoParticipantParamsSchema = z.object({
	userId: snowflakeSchema,
});

const eventWindowSchema = z.object({
	start: z.string(),
	week1End: z.string(),
	end: z.string(),
});

const generalWeeklyCountsSchema = z.object({
	week1: z.number(),
	week2: z.number(),
});

const funChannelCountsSchema = z.object({
	total: z.number(),
	byChannel: z.record(z.string(), z.number()),
});

export const countsResponseSchema = z.object({
	userId: z.string(),
	window: eventWindowSchema,
	msgsWeek1: z.number(),
	msgsWeek2: z.number(),
	msgsTotal: z.number(),
	msgsTotalGuildAllTime: z.number(),
	generals: z.record(z.string(), generalWeeklyCountsSchema),
	counting: z.object({ total: z.number() }),
	supporters: z.object({ total: z.number() }),
	fun: funChannelCountsSchema,
});

const supremeFlagsSchema = z.object({
	I: z.boolean(),
	II: z.boolean(),
	III: z.boolean(),
	all: z.boolean(),
});

export const rolesResponseSchema = z.object({
	userId: z.string(),
	snapshotAt: z.string(),
	hasMillionaires: z.boolean(),
	supreme: supremeFlagsSchema,
});

/** Error response schema used for 400 / 502 / 503 responses. */
export const errorResponseSchema = z.object({
	error: z.string(),
});
