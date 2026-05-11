/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { extractReleaseInput, extractReleaseInputWithBody } from '../../src/rotator/release-input';

const ROUTE_KEY = 'GET:/guilds/:id/messages/search';

describe('extractReleaseInput', () => {
	it('parses Discord rate-limit headers from a 200 response', () => {
		const r = new Response('{}', {
			status: 200,
			headers: {
				'X-RateLimit-Bucket': 'abc123',
				'X-RateLimit-Remaining': '4',
				'X-RateLimit-Reset-After': '5.250',
			},
		});
		const input = extractReleaseInput(r, ROUTE_KEY, '219564597349318656');
		expect(input).toEqual({
			status: 200,
			routeKey: ROUTE_KEY,
			discordBucketHash: 'abc123',
			remaining: 4,
			resetAfterMs: 5250,
			retryAfterMs: undefined,
			guildId: '219564597349318656',
		});
	});

	it('captures Retry-After on a 429 response (fractional seconds)', () => {
		const r = new Response('{"message":"You are being rate limited.","retry_after":1.234}', {
			status: 429,
			headers: { 'Retry-After': '1.234' },
		});
		const input = extractReleaseInput(r, ROUTE_KEY);
		expect(input.status).toBe(429);
		expect(input.retryAfterMs).toBe(1234);
		expect(input.discordBucketHash).toBeUndefined();
	});

	it('returns undefined fields when headers are absent', () => {
		const r = new Response('', { status: 502 });
		const input = extractReleaseInput(r, ROUTE_KEY);
		expect(input.status).toBe(502);
		expect(input.discordBucketHash).toBeUndefined();
		expect(input.remaining).toBeUndefined();
		expect(input.resetAfterMs).toBeUndefined();
		expect(input.retryAfterMs).toBeUndefined();
	});

	it('treats X-RateLimit-Remaining of 0 as 0, not undefined', () => {
		const r = new Response('', {
			status: 200,
			headers: { 'X-RateLimit-Bucket': 'b', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '10' },
		});
		const input = extractReleaseInput(r, ROUTE_KEY);
		expect(input.remaining).toBe(0);
		expect(input.resetAfterMs).toBe(10000);
	});
});

describe('extractReleaseInputWithBody', () => {
	it('captures Discord error code 50001 from a 403 body', async () => {
		const r = new Response(JSON.stringify({ message: 'Missing Access', code: 50001 }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
		const input = await extractReleaseInputWithBody(r, ROUTE_KEY, '219564597349318656');
		expect(input.code).toBe(50001);
		expect(input.guildId).toBe('219564597349318656');
	});

	it('returns base ReleaseInput unchanged for non-403 responses', async () => {
		const r = new Response('', { status: 200 });
		const input = await extractReleaseInputWithBody(r, ROUTE_KEY);
		expect(input.code).toBeUndefined();
	});

	it('does not consume the original response body (clone preserves it)', async () => {
		const r = new Response(JSON.stringify({ code: 50001 }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
		await extractReleaseInputWithBody(r, ROUTE_KEY);
		const text = await r.text();
		expect(text).toContain('50001');
	});

	it('survives a malformed JSON body without throwing', async () => {
		const r = new Response('not-json', { status: 403 });
		const input = await extractReleaseInputWithBody(r, ROUTE_KEY);
		expect(input.status).toBe(403);
		expect(input.code).toBeUndefined();
	});
});
