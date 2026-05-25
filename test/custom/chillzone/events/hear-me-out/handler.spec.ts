/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/handler.spec
 * Integration tests for the Hear Me Out HTTP handler. Uses Hono's `.request()`
 * test helper with a mocked Discord API to exercise JSON + formatted-text modes,
 * input validation, error paths, and the top-10 default cap.
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { hearMeOutRoutes } from '../../../../../src/custom/chillzone/events/hear-me-out/handler';
import type { Bindings } from '../../../../../src/types';
import type { DiscordContextVariables } from '../../../../../src/middleware/discord-context';
import { MOCK_GUILD_ID, MOCK_CHANNEL_ID, FULL_CHANNEL_MESSAGES } from './fixtures';

describe('hear-me-out handler', () => {
	const MOCK_ENV: Bindings = {
		AUTH_KEY: 'secret-key',
		DISCORD_TOKEN_BOT: 'bot-token',
		DISCORD_TOKEN_USER: 'user-token',
	};

	function createMockFetch(messages: readonly unknown[]) {
		return vi.fn(
			async () =>
				new Response(JSON.stringify(messages), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		) as unknown as typeof fetch;
	}

	function createTestApp(mockFetch: typeof fetch) {
		const app = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();
		app.use('*', async (c, next) => {
			c.set('discordToken', `Bot ${c.env.DISCORD_TOKEN_BOT}`);
			c.set('proxyFetch', mockFetch);
			await next();
		});
		app.route('/', hearMeOutRoutes);
		return app;
	}

	function buildUrl(params?: { guildId?: string; channelId?: string; all?: string; formattedMessage?: string }): string {
		const query = new URLSearchParams();
		if (params?.guildId) query.set('guildId', params.guildId);
		if (params?.channelId) query.set('channelId', params.channelId);
		if (params?.all) query.set('all', params.all);
		if (params?.formattedMessage) query.set('formattedMessage', params.formattedMessage);
		return `http://localhost/hear-me-out?${query.toString()}`;
	}

	it('returns the full tallying result for a valid request', async () => {
		const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);
		const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ranked).toBeDefined();
		expect(body.ranked.topVotedSubmissions).toBeInstanceOf(Array);
		expect(body.ranked.mostSubmissions).toBeInstanceOf(Array);
		expect(body.ranked.topVotedSubmitters).toBeInstanceOf(Array);
		expect(body.ranked.messengerActivity).toBeInstanceOf(Array);
		expect(body.listings).toBeDefined();
		expect(body.listings.nonDefault).toBeInstanceOf(Array);
		expect(body.listings.formattingErrors).toBeInstanceOf(Array);
		expect(body.listings.missingAttribution).toBeInstanceOf(Array);
		expect(body.listings.missingVotes).toBeInstanceOf(Array);
		expect(body.stats.totalMessages).toBe(17);
	});

	it('returns top 10 by default', async () => {
		const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);
		const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);
		const body = await res.json();
		expect(body.ranked.topVotedSubmissions.length).toBeLessThanOrEqual(10);
	});

	it('returns all entries when all=true', async () => {
		const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);
		const res = await createTestApp(mockFetch).request(
			buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID, all: 'true' }),
			{},
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
	});

	it('returns plain text when formattedMessage=true', async () => {
		const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);
		const res = await createTestApp(mockFetch).request(
			buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID, formattedMessage: 'true' }),
			{},
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/plain/);
		const text = await res.text();
		expect(text).toContain('Hear Me Out Tally');
		expect(text).toContain('### Top Voted Submissions');
	});

	it('rejects missing guildId with 400', async () => {
		const mockFetch = createMockFetch([]);
		const res = await createTestApp(mockFetch).request(buildUrl({ channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);
		expect(res.status).toBe(400);
	});

	it('rejects non-snowflake channelId with 400', async () => {
		const mockFetch = createMockFetch([]);
		const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: 'not-a-snowflake' }), {}, MOCK_ENV);
		expect(res.status).toBe(400);
	});

	it('forwards Discord 403 as 502', async () => {
		const mockFetch = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;
		const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toContain('Cannot access');
	});

	it('forwards Discord 404 as 502', async () => {
		const mockFetch = vi.fn(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
		const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toContain('not found');
	});

	it('handles empty channel without errors', async () => {
		const mockFetch = createMockFetch([]);
		const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.stats.totalMessages).toBe(0);
	});
});
