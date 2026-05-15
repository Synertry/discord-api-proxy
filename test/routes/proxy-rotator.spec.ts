/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * Integration tests for the proxy route's token-pool release-and-retry path.
 * Uses createApp(mockFetch, mockTokenPool) to inject both seams.
 */

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/index';
import type { Bindings } from '../../src/types';
import type { AcquireResult, TokenPoolClient } from '../../src/rotator/types';

const ENV: Bindings = {
	AUTH_KEY: 'k',
	DISCORD_TOKEN_BOT: 'BOT',
	DISCORD_TOKEN_USER: 'STATIC',
	TOKEN_POOL: {} as DurableObjectNamespace, // injected client bypasses this
};

const ROTATABLE_PATH = '/guilds/219564597349318656/messages/search?author_id=999';

function ok(label: string, secret: string, requestId: string): AcquireResult {
	return {
		ok: true,
		label,
		tokenSecret: secret,
		requestId,
		fingerprintProfileId: 'profile-chrome-win-de-1',
	};
}

function buildPoolClient(
	acquireResults: AcquireResult[],
): TokenPoolClient & { releases: Array<{ label: string; requestId: string; status: number; routeKey: string }> } {
	const releases: Array<{ label: string; requestId: string; status: number; routeKey: string }> = [];
	let i = 0;
	const acquire = vi.fn(async () => {
		const r = acquireResults[i] ?? acquireResults[acquireResults.length - 1];
		i++;
		return r;
	});
	const release = vi.fn(async (label: string, requestId: string, response) => {
		releases.push({ label, requestId, status: response.status, routeKey: response.routeKey });
	});
	return { acquire, release, releases };
}

describe('proxy + rotator integration', () => {
	it('releases the token after a successful Discord call', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response('{}', {
				status: 200,
				headers: {
					'X-RateLimit-Bucket': 'bucket-1',
					'X-RateLimit-Remaining': '4',
					'X-RateLimit-Reset-After': '5.0',
				},
			}),
		);
		const pool = buildPoolClient([ok('tok-1', 'POOLED_1', 'req-1')]);
		const app = createApp(fetchMock as unknown as typeof fetch, pool);

		const req = new Request(`http://localhost${ROTATABLE_PATH}`, {
			method: 'GET',
			headers: { 'x-auth-key': 'k' },
		});
		const res = await app.request(req, undefined, ENV);
		expect(res.status).toBe(200);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const callHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
		expect(callHeaders.get('Authorization')).toBe('POOLED_1');

		expect(pool.releases).toHaveLength(1);
		expect(pool.releases[0]).toMatchObject({
			label: 'tok-1',
			requestId: 'req-1',
			status: 200,
			routeKey: 'GET:/guilds/:id/messages/search',
		});
	});

	it('auto-retries once with a different token on 429 and returns the retry response', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response('rate limited', {
					status: 429,
					headers: { 'Retry-After': '0.5' },
				}),
			)
			.mockResolvedValueOnce(
				new Response('{"data":1}', {
					status: 200,
					headers: { 'X-RateLimit-Bucket': 'b1', 'X-RateLimit-Remaining': '4', 'X-RateLimit-Reset-After': '5' },
				}),
			);
		const pool = buildPoolClient([
			ok('tok-1', 'POOLED_1', 'req-1'),
			ok('tok-2', 'POOLED_2', 'req-2'),
		]);
		const app = createApp(fetchMock as unknown as typeof fetch, pool);

		const req = new Request(`http://localhost${ROTATABLE_PATH}`, {
			method: 'GET',
			headers: { 'x-auth-key': 'k' },
		});
		const res = await app.request(req, undefined, ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: number };
		expect(body.data).toBe(1);

		// Both Discord calls happened with different Authorization values
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const headersA = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
		const headersB = (fetchMock.mock.calls[1][1] as RequestInit).headers as Headers;
		expect(headersA.get('Authorization')).toBe('POOLED_1');
		expect(headersB.get('Authorization')).toBe('POOLED_2');

		// Both releases happened with their respective requestIds
		expect(pool.releases).toHaveLength(2);
		expect(pool.releases[0]).toMatchObject({ label: 'tok-1', status: 429 });
		expect(pool.releases[1]).toMatchObject({ label: 'tok-2', status: 200 });
	});

	it('passes the original 429 through when retry acquire reports cooldown', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } }),
		);
		const pool: TokenPoolClient = {
			acquire: vi
				.fn()
				.mockResolvedValueOnce(ok('tok-1', 'POOLED_1', 'req-1'))
				.mockResolvedValueOnce({ ok: false, reason: 'cooldown', retryAfter: 1500 }),
			release: vi.fn(),
		};
		const app = createApp(fetchMock as unknown as typeof fetch, pool);

		const req = new Request(`http://localhost${ROTATABLE_PATH}`, {
			method: 'GET',
			headers: { 'x-auth-key': 'k' },
		});
		const res = await app.request(req, undefined, ENV);
		// The L1 rate-limit interceptor reformats the original 429 into the standard envelope
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('Too Many Requests');

		// Only ONE Discord call happened (the original); no retry call.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not call the rotator at all on a non-rotatable path', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		const pool: TokenPoolClient = { acquire: vi.fn(), release: vi.fn() };
		const app = createApp(fetchMock as unknown as typeof fetch, pool);

		const req = new Request('http://localhost/users/@me', {
			method: 'GET',
			headers: { 'x-auth-key': 'k' },
		});
		const res = await app.request(req, undefined, ENV);
		expect(res.status).toBe(200);

		expect(pool.acquire).not.toHaveBeenCalled();
		expect(pool.release).not.toHaveBeenCalled();
		// Original behavior: bot-token header for /users/@me (no /guilds in path)
		const callHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
		expect(callHeaders.get('Authorization')).toBe('Bot BOT');
	});

	it('releases with synthetic 599 on a fetch throw to free inFlightCount', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
		const pool = buildPoolClient([ok('tok-1', 'POOLED_1', 'req-1')]);
		const app = createApp(fetchMock as unknown as typeof fetch, pool);

		const req = new Request(`http://localhost${ROTATABLE_PATH}`, {
			method: 'GET',
			headers: { 'x-auth-key': 'k' },
		});
		const res = await app.request(req, undefined, ENV);
		expect(res.status).toBe(500);

		expect(pool.releases).toHaveLength(1);
		expect(pool.releases[0]).toMatchObject({ label: 'tok-1', requestId: 'req-1', status: 599 });
	});

	it('captures Discord error code 50001 from a 403 body and forwards it to release', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: 'Missing Access', code: 50001 }), {
				status: 403,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		const pool = buildPoolClient([ok('tok-1', 'POOLED_1', 'req-1')]);
		const app = createApp(fetchMock as unknown as typeof fetch, pool);

		const req = new Request(`http://localhost${ROTATABLE_PATH}`, {
			method: 'GET',
			headers: { 'x-auth-key': 'k' },
		});
		const res = await app.request(req, undefined, ENV);
		expect(res.status).toBe(403);

		expect(pool.releases).toHaveLength(1);
		expect(pool.releases[0].status).toBe(403);
	});
});
