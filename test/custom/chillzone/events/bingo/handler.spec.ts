/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/handler.spec
 * Integration tests for the bingo HTTP handler. Mocks `fetch` at the proxy
 * boundary so the full route -> aggregator -> client pipeline is exercised
 * without hitting Discord.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { bingoRoutes } from '../../../../../src/custom/chillzone/events/bingo/handler';
import { __resetBingoClientCachesForTests } from '../../../../../src/custom/chillzone/events/bingo/discord-client';
import {
	CHANNELS_FUN,
	CHANNELS_GENERAL,
	CHANNEL_COUNTING,
	CHANNEL_SUPPORTERS,
	CHILLZONE_GUILD_ID,
	ROLE_MILLIONAIRES,
	ROLES_SUPREME,
} from '../../../../../src/custom/chillzone/events/bingo/constants';
import type { Bindings } from '../../../../../src/types';
import type { DiscordContextVariables } from '../../../../../src/middleware/discord-context';

const TEST_USER_ID = '100000000000000001';
const NEEDS_MEMBER_ID = '100000000000000002';

const MOCK_ENV: Bindings = {
	AUTH_KEY: 'secret-key',
	DISCORD_TOKEN_BOT: 'bot-token',
	DISCORD_TOKEN_USER: 'user-token',
};

/** Builds a JSON Response with the given body. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
		...init,
	});
}

/**
 * Creates a fetch mock that routes Discord API calls to canned responses.
 * - `messages/search` returns 1 unless `searchOverrides` says otherwise (matched by URL substring).
 * - `members/<userId>` returns the supplied member object.
 *
 * Fun-channels list is hardcoded in `constants.ts`, so no /guilds/{id}/channels mock is needed.
 */
function createFetchMock(opts: {
	memberRoles?: readonly string[];
	memberStatus?: number;
	searchOverrides?: ReadonlyArray<{ match: (url: string) => boolean; total: number }>;
}) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

		if (url.includes(`/guilds/${CHILLZONE_GUILD_ID}/members/`)) {
			if (opts.memberStatus && opts.memberStatus >= 400) {
				return new Response('{"message":"err"}', { status: opts.memberStatus });
			}
			const memberId = url.split('/members/')[1].split('?')[0];
			return jsonResponse({ user: { id: memberId }, roles: opts.memberRoles ?? [] });
		}

		if (url.includes(`/guilds/${CHILLZONE_GUILD_ID}/messages/search`)) {
			const override = opts.searchOverrides?.find((o) => o.match(url));
			return jsonResponse({ total_results: override?.total ?? 1 });
		}

		throw new Error(`Unexpected fetch URL in test: ${url}`);
	}) as unknown as typeof fetch;
}

/** Wraps the handler routes with a middleware that injects the Discord context. */
function createTestApp(mockFetch: typeof fetch) {
	const app = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();
	app.use('*', async (c, next) => {
		c.set('discordToken', c.env.DISCORD_TOKEN_USER);
		c.set('discordUserAgent', 'TestUA/1.0');
		c.set('proxyFetch', mockFetch);
		await next();
	});
	app.route('/', bingoRoutes);
	return app;
}

beforeEach(() => {
	__resetBingoClientCachesForTests();
});

describe('bingo /participant/:userId/counts', () => {
	// Counts hits ~26 mocked Discord calls; the in-worker fetchWithRetry pre-call
	// floor (250ms) means wall-clock ~6.5s. Default vitest timeout is 5s.
	it('returns the aggregated counts shape for a valid user', { timeout: 30_000 }, async () => {
		const mockFetch = createFetchMock({
			searchOverrides: [
				{ match: (u) => u.includes(`channel_id=${CHANNEL_COUNTING}`), total: 312 },
				{ match: (u) => u.includes(`channel_id=${CHANNEL_SUPPORTERS}`), total: 18 },
				{ match: (u) => u.includes(`channel_id=${CHANNELS_GENERAL[0]}`), total: 800 },
				{ match: (u) => !u.includes('channel_id=') && u.includes('min_id='), total: 5000 },
				{ match: (u) => !u.includes('channel_id=') && !u.includes('min_id='), total: 489210 },
			],
		});

		const res = await createTestApp(mockFetch).request(`http://localhost/participant/${TEST_USER_ID}/counts`, {}, MOCK_ENV);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.userId).toBe(TEST_USER_ID);
		expect(body.window).toBeDefined();
		expect(body.msgsWeek1).toBe(5000);
		expect(body.msgsWeek2).toBe(5000);
		expect(body.msgsTotal).toBe(10000);
		expect(body.msgsTotalGuildAllTime).toBe(489210);
		expect(body.counting.total).toBe(312);
		expect(body.supporters.total).toBe(18);
		// Counting matcher returns 312; every other fun channel falls through to 1.
		expect(body.fun.total).toBe(312 + (CHANNELS_FUN.length - 1));
		expect(body.fun.byChannel[CHANNEL_COUNTING]).toBe(312);
		expect(Object.keys(body.fun.byChannel)).toHaveLength(CHANNELS_FUN.length);
		expect(Object.keys(body.generals)).toHaveLength(CHANNELS_GENERAL.length);
	});

	it('rejects an invalid userId snowflake with 400', async () => {
		const mockFetch = createFetchMock({});
		const res = await createTestApp(mockFetch).request('http://localhost/participant/not-a-snowflake/counts', {}, MOCK_ENV);
		expect(res.status).toBe(400);
	});

	it('echoes overridden window when start/week1End/end query params are supplied', { timeout: 30_000 }, async () => {
		const mockFetch = createFetchMock({});
		const start = '2026-04-01T00:00:00.000Z';
		const week1End = '2026-04-08T00:00:00.000Z';
		const end = '2026-04-15T00:00:00.000Z';
		const url = `http://localhost/participant/${TEST_USER_ID}/counts?start=${encodeURIComponent(start)}&week1End=${encodeURIComponent(week1End)}&end=${encodeURIComponent(end)}`;
		const res = await createTestApp(mockFetch).request(url, {}, MOCK_ENV);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.window).toEqual({ start, week1End, end });
	});

	it('rejects partial window override (only start supplied) with 400', async () => {
		const mockFetch = createFetchMock({});
		const url = `http://localhost/participant/${TEST_USER_ID}/counts?start=${encodeURIComponent('2026-04-01T00:00:00.000Z')}`;
		const res = await createTestApp(mockFetch).request(url, {}, MOCK_ENV);
		expect(res.status).toBe(400);
	});

	it('rejects window override with start >= end with 400', async () => {
		const mockFetch = createFetchMock({});
		const start = '2026-05-15T00:00:00.000Z';
		const week1End = '2026-05-12T00:00:00.000Z';
		const end = '2026-05-10T00:00:00.000Z';
		const url = `http://localhost/participant/${TEST_USER_ID}/counts?start=${encodeURIComponent(start)}&week1End=${encodeURIComponent(week1End)}&end=${encodeURIComponent(end)}`;
		const res = await createTestApp(mockFetch).request(url, {}, MOCK_ENV);
		expect(res.status).toBe(400);
	});
});

describe('bingo /participant/:userId/roles', () => {
	it('reports hasMillionaires=true when the member holds the role', async () => {
		const mockFetch = createFetchMock({ memberRoles: [ROLE_MILLIONAIRES] });
		const res = await createTestApp(mockFetch).request(`http://localhost/participant/${NEEDS_MEMBER_ID}/roles`, {}, MOCK_ENV);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.userId).toBe(NEEDS_MEMBER_ID);
		expect(body.hasMillionaires).toBe(true);
		expect(body.supreme.all).toBe(false);
	});

	it('reports supreme.all=true when all three Supreme roles are present', async () => {
		const mockFetch = createFetchMock({ memberRoles: [...ROLES_SUPREME] });
		const res = await createTestApp(mockFetch).request(`http://localhost/participant/${NEEDS_MEMBER_ID}/roles`, {}, MOCK_ENV);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.supreme).toEqual({ I: true, II: true, III: true, all: true });
	});

	it('rejects an invalid userId snowflake with 400', async () => {
		const mockFetch = createFetchMock({});
		const res = await createTestApp(mockFetch).request('http://localhost/participant/abc/roles', {}, MOCK_ENV);
		expect(res.status).toBe(400);
	});

	it('returns 502 when Discord returns 404 for the member fetch', async () => {
		const mockFetch = createFetchMock({ memberStatus: 404 });
		const res = await createTestApp(mockFetch).request(`http://localhost/participant/${NEEDS_MEMBER_ID}/roles`, {}, MOCK_ENV);
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toContain('not found');
	});
});
