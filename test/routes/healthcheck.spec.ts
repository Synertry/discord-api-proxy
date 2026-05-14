/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createApp } from '../../src/index';

const ENV_OVERRIDE = {
	...env,
	AUTH_KEY: 'proxy-key-for-tests',
	AUTH_KEY_ADMIN: 'admin-key-for-tests',
	DISCORD_TOKEN_BOT: 'BOT',
	DISCORD_TOKEN_USER: 'STATIC_USER',
};

describe('public /healthcheck', () => {
	it('returns 200 without any auth header', async () => {
		const app = createApp();
		const res = await app.request('http://localhost/healthcheck', {}, ENV_OVERRIDE);
		expect(res.status).toBe(200);
	});

	it('returns the expected JSON shape', async () => {
		const app = createApp();
		const res = await app.request('http://localhost/healthcheck', {}, ENV_OVERRIDE);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe('ok');
		expect(body.service).toBe('discord-api-proxy');
		expect(body.build).toMatchObject({ hash: expect.any(String), timestamp: expect.any(String) });
		expect(body.time).toEqual(expect.any(String));
		expect(new Date(body.time as string).toString()).not.toBe('Invalid Date');
	});

	it('returns Cache-Control: no-store to defeat CDN caching', async () => {
		const app = createApp();
		const res = await app.request('http://localhost/healthcheck', {}, ENV_OVERRIDE);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('ignores any provided auth header (no auth chain)', async () => {
		const app = createApp();
		const resWithBogus = await app.request(
			'http://localhost/healthcheck',
			{ headers: { 'x-auth-key': 'totally-wrong-key' } },
			ENV_OVERRIDE,
		);
		expect(resWithBogus.status).toBe(200);
	});

	it('is mounted before the sieve - a missing AUTH_KEY does not affect /healthcheck', async () => {
		const app = createApp();
		const envNoAuth = { ...ENV_OVERRIDE, AUTH_KEY: '' };
		const res = await app.request('http://localhost/healthcheck', {}, envNoAuth);
		expect(res.status).toBe(200);
	});

	it('does not respond to non-GET methods (Hono default 405-ish behavior)', async () => {
		const app = createApp();
		const res = await app.request(
			'http://localhost/healthcheck',
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
			ENV_OVERRIDE,
		);
		// POST falls through to the catch-all proxy, which goes through auth.
		// Either 401 (no auth key) or 404 from Hono - just make sure it is NOT 200.
		expect(res.status).not.toBe(200);
	});
});
