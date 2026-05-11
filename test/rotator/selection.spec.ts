/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { chooseToken, isBucketCooling, isGuildIneligible } from '../../src/rotator/selection';
import type { TokenState } from '../../src/rotator/types';

const ROUTE = 'GET:/guilds/:id/messages/search';
const NOW = 1_000_000;

function makeToken(label: string, overrides: Partial<TokenState> = {}): TokenState {
	return {
		label,
		slot: 'default',
		tokenSecret: 'X'.repeat(60),
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

describe('chooseToken - happy paths', () => {
	it('picks the only active token in the slot', () => {
		const pool = [makeToken('a')];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('a');
		expect(result.unavailable).toBeUndefined();
	});

	it('picks the LRU token when none are in flight', () => {
		const pool = [
			makeToken('a', { lastUsedAt: NOW - 100 }),
			makeToken('b', { lastUsedAt: NOW - 5000 }), // older = LRU
			makeToken('c', { lastUsedAt: NOW - 200 }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('b');
	});

	it('prefers in-flight=0 over lower lastUsedAt', () => {
		const pool = [
			makeToken('busy', { lastUsedAt: 0, inFlightCount: 2 }),
			makeToken('idle', { lastUsedAt: NOW - 100, inFlightCount: 0 }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('idle');
	});

	it('falls back to in-flight tokens when none are idle (preferential, not exclusive)', () => {
		const pool = [
			makeToken('a', { lastUsedAt: NOW - 100, inFlightCount: 1 }),
			makeToken('b', { lastUsedAt: NOW - 200, inFlightCount: 1 }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('b');
	});
});

describe('chooseToken - filters', () => {
	it('honours strict slot isolation (default never sees premium)', () => {
		const pool = [
			makeToken('p', { slot: 'premium' }),
			makeToken('d', { slot: 'default' }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('d');
		const premium = chooseToken(pool, 'premium', ROUTE, NOW);
		expect(premium.chosen?.label).toBe('p');
	});

	it('skips tokens with status=invalid', () => {
		const pool = [
			makeToken('bad', { status: 'invalid' }),
			makeToken('good'),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('good');
	});

	it('skips tokens with active globalCooldownUntil', () => {
		const pool = [
			makeToken('cooling', { globalCooldownUntil: NOW + 5000 }),
			makeToken('ok'),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('ok');
	});

	it('skips tokens with exhausted bucket for this routeKey', () => {
		const pool = [
			makeToken('exhausted', {
				routeToBucket: { [ROUTE]: 'bucket1' },
				bucketStates: { bucket1: { remaining: 0, resetAt: NOW + 5000 } },
			}),
			makeToken('ok'),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('ok');
	});

	it('treats unknown bucket (no routeToBucket entry) as eligible', () => {
		const pool = [makeToken('virgin')];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen?.label).toBe('virgin');
	});

	it('skips tokens with current ineligibleGuilds entry for the requested guild', () => {
		const pool = [
			makeToken('blocked', {
				ineligibleGuilds: [{ guildId: '219', expiresAt: NOW + 5000 }],
			}),
			makeToken('ok'),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW, '219');
		expect(result.chosen?.label).toBe('ok');
	});

	it('respects per-token guildIds whitelist', () => {
		const pool = [
			makeToken('whitelist-other', { guildIds: ['111'] }),
			makeToken('whitelist-target', { guildIds: ['219'] }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW, '219');
		expect(result.chosen?.label).toBe('whitelist-target');
	});

	it('treats empty/undefined guildIds whitelist as "try everywhere"', () => {
		const pool = [
			makeToken('open'),
			makeToken('limited', { guildIds: ['111'] }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW, '219');
		expect(result.chosen?.label).toBe('open');
	});
});

describe('chooseToken - unavailable reasons', () => {
	it('returns empty-pool when no tokens exist for the slot', () => {
		const pool = [makeToken('p', { slot: 'premium' })];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen).toBeNull();
		expect(result.unavailable?.reason).toBe('empty-pool');
	});

	it('returns no-eligible-token when slot has tokens but none are active', () => {
		const pool = [
			makeToken('a', { status: 'invalid' }),
			makeToken('b', { status: 'suspended' }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen).toBeNull();
		expect(result.unavailable?.reason).toBe('no-eligible-token');
	});

	it('returns cooldown with retryAfter pointing to soonest reset', () => {
		const pool = [
			makeToken('a', { globalCooldownUntil: NOW + 5000 }),
			makeToken('b', { globalCooldownUntil: NOW + 3000 }),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen).toBeNull();
		expect(result.unavailable?.reason).toBe('cooldown');
		expect(result.unavailable?.retryAfter).toBe(3000);
	});

	it('returns cooldown when bucket is exhausted on every token', () => {
		const pool = [
			makeToken('a', {
				routeToBucket: { [ROUTE]: 'b1' },
				bucketStates: { b1: { remaining: 0, resetAt: NOW + 2000 } },
			}),
			makeToken('b', {
				routeToBucket: { [ROUTE]: 'b1' },
				bucketStates: { b1: { remaining: 0, resetAt: NOW + 4000 } },
			}),
		];
		const result = chooseToken(pool, 'default', ROUTE, NOW);
		expect(result.chosen).toBeNull();
		expect(result.unavailable?.reason).toBe('cooldown');
		expect(result.unavailable?.retryAfter).toBe(2000);
	});
});

describe('isBucketCooling / isGuildIneligible', () => {
	it('isBucketCooling false when remaining > 0', () => {
		const t = makeToken('a', {
			routeToBucket: { [ROUTE]: 'b' },
			bucketStates: { b: { remaining: 3, resetAt: NOW + 5000 } },
		});
		expect(isBucketCooling(t, ROUTE, NOW)).toBe(false);
	});

	it('isBucketCooling false when resetAt is in the past (window expired)', () => {
		const t = makeToken('a', {
			routeToBucket: { [ROUTE]: 'b' },
			bucketStates: { b: { remaining: 0, resetAt: NOW - 1 } },
		});
		expect(isBucketCooling(t, ROUTE, NOW)).toBe(false);
	});

	it('isGuildIneligible respects the expiresAt boundary', () => {
		const t = makeToken('a', {
			ineligibleGuilds: [{ guildId: '219', expiresAt: NOW + 1000 }],
		});
		expect(isGuildIneligible(t, '219', NOW)).toBe(true);
		expect(isGuildIneligible(t, '219', NOW + 2000)).toBe(false);
	});
});
