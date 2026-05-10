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
import type { AuthVariables } from '../../../../middleware/auth';
import { BROWSER_USER_AGENT, type DiscordContextVariables } from '../../../../middleware/discord-context';
import { aggregateCounts, DEFAULT_EVENT_WINDOW } from './aggregator';
import { createBingoDiscordClient, DiscordApiError } from './discord-client';
import { deriveRoles } from './roles';
import { bingoCountsQuerySchema, bingoParticipantParamsSchema, countsResponseSchema, errorResponseSchema, rolesResponseSchema } from './schemas';
import type { EventWindow } from './types';

type Env = { Bindings: Bindings; Variables: DiscordContextVariables & AuthVariables };

/**
 * ChillZone is a guild where Synertry is a regular member only - the bot has no
 * access. Every bingo Discord call must run through the user token regardless
 * of what the path-based heuristic in `discordContextMiddleware` picked. The
 * `authSlot` set by `authMiddleware` still chooses between default and premium
 * user-token bindings; an unconfigured slot is reported as `null` so the caller
 * can short-circuit with a typed 503.
 */
function pickUserToken(c: Context<Env>): string | null {
	const slot = c.var.authSlot;
	const token = slot === 'premium' ? c.env.DISCORD_TOKEN_USER_PREMIUM : c.env.DISCORD_TOKEN_USER;
	if (!token) {
		console.error(`FATAL: bingo route reached but DISCORD_TOKEN_USER${slot === 'premium' ? '_PREMIUM' : ''} is not configured`);
		return null;
	}
	return token;
}

const countsRoute = createRoute({
	method: 'get',
	path: '/participant/{userId}/counts',
	request: { params: bingoParticipantParamsSchema, query: bingoCountsQuerySchema },
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
		503: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'User token not configured for the auth slot',
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
		503: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'User token not configured for the auth slot',
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
	const query = c.req.valid('query');
	const token = pickUserToken(c);
	if (!token) return c.json({ error: 'Service misconfigured' }, 503);

	const window: EventWindow =
		query.start && query.week1End && query.end
			? { start: query.start, week1End: query.week1End, end: query.end }
			: DEFAULT_EVENT_WINDOW;

	const client = createBingoDiscordClient({
		token,
		userAgent: BROWSER_USER_AGENT,
		fetcher: c.var.proxyFetch ?? fetch,
	});

	try {
		const result = await aggregateCounts(client, userId, window);
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
	const token = pickUserToken(c);
	if (!token) return c.json({ error: 'Service misconfigured' }, 503);

	const client = createBingoDiscordClient({
		token,
		userAgent: BROWSER_USER_AGENT,
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
