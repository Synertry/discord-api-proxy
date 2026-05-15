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

const VALID_TOKEN = 'A'.repeat(40) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(40);
const VALID_TOKEN_2 = 'D'.repeat(40) + '.' + 'E'.repeat(10) + '.' + 'F'.repeat(40);

const ADMIN_KEY = 'admin-key-for-tests';
const PROXY_KEY = 'proxy-key-for-tests';

const ENV_OVERRIDE = {
	...env,
	AUTH_KEY: PROXY_KEY,
	AUTH_KEY_ADMIN: ADMIN_KEY,
	DISCORD_TOKEN_BOT: 'BOT',
	DISCORD_TOKEN_USER: 'STATIC_USER',
};

function admin() {
	return createApp();
}

let labelCounter = 0;
function nextLabel(): string {
	return `tok-${Date.now()}-${labelCounter++}`;
}

async function adminPost(app: ReturnType<typeof admin>, path: string, body: unknown, key = ADMIN_KEY) {
	return app.request(
		`http://localhost${path}`,
		{
			method: 'POST',
			headers: { 'x-auth-key': key, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
		ENV_OVERRIDE,
	);
}

async function adminGet(app: ReturnType<typeof admin>, path: string, key = ADMIN_KEY) {
	return app.request(`http://localhost${path}`, { headers: { 'x-auth-key': key } }, ENV_OVERRIDE);
}

async function adminDelete(app: ReturnType<typeof admin>, path: string, key = ADMIN_KEY) {
	return app.request(`http://localhost${path}`, { method: 'DELETE', headers: { 'x-auth-key': key } }, ENV_OVERRIDE);
}

describe('admin auth', () => {
	it('returns 401 without an auth key', async () => {
		const app = admin();
		const res = await app.request('http://localhost/admin/tokens', {}, ENV_OVERRIDE);
		expect(res.status).toBe(401);
	});

	it('returns 401 when proxy AUTH_KEY is supplied (privilege isolation)', async () => {
		const app = admin();
		const res = await adminGet(app, '/admin/tokens', PROXY_KEY);
		expect(res.status).toBe(401);
	});

	it('returns 503 when AUTH_KEY_ADMIN is not configured', async () => {
		const app = admin();
		const noAdmin = { ...ENV_OVERRIDE, AUTH_KEY_ADMIN: undefined };
		const res = await app.request(
			'http://localhost/admin/tokens',
			{ headers: { 'x-auth-key': 'whatever' } },
			noAdmin,
		);
		expect(res.status).toBe(503);
	});

	it('accepts the admin key', async () => {
		const app = admin();
		const res = await adminGet(app, '/admin/tokens');
		expect(res.status).toBe(200);
	});
});

describe('admin POST /tokens', () => {
	it('registers a valid token and returns 201', async () => {
		const app = admin();
		const label = nextLabel();
		const res = await adminPost(app, '/admin/tokens', {
			label,
			slot: 'default',
			tokenSecret: VALID_TOKEN,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { label: string; registeredAt: number };
		expect(body.label).toBe(label);
		expect(body.registeredAt).toBeGreaterThan(0);
	});

	it('rejects malformed payload with 400', async () => {
		const app = admin();
		const res = await adminPost(app, '/admin/tokens', { label: 'has space', slot: 'default', tokenSecret: VALID_TOKEN });
		expect(res.status).toBe(400);
	});

	it('rejects token with header-injection characters', async () => {
		const app = admin();
		const res = await adminPost(app, '/admin/tokens', {
			label: nextLabel(),
			slot: 'default',
			tokenSecret: VALID_TOKEN.slice(0, 50) + '\r\nX-Inject: bad',
		});
		expect(res.status).toBe(400);
	});

	it('returns the same generic 400 for "label exists" and "invalid format" (constant-time)', async () => {
		const app = admin();
		const label = nextLabel();
		await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });

		const dup = await adminPost(app, '/admin/tokens', {
			label,
			slot: 'default',
			tokenSecret: VALID_TOKEN_2,
		});
		const bad = await adminPost(app, '/admin/tokens', {
			label: 'has space',
			slot: 'default',
			tokenSecret: VALID_TOKEN,
		});
		expect(dup.status).toBe(400);
		expect(bad.status).toBe(400);
		const dupBody = (await dup.json()) as { error: string };
		const badBody = (await bad.json()) as { error: string };
		expect(dupBody.error).toBe(badBody.error);
	});
});

describe('admin GET /tokens never returns the secret', () => {
	it('omits tokenSecret from list responses', async () => {
		const app = admin();
		const label = nextLabel();
		await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });

		const res = await adminGet(app, '/admin/tokens');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tokens: Array<Record<string, unknown>> };
		const ours = body.tokens.find((t) => t.label === label);
		expect(ours).toBeDefined();
		expect(ours).not.toHaveProperty('tokenSecret');
	});
});

describe('admin DELETE /tokens/:label', () => {
	it('returns 204 and removes the token', async () => {
		const app = admin();
		const label = nextLabel();
		await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
		const del = await adminDelete(app, `/admin/tokens/${label}`);
		expect(del.status).toBe(204);
	});

	it('is idempotent on missing label (still 204)', async () => {
		const app = admin();
		const del = await adminDelete(app, `/admin/tokens/never-existed`);
		expect(del.status).toBe(204);
	});

	it('rejects label with disallowed characters with 400', async () => {
		const app = admin();
		const del = await adminDelete(app, `/admin/tokens/has%20space`);
		expect(del.status).toBe(400);
	});
});

describe('admin POST /tokens/:label/reset', () => {
	it('returns 200 on existing label', async () => {
		const app = admin();
		const label = nextLabel();
		await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
		const res = await adminPost(app, `/admin/tokens/${label}/reset`, {});
		expect(res.status).toBe(200);
	});

	it('returns 400 for missing label', async () => {
		const app = admin();
		const res = await adminPost(app, `/admin/tokens/never-existed/reset`, {});
		expect(res.status).toBe(400);
	});
});

describe('admin fingerprint endpoints', () => {
	it('GET /admin/fingerprint/profiles returns the registry ids + fallback', async () => {
		const app = admin();
		const res = await adminGet(app, '/admin/fingerprint/profiles');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { profileIds: string[]; fallbackProfileId: string };
		expect(body.profileIds.length).toBeGreaterThanOrEqual(8);
		expect(body.profileIds).toContain(body.fallbackProfileId);
	});

	it('POST /admin/tokens/:label/fingerprint validates profileId and returns 400 on unknown', async () => {
		const app = admin();
		const label = nextLabel();
		await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
		const bad = await adminPost(app, `/admin/tokens/${label}/fingerprint`, { profileId: 'nonsense' });
		expect(bad.status).toBe(400);
	});

	it('POST /admin/tokens/:label/fingerprint sets the assignment', async () => {
		const app = admin();
		const label = nextLabel();
		await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
		const ok = await adminPost(app, `/admin/tokens/${label}/fingerprint`, {
			profileId: 'profile-chrome-win-de-1',
		});
		expect(ok.status).toBe(200);

		// GET /tokens reflects the override
		const list = await adminGet(app, '/admin/tokens');
		const body = (await list.json()) as { tokens: Array<{ label: string; fingerprintProfileId?: string }> };
		const ours = body.tokens.find((t) => t.label === label);
		expect(ours?.fingerprintProfileId).toBe('profile-chrome-win-de-1');
	});

	it('POST /admin/static-fingerprint sets per-kind mapping; GET returns it', async () => {
		const app = admin();
		const set = await adminPost(app, '/admin/static-fingerprint', {
			kind: 'user-default',
			profileId: 'profile-chrome-win-de-1',
		});
		expect(set.status).toBe(200);
		const got = await adminGet(app, '/admin/static-fingerprint');
		expect(got.status).toBe(200);
		const body = (await got.json()) as { userDefault: string | null; userPremium: string | null };
		expect(body.userDefault).toBe('profile-chrome-win-de-1');
	});

	it('POST /admin/static-fingerprint rejects unknown kind with 400', async () => {
		const app = admin();
		const res = await adminPost(app, '/admin/static-fingerprint', {
			kind: 'admin-user',
			profileId: 'profile-chrome-win-de-1',
		});
		expect(res.status).toBe(400);
	});

	it('POST /admin/static-fingerprint rejects unknown profileId with 400', async () => {
		const app = admin();
		const res = await adminPost(app, '/admin/static-fingerprint', {
			kind: 'user-default',
			profileId: 'made-up',
		});
		expect(res.status).toBe(400);
	});

	it('GET /admin/build-number returns null before any scrape', async () => {
		const app = admin();
		const res = await adminGet(app, '/admin/build-number');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toBe('null');
	});

	it('all fingerprint endpoints require admin auth (401 without key)', async () => {
		const app = admin();
		const unauthenticated = await app.request(
			'http://localhost/admin/fingerprint/profiles',
			{},
			ENV_OVERRIDE,
		);
		expect(unauthenticated.status).toBe(401);
	});
});

describe('admin GET /health', () => {
	it('returns per-slot rollup', async () => {
		const app = admin();
		await adminPost(app, '/admin/tokens', {
			label: nextLabel(),
			slot: 'default',
			tokenSecret: VALID_TOKEN,
		});
		await adminPost(app, '/admin/tokens', {
			label: nextLabel(),
			slot: 'premium',
			tokenSecret: VALID_TOKEN_2,
		});
		const res = await adminGet(app, '/admin/health');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { default: { count: number }; premium: { count: number } };
		expect(body.default.count).toBeGreaterThanOrEqual(1);
		expect(body.premium.count).toBeGreaterThanOrEqual(1);
	});
});
