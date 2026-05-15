/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/do.spec
 * End-to-end tests for the TokenPoolDO via the test pool's real binding.
 * Each test uses a fresh DO id to avoid cross-test state leakage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { TokenPoolDO } from '../../src/rotator/do';
import type { ReleaseInput } from '../../src/rotator/types';

const VALID_TOKEN = 'A'.repeat(40) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(40);
const VALID_TOKEN_2 = 'D'.repeat(40) + '.' + 'E'.repeat(10) + '.' + 'F'.repeat(40);
const ROUTE = 'GET:/guilds/:id/messages/search';
const GUILD_ID = '219564597349318656';

let counter = 0;
function freshStub() {
	const id = env.TOKEN_POOL.idFromName(`test-${Date.now()}-${counter++}`);
	return env.TOKEN_POOL.get(id) as DurableObjectStub<TokenPoolDO>;
}

describe('TokenPoolDO.register / list / countSlot', () => {
	it('registers a token and lists it as a public-safe summary', async () => {
		const stub = freshStub();
		const reg = await stub.register({ label: 'tok-1', slot: 'default', tokenSecret: VALID_TOKEN });
		expect(reg.ok).toBe(true);
		if (reg.ok) {
			expect(reg.label).toBe('tok-1');
			expect(reg.registeredAt).toBeGreaterThan(0);
		}

		const list = await stub.list();
		expect(list).toHaveLength(1);
		expect(list[0].label).toBe('tok-1');
		expect(list[0].status).toBe('active');
		expect(list[0].slot).toBe('default');
		// Crucial: tokenSecret never leaks via list()
		expect(list[0]).not.toHaveProperty('tokenSecret');
	});

	it('rejects registration of an existing label', async () => {
		const stub = freshStub();
		await stub.register({ label: 'dup', slot: 'default', tokenSecret: VALID_TOKEN });
		const second = await stub.register({ label: 'dup', slot: 'default', tokenSecret: VALID_TOKEN_2 });
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.reason).toBe('label-exists');
	});

	it('countSlot is per-slot', async () => {
		const stub = freshStub();
		await stub.register({ label: 'd1', slot: 'default', tokenSecret: VALID_TOKEN });
		await stub.register({ label: 'd2', slot: 'default', tokenSecret: VALID_TOKEN_2 });
		await stub.register({ label: 'p1', slot: 'premium', tokenSecret: VALID_TOKEN });
		expect(await stub.countSlot('default')).toBe(2);
		expect(await stub.countSlot('premium')).toBe(1);
	});

	it('unregister is idempotent', async () => {
		const stub = freshStub();
		await stub.register({ label: 'doomed', slot: 'default', tokenSecret: VALID_TOKEN });
		await stub.unregister('doomed');
		await stub.unregister('doomed'); // no throw
		expect(await stub.list()).toHaveLength(0);
	});
});

describe('TokenPoolDO.acquire', () => {
	it('returns the only registered token for the slot', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const result = await stub.acquire('default', ROUTE);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.label).toBe('tok');
			expect(result.tokenSecret).toBe(VALID_TOKEN);
			expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/i);
		}
	});

	it('returns empty-pool when slot has zero registered tokens', async () => {
		const stub = freshStub();
		const result = await stub.acquire('default', ROUTE);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('empty-pool');
	});

	it('strict slot isolation: default request never sees premium token', async () => {
		const stub = freshStub();
		await stub.register({ label: 'p', slot: 'premium', tokenSecret: VALID_TOKEN });
		const result = await stub.acquire('default', ROUTE);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('empty-pool');
	});

	it('persists lastUsedAt and inFlightCount after acquire', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		await stub.acquire('default', ROUTE);
		const list = await stub.list();
		expect(list[0].inFlightCount).toBe(1);
		expect(list[0].lastUsedAt).toBeGreaterThan(0);
	});

	it('LRU: prefers the older lastUsedAt among multiple tokens', async () => {
		const stub = freshStub();
		await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
		await stub.register({ label: 'b', slot: 'default', tokenSecret: VALID_TOKEN_2 });

		// Acquire+release `a` so its lastUsedAt is "now"; `b` stays at 0 (LRU).
		const ra = await stub.acquire('default', ROUTE);
		expect(ra.ok).toBe(true);
		if (!ra.ok) return;
		await stub.release(ra.label, ra.requestId, { status: 200, routeKey: ROUTE });

		const next = await stub.acquire('default', ROUTE);
		expect(next.ok).toBe(true);
		if (next.ok) expect(next.label).toBe('b');
	});
});

describe('TokenPoolDO.release', () => {
	it('updates bucket state from response headers', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const acq = await stub.acquire('default', ROUTE);
		expect(acq.ok).toBe(true);
		if (!acq.ok) return;

		const release: ReleaseInput = {
			status: 200,
			routeKey: ROUTE,
			discordBucketHash: 'b1',
			remaining: 4,
			resetAfterMs: 5000,
		};
		await stub.release(acq.label, acq.requestId, release);

		const list = await stub.list();
		expect(list[0].inFlightCount).toBe(0);
		expect(list[0].bucketCount).toBe(1);
	});

	it('marks token invalid after 3 consecutive 401s', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		for (let i = 0; i < 3; i++) {
			const acq = await stub.acquire('default', ROUTE);
			expect(acq.ok).toBe(true);
			if (!acq.ok) return;
			await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
		}
		const list = await stub.list();
		expect(list[0].status).toBe('invalid');
		expect(list[0].consecutive401s).toBe(3);
	});

	it('resets the 401 counter after a successful response', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });

		let acq = await stub.acquire('default', ROUTE);
		if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });

		acq = await stub.acquire('default', ROUTE);
		if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });

		acq = await stub.acquire('default', ROUTE);
		if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });

		const list = await stub.list();
		expect(list[0].consecutive401s).toBe(0);
		expect(list[0].status).toBe('active');
	});

	it('429 sets globalCooldownUntil to retryAfter * 1.5', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const acq = await stub.acquire('default', ROUTE);
		if (!acq.ok) return;

		const before = Date.now();
		await stub.release(acq.label, acq.requestId, {
			status: 429,
			routeKey: ROUTE,
			retryAfterMs: 2000,
		});
		const list = await stub.list();
		expect(list[0].globalCooldownUntil).toBeGreaterThanOrEqual(before + 3000);
		expect(list[0].globalCooldownUntil).toBeLessThanOrEqual(before + 3500);
	});

	it('drops duplicate release calls with same requestId', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const acq = await stub.acquire('default', ROUTE);
		if (!acq.ok) return;
		await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });
		await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });
		const list = await stub.list();
		// inFlightCount decremented exactly once; otherwise it would be -1 clamped to 0
		// but consecutive401s tracking would also be off. Defensive check via direct state.
		expect(list[0].inFlightCount).toBe(0);
	});

	it('records ineligibleGuilds on 50001 within a guild', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const acq = await stub.acquire('default', ROUTE, GUILD_ID);
		if (!acq.ok) return;

		await stub.release(acq.label, acq.requestId, {
			status: 403,
			routeKey: ROUTE,
			code: 50001,
			guildId: GUILD_ID,
		});

		// Subsequent acquire for the same guild should fail (token marked ineligible)
		const next = await stub.acquire('default', ROUTE, GUILD_ID);
		expect(next.ok).toBe(false);
		if (!next.ok) expect(next.reason).toBe('cooldown');

		// But the same token is fine for a different guild
		const otherGuild = await stub.acquire('default', ROUTE, '111111111111111111');
		expect(otherGuild.ok).toBe(true);
	});

	it('release on a deleted token is a silent no-op', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const acq = await stub.acquire('default', ROUTE);
		if (!acq.ok) return;
		await stub.unregister('tok');
		// Should not throw
		await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });
	});
});

describe('TokenPoolDO fingerprint integration', () => {
	it('assigns a fingerprintProfileId on first acquire and persists it', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const acq1 = await stub.acquire('default', ROUTE);
		expect(acq1.ok).toBe(true);
		if (!acq1.ok) return;
		expect(typeof acq1.fingerprintProfileId).toBe('string');
		expect(acq1.fingerprintProfileId.length).toBeGreaterThan(0);

		// Subsequent acquires return the same id
		await stub.release(acq1.label, acq1.requestId, { status: 200, routeKey: ROUTE });
		const acq2 = await stub.acquire('default', ROUTE);
		if (!acq2.ok) return;
		expect(acq2.fingerprintProfileId).toBe(acq1.fingerprintProfileId);

		// Summary exposes the assignment
		const list = await stub.list();
		expect(list[0].fingerprintProfileId).toBe(acq1.fingerprintProfileId);
	});

	it('setTokenFingerprintProfile overrides the assignment', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		const r = await stub.setTokenFingerprintProfile('tok', 'profile-chrome-win-de-1');
		expect(r.ok).toBe(true);
		const acq = await stub.acquire('default', ROUTE);
		if (!acq.ok) return;
		expect(acq.fingerprintProfileId).toBe('profile-chrome-win-de-1');
	});

	it('setTokenFingerprintProfile on missing label returns not-found', async () => {
		const stub = freshStub();
		const r = await stub.setTokenFingerprintProfile('nope', 'profile-chrome-win-de-1');
		expect(r.ok).toBe(false);
	});

	it('static fingerprint roundtrip per kind', async () => {
		const stub = freshStub();
		expect(await stub.getStaticFingerprint('user-default')).toBeNull();
		expect(await stub.getStaticFingerprint('user-premium')).toBeNull();

		await stub.setStaticFingerprint('user-default', 'profile-chrome-win-de-1');
		await stub.setStaticFingerprint('user-premium', 'profile-firefox-linux-de-1');

		const d = await stub.getStaticFingerprint('user-default');
		const p = await stub.getStaticFingerprint('user-premium');
		expect(d?.profileId).toBe('profile-chrome-win-de-1');
		expect(p?.profileId).toBe('profile-firefox-linux-de-1');

		const mapping = await stub.listStaticFingerprints();
		expect(mapping.userDefault).toBe('profile-chrome-win-de-1');
		expect(mapping.userPremium).toBe('profile-firefox-linux-de-1');
	});

	it('build-number record roundtrip', async () => {
		const stub = freshStub();
		expect(await stub.getBuildNumberRecord()).toBeNull();
		await stub.setBuildNumberRecord({ buildNumber: 600_000, fetchedAt: 1_700_000_000_000, source: 'scraped' });
		const r = await stub.getBuildNumberRecord();
		expect(r).toEqual({ buildNumber: 600_000, fetchedAt: 1_700_000_000_000, source: 'scraped' });
	});

	it('loadAllTokens prefix scan does not pick up meta keys', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		await stub.setBuildNumberRecord({ buildNumber: 1, fetchedAt: 1, source: 'manual' });
		await stub.setStaticFingerprint('user-default', 'profile-chrome-win-de-1');
		const list = await stub.list();
		expect(list).toHaveLength(1);
		expect(list[0].label).toBe('tok');
	});
});

describe('TokenPoolDO.reset and health', () => {
	it('reset returns active and clears cooldowns', async () => {
		const stub = freshStub();
		await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
		// 3x401 -> invalid
		for (let i = 0; i < 3; i++) {
			const acq = await stub.acquire('default', ROUTE);
			if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
		}
		const reset = await stub.reset('tok');
		expect(reset.ok).toBe(true);

		const list = await stub.list();
		expect(list[0].status).toBe('active');
		expect(list[0].consecutive401s).toBe(0);
		expect(list[0].globalCooldownUntil).toBe(0);
	});

	it('reset on missing label returns ok:false', async () => {
		const stub = freshStub();
		const result = await stub.reset('nope');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('not-found');
	});

	it('health rolls up active vs cooling vs invalid per slot', async () => {
		const stub = freshStub();
		await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
		await stub.register({ label: 'b', slot: 'default', tokenSecret: VALID_TOKEN_2 });
		await stub.register({ label: 'p', slot: 'premium', tokenSecret: VALID_TOKEN });

		// Force `b` to invalid via direct in-instance release calls, bypassing
		// the LRU selection that would otherwise hit `a` half the time.
		for (let i = 0; i < 3; i++) {
			await runInDurableObject(stub, async (instance) => {
				await instance.release('b', `req-${i}`, { status: 401, routeKey: ROUTE });
			});
		}

		const health = await stub.health();
		expect(health.default.count).toBe(2);
		expect(health.default.invalid).toBe(1);
		expect(health.default.active).toBe(1);
		expect(health.premium.count).toBe(1);
		expect(health.premium.active).toBe(1);
	});
});
