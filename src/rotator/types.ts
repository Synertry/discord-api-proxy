/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/types
 * Core types for the multi-token user-pool rotator.
 *
 * The rotator is a Durable Object that holds N Discord user tokens, picks the
 * least-recently-used eligible one per request, and tracks per-Discord-bucket
 * cooldowns learned from `X-RateLimit-Bucket` response headers.
 */

/** Two strictly isolated pools. Default consumers never see premium tokens; vice versa. */
export type Slot = 'default' | 'premium';

/**
 * Static-token fingerprint identity. The static `DISCORD_TOKEN_USER` /
 * `DISCORD_TOKEN_USER_PREMIUM` tokens don't live in the DO, but their
 * fingerprint profile assignment does (so the same static token always
 * appears to Discord as the same client).
 */
export type StaticTokenKind = 'user-default' | 'user-premium';

/** Per-kind static fingerprint mapping (operator-set via /admin/static-fingerprint). */
export interface StaticFingerprintRecord {
	profileId: string;
	assignedAt: number;
}

/** Status of a registered token. `invalid` blocks selection until an admin resets it. */
export type TokenStatus = 'active' | 'invalid' | 'suspended';

/** Value of Discord's `X-RateLimit-Bucket` response header (an opaque hash). */
export type DiscordBucketHash = string;

/** Our derived `${METHOD}:${normalizedPath}` form. Used as a lookup key into routeToBucket. */
export type RouteKey = string;

/** Per-bucket cooldown state. */
export interface BucketState {
	remaining: number;
	resetAt: number;
}

/** TTL'd guild ineligibility (e.g. discovered via 50001 Missing Access). */
export interface IneligibleGuild {
	guildId: string;
	expiresAt: number;
}

/**
 * Full per-token state stored in DO storage.
 *
 * Persisted under storage key `token:${label}`. The DO reads all token states at the
 * top of each acquire/release call, mutates in memory, and writes back. No long-lived
 * instance variables for token state - hibernation wipes them, storage survives.
 */
export interface TokenState {
	/** Operator-chosen label, opaque, unique within the pool. */
	label: string;
	slot: Slot;
	/** Raw Discord token. Never logged, never returned in admin GET responses. */
	tokenSecret: string;
	/** Optional whitelist; empty/undefined means "try everywhere". */
	guildIds?: string[];
	status: TokenStatus;
	/** 3 consecutive 401s -> status = 'invalid'. Reset by admin endpoint. */
	consecutive401s: number;
	/** Epoch ms; LRU tiebreaker after inFlightCount. */
	lastUsedAt: number;
	/** Outstanding acquire-without-release count. Preferential filter, not exclusive. */
	inFlightCount: number;
	/** 0 unless a global 429 benched the whole token. */
	globalCooldownUntil: number;
	bucketStates: Record<DiscordBucketHash, BucketState>;
	/** Learned from response `X-RateLimit-Bucket` headers per route. */
	routeToBucket: Record<RouteKey, DiscordBucketHash>;
	ineligibleGuilds: IneligibleGuild[];
	/** Last release's requestId; gates stale-write protection. */
	lastReleaseRequestId: string | null;
	/** Epoch ms of last release; gates stale-write protection. */
	lastReleaseAt: number;
	registeredAt: number;
	/**
	 * Assigned fingerprint profile id. Optional for tokens registered before the
	 * fingerprint-hygiene feature shipped; the DO assigns one deterministically
	 * on first `acquire()` and persists immediately. Once set it is stable -
	 * growing the profile registry later does NOT reshuffle existing tokens.
	 */
	fingerprintProfileId?: string;
}

/** Reason an acquire failed when no eligible token is available. */
export type UnavailableReason = 'cooldown' | 'empty-pool' | 'no-eligible-token';

/** Successful acquire payload. The Worker forwards `tokenSecret` to Discord. */
export interface AcquireSuccess {
	ok: true;
	label: string;
	tokenSecret: string;
	requestId: string;
	/** Always populated - assignment happens at acquire time if not already set. */
	fingerprintProfileId: string;
}

export interface AcquireUnavailable {
	ok: false;
	reason: UnavailableReason;
	retryAfter: number;
}

export type AcquireResult = AcquireSuccess | AcquireUnavailable;

/** Parsed Discord response shape consumed by `release`. */
export interface ReleaseInput {
	status: number;
	routeKey: RouteKey;
	/** From `X-RateLimit-Bucket` header. Absent for some 5xx and network errors. */
	discordBucketHash?: DiscordBucketHash;
	/** From `X-RateLimit-Remaining` header. */
	remaining?: number;
	/** Computed from `X-RateLimit-Reset-After` header (seconds -> ms). */
	resetAfterMs?: number;
	/** From `Retry-After` header on 429 (seconds -> ms). */
	retryAfterMs?: number;
	/** Discord error code from response body (e.g. 50001 for Missing Access). */
	code?: number;
	/** Guild context for 50001 ineligibility tracking. */
	guildId?: string;
}

/** Public-safe summary returned by `GET /admin/tokens`. tokenSecret is NEVER included. */
export interface TokenSummary {
	label: string;
	slot: Slot;
	status: TokenStatus;
	consecutive401s: number;
	lastUsedAt: number;
	inFlightCount: number;
	globalCooldownUntil: number;
	bucketCount: number;
	registeredAt: number;
	guildIds?: string[];
	/** Assigned fingerprint profile id. Undefined for tokens that have never been acquired. */
	fingerprintProfileId?: string;
}

/** Per-slot health rollup returned by `GET /admin/health`. */
export interface SlotHealth {
	count: number;
	active: number;
	cooling: number;
	invalid: number;
}

export interface PoolHealth {
	default: SlotHealth;
	premium: SlotHealth;
}

/** Input to `register` (admin POST /admin/tokens). */
export interface RegisterInput {
	label: string;
	slot: Slot;
	tokenSecret: string;
	guildIds?: string[];
}

/**
 * Hono context variables set by the rotator middleware.
 * Intersected with `AuthVariables & DiscordContextVariables` at the app level.
 */
export interface RotatorVariables {
	/** Set when the rotator middleware acquired a token. Triggers release in proxy.ts. */
	acquiredLabel?: string;
	acquiredRequestId?: string;
	/** Profile id of the acquired pool token (always set on rotation success). */
	acquiredFingerprintProfileId?: string;
	/** Lazily-constructed client. Tests inject via createApp(_, mockTokenPool). */
	tokenPoolClient?: TokenPoolClient;
}

/**
 * Worker-side client interface. Implementations: real DO-backed (production)
 * and `vi.fn()`-backed (tests).
 *
 * Fingerprint methods are optional so existing tests can mock with just
 * acquire/release; the real client always implements them. Call sites use
 * optional chaining with sensible fallbacks (FALLBACK_BUILD_NUMBER, etc.).
 */
export interface TokenPoolClient {
	acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult>;
	release(label: string, requestId: string, response: ReleaseInput): Promise<void>;
	getStaticFingerprint?(kind: StaticTokenKind): Promise<StaticFingerprintRecord | null>;
	getBuildNumberRecord?(): Promise<import('../fingerprint/build-number').BuildNumberRecord | null>;
}
