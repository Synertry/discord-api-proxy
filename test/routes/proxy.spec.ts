/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/proxy.spec
 * Integration tests for the catch-all Discord API proxy and rate limit interceptor.
 *
 * Uses {@link createApp} with a mock fetch to verify:
 * - Correct URL rewriting to `discord.com/api/v10`
 * - Authorization header injection (bot UA for bot, full fingerprint set for user)
 * - Host header stripping
 * - Custom client headers are forwarded
 * - 429 rate limit responses are intercepted and reformatted
 */

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/index';
import type { Bindings } from '../../src/types';
import { composeBotUserAgent } from '../../src/fingerprint/compose';
import { FALLBACK_PROFILE_ID, lookupProfile } from '../../src/fingerprint/profiles';

const MOCK_ENV: Bindings = {
	AUTH_KEY: 'secret-key',
	DISCORD_TOKEN_BOT: 'bot-token',
	DISCORD_TOKEN_USER: 'user-token',
	TOKEN_POOL: {} as DurableObjectNamespace,
};

describe('Proxy Route & Introspection (Integration)', () => {
	it('forwards bot-token requests with a Discord-compliant bot UA and no super-properties', async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const app = createApp(mockFetch as unknown as typeof fetch);

		const req = new Request('http://localhost/users/@me', {
			method: 'GET',
			headers: {
				'x-auth-key': 'secret-key',
				Host: 'localhost',
				'Custom-Client-Header': '123',
			},
		});

		const res = await app.request(req, undefined, MOCK_ENV);
		expect(res.status).toBe(200);
		const json = (await res.json()) as { success: boolean };
		expect(json.success).toBe(true);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const callUrl = mockFetch.mock.calls[0][0] as string;
		const callHeaders = (mockFetch.mock.calls[0][1] as RequestInit).headers as Headers;
		expect(callUrl).toBe('https://discord.com/api/v10/users/@me');
		expect(callHeaders.get('Authorization')).toBe('Bot bot-token');
		expect(callHeaders.has('Host')).toBe(false);
		expect(callHeaders.get('Custom-Client-Header')).toBe('123');
		expect(callHeaders.get('User-Agent')).toMatch(/^DiscordBot \(/);
		expect(callHeaders.get('X-Super-Properties')).toBeNull();
	});

	it('forwards user-token requests with the FALLBACK fingerprint header set on /guilds paths', async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		const app = createApp(mockFetch as unknown as typeof fetch);

		const req = new Request('http://localhost/users/@me/guilds', {
			method: 'GET',
			headers: { 'x-auth-key': 'secret-key' },
		});

		const res = await app.request(req, undefined, MOCK_ENV);
		expect(res.status).toBe(200);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const callHeaders = (mockFetch.mock.calls[0][1] as RequestInit).headers as Headers;
		expect(callHeaders.get('Authorization')).toBe('user-token');

		// Without a configured static fingerprint in the DO, the proxy falls back
		// through to FALLBACK_PROFILE_ID and emits the matching UA.
		const fallback = lookupProfile(FALLBACK_PROFILE_ID);
		expect(callHeaders.get('User-Agent')).toBe(fallback?.userAgent ?? '');
		expect(callHeaders.get('X-Super-Properties')).toBeTruthy();
		expect(callHeaders.get('X-Discord-Locale')).toBe(fallback?.locale ?? '');
		expect(callHeaders.get('X-Debug-Options')).toBe('bugReporterEnabled');
		expect(callHeaders.get('Origin')).toBe('https://discord.com');
		expect(callHeaders.get('Referer')).toBe('https://discord.com/channels/@me');
	});

	it('uses BUILD_HASH in the bot User-Agent', async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
		const app = createApp(mockFetch as unknown as typeof fetch);
		const req = new Request('http://localhost/users/@me', { headers: { 'x-auth-key': 'secret-key' } });
		await app.request(req, undefined, MOCK_ENV);
		const callHeaders = (mockFetch.mock.calls[0][1] as RequestInit).headers as Headers;
		expect(callHeaders.get('User-Agent')).toBe(composeBotUserAgent(BUILD_HASH));
	});

	it('intercepts 429 Too Many Requests and formats response', async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response('Rate limited', {
				status: 429,
				headers: { 'Retry-After': '1.5' },
			}),
		);
		const app = createApp(mockFetch as unknown as typeof fetch);

		const req = new Request('http://localhost/users/@me', {
			method: 'GET',
			headers: { 'x-auth-key': 'secret-key' },
		});

		const res = await app.request(req, undefined, MOCK_ENV);
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string; retryAfter: number };
		expect(body.error).toBe('Too Many Requests');
		expect(body.retryAfter).toBe(1.5);
	});

	it('preserves Retry-After and X-RateLimit-* headers on 429', async () => {
		const mockFetch = vi.fn().mockResolvedValue(
			new Response('Rate limited', {
				status: 429,
				headers: {
					'Retry-After': '2.0',
					'X-RateLimit-Limit': '5',
					'X-RateLimit-Remaining': '0',
					'X-RateLimit-Reset-After': '2.0',
				},
			}),
		);
		const app = createApp(mockFetch as unknown as typeof fetch);

		const req = new Request('http://localhost/users/@me', {
			method: 'GET',
			headers: { 'x-auth-key': 'secret-key' },
		});

		const res = await app.request(req, undefined, MOCK_ENV);
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('2.0');
		expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
		expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
		expect(res.headers.get('X-RateLimit-Reset-After')).toBe('2.0');
	});
});
