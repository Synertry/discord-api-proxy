/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { tokenRotatorMiddleware } from '../../src/middleware/token-rotator';
import type { Bindings } from '../../src/types';
import type { AuthVariables } from '../../src/middleware/auth';
import type { DiscordContextVariables } from '../../src/middleware/discord-context';
import type { AcquireResult, RotatorVariables, TokenPoolClient } from '../../src/rotator/types';

type Vars = AuthVariables & DiscordContextVariables & RotatorVariables;

const MOCK_ENV: Bindings = {
	DISCORD_TOKEN_BOT: 'BOT',
	DISCORD_TOKEN_USER: 'STATIC_USER',
	AUTH_KEY: 'k',
	TOKEN_POOL: {} as DurableObjectNamespace, // unused; tests inject mockTokenPool
};

function buildApp(client: TokenPoolClient, authSlot: 'default' | 'premium' = 'default') {
	const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Vars }>();
	// Seed authSlot + a static discordToken to mimic the upstream sieve layers
	app.use('*', async (c, next) => {
		c.set('authSlot', authSlot);
		c.set('discordToken', 'STATIC_USER');
		c.set('tokenPoolClient', client);
		await next();
	});
	app.use('*', tokenRotatorMiddleware);
	app.get('/*', (c) => {
		return c.json({
			discordToken: c.var.discordToken,
			acquiredLabel: c.var.acquiredLabel ?? null,
			acquiredRequestId: c.var.acquiredRequestId ?? null,
		});
	});
	app.post('/*', (c) => c.json({ discordToken: c.var.discordToken, acquiredLabel: c.var.acquiredLabel ?? null }));
	return app;
}

function mockClientReturning(result: AcquireResult): TokenPoolClient {
	return {
		acquire: vi.fn(async () => result),
		release: vi.fn(),
	};
}

describe('tokenRotatorMiddleware', () => {
	it('passes through and leaves discordToken unchanged on non-rotatable paths', async () => {
		const acquire = vi.fn();
		const app = buildApp({ acquire, release: vi.fn() });
		const res = await app.request('http://localhost/users/@me', {}, MOCK_ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; acquiredLabel: string | null };
		expect(body.discordToken).toBe('STATIC_USER');
		expect(body.acquiredLabel).toBeNull();
		expect(acquire).not.toHaveBeenCalled();
	});

	it('rotates on /guilds/:id/messages/search and overwrites discordToken with the acquired secret', async () => {
		const acquire = vi.fn(async () => ({
			ok: true as const,
			label: 'tok-3',
			tokenSecret: 'POOLED_SECRET',
			requestId: 'req-1',
			fingerprintProfileId: 'profile-chrome-win-de-1',
		}));
		const app = buildApp({ acquire, release: vi.fn() });

		const res = await app.request(
			'http://localhost/guilds/219564597349318656/messages/search?author_id=999',
			{},
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; acquiredLabel: string };
		expect(body.discordToken).toBe('POOLED_SECRET');
		expect(body.acquiredLabel).toBe('tok-3');
		expect(acquire).toHaveBeenCalledWith('default', 'GET:/guilds/:id/messages/search', '219564597349318656');
	});

	it('forwards the premium slot when authSlot is premium', async () => {
		const acquire = vi.fn(async () => ({
			ok: true as const,
			label: 'p1',
			tokenSecret: 'PREMIUM',
			requestId: 'req-2',
			fingerprintProfileId: 'profile-chrome-win-de-1',
		}));
		const app = buildApp({ acquire, release: vi.fn() }, 'premium');
		await app.request('http://localhost/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
		expect(acquire).toHaveBeenCalledWith('premium', expect.any(String), expect.any(String));
	});

	it('returns 429 with Retry-After when the pool is fully cooling', async () => {
		const client = mockClientReturning({ ok: false, reason: 'cooldown', retryAfter: 4500 });
		const app = buildApp(client);
		const res = await app.request('http://localhost/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string; retryAfter: number };
		expect(body.retryAfter).toBe(5);
		expect(res.headers.get('Retry-After')).toBe('5');
	});

	it('falls through to the static token when the pool is empty (graceful fallback)', async () => {
		const client = mockClientReturning({ ok: false, reason: 'empty-pool', retryAfter: 60_000 });
		const app = buildApp(client);
		const res = await app.request('http://localhost/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; acquiredLabel: string | null };
		expect(body.discordToken).toBe('STATIC_USER');
		expect(body.acquiredLabel).toBeNull();
	});

	it('returns 503 when the DO acquire throws (e.g. binding misconfigured)', async () => {
		const client: TokenPoolClient = {
			acquire: vi.fn(async () => {
				throw new Error('DO offline');
			}),
			release: vi.fn(),
		};
		const app = buildApp(client);
		const res = await app.request('http://localhost/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
		expect(res.status).toBe(503);
	});

	it('blocks rotation on POST /channels/:id/messages (message authorship)', async () => {
		const acquire = vi.fn();
		const app = buildApp({ acquire, release: vi.fn() });
		const res = await app.request(
			'http://localhost/channels/123456789012345678/messages',
			{ method: 'POST', body: '{}' },
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		expect(acquire).not.toHaveBeenCalled();
	});

	it('X-Proxy-Token: static skips the rotator entirely', async () => {
		const acquire = vi.fn();
		const acquireByLabel = vi.fn();
		const app = buildApp({ acquire, acquireByLabel, release: vi.fn() });
		const res = await app.request(
			'http://localhost/guilds/219564597349318656/messages/search',
			{ headers: { 'X-Proxy-Token': 'static' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; acquiredLabel: string | null };
		expect(body.discordToken).toBe('STATIC_USER');
		expect(body.acquiredLabel).toBeNull();
		expect(acquire).not.toHaveBeenCalled();
		expect(acquireByLabel).not.toHaveBeenCalled();
	});

	it('X-Proxy-Token: <label> pins via acquireByLabel', async () => {
		const acquire = vi.fn();
		const acquireByLabel = vi.fn(async () => ({
			ok: true as const,
			label: 'tok-local',
			tokenSecret: 'PINNED_SECRET',
			requestId: 'req-pin',
			fingerprintProfileId: 'profile-chrome-win-de-1',
		}));
		const app = buildApp({ acquire, acquireByLabel, release: vi.fn() });
		const res = await app.request(
			'http://localhost/guilds/219564597349318656/messages/search',
			{ headers: { 'X-Proxy-Token': 'tok-local' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { discordToken: string; acquiredLabel: string };
		expect(body.discordToken).toBe('PINNED_SECRET');
		expect(body.acquiredLabel).toBe('tok-local');
		expect(acquire).not.toHaveBeenCalled();
		expect(acquireByLabel).toHaveBeenCalledWith('tok-local', 'default', 'GET:/guilds/:id/messages/search', '219564597349318656');
	});

	it('X-Proxy-Token: <label> returns 503 when the label is not found', async () => {
		const acquireByLabel = vi.fn(async () => ({
			ok: false as const,
			reason: 'no-eligible-token' as const,
			retryAfter: 60_000,
		}));
		const app = buildApp({ acquire: vi.fn(), acquireByLabel, release: vi.fn() });
		const res = await app.request(
			'http://localhost/guilds/219564597349318656/messages/search',
			{ headers: { 'X-Proxy-Token': 'nonexistent' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; reason: string };
		expect(body.reason).toBe('no-eligible-token');
	});

	it('X-Proxy-Token: <label> still 503s on empty-pool (no graceful fallback when pinned)', async () => {
		const acquireByLabel = vi.fn(async () => ({
			ok: false as const,
			reason: 'no-eligible-token' as const,
			retryAfter: 60_000,
		}));
		const app = buildApp({ acquire: vi.fn(), acquireByLabel, release: vi.fn() });
		const res = await app.request(
			'http://localhost/guilds/219564597349318656/messages/search',
			{ headers: { 'X-Proxy-Token': 'tok-missing' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(503);
	});

	it('X-Proxy-Token: <label> returns 503 if the client mock lacks acquireByLabel', async () => {
		// Old-style mock with only acquire/release. Middleware must not crash.
		const app = buildApp({ acquire: vi.fn(), release: vi.fn() });
		const res = await app.request(
			'http://localhost/guilds/219564597349318656/messages/search',
			{ headers: { 'X-Proxy-Token': 'tok-1' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(503);
	});

	it('X-Proxy-Token: auto behaves like absent header (LRU acquire)', async () => {
		const acquire = vi.fn(async () => ({
			ok: true as const,
			label: 'lru',
			tokenSecret: 'LRU_SECRET',
			requestId: 'req-lru',
			fingerprintProfileId: 'profile-chrome-win-de-1',
		}));
		const acquireByLabel = vi.fn();
		const app = buildApp({ acquire, acquireByLabel, release: vi.fn() });
		const res = await app.request(
			'http://localhost/guilds/219564597349318656/messages/search',
			{ headers: { 'X-Proxy-Token': 'auto' } },
			MOCK_ENV,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { acquiredLabel: string };
		expect(body.acquiredLabel).toBe('lru');
		expect(acquire).toHaveBeenCalled();
		expect(acquireByLabel).not.toHaveBeenCalled();
	});
});
