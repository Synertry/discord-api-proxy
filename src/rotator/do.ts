/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/do
 * Durable Object implementation of the token pool rotator.
 *
 * Storage layout:
 *   `token:${label}`                       per-token TokenState
 *   `meta:discord-build-number`            BuildNumberRecord (scheduled scraper writes daily)
 *   `static-fingerprint:user-default`      StaticFingerprintRecord for DISCORD_TOKEN_USER
 *   `static-fingerprint:user-premium`      StaticFingerprintRecord for DISCORD_TOKEN_USER_PREMIUM
 *
 * The DO loads all token rows at the top of each acquire/release RPC, mutates
 * in memory, writes back the mutated rows. Selection logic lives in
 * `selection.ts` (pure function, fully testable in isolation).
 *
 * Concurrency: the DO's single-threaded event loop serializes acquire/release
 * calls. `inFlightCount` is a preferential filter; `requestId`-gated release
 * drops stale or duplicate updates.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Bindings } from '../types';
import { BUILD_NUMBER_META_KEY, type BuildNumberRecord } from '../fingerprint/build-number';
import { FALLBACK_PROFILE_ID, listProfileIds, lookupProfile } from '../fingerprint/profiles';
import { chooseToken } from './selection';
import { evictOldestBucketsIfOverCap, pruneIneligibleGuilds } from './validators';
import type {
	AcquireResult,
	BucketState,
	IneligibleGuild,
	PoolHealth,
	RegisterInput,
	ReleaseInput,
	RouteKey,
	Slot,
	SlotHealth,
	StaticFingerprintRecord,
	StaticTokenKind,
	TokenState,
	TokenStatus,
	TokenSummary,
} from './types';

const TOKEN_KEY_PREFIX = 'token:';
const STATIC_FINGERPRINT_PREFIX = 'static-fingerprint:';
const INELIGIBLE_GUILD_TTL_MS = 60 * 60 * 1000; // 1 hour
const COOLDOWN_BACKOFF_FACTOR = 1.5;

/**
 * Build a fresh TokenState for a newly registered token. Pure helper.
 * Exported for test-time construction without going through the full register flow.
 */
export function makeTokenState(input: RegisterInput, now: number): TokenState {
	return {
		label: input.label,
		slot: input.slot,
		tokenSecret: input.tokenSecret,
		guildIds: input.guildIds,
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
		registeredAt: now,
	};
}

/** Public-safe summary projection. */
export function summarize(t: TokenState): TokenSummary {
	return {
		label: t.label,
		slot: t.slot,
		status: t.status,
		consecutive401s: t.consecutive401s,
		lastUsedAt: t.lastUsedAt,
		inFlightCount: t.inFlightCount,
		globalCooldownUntil: t.globalCooldownUntil,
		bucketCount: Object.keys(t.bucketStates).length,
		registeredAt: t.registeredAt,
		guildIds: t.guildIds,
		fingerprintProfileId: t.fingerprintProfileId,
	};
}

/**
 * Deterministically pick a profile id for a token. Stable hash of `label`
 * modulo the registry size, so the same label always maps to the same profile
 * (until persisted - after first use, the assignment is read from storage
 * instead, so growing the registry does not reshuffle existing tokens).
 *
 * FNV-1a 32-bit hash. Six lines, no crypto dependency, sufficient avalanche
 * for spreading 20 labels across ~12 profiles.
 */
export function pickProfileId(label: string, profileIds: readonly string[]): string {
	if (profileIds.length === 0) return FALLBACK_PROFILE_ID;
	let h = 0x811c9dc5;
	for (let i = 0; i < label.length; i++) {
		h ^= label.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return profileIds[h % profileIds.length];
}

/**
 * TokenPoolDO holds the token pool. Bound as `TOKEN_POOL` in wrangler.jsonc.
 * Single instance: callers resolve via `idFromName('token-pool-v1')`.
 */
export class TokenPoolDO extends DurableObject<Bindings> {
	/**
	 * Acquire a token for the given slot + route. Updates lastUsedAt and
	 * inFlightCount on the chosen token; persists immediately. If the chosen
	 * token has no `fingerprintProfileId` yet, assigns one deterministically.
	 */
	async acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
		const now = Date.now();
		const tokens = await this.loadAllTokens();

		const result = chooseToken(tokens, slot, routeKey, now, guildId);
		if (!result.chosen) {
			return result.unavailable!;
		}

		const t = result.chosen;
		t.lastUsedAt = now;
		t.inFlightCount += 1;

		// First-use fingerprint assignment, persisted immediately.
		if (!t.fingerprintProfileId) {
			t.fingerprintProfileId = pickProfileId(t.label, listProfileIds());
		}

		await this.ctx.storage.put(`${TOKEN_KEY_PREFIX}${t.label}`, t);

		return {
			ok: true,
			label: t.label,
			tokenSecret: t.tokenSecret,
			requestId: crypto.randomUUID(),
			fingerprintProfileId: t.fingerprintProfileId,
		};
	}

	/**
	 * Release a token after a Discord call completes. Updates per-bucket cooldown
	 * state from the response headers. Stale-write protection: out-of-order or
	 * duplicate release calls are ignored (idempotent on requestId).
	 */
	async release(label: string, requestId: string, response: ReleaseInput): Promise<void> {
		const now = Date.now();
		const t = await this.ctx.storage.get<TokenState>(`${TOKEN_KEY_PREFIX}${label}`);
		if (!t) return; // Token deleted before release; drop silently.

		// Stale-write guard: duplicate or out-of-order
		if (t.lastReleaseRequestId === requestId) return;
		if (t.lastReleaseAt > now) return;

		t.inFlightCount = Math.max(0, t.inFlightCount - 1);
		t.lastReleaseRequestId = requestId;
		t.lastReleaseAt = now;

		// 401 -> circuit breaker on 3 consecutive
		if (response.status === 401) {
			t.consecutive401s += 1;
			if (t.consecutive401s >= 3) t.status = 'invalid';
		} else if (response.status >= 200 && response.status < 500 && response.status !== 429) {
			t.consecutive401s = 0;
		}

		// 429 -> bench the whole token for retryAfter * 1.5
		if (response.status === 429) {
			const retryAfterMs = response.retryAfterMs ?? 1000;
			const cooldownUntil = now + Math.ceil(retryAfterMs * COOLDOWN_BACKOFF_FACTOR);
			t.globalCooldownUntil = Math.max(t.globalCooldownUntil, cooldownUntil);
		}

		// Per-Discord-bucket update when header was present
		if (response.discordBucketHash) {
			const bucketState: BucketState = {
				remaining: response.remaining ?? 0,
				resetAt: now + (response.resetAfterMs ?? 0),
			};
			t.bucketStates[response.discordBucketHash] = bucketState;
			t.routeToBucket[response.routeKey] = response.discordBucketHash;
			evictOldestBucketsIfOverCap(t);
		}

		// 50001 Missing Access in a guild -> mark token ineligible for that guild
		if (response.status === 403 && response.code === 50001 && response.guildId) {
			const expiresAt = now + INELIGIBLE_GUILD_TTL_MS;
			pruneIneligibleGuilds(t, now);
			const existing: IneligibleGuild | undefined = t.ineligibleGuilds.find(
				(g) => g.guildId === response.guildId,
			);
			if (existing) {
				existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
			} else {
				t.ineligibleGuilds.push({ guildId: response.guildId, expiresAt });
			}
		}

		await this.ctx.storage.put(`${TOKEN_KEY_PREFIX}${label}`, t);
	}

	/**
	 * Register a new token. Caller must enforce pool cap before calling.
	 * Returns `{ ok: false, reason: 'label-exists' }` on duplicate label
	 * (rather than throwing) so the admin endpoint can surface a constant-time
	 * generic error without a workerd unhandled-rejection trace.
	 */
	async register(
		input: RegisterInput,
	): Promise<{ ok: true; label: string; registeredAt: number } | { ok: false; reason: 'label-exists' }> {
		const now = Date.now();
		const key = `${TOKEN_KEY_PREFIX}${input.label}`;
		const existing = await this.ctx.storage.get<TokenState>(key);
		if (existing) {
			return { ok: false, reason: 'label-exists' };
		}
		const t = makeTokenState(input, now);
		await this.ctx.storage.put(key, t);
		return { ok: true, label: t.label, registeredAt: t.registeredAt };
	}

	/** Delete a token. Idempotent. */
	async unregister(label: string): Promise<void> {
		await this.ctx.storage.delete(`${TOKEN_KEY_PREFIX}${label}`);
	}

	/** Reset a token to active status (operator action after fixing whatever caused 401s). */
	async reset(label: string): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
		const key = `${TOKEN_KEY_PREFIX}${label}`;
		const t = await this.ctx.storage.get<TokenState>(key);
		if (!t) return { ok: false, reason: 'not-found' };
		t.consecutive401s = 0;
		t.status = 'active';
		t.globalCooldownUntil = 0;
		t.ineligibleGuilds = [];
		await this.ctx.storage.put(key, t);
		return { ok: true };
	}

	/** List all tokens as TokenSummary (never returns the secret). */
	async list(): Promise<TokenSummary[]> {
		const tokens = await this.loadAllTokens();
		return tokens.map(summarize);
	}

	/** Per-slot rollup for /admin/health. */
	async health(): Promise<PoolHealth> {
		const now = Date.now();
		const tokens = await this.loadAllTokens();
		return {
			default: rollup(tokens, 'default', now),
			premium: rollup(tokens, 'premium', now),
		};
	}

	/** Count tokens currently registered to the given slot. Used by admin pool-cap check. */
	async countSlot(slot: Slot): Promise<number> {
		const tokens = await this.loadAllTokens();
		return tokens.filter((t) => t.slot === slot).length;
	}

	/**
	 * Override the fingerprint profile id for a specific token. Validated by
	 * the admin endpoint; the DO trusts the caller's `profileId` value. Returns
	 * `not-found` when the label does not exist so the admin layer can surface
	 * a constant-time generic 400.
	 */
	async setTokenFingerprintProfile(
		label: string,
		profileId: string,
	): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
		const key = `${TOKEN_KEY_PREFIX}${label}`;
		const t = await this.ctx.storage.get<TokenState>(key);
		if (!t) return { ok: false, reason: 'not-found' };
		t.fingerprintProfileId = profileId;
		await this.ctx.storage.put(key, t);
		return { ok: true };
	}

	/**
	 * Read the live build-number record. Null when no scrape has ever
	 * succeeded; callers fall back to FALLBACK_BUILD_NUMBER.
	 */
	async getBuildNumberRecord(): Promise<BuildNumberRecord | null> {
		const r = await this.ctx.storage.get<BuildNumberRecord>(BUILD_NUMBER_META_KEY);
		return r ?? null;
	}

	/** Persist a build-number record (scheduled scraper + admin refresh endpoint). */
	async setBuildNumberRecord(record: BuildNumberRecord): Promise<void> {
		await this.ctx.storage.put(BUILD_NUMBER_META_KEY, record);
	}

	/** Static-fingerprint identity per non-pool kind. Null when unset. */
	async getStaticFingerprint(kind: StaticTokenKind): Promise<StaticFingerprintRecord | null> {
		const r = await this.ctx.storage.get<StaticFingerprintRecord>(`${STATIC_FINGERPRINT_PREFIX}${kind}`);
		return r ?? null;
	}

	/** Persist a static-fingerprint identity. Validated upstream by admin endpoint. */
	async setStaticFingerprint(kind: StaticTokenKind, profileId: string): Promise<void> {
		const record: StaticFingerprintRecord = { profileId, assignedAt: Date.now() };
		await this.ctx.storage.put(`${STATIC_FINGERPRINT_PREFIX}${kind}`, record);
	}

	/** Read both static-fingerprint identities at once. Convenience for the admin GET. */
	async listStaticFingerprints(): Promise<{
		userDefault: string | null;
		userPremium: string | null;
	}> {
		const [d, p] = await Promise.all([
			this.getStaticFingerprint('user-default'),
			this.getStaticFingerprint('user-premium'),
		]);
		return {
			userDefault: d?.profileId ?? null,
			userPremium: p?.profileId ?? null,
		};
	}

	private async loadAllTokens(): Promise<TokenState[]> {
		const map = await this.ctx.storage.list<TokenState>({ prefix: TOKEN_KEY_PREFIX });
		return Array.from(map.values());
	}
}

/** Re-export profile validation helper so admin route doesn't need to import fingerprint internals. */
export function isKnownProfileId(profileId: string): boolean {
	return lookupProfile(profileId) !== undefined;
}

function rollup(tokens: TokenState[], slot: Slot, now: number): SlotHealth {
	const inSlot = tokens.filter((t) => t.slot === slot);
	let active = 0;
	let cooling = 0;
	let invalid = 0;
	for (const t of inSlot) {
		if ((t.status as TokenStatus) === 'invalid') {
			invalid += 1;
			continue;
		}
		if (t.status !== 'active') continue;
		if (t.globalCooldownUntil > now) {
			cooling += 1;
		} else {
			active += 1;
		}
	}
	return { count: inSlot.length, active, cooling, invalid };
}
