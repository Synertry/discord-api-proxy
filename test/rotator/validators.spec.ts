/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import {
	BUCKET_STATES_CAP,
	POOL_SIZE_CAP_PER_SLOT,
	enforcePoolCap,
	evictOldestBucketsIfOverCap,
	pruneIneligibleGuilds,
	validateRegisterInput,
} from '../../src/rotator/validators';
import type { TokenState } from '../../src/rotator/types';

const validToken = 'A'.repeat(40) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(40);

function makeTokenState(label: string, overrides: Partial<TokenState> = {}): TokenState {
	return {
		label,
		slot: 'default',
		tokenSecret: validToken,
		status: 'active',
		consecutive401s: 0,
		lastUsedAt: 0,
		inFlightCount: 0,
		globalCooldownUntil: 0,
		bucketStates: {},
		routeToBucket: {},
		ineligibleGuilds: [],
		lastReleaseRequestId: null,
		lastReleaseAt: 0,
		registeredAt: 1,
		...overrides,
	};
}

describe('validateRegisterInput', () => {
	it('accepts a well-formed payload', () => {
		const result = validateRegisterInput({
			label: 'tok-1',
			slot: 'default',
			tokenSecret: validToken,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.label).toBe('tok-1');
			expect(result.value.guildIds).toBeUndefined();
		}
	});

	it('rejects non-object payload', () => {
		expect(validateRegisterInput(null).ok).toBe(false);
		expect(validateRegisterInput('a string').ok).toBe(false);
		expect(validateRegisterInput(123).ok).toBe(false);
	});

	it('returns the same generic error for missing/invalid label and missing/invalid slot (constant-time shape)', () => {
		const a = validateRegisterInput({ slot: 'default', tokenSecret: validToken });
		const b = validateRegisterInput({ label: 'tok', slot: 'free-tier', tokenSecret: validToken });
		expect(a.ok).toBe(false);
		expect(b.ok).toBe(false);
		if (!a.ok && !b.ok) {
			expect(a.error).toBe(b.error);
		}
	});

	it('rejects label with disallowed characters', () => {
		expect(validateRegisterInput({ label: 'tok 1', slot: 'default', tokenSecret: validToken }).ok).toBe(false);
		expect(validateRegisterInput({ label: 'tok/1', slot: 'default', tokenSecret: validToken }).ok).toBe(false);
		expect(validateRegisterInput({ label: '', slot: 'default', tokenSecret: validToken }).ok).toBe(false);
	});

	it('rejects token with header-injection characters', () => {
		const injection = validToken.slice(0, 50) + '\r\nX-Inject: bad';
		expect(validateRegisterInput({ label: 'tok', slot: 'default', tokenSecret: injection }).ok).toBe(false);
	});

	it('rejects token shorter than the minimum length', () => {
		expect(validateRegisterInput({ label: 'tok', slot: 'default', tokenSecret: 'short' }).ok).toBe(false);
	});

	it('accepts both default and premium slots', () => {
		expect(validateRegisterInput({ label: 'a', slot: 'default', tokenSecret: validToken }).ok).toBe(true);
		expect(validateRegisterInput({ label: 'b', slot: 'premium', tokenSecret: validToken }).ok).toBe(true);
	});

	it('accepts a guildIds whitelist of snowflakes', () => {
		const result = validateRegisterInput({
			label: 'tok',
			slot: 'default',
			tokenSecret: validToken,
			guildIds: ['219564597349318656', '123456789012345678'],
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.guildIds).toEqual(['219564597349318656', '123456789012345678']);
	});

	it('rejects a non-snowflake guildIds entry', () => {
		const result = validateRegisterInput({
			label: 'tok',
			slot: 'default',
			tokenSecret: validToken,
			guildIds: ['not-a-snowflake'],
		});
		expect(result.ok).toBe(false);
	});

	it('drops an empty guildIds array (treats as "try everywhere")', () => {
		const result = validateRegisterInput({
			label: 'tok',
			slot: 'default',
			tokenSecret: validToken,
			guildIds: [],
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.guildIds).toBeUndefined();
	});
});

describe('enforcePoolCap', () => {
	it('allows registration up to the cap', () => {
		expect(enforcePoolCap(POOL_SIZE_CAP_PER_SLOT - 1).ok).toBe(true);
	});

	it('rejects when at the cap', () => {
		expect(enforcePoolCap(POOL_SIZE_CAP_PER_SLOT).ok).toBe(false);
	});
});

describe('evictOldestBucketsIfOverCap', () => {
	it('does nothing when under the cap', () => {
		const t = makeTokenState('a');
		t.bucketStates = { 'b1': { remaining: 5, resetAt: 100 } };
		evictOldestBucketsIfOverCap(t);
		expect(Object.keys(t.bucketStates)).toHaveLength(1);
	});

	it('evicts buckets with the smallest resetAt when over cap', () => {
		const t = makeTokenState('a');
		for (let i = 0; i < BUCKET_STATES_CAP + 5; i++) {
			t.bucketStates[`b${i}`] = { remaining: 0, resetAt: i * 10 };
		}
		evictOldestBucketsIfOverCap(t);
		expect(Object.keys(t.bucketStates).length).toBe(BUCKET_STATES_CAP);
		// The 5 lowest resetAt buckets (b0..b4) should be gone.
		expect(t.bucketStates['b0']).toBeUndefined();
		expect(t.bucketStates['b4']).toBeUndefined();
		expect(t.bucketStates['b5']).toBeDefined();
	});

	it('drops routeToBucket entries pointing at evicted hashes', () => {
		const t = makeTokenState('a');
		for (let i = 0; i < BUCKET_STATES_CAP + 2; i++) {
			t.bucketStates[`b${i}`] = { remaining: 0, resetAt: i * 10 };
			t.routeToBucket[`R${i}`] = `b${i}`;
		}
		evictOldestBucketsIfOverCap(t);
		expect(t.routeToBucket['R0']).toBeUndefined();
		expect(t.routeToBucket['R1']).toBeUndefined();
		expect(t.routeToBucket['R2']).toBeDefined();
	});
});

describe('pruneIneligibleGuilds', () => {
	it('drops expired entries and keeps live ones', () => {
		const t = makeTokenState('a');
		t.ineligibleGuilds = [
			{ guildId: '1', expiresAt: 500 },
			{ guildId: '2', expiresAt: 1500 },
			{ guildId: '3', expiresAt: 200 },
		];
		pruneIneligibleGuilds(t, 1000);
		expect(t.ineligibleGuilds.map((g) => g.guildId)).toEqual(['2']);
	});
});
