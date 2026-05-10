/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/validators
 * Pure validation + housekeeping helpers for the token pool.
 */

import type { RegisterInput, Slot, TokenState } from './types';

/** Hard cap on tokens per slot. Bounds blast radius if storage leaks. */
export const POOL_SIZE_CAP_PER_SLOT = 20;

/** LRU eviction cap on per-token bucket entries. */
export const BUCKET_STATES_CAP = 200;

/**
 * Approximate Discord user-token format. Primary purpose: header-injection
 * defense (tokens are written into Authorization headers downstream). Not
 * authoritative authenticity validation.
 *
 * Discord user tokens are roughly three base64-ish segments separated by `.`,
 * each printable. The character class accepts all of: letters, digits, `+/=._-`.
 * Length window 50-120 covers observed real tokens with margin.
 */
const TOKEN_FORMAT_REGEX = /^[A-Za-z0-9+/._=-]{50,120}$/;

/** Acceptable Slot values. Used for runtime validation of admin input. */
const SLOT_VALUES = new Set<Slot>(['default', 'premium']);

/**
 * Validation outcome. Constant-time error shape: same string for "label exists"
 * and "label invalid" prevents enumeration via the admin endpoint.
 */
export interface ValidationFailure {
	ok: false;
	error: string;
}
export interface ValidationSuccess<T> {
	ok: true;
	value: T;
}
export type ValidationResult<T> = ValidationFailure | ValidationSuccess<T>;

/**
 * Validate a `POST /admin/tokens` payload. Returns a normalized RegisterInput
 * or a generic error string. Errors are deliberately uniform to prevent label
 * enumeration via differential responses.
 */
export function validateRegisterInput(raw: unknown): ValidationResult<RegisterInput> {
	if (!raw || typeof raw !== 'object') {
		return { ok: false, error: 'invalid request' };
	}
	const obj = raw as Record<string, unknown>;

	const label = obj.label;
	if (typeof label !== 'string' || label.length === 0 || label.length > 64 || !/^[A-Za-z0-9._-]+$/.test(label)) {
		return { ok: false, error: 'invalid request' };
	}

	const slot = obj.slot;
	if (typeof slot !== 'string' || !SLOT_VALUES.has(slot as Slot)) {
		return { ok: false, error: 'invalid request' };
	}

	const tokenSecret = obj.tokenSecret;
	if (typeof tokenSecret !== 'string' || !TOKEN_FORMAT_REGEX.test(tokenSecret)) {
		return { ok: false, error: 'invalid request' };
	}

	let guildIds: string[] | undefined;
	if (obj.guildIds !== undefined) {
		if (!Array.isArray(obj.guildIds)) {
			return { ok: false, error: 'invalid request' };
		}
		const ids: string[] = [];
		for (const g of obj.guildIds) {
			if (typeof g !== 'string' || !/^\d{17,20}$/.test(g)) {
				return { ok: false, error: 'invalid request' };
			}
			ids.push(g);
		}
		guildIds = ids.length > 0 ? ids : undefined;
	}

	return {
		ok: true,
		value: {
			label,
			slot: slot as Slot,
			tokenSecret,
			guildIds,
		},
	};
}

/**
 * Enforce the per-slot pool size cap before registering a new token.
 * `existingCountInSlot` is the number of tokens already present for the same slot.
 */
export function enforcePoolCap(existingCountInSlot: number): ValidationResult<void> {
	if (existingCountInSlot >= POOL_SIZE_CAP_PER_SLOT) {
		return { ok: false, error: 'invalid request' };
	}
	return { ok: true, value: undefined };
}

/**
 * Trim `bucketStates` to BUCKET_STATES_CAP entries by evicting the rows with
 * the smallest `resetAt` (oldest reset, most likely already expired). Mutates
 * the token in place.
 */
export function evictOldestBucketsIfOverCap(t: TokenState): void {
	const entries = Object.entries(t.bucketStates);
	if (entries.length <= BUCKET_STATES_CAP) return;

	entries.sort((a, b) => a[1].resetAt - b[1].resetAt);
	const toEvict = entries.length - BUCKET_STATES_CAP;
	for (let i = 0; i < toEvict; i++) {
		delete t.bucketStates[entries[i][0]];
	}

	// Drop routeToBucket entries whose target was evicted.
	const remaining = new Set(Object.keys(t.bucketStates));
	for (const route of Object.keys(t.routeToBucket)) {
		if (!remaining.has(t.routeToBucket[route])) {
			delete t.routeToBucket[route];
		}
	}
}

/**
 * Drop expired ineligibleGuilds entries. Mutates the token in place.
 */
export function pruneIneligibleGuilds(t: TokenState, now: number): void {
	t.ineligibleGuilds = t.ineligibleGuilds.filter((g) => g.expiresAt > now);
}
