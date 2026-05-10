/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/selection
 * Pure function: given the full pool, pick the best token for the request.
 *
 * Extracted from the DO so it can be tested independently with synthetic
 * TokenState arrays.
 */

import type { AcquireUnavailable, RouteKey, Slot, TokenState } from './types';

export interface SelectionResult {
	chosen: TokenState | null;
	/** Populated when chosen is null. Tells the caller why. */
	unavailable?: AcquireUnavailable;
}

/**
 * Apply all eligibility filters and pick the LRU token (preferring those with
 * `inFlightCount === 0`). Returns null + reason when nothing fits.
 *
 * Selection rules in order:
 * 1. slot must match (strict isolation)
 * 2. status must be 'active'
 * 3. globalCooldownUntil <= now
 * 4. token's known bucket for this routeKey (if any) must not be exhausted
 * 5. guildId (if provided) must not be in ineligibleGuilds with future expiresAt
 * 6. token's guildIds whitelist (if set) must contain guildId
 *
 * Tiebreak: smallest inFlightCount, then smallest lastUsedAt.
 */
export function chooseToken(
	pool: readonly TokenState[],
	slot: Slot,
	routeKey: RouteKey,
	now: number,
	guildId?: string,
): SelectionResult {
	const slotPool = pool.filter((t) => t.slot === slot);
	if (slotPool.length === 0) {
		return {
			chosen: null,
			unavailable: { ok: false, reason: 'empty-pool', retryAfter: 60_000 },
		};
	}

	const eligible = slotPool.filter((t) => isEligible(t, routeKey, now, guildId));

	if (eligible.length === 0) {
		// Distinguish "all currently cooling" from "no token has access at all"
		const anyActive = slotPool.some((t) => t.status === 'active');
		if (!anyActive) {
			return {
				chosen: null,
				unavailable: { ok: false, reason: 'no-eligible-token', retryAfter: 60_000 },
			};
		}
		const retryAfter = computeRetryAfter(slotPool, routeKey, now, guildId);
		return {
			chosen: null,
			unavailable: { ok: false, reason: 'cooldown', retryAfter },
		};
	}

	const sorted = [...eligible].sort(
		(a, b) => a.inFlightCount - b.inFlightCount || a.lastUsedAt - b.lastUsedAt,
	);

	return { chosen: sorted[0] };
}

function isEligible(t: TokenState, routeKey: RouteKey, now: number, guildId: string | undefined): boolean {
	if (t.status !== 'active') return false;
	if (t.globalCooldownUntil > now) return false;
	if (isBucketCooling(t, routeKey, now)) return false;
	if (guildId && isGuildIneligible(t, guildId, now)) return false;
	if (t.guildIds && t.guildIds.length > 0 && guildId && !t.guildIds.includes(guildId)) return false;
	return true;
}

export function isBucketCooling(t: TokenState, routeKey: RouteKey, now: number): boolean {
	const bucketHash = t.routeToBucket[routeKey];
	if (!bucketHash) return false;
	const bs = t.bucketStates[bucketHash];
	if (!bs) return false;
	return bs.remaining <= 0 && bs.resetAt > now;
}

export function isGuildIneligible(t: TokenState, guildId: string, now: number): boolean {
	for (const g of t.ineligibleGuilds) {
		if (g.guildId === guildId && g.expiresAt > now) return true;
	}
	return false;
}

/**
 * Among the slot's tokens, find the soonest moment when any of them becomes
 * eligible again. Returns the delta in ms from `now`. Used to populate
 * `retryAfter` on a `cooldown` AcquireUnavailable.
 */
function computeRetryAfter(
	slotPool: readonly TokenState[],
	routeKey: RouteKey,
	now: number,
	guildId: string | undefined,
): number {
	let soonest = Number.POSITIVE_INFINITY;

	for (const t of slotPool) {
		if (t.status !== 'active') continue;
		if (guildId && t.guildIds && t.guildIds.length > 0 && !t.guildIds.includes(guildId)) {
			continue;
		}

		const candidates: number[] = [];
		if (t.globalCooldownUntil > now) candidates.push(t.globalCooldownUntil);

		const bucketHash = t.routeToBucket[routeKey];
		if (bucketHash) {
			const bs = t.bucketStates[bucketHash];
			if (bs && bs.remaining <= 0 && bs.resetAt > now) candidates.push(bs.resetAt);
		}

		if (guildId) {
			for (const g of t.ineligibleGuilds) {
				if (g.guildId === guildId && g.expiresAt > now) candidates.push(g.expiresAt);
			}
		}

		if (candidates.length === 0) {
			// This token is already eligible; we shouldn't have been called.
			// Be defensive: zero retry.
			return 0;
		}
		const tokenSoonest = Math.min(...candidates);
		if (tokenSoonest < soonest) soonest = tokenSoonest;
	}

	if (!Number.isFinite(soonest)) return 60_000;
	return Math.max(0, soonest - now);
}
