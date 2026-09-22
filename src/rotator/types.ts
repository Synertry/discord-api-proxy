/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/types
 * Core types for the multi-token user-pool rotator and the static-token
 * identity guard.
 *
 * The rotator is a Durable Object that holds N Discord user tokens, picks the
 * least-recently-used eligible one per request, and tracks per-Discord-bucket
 * cooldowns learned from `X-RateLimit-Bucket` response headers. The same DO
 * also guards the static `DISCORD_TOKEN_USER` / `DISCORD_TOKEN_USER_PREMIUM`
 * identities with an equivalent per-bucket budget plus abuse-signal circuits,
 * since those bypass the pool entirely but still need the same rate-limit and
 * captcha/Cloudflare backpressure.
 *
 * Static-guard state is keyed by the token's SHA-256 hash (`tokenHash`,
 * computed in the Worker via `hashToken` in `token-hash.ts`, never the raw
 * secret), not by `StaticTokenKind`: `DISCORD_TOKEN_USER` and
 * `DISCORD_TOKEN_USER_PREMIUM` may be the same underlying token, and keying
 * by kind alone would let one physical token accumulate two independent
 * budgets/circuits - effectively doubling its own rate-limit resistance.
 * Fingerprint *profile* assignment stays kind-keyed (`static-fingerprint:${kind}`):
 * that's an operator-UX choice ("what does the default slot look like"),
 * orthogonal to the physical token's abuse budget.
 */

import type { CustomProfile, ResolvedProfile } from '../fingerprint/profiles';
import type { ClientVersionRecords, ClientVersions } from '../fingerprint/versions';

/** Two strictly isolated pools. Default consumers never see premium tokens; vice versa. */
export type Slot = 'default' | 'premium';

/**
 * Static-token fingerprint identity. The static `DISCORD_TOKEN_USER` /
 * `DISCORD_TOKEN_USER_PREMIUM` tokens don't live in the DO, but their
 * fingerprint profile assignment and guard state do (so the same static
 * token always appears to Discord as the same client, and is rate-limited
 * as one identity).
 */
export type StaticTokenKind = 'user-default' | 'user-premium';

/** Every identity a fingerprint/session is derived for: a static token kind, or a pool token label. Kind-keyed for static (operator UX); see the module doc for why the *guard* uses a token hash instead. */
export type IdentityKey = `static:${StaticTokenKind}` | `pool:${string}`;

/**
 * Per-kind static fingerprint mapping (operator-set via /admin/static-fingerprint).
 * `custom` is present if and only if `profileId === 'custom'`.
 */
export type StaticFingerprintRecord =
  { profileId: string; custom?: never; assignedAt: number } | { profileId: 'custom'; custom: CustomProfile; assignedAt: number };

/** Status of a registered token. `invalid` blocks selection until an admin resets it. */
export type TokenStatus = 'active' | 'invalid' | 'suspended';

/** An abuse signal detected in a Discord response body: a captcha challenge, or a Cloudflare edge-level block (shared egress IP, not account-specific). */
export type AbuseSignal = 'captcha' | 'cloudflare';

/** An open circuit breaker for one identity, or - for the DO-wide `meta:upstream-circuit` record - every identity at once. */
export interface IdentityCircuit {
  signal: AbuseSignal;
  until: number;
  openedAt: number;
}

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
 * The rate-limit budget shared by pool tokens and static identities: per-
 * Discord-bucket cooldown state, a whole-identity global cooldown (429
 * bench), an abuse-signal circuit, and the identity-wide dispatch-gap floor.
 * `evaluateBudget` / `applyOutcome` in `budget.ts` operate purely on this
 * shape.
 */
export interface BucketBudget {
  bucketStates: Record<DiscordBucketHash, BucketState>;
  /** Learned from response `X-RateLimit-Bucket` headers per route. */
  routeToBucket: Record<RouteKey, DiscordBucketHash>;
  /** 0 unless a global 429 benched the whole identity. */
  globalCooldownUntil: number;
  circuit: IdentityCircuit | null;
  /**
   * Epoch ms of the last dispatched request for this identity, set at
   * lease/acquire time (not settle time - the gap is about dispatch
   * timing). `evaluateBudget` enforces `MIN_DISPATCH_GAP_MS` from this
   * value regardless of route or per-bucket `remaining` count: two
   * concurrent leases for the same identity can both see a bucket with
   * `remaining > 0` before either has actually dispatched, so the bucket
   * check alone cannot prevent two REST calls to the same identity under
   * 1s apart. This floor is identity-wide, not per-route, so e.g. a
   * typing-indicator dispatch and the message-send dispatch that follows
   * it are paced against each other too.
   */
  lastDispatchAt: number;
}

/**
 * Full per-token state stored in DO storage.
 *
 * Persisted under storage key `token:${label}`. The DO reads all token states at the
 * top of each acquire/release call, mutates in memory, and writes back. No long-lived
 * instance variables for token state - hibernation wipes them, storage survives.
 */
export interface TokenState extends BucketBudget {
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

/** One outstanding `leaseStatic` reservation, awaiting `settleStatic`. */
export interface PendingStaticLease {
  requestId: string;
  routeKey: RouteKey;
  leasedAt: number;
}

/**
 * Guard state for one static-token identity, keyed by `tokenHash` (see the
 * module doc). Persisted under storage key `static-guard:${tokenHash}`,
 * created lazily (empty budget) on first `leaseStatic` call for a hash that
 * has never been seen (`prepareStatic` is read-only and never creates one).
 */
export interface StaticIdentityState extends BucketBudget {
  tokenHash: string;
  lastSeenAt: number;
  /**
   * Leases issued by `leaseStatic` and not yet settled. `settleStatic`
   * applies an outcome only when its requestId is present here (and its
   * `routeKey` matches the leased one), then removes the entry - this
   * rejects an unknown requestId and a replayed duplicate of an
   * already-settled one alike, regardless of settle order. A single
   * last-requestId field (as `TokenState.lastReleaseRequestId` uses) only
   * catches a duplicate of the *most recent* settle; concurrent leases can
   * settle out of order, so a full tracking list is needed here.
   *
   * Entries past `STALE_LEASE_TTL_MS` (see `do.ts`) are pruned lazily on
   * the next `leaseStatic`/`settleStatic` call for this identity - the
   * request that issued them evidently crashed or hung before settling.
   * At `PENDING_LEASE_CAP`, `leaseStatic` rejects a new lease rather than
   * evicting a still-outstanding one, so a genuinely in-flight request's
   * eventual settle is never silently lost.
   */
  pendingLeases: PendingStaticLease[];
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

/** Parsed Discord response shape consumed by `release` / `settleStatic`. */
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
  /** Abuse signal detected in the response body (captcha challenge or Cloudflare edge block), if any. */
  signal?: AbuseSignal;
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

/** Why a static-identity request was blocked before it ever reached Discord. `capacity` is the pending-lease cap, not a Discord-reported cooldown - see `PENDING_LEASE_CAP` in `do.ts`. */
export interface IdentityBlock {
  reason: 'cooldown' | 'circuit' | 'capacity';
  retryAfter: number;
  signal?: AbuseSignal;
}

/** Result of `prepareStatic`: a read-only peek at the identity's fingerprint + live versions. No eligibility check, no mutation, no `routeKey` - safe to call from middleware on every request without leasing anything. */
export interface StaticPrepareResult {
  fingerprint: StaticFingerprintRecord | null;
  versions: ClientVersionRecords;
}

/** Result of `leaseStatic`: either a reservation (carrying a `requestId` for `settleStatic`'s idempotency, matching the pool's acquire/release pattern) or a block. */
export type LeaseStaticResult = { ok: true; requestId: string } | { ok: false; block: IdentityBlock };

/** The resolved identity for one request: which token, whose fingerprint. Set by the identity middleware for both pool and static paths. */
export interface RequestIdentity {
  key: IdentityKey;
  kind: 'static' | 'pool';
  staticKind?: StaticTokenKind;
  label?: string;
  profile: ResolvedProfile;
}

/**
 * Recorded by the identity middleware when the route is pool-eligible
 * (rotatable, and the caller didn't explicitly pin `X-Proxy-Token: static`).
 * Carries everything `proxy.ts` needs to attempt `acquire`/`acquireByLabel`
 * itself, immediately before dispatch - the middleware never calls them, so
 * no pool lease is ever granted anywhere but the point of use.
 */
export interface PoolPlan {
  slot: Slot;
  /** `'auto'` for LRU selection, or a specific label to pin via `acquireByLabel`. */
  selector: 'auto' | { label: string };
  routeKey: RouteKey;
  guildId?: string;
}

/**
 * Hono context variables set by the identity middleware.
 * Intersected with `AuthVariables & DiscordContextVariables` at the app level.
 */
export interface RotatorVariables {
  /**
   * Fallback identity for this request, resolved read-only by the
   * middleware via `prepareStatic` - always set for non-bot requests. When
   * `poolPlan` is also set and its `acquire`/`acquireByLabel` call succeeds,
   * `proxy.ts` uses the pool-resolved identity instead of this one; on an
   * `empty-pool`/`no-eligible-token` fallback, this is what gets used.
   */
  identity?: RequestIdentity;
  /** Live client versions resolved for this request (DO-wide, not identity-specific, so the same value is valid for either path). */
  clientVersions?: ClientVersions;
  /** Set only when the route is pool-eligible; absent means static-only (proxy.ts must use `identity` above and `leaseStatic`/`settleStatic`). */
  poolPlan?: PoolPlan;
  /** Lazily-constructed client. Tests inject via createApp(_, mockTokenPool). */
  tokenPoolClient?: TokenPoolClient;
}

/**
 * Worker-side client interface. Implementations: real DO-backed (production)
 * and `vi.fn()`-backed (tests).
 *
 * `acquireByLabel` is optional so existing test mocks need only `acquire` +
 * `release`; the real client always implements it. Static-identity guard
 * methods (`prepareStatic`, `leaseStatic`, `settleStatic`, `getClientVersions`)
 * are likewise optional so a mock that only exercises the pool path can omit
 * them; the identity middleware falls back to the fallback profile/versions
 * and no guard when they're absent (the static path stays first-class with
 * zero DO binding, e.g. in unit tests).
 */
export interface TokenPoolClient {
  acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult>;
  acquireByLabel?(label: string, slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult>;
  release(label: string, requestId: string, response: ReleaseInput): Promise<void>;
  /**
   * Read-only identity peek: fingerprint + live versions for `kind`, no
   * eligibility check, no `routeKey`, no lease. Called once per request by
   * the identity middleware to build the response identity/headers context.
   * The actual budget lease happens at the point of each outbound fetch via
   * `leaseStatic`, never here - see the module doc on `do.ts` for why.
   */
  prepareStatic?(kind: StaticTokenKind): Promise<StaticPrepareResult>;
  /**
   * Reserve the budget for one outbound fetch on `routeKey`, immediately
   * before dispatching it. `tokenHash` is the SHA-256 hex of the static
   * token, computed by the caller (see `token-hash.ts`); `kind` selects the
   * fingerprint-profile lookup only, never the guard's storage key.
   */
  leaseStatic?(kind: StaticTokenKind, tokenHash: string, routeKey: RouteKey): Promise<LeaseStaticResult>;
  /** Settle a lease immediately after its fetch completes. Idempotent on `requestId`, mirroring `release`. */
  settleStatic?(kind: StaticTokenKind, tokenHash: string, requestId: string, outcome: ReleaseInput): Promise<void>;
  getClientVersions?(): Promise<ClientVersionRecords>;
}
