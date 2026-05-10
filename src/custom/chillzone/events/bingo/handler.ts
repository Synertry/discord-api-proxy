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
 * v2: bingo runs on the token pool. Per Discord call: acquire from the
 * `default` pool, fetch with the acquired secret, release. Single retry on
 * 429 with a fresh acquire if another eligible token exists.
 *
 * The pool client comes from `c.var.tokenPoolClient` (set by createApp's
 * test seam, or constructed lazily from c.env.TOKEN_POOL).
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Bindings } from '../../../../types';
import type { AuthVariables } from '../../../../middleware/auth';
import type { DiscordContextVariables } from '../../../../middleware/discord-context';
import { createTokenPoolClient, getPoolStub } from '../../../../rotator/client';
import type { RotatorVariables, TokenPoolClient } from '../../../../rotator/types';
import { aggregateCounts, DEFAULT_EVENT_WINDOW } from './aggregator';
import { createBingoDiscordClient, DiscordApiError } from './discord-client';
import { deriveRoles } from './roles';
import { bingoCountsQuerySchema, bingoParticipantParamsSchema, countsResponseSchema, errorResponseSchema, rolesResponseSchema } from './schemas';
import type { EventWindow } from './types';

type Env = { Bindings: Bindings; Variables: DiscordContextVariables & AuthVariables & RotatorVariables };

/**
 * Resolve the token-pool client for this request. Tests inject one via
 * `createApp(_, mockTokenPool)`. In production, lazily construct from the
 * TOKEN_POOL binding. Returns null if the binding is missing - the handler
 * surfaces that as a 503 misconfiguration.
 */
function resolvePoolClient(c: Context<Env>): TokenPoolClient | null {
	if (c.var.tokenPoolClient) return c.var.tokenPoolClient;
	if (!c.env.TOKEN_POOL) return null;
	const stub = getPoolStub(c.env);
	const client = createTokenPoolClient(stub);
	c.set('tokenPoolClient', client);
	return client;
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
		429: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Token pool fully cooling',
		},
		502: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Discord API error',
		},
		503: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Token pool unavailable / misconfigured',
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
		429: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Token pool fully cooling',
		},
		502: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Discord API error',
		},
		503: {
			content: { 'application/json': { schema: errorResponseSchema } },
			description: 'Token pool unavailable / misconfigured',
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
	if (err.status === 429) {
		// fetchWithRotator threw with status 429 because the pool was unavailable on acquire.
		return c.json({ error: 'Too Many Requests', retryAfter: null }, 429);
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
	const pool = resolvePoolClient(c);
	if (!pool) return c.json({ error: 'token pool unavailable' }, 503);

	const window: EventWindow =
		query.start && query.week1End && query.end
			? { start: query.start, week1End: query.week1End, end: query.end }
			: DEFAULT_EVENT_WINDOW;

	const client = createBingoDiscordClient({
		pool,
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
	const pool = resolvePoolClient(c);
	if (!pool) return c.json({ error: 'token pool unavailable' }, 503);

	const client = createBingoDiscordClient({
		pool,
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
