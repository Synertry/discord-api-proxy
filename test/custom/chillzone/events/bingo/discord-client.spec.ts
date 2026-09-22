/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/discord-client.spec
 * Covers `fetchWithRotator`'s pool acquire/release pairing directly - in
 * particular the live-429 retry path and its lease cleanup on a thrown
 * dispatch error, which the higher-level `countMessages`/`fetchGuildMember`
 * tests in `aggregator.spec.ts`/`roles.spec.ts` never exercise since they
 * mock `BingoDiscordClient` itself rather than the pool underneath it.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBingoDiscordClient, DiscordApiError, __resetBingoClientCachesForTests } from '../../../../../src/custom/chillzone/events/bingo/discord-client';
import type { AcquireResult, TokenPoolClient } from '../../../../../src/rotator/types';

const USER_ID = '100000000000000001';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createBingoDiscordClient: fetchWithRotator retry lease cleanup', () => {
	it('releases the retry token with status 599 when the retry fetch itself throws (no lease leak)', async () => {
		__resetBingoClientCachesForTests();
		let acquireCalls = 0;
		const acquire = vi.fn(async (): Promise<AcquireResult> => {
			acquireCalls += 1;
			return {
				ok: true,
				label: `tok-${acquireCalls}`,
				tokenSecret: `SECRET_${acquireCalls}`,
				requestId: `req-${acquireCalls}`,
				fingerprintProfileId: 'chrome-win-de',
			};
		});
		const release = vi.fn(async () => undefined);
		const pool: TokenPoolClient = { acquire, release };
		const fetcher = vi.fn().mockImplementation(async () => {
			if (acquireCalls === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '1' } });
			throw new Error('network down on retry');
		});
		const wait = vi.fn(async () => undefined);
		const client = createBingoDiscordClient({ pool, fetcher: fetcher as unknown as typeof fetch, wait });

		let caught: unknown;
		try {
			await client.fetchGuildMember(USER_ID);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(DiscordApiError);
		expect((caught as DiscordApiError).body).toMatch(/Network error on retry/);

		expect(release).toHaveBeenCalledTimes(2);
		expect(release).toHaveBeenCalledWith('tok-1', 'req-1', expect.objectContaining({ status: 429 }));
		expect(release).toHaveBeenCalledWith('tok-2', 'req-2', expect.objectContaining({ status: 599 }));
	});

	it('releases the retry token on a live 429 success and returns the retry response', async () => {
		__resetBingoClientCachesForTests();
		let acquireCalls = 0;
		const acquire = vi.fn(async (): Promise<AcquireResult> => {
			acquireCalls += 1;
			return {
				ok: true,
				label: `tok-${acquireCalls}`,
				tokenSecret: `SECRET_${acquireCalls}`,
				requestId: `req-${acquireCalls}`,
				fingerprintProfileId: 'chrome-win-de',
			};
		});
		const release = vi.fn(async () => undefined);
		const pool: TokenPoolClient = { acquire, release };
		const fetcher = vi.fn().mockImplementation(async () => {
			if (acquireCalls === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '1' } });
			return jsonResponse({ id: USER_ID, user: { id: USER_ID, username: 'u' }, roles: [] });
		});
		const wait = vi.fn(async () => undefined);
		const client = createBingoDiscordClient({ pool, fetcher: fetcher as unknown as typeof fetch, wait });

		const member = await client.fetchGuildMember(USER_ID);
		expect(member.user.id).toBe(USER_ID);
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(release).toHaveBeenCalledWith('tok-1', 'req-1', expect.objectContaining({ status: 429 }));
		expect(release).toHaveBeenCalledWith('tok-2', 'req-2', expect.objectContaining({ status: 200 }));
	});

	it('releases the initial token with status 599 when the initial fetch throws (no retry attempted)', async () => {
		__resetBingoClientCachesForTests();
		const acquire = vi.fn(async (): Promise<AcquireResult> => ({
			ok: true,
			label: 'tok-1',
			tokenSecret: 'SECRET_1',
			requestId: 'req-1',
			fingerprintProfileId: 'chrome-win-de',
		}));
		const release = vi.fn(async () => undefined);
		const pool: TokenPoolClient = { acquire, release };
		const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
		const client = createBingoDiscordClient({ pool, fetcher: fetcher as unknown as typeof fetch, wait: vi.fn(async () => undefined) });

		let caught: unknown;
		try {
			await client.fetchGuildMember(USER_ID);
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(DiscordApiError);
		expect((caught as DiscordApiError).body).toMatch(/Network error: network down/);
		expect(release).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledWith('tok-1', 'req-1', expect.objectContaining({ status: 599 }));
	});
});
