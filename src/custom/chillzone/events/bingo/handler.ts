/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/handler
 * Hono OpenAPI sub-app exposing two endpoints under
 * `/custom/chillzone/events/bingo/`:
 *
 * - `GET /participant/:userId/counts` - per-window message counts for sq 1, 2, 4, 7, 13, 18, 22, 25
 * - `GET /participant/:userId/roles`  - role-membership snapshot for sq 12, 19
 *
 * The handler relies on the upstream Sieve middleware to inject
 * `discordToken`, `discordUserAgent`, and `proxyFetch` via
 * {@link DiscordContextVariables}; it does not authenticate or
 * pick tokens itself.
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Bindings } from '../../../../types';
import type { DiscordContextVariables } from '../../../../middleware/discord-context';
import { aggregateCounts } from './aggregator';
import { createBingoDiscordClient, DiscordApiError } from './discord-client';
import { deriveRoles } from './roles';
import { bingoParticipantParamsSchema, countsResponseSchema, errorResponseSchema, rolesResponseSchema } from './schemas';

type Env = { Bindings: Bindings; Variables: DiscordContextVariables };

const countsRoute = createRoute({
	method: 'get',
	path: '/participant/{userId}/counts',
	request: { params: bingoParticipantParamsSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: countsResponseSchema } },
			description: 'Aggregate message counts for one bingo participant',
		},
		400: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Invalid userId path parameter',
		},
		502: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Discord API error',
		},
	},
});

const rolesRoute = createRoute({
	method: 'get',
	path: '/participant/{userId}/roles',
	request: { params: bingoParticipantParamsSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: rolesResponseSchema } },
			description: 'Role-membership snapshot for one bingo participant',
		},
		400: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Invalid userId path parameter',
		},
		502: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Discord API error',
		},
	},
});

/** Maps {@link DiscordApiError} status codes to JSON responses for the GAS consumer. */
function handleDiscordError(c: Context, err: DiscordApiError) {
	if (err.status === 403) {
		return c.json({ error: 'Cannot access ChillZone resource' }, 502);
	}
	if (err.status === 404) {
		return c.json({ error: 'ChillZone resource not found' }, 502);
	}
	if (err.status === 0) {
		return c.json({ error: 'Network error talking to Discord' }, 502);
	}
	return c.json({ error: `Discord API error: ${err.status}` }, 502);
}

export const bingoRoutes = new OpenAPIHono<Env>();

bingoRoutes.openapi(countsRoute, async (c) => {
	const { userId } = c.req.valid('param');
	const client = createBingoDiscordClient({
		token: c.var.discordToken,
		userAgent: c.var.discordUserAgent,
		fetcher: c.var.proxyFetch ?? fetch,
	});

	try {
		const result = await aggregateCounts(client, userId);
		return c.json(result, 200);
	} catch (err: unknown) {
		if (err instanceof DiscordApiError) {
			return handleDiscordError(c, err);
		}
		console.error('BINGO COUNTS ERROR:', err);
		throw err;
	}
});

bingoRoutes.openapi(rolesRoute, async (c) => {
	const { userId } = c.req.valid('param');
	const client = createBingoDiscordClient({
		token: c.var.discordToken,
		userAgent: c.var.discordUserAgent,
		fetcher: c.var.proxyFetch ?? fetch,
	});

	try {
		const member = await client.fetchGuildMember(userId);
		const result = deriveRoles(member, new Date());
		return c.json(result, 200);
	} catch (err: unknown) {
		if (err instanceof DiscordApiError) {
			return handleDiscordError(c, err);
		}
		console.error('BINGO ROLES ERROR:', err);
		throw err;
	}
});
