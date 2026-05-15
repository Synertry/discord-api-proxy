/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/discord-context.spec
 * Tests for the Discord context middleware.
 *
 * Validates token selection: bot vs. user-default vs. user-premium based on
 * path heuristics, the `x-proxy-context` header override, and the auth slot.
 * The middleware sets `discordTokenKind` so the proxy can compose the right
 * header set downstream.
 */

import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { discordContextMiddleware, type DiscordContextVariables } from '../../src/middleware/discord-context';
import type { AuthVariables } from '../../src/middleware/auth';
import type { Bindings } from '../../src/types';

type Vars = DiscordContextVariables & AuthVariables;

describe('Discord Context Middleware', () => {
	const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Vars }>();
	app.use('*', async (c, next) => {
		c.set('authSlot', 'default');
		await next();
	});
	app.use('*', discordContextMiddleware);
	app.get('*', (c) =>
		c.json({
			discordToken: c.var.discordToken,
			discordTokenKind: c.var.discordTokenKind,
		}),
	);

	const MOCK_ENV: Bindings = {
		AUTH_KEY: 'secret-key',
		DISCORD_TOKEN_BOT: 'bot-token',
		DISCORD_TOKEN_USER: 'user-token',
		TOKEN_POOL: {} as DurableObjectNamespace,
	};

	it('assigns bot token + kind=bot for paths without /guilds', async () => {
		const res = await app.request('http://localhost/users/@me', {}, MOCK_ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; discordTokenKind: string };
		expect(body.discordToken).toBe('Bot bot-token');
		expect(body.discordTokenKind).toBe('bot');
	});

	it('assigns user token + kind=user-default for paths including /guilds', async () => {
		const res = await app.request('http://localhost/users/@me/guilds', {}, MOCK_ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; discordTokenKind: string };
		expect(body.discordToken).toBe('user-token');
		expect(body.discordTokenKind).toBe('user-default');
	});

	it('overrides with user kind when X-Proxy-Context is user, despite not being /guilds', async () => {
		const res = await app.request(
			'http://localhost/users/@me',
			{ headers: { 'X-Proxy-Context': 'user' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; discordTokenKind: string };
		expect(body.discordToken).toBe('user-token');
		expect(body.discordTokenKind).toBe('user-default');
	});

	it('overrides with bot kind when X-Proxy-Context is bot, despite being /guilds', async () => {
		const res = await app.request(
			'http://localhost/users/@me/guilds',
			{ headers: { 'X-Proxy-Context': 'bot' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; discordTokenKind: string };
		expect(body.discordToken).toBe('Bot bot-token');
		expect(body.discordTokenKind).toBe('bot');
	});

	it('routes premium slot to DISCORD_TOKEN_USER_PREMIUM and kind=user-premium', async () => {
		const premiumApp = new OpenAPIHono<{ Bindings: Bindings; Variables: Vars }>();
		premiumApp.use('*', async (c, next) => {
			c.set('authSlot', 'premium');
			await next();
		});
		premiumApp.use('*', discordContextMiddleware);
		premiumApp.get('*', (c) =>
			c.json({ discordToken: c.var.discordToken, discordTokenKind: c.var.discordTokenKind }),
		);

		const env: Bindings = { ...MOCK_ENV, DISCORD_TOKEN_USER_PREMIUM: 'premium-token' };
		const res = await premiumApp.request('http://localhost/users/@me/guilds', {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; discordTokenKind: string };
		expect(body.discordToken).toBe('premium-token');
		expect(body.discordTokenKind).toBe('user-premium');
	});

	it('returns 503 when premium slot is requested but DISCORD_TOKEN_USER_PREMIUM is unset', async () => {
		const premiumApp = new OpenAPIHono<{ Bindings: Bindings; Variables: Vars }>();
		premiumApp.use('*', async (c, next) => {
			c.set('authSlot', 'premium');
			await next();
		});
		premiumApp.use('*', discordContextMiddleware);
		premiumApp.get('*', (c) => c.json({ ok: true }));

		const res = await premiumApp.request('http://localhost/users/@me/guilds', {}, MOCK_ENV);
		expect(res.status).toBe(503);
	});
});
