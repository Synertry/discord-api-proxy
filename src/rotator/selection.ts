/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/selection
 * Pure eligibility + selection functions for the token pool.
 *
 * - {@link evaluateTokenEligibility}: per-token eligibility check returning a
 *   rich reason. Used by both `chooseToken` (LRU pick) and the DO's
 *   `acquireByLabel` RPC (single-token pin).
 * - {@link chooseToken}: filter the pool + pick LRU. Returns null + reason when
 *   nothing fits.
 *
 * Extracted from the DO so callers can be tested independently with synthetic
 * TokenState arrays.
 */

import type { AcquireUnavailable, RouteKey, Slot, TokenState } from './types';

export interface SelectionResult {
	chosen: TokenState | null;
	/** Populated when chosen is null. Tells the caller why. */
	unavailable?: AcquireUnavailable;
}

/**
 * Per-token eligibility result. `cooldown` carries a `retryAfter` (ms from now)
 * pointing to the soonest moment this token becomes eligible again.
 * `no-eligible-token` means this token will never satisfy the request as-is
 * (wrong slot, status != active, or guild-whitelist mismatch).
 */
export type EligibilityResult =
	| { ok: true }
	| { ok: false; reason: 'no-eligible-token' }
	| { ok: false; reason: 'cooldown'; retryAfter: number };

/**
 * Evaluate whether a single token can satisfy `(slot, routeKey, guildId)` at
 * time `now`. Pure - no side effects. Both `chooseToken` (LRU filter) and
 * `acquireByLabel` (single-token check) call this for consistent semantics.
 *
 * Rules:
 * 1. slot must match (strict isolation) -> no-eligible-token
 * 2. status must be 'active' -> no-eligible-token
 * 3. guildIds whitelist (if non-empty) must contain guildId -> no-eligible-token
 *    (permanent constraint - retry will not help for this guild)
 * 4. globalCooldownUntil > now -> cooldown(globalCooldownUntil - now)
 * 5. bucket exhausted for this routeKey -> cooldown(resetAt - now)
 * 6. ineligibleGuilds entry for guildId still in TTL -> cooldown(expiresAt - now)
 *    (time-bounded; entries expire after 1h per do.ts:INELIGIBLE_GUILD_TTL_MS)
 */
export function evaluateTokenEligibility(
	t: TokenState,
	slot: Slot,
	routeKey: RouteKey,
	now: number,
	guildId?: string,
): EligibilityResult {
	if (t.slot !== slot) return { ok: false, reason: 'no-eligible-token' };
	if (t.status !== 'active') return { ok: false, reason: 'no-eligible-token' };
	if (t.guildIds && t.guildIds.length > 0 && guildId && !t.guildIds.includes(guildId)) {
		return { ok: false, reason: 'no-eligible-token' };
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

	if (candidates.length === 0) return { ok: true };

	const soonest = Math.min(...candidates);
	return { ok: false, reason: 'cooldown', retryAfter: Math.max(0, soonest - now) };
}

/**
 * Apply all eligibility filters and pick the LRU token (preferring those with
 * `inFlightCount === 0`). Returns null + reason when nothing fits.
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

	const evaluations = slotPool.map((t) => ({
		t,
		e: evaluateTokenEligibility(t, slot, routeKey, now, guildId),
	}));
	const eligible = evaluations.filter(({ e }) => e.ok).map(({ t }) => t);

	if (eligible.length === 0) {
		// If at least one token is in cooldown, surface cooldown with soonest retry;
		// otherwise the slot is structurally blocked (all invalid / whitelist-mismatch).
		const cooldowns = evaluations
			.map(({ e }) => e)
			.filter((e): e is { ok: false; reason: 'cooldown'; retryAfter: number } => !e.ok && e.reason === 'cooldown');
		if (cooldowns.length === 0) {
			return {
				chosen: null,
				unavailable: { ok: false, reason: 'no-eligible-token', retryAfter: 60_000 },
			};
		}
		const retryAfter = Math.min(...cooldowns.map((c) => c.retryAfter));
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

/** Bucket cooling predicate. Exported for direct testing. */
export function isBucketCooling(t: TokenState, routeKey: RouteKey, now: number): boolean {
	const bucketHash = t.routeToBucket[routeKey];
	if (!bucketHash) return false;
	const bs = t.bucketStates[bucketHash];
	if (!bs) return false;
	return bs.remaining <= 0 && bs.resetAt > now;
}

/** Guild ineligibility predicate. Exported for direct testing. */
export function isGuildIneligible(t: TokenState, guildId: string, now: number): boolean {
	for (const g of t.ineligibleGuilds) {
		if (g.guildId === guildId && g.expiresAt > now) return true;
	}
	return false;
}
