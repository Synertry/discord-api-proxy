/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/handler
 * Hono route handlers for the Hear Me Out tallying endpoint.
 *
 * Supports two response modes on `GET /hear-me-out`:
 * - JSON (default): OpenAPI-typed response with the full tallying result.
 * - Text (`?formattedMessage=true`): Discord-formatted `text/plain` message
 *   suitable for direct paste into the event channel.
 *
 * The text handler is registered BEFORE the OpenAPI handler so it takes priority
 * when the query param is set; otherwise it falls through via `next()` to the
 * OpenAPI handler, which provides typed JSON with automatic schema validation.
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Bindings } from '../../../../types';
import type { DiscordContextVariables } from '../../../../middleware/discord-context';
import { hearMeOutQuerySchema, hearMeOutResponseSchema, errorResponseSchema } from './schemas';
import { fetchAllMessages, DiscordApiError } from './discord-client';
import { classifyMessages } from './classifier';
import { applyExceptions } from './exceptions';
import { tally } from './tallier';
import { formatDiscordMessage } from './formatter';
import type { HearMeOutResult } from './types';

type Env = { Bindings: Bindings; Variables: DiscordContextVariables };

/** OpenAPI route definition for the JSON response mode. */
const hearMeOutRoute = createRoute({
	method: 'get',
	path: '/hear-me-out',
	request: {
		query: hearMeOutQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: hearMeOutResponseSchema } },
			description: 'Hear Me Out tallying results',
		},
		400: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Invalid request parameters',
		},
		502: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Discord API error',
		},
	},
});

/**
 * Shared pipeline: fetch all messages -> classify -> tally.
 * Used by both the JSON and formatted-text response handlers.
 */
async function runPipeline(
	channelId: string,
	guildId: string,
	token: string,
	fetcher: typeof fetch,
	showAll: boolean,
): Promise<HearMeOutResult> {
	const messages = await fetchAllMessages(channelId, token, fetcher);
	const classified = classifyMessages(messages, guildId, channelId);
	// Apply manual submitter overrides for messages the classifier can't resolve
	// programmatically (typically plain-text "@username" references).
	const overridden = applyExceptions(classified);
	return tally(overridden, { all: showAll });
}

/**
 * Maps {@link DiscordApiError} status codes to user-facing error responses.
 * Returns 502 for all Discord errors with a descriptive (but non-leaking) message.
 */
function handleDiscordError(c: Context, err: DiscordApiError) {
	if (err.status === 403) {
		return c.json({ error: 'Cannot access channel' }, 502);
	}
	if (err.status === 404) {
		return c.json({ error: 'Channel not found' }, 502);
	}
	return c.json({ error: `Discord API error: ${err.status}` }, 502);
}

export const hearMeOutRoutes = new OpenAPIHono<Env>();

// Formatted-text handler - registered before OpenAPI route to take priority when matched.
// Falls through to the OpenAPI handler via next() when formattedMessage is not 'true'.
hearMeOutRoutes.get('/hear-me-out', async (c, next) => {
	if (c.req.query('formattedMessage') !== 'true') return next();

	const parsed = hearMeOutQuerySchema.safeParse({
		guildId: c.req.query('guildId'),
		channelId: c.req.query('channelId'),
		all: c.req.query('all'),
		formattedMessage: c.req.query('formattedMessage'),
	});

	if (!parsed.success) {
		return c.json({ error: 'Invalid request parameters' }, 400);
	}

	const { guildId, channelId, all } = parsed.data;
	const token = c.var.discordToken;
	const fetcher = c.var.proxyFetch ?? fetch;

	try {
		const showAll = all === 'true';
		const result = await runPipeline(channelId, guildId, token, fetcher, showAll);
		return c.text(formatDiscordMessage(result, undefined, { showAll }));
	} catch (err: unknown) {
		if (err instanceof DiscordApiError) {
			return handleDiscordError(c, err);
		}
		console.error('HEAR-ME-OUT TEXT ERROR:', { guildId, channelId, err });
		throw err;
	}
});

// OpenAPI handler - JSON response with automatic schema validation.
hearMeOutRoutes.openapi(hearMeOutRoute, async (c) => {
	const { guildId, channelId, all } = c.req.valid('query');
	const token = c.var.discordToken;
	const fetcher = c.var.proxyFetch ?? fetch;

	try {
		const result = await runPipeline(channelId, guildId, token, fetcher, all === 'true');
		return c.json(result, 200);
	} catch (err: unknown) {
		if (err instanceof DiscordApiError) {
			return handleDiscordError(c, err);
		}
		console.error('HEAR-ME-OUT JSON ERROR:', { guildId, channelId, err });
		throw err;
	}
});
