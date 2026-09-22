/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/do
 * `TokenPoolDO`: the Durable Object backing the multi-token user-pool
 * rotator and the static-token identity guard.
 *
 * Two independent identity spaces share this one DO instance:
 *  - Pool tokens (`token:${label}`), picked LRU per `acquire`/`acquireByLabel`.
 *  - Static identities (`static-guard:${tokenHash}`), the `DISCORD_TOKEN_USER`
 *    / `DISCORD_TOKEN_USER_PREMIUM` tokens that bypass the pool entirely but
 *    still need the same per-bucket budget and abuse-signal circuit backing.
 *
 * Both share the pure budget logic in `budget.ts` (`TokenState` and
 * `StaticIdentityState` both extend `BucketBudget`). A single DO-wide
 * `meta:upstream-circuit` record blocks every identity at once on a
 * Cloudflare/edge-level signal (shared egress IP - not account-specific);
 * `applyOutcome` never writes to that record itself, so a per-identity
 * `release`/`recordStaticOutcome` call always applies `openUpstreamCircuit`
 * as a second, explicit step.
 */

import { DurableObject } from 'cloudflare:workers';
import { applyOutcome, evaluateBudget, markDispatched, openUpstreamCircuit } from './budget';
import { chooseToken, evaluateTokenEligibility } from './selection';
import { pruneIneligibleGuilds } from './validators';
import { lookupProfile, listProfileIds } from '../fingerprint/profiles';
import { BUILD_NUMBER_META_KEY, CHROME_VERSION_META_KEY } from '../fingerprint/versions';
import { fnv1a32 } from '../fingerprint/hash';
import type { Bindings } from '../types';
import type { CustomProfile } from '../fingerprint/profiles';
import type { BuildNumberRecord, ChromeVersionRecord, ClientVersionRecords } from '../fingerprint/versions';
import type {
  AcquireResult,
  BucketBudget,
  IdentityCircuit,
  IneligibleGuild,
  LeaseStaticResult,
  PendingStaticLease,
  PoolHealth,
  RegisterInput,
  ReleaseInput,
  RouteKey,
  Slot,
  SlotHealth,
  StaticFingerprintRecord,
  StaticIdentityState,
  StaticPrepareResult,
  StaticTokenKind,
  TokenState,
  TokenStatus,
  TokenSummary,
} from './types';

export const TOKEN_KEY_PREFIX = 'token:';
export const STATIC_FINGERPRINT_PREFIX = 'static-fingerprint:';
export const STATIC_GUARD_PREFIX = 'static-guard:';
export const META_UPSTREAM_CIRCUIT_KEY = 'meta:upstream-circuit';
const INELIGIBLE_GUILD_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Max concurrent outstanding leases per static identity. Generous: the budget/circuit backpressure keeps real concurrency low; this cap exists to bound storage, not to be a normal operating limit. */
export const PENDING_LEASE_CAP = 50;
/**
 * A pending lease older than this is treated as abandoned (its request
 * crashed or hung before calling `settleStatic`) and pruned lazily. Set
 * comfortably above the outbound fetch's own `AbortSignal.timeout(60_000)`
 * (see `proxy.ts`) so a legitimately slow-but-live request is never pruned
 * out from under its own eventual settle.
 */
const STALE_LEASE_TTL_MS = 120_000;

/** An empty budget for a newly-seen identity (pool or static). */
function emptyBudget(): BucketBudget {
  return { bucketStates: {}, routeToBucket: {}, globalCooldownUntil: 0, circuit: null, lastDispatchAt: 0 };
}

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
    ...emptyBudget(),
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
 */
export function pickProfileId(label: string, profileIds: readonly string[]): string {
  if (profileIds.length === 0) return 'chrome-win-de';
  const h = fnv1a32(label);
  return profileIds[h % profileIds.length];
}

/** Hydrate a token/identity read from storage that may predate a field being added, so an old record never crashes a budget read. */
function hydrateBudget<T extends Partial<BucketBudget>>(raw: T): T & BucketBudget {
  return {
    ...raw,
    bucketStates: raw.bucketStates ?? {},
    routeToBucket: raw.routeToBucket ?? {},
    globalCooldownUntil: raw.globalCooldownUntil ?? 0,
    circuit: raw.circuit ?? null,
    lastDispatchAt: raw.lastDispatchAt ?? 0,
  };
}

/** A fresh, empty guard for a static identity never seen before. */
function freshStaticGuard(tokenHash: string, now: number): StaticIdentityState {
  return { tokenHash, lastSeenAt: now, pendingLeases: [], ...emptyBudget() };
}

/** Hydrate a static-guard record read from storage, tolerating a record written before `pendingLeases` existed. */
function hydrateStaticGuard(raw: StaticIdentityState, tokenHash: string): StaticIdentityState {
  return { ...hydrateBudget(raw), tokenHash, pendingLeases: raw.pendingLeases ?? [] };
}

/** Drop leases older than `STALE_LEASE_TTL_MS`: their request evidently crashed or hung before settling. */
function prunePendingLeases(leases: readonly PendingStaticLease[], now: number): PendingStaticLease[] {
  return leases.filter((l) => now - l.leasedAt < STALE_LEASE_TTL_MS);
}

/**
 * TokenPoolDO holds the token pool and the static-identity guard. Bound as
 * `TOKEN_POOL` in wrangler.jsonc. Single instance: callers resolve via
 * `idFromName('token-pool-v1')`.
 */
export class TokenPoolDO extends DurableObject<Bindings> {
  /**
   * Acquire a token for the given slot + route. Updates lastUsedAt and
   * inFlightCount on the chosen token; persists immediately. If the chosen
   * token has no `fingerprintProfileId` yet, assigns one deterministically.
   */
  async acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
    const now = Date.now();
    const [tokens, upstreamCircuit] = await Promise.all([this.loadAllTokens(), this.getUpstreamCircuit()]);

    const result = chooseToken(tokens, slot, routeKey, now, guildId, upstreamCircuit);
    if (!result.chosen) {
      return result.unavailable!;
    }

    const t = markDispatched(result.chosen, now);
    t.lastUsedAt = now;
    t.inFlightCount += 1;

    // First-use fingerprint assignment, persisted immediately.
    if (!t.fingerprintProfileId || !lookupProfile(t.fingerprintProfileId)) {
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
   * Acquire a specific token by label - the pin-to-label path used by the
   * `X-Proxy-Token: <label>` request header. Same mutations as `acquire` on
   * success; same eligibility semantics enforced by `evaluateTokenEligibility`.
   *
   * Returns `{ ok: false, reason: 'no-eligible-token' }` when the label does
   * not exist, the slot mismatches, the status is not active, or the requested
   * guild is permanently outside this token's whitelist. Returns
   * `{ ok: false, reason: 'cooldown', retryAfter }` for time-bounded constraints
   * (globalCooldownUntil, bucket cooling, an open circuit, ineligibleGuilds TTL).
   */
  async acquireByLabel(label: string, slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
    const now = Date.now();
    const [raw, upstreamCircuit] = await Promise.all([
      this.ctx.storage.get<TokenState>(`${TOKEN_KEY_PREFIX}${label}`),
      this.getUpstreamCircuit(),
    ]);
    if (!raw) {
      return { ok: false, reason: 'no-eligible-token', retryAfter: 60_000 };
    }
    const hydrated = hydrateBudget(raw);

    const verdict = evaluateTokenEligibility(hydrated, slot, routeKey, now, guildId, upstreamCircuit);
    if (!verdict.ok) {
      if (verdict.reason === 'cooldown') {
        return { ok: false, reason: 'cooldown', retryAfter: verdict.retryAfter };
      }
      return { ok: false, reason: 'no-eligible-token', retryAfter: 60_000 };
    }

    const t = markDispatched(hydrated, now);
    t.lastUsedAt = now;
    t.inFlightCount += 1;

    if (!t.fingerprintProfileId || !lookupProfile(t.fingerprintProfileId)) {
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
   * Release a token after a Discord call completes. Updates per-bucket
   * cooldown state and (on a captcha signal) this token's own circuit via
   * `applyOutcome`; on a Cloudflare signal, also opens the DO-wide upstream
   * circuit via `openUpstreamCircuit`, since that blocks every identity, not
   * just this token. Stale-write protection: out-of-order or duplicate
   * release calls are ignored (idempotent on requestId).
   */
  async release(label: string, requestId: string, outcome: ReleaseInput): Promise<void> {
    const now = Date.now();
    const raw = await this.ctx.storage.get<TokenState>(`${TOKEN_KEY_PREFIX}${label}`);
    if (!raw) return; // Token deleted before release; drop silently.
    const t = hydrateBudget(raw);

    // Stale-write guard: duplicate or out-of-order
    if (t.lastReleaseRequestId === requestId) return;
    if (t.lastReleaseAt > now) return;

    t.inFlightCount = Math.max(0, t.inFlightCount - 1);
    t.lastReleaseRequestId = requestId;
    t.lastReleaseAt = now;

    // 401 -> circuit breaker on 3 consecutive
    if (outcome.status === 401) {
      t.consecutive401s += 1;
      if (t.consecutive401s >= 3) t.status = 'invalid';
    } else if (outcome.status >= 200 && outcome.status < 500 && outcome.status !== 429) {
      t.consecutive401s = 0;
    }

    const budgetBefore = t.circuit;
    const budgetAfter = applyOutcome(t, outcome, now);
    t.bucketStates = budgetAfter.bucketStates;
    t.routeToBucket = budgetAfter.routeToBucket;
    t.globalCooldownUntil = budgetAfter.globalCooldownUntil;
    t.circuit = budgetAfter.circuit;
    if (!budgetBefore && t.circuit) {
      console.error('IDENTITY_GUARD circuit opened', { identity: `pool:${label}`, signal: t.circuit.signal, until: t.circuit.until });
    }

    // 50001 Missing Access in a guild -> mark token ineligible for that guild
    if (outcome.status === 403 && outcome.code === 50001 && outcome.guildId) {
      const expiresAt = now + INELIGIBLE_GUILD_TTL_MS;
      pruneIneligibleGuilds(t, now);
      const existing: IneligibleGuild | undefined = t.ineligibleGuilds.find((g) => g.guildId === outcome.guildId);
      if (existing) {
        existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
      } else {
        t.ineligibleGuilds.push({ guildId: outcome.guildId, expiresAt });
      }
    }

    await Promise.all([this.ctx.storage.put(`${TOKEN_KEY_PREFIX}${label}`, t), this.applyUpstreamCircuit(outcome, now)]);
  }

  /**
   * Read-only identity peek for a static kind: fingerprint + live client
   * versions, no eligibility check, no lease, no mutation. Called once per
   * request by the identity middleware to build the response headers; the
   * actual budget reservation happens per-outbound-fetch via `leaseStatic`.
   */
  async prepareStatic(kind: StaticTokenKind): Promise<StaticPrepareResult> {
    const map = await this.ctx.storage.get<unknown>([
      `${STATIC_FINGERPRINT_PREFIX}${kind}`,
      BUILD_NUMBER_META_KEY,
      CHROME_VERSION_META_KEY,
    ]);
    return {
      fingerprint: (map.get(`${STATIC_FINGERPRINT_PREFIX}${kind}`) as StaticFingerprintRecord | undefined) ?? null,
      versions: {
        build: (map.get(BUILD_NUMBER_META_KEY) as BuildNumberRecord | undefined) ?? null,
        chrome: (map.get(CHROME_VERSION_META_KEY) as ChromeVersionRecord | undefined) ?? null,
      },
    };
  }

  /**
   * Reserve the budget for one outbound fetch on `routeKey`, immediately
   * before dispatching it. `tokenHash` (see `token-hash.ts`) keys the
   * guard state, not `kind`: two static kinds may be the same underlying
   * token, and kind alone would let it accumulate two independent budgets.
   * On success, records the issued lease in `pendingLeases` so `settleStatic`
   * can validate against it; rejects with `reason: 'capacity'` at
   * `PENDING_LEASE_CAP` rather than evicting a still-outstanding lease.
   */
  async leaseStatic(kind: StaticTokenKind, tokenHash: string, routeKey: RouteKey): Promise<LeaseStaticResult> {
    const now = Date.now();
    const guardKey = `${STATIC_GUARD_PREFIX}${tokenHash}`;
    const [raw, upstreamCircuit] = await Promise.all([this.ctx.storage.get<StaticIdentityState>(guardKey), this.getUpstreamCircuit()]);
    const guard: StaticIdentityState = raw ? hydrateStaticGuard(raw, tokenHash) : freshStaticGuard(tokenHash, now);
    guard.pendingLeases = prunePendingLeases(guard.pendingLeases, now);

    const eligibility = evaluateBudget(guard, routeKey, now, upstreamCircuit);
    if (!eligibility.ok) {
      return { ok: false, block: { reason: 'cooldown', retryAfter: eligibility.retryAfter, signal: eligibility.signal } };
    }
    if (guard.pendingLeases.length >= PENDING_LEASE_CAP) {
      console.error('IDENTITY_GUARD pending-lease cap reached', { identity: `static:${kind}`, cap: PENDING_LEASE_CAP });
      return { ok: false, block: { reason: 'capacity', retryAfter: 1000 } };
    }

    guard.lastDispatchAt = now;
    guard.lastSeenAt = now;
    const requestId = crypto.randomUUID();
    guard.pendingLeases.push({ requestId, routeKey, leasedAt: now });
    await this.ctx.storage.put(guardKey, guard);

    return { ok: true, requestId };
  }

  /**
   * Settle a lease immediately after its fetch completes. Applies the
   * outcome via `applyOutcome` (identity-scoped: bucket, global cooldown,
   * captcha circuit) plus `openUpstreamCircuit` on a Cloudflare signal
   * (DO-wide). A no-op when `requestId` is not a currently-pending lease
   * for this identity - an unknown id, a replayed duplicate of an
   * already-settled lease, or one pruned as abandoned all land here safely.
   */
  async settleStatic(kind: StaticTokenKind, tokenHash: string, requestId: string, outcome: ReleaseInput): Promise<void> {
    const now = Date.now();
    const guardKey = `${STATIC_GUARD_PREFIX}${tokenHash}`;
    const raw = await this.ctx.storage.get<StaticIdentityState>(guardKey);
    if (!raw) return;
    const guard = hydrateStaticGuard(raw, tokenHash);
    guard.pendingLeases = prunePendingLeases(guard.pendingLeases, now);

    const lease = guard.pendingLeases.find((l) => l.requestId === requestId);
    if (!lease) return; // Unknown, already-settled, or pruned-as-abandoned - drop silently, matching `release`'s stale-write guard.
    if (lease.routeKey !== outcome.routeKey) {
      console.error('IDENTITY_GUARD settle routeKey mismatch, dropping', {
        identity: `static:${kind}`,
        leasedRoute: lease.routeKey,
        outcomeRoute: outcome.routeKey,
      });
      return;
    }
    guard.pendingLeases = guard.pendingLeases.filter((l) => l.requestId !== requestId);

    const before = guard.circuit;
    const after = applyOutcome(guard, outcome, now);
    guard.bucketStates = after.bucketStates;
    guard.routeToBucket = after.routeToBucket;
    guard.globalCooldownUntil = after.globalCooldownUntil;
    guard.circuit = after.circuit;
    guard.lastSeenAt = now;
    if (!before && guard.circuit) {
      console.error('IDENTITY_GUARD circuit opened', {
        identity: `static:${kind}`,
        signal: guard.circuit.signal,
        until: guard.circuit.until,
      });
    }

    await Promise.all([this.ctx.storage.put(guardKey, guard), this.applyUpstreamCircuit(outcome, now)]);
  }

  /** Register a new token. Caller must enforce pool cap before calling. */
  async register(input: RegisterInput): Promise<{ ok: true; label: string; registeredAt: number } | { ok: false; reason: 'label-exists' }> {
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
    const raw = await this.ctx.storage.get<TokenState>(key);
    if (!raw) return { ok: false, reason: 'not-found' };
    const t = hydrateBudget(raw);
    t.consecutive401s = 0;
    t.status = 'active';
    t.globalCooldownUntil = 0;
    t.circuit = null;
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
  async setTokenFingerprintProfile(label: string, profileId: string): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
    const key = `${TOKEN_KEY_PREFIX}${label}`;
    const t = await this.ctx.storage.get<TokenState>(key);
    if (!t) return { ok: false, reason: 'not-found' };
    t.fingerprintProfileId = profileId;
    await this.ctx.storage.put(key, t);
    return { ok: true };
  }

  /** Read both live version records. Callers resolve missing/stale fields via `resolveClientVersions`. */
  async getClientVersions(): Promise<ClientVersionRecords> {
    const map = await this.ctx.storage.get<unknown>([BUILD_NUMBER_META_KEY, CHROME_VERSION_META_KEY]);
    return {
      build: (map.get(BUILD_NUMBER_META_KEY) as BuildNumberRecord | undefined) ?? null,
      chrome: (map.get(CHROME_VERSION_META_KEY) as ChromeVersionRecord | undefined) ?? null,
    };
  }

  /** Persist a build-number record (scheduled scraper + admin refresh endpoint). */
  async setBuildNumberRecord(record: BuildNumberRecord): Promise<void> {
    await this.ctx.storage.put(BUILD_NUMBER_META_KEY, record);
  }

  /** Persist a Chrome-stable-major record (scheduled scraper + admin refresh endpoint). */
  async setChromeVersionRecord(record: ChromeVersionRecord): Promise<void> {
    await this.ctx.storage.put(CHROME_VERSION_META_KEY, record);
  }

  /**
   * Persist a static-fingerprint identity: either a registered template id,
   * or an operator-captured clone profile. Validated upstream by the admin
   * endpoint (`validateCustomProfile` / `isKnownProfileId`); the DO trusts
   * the caller's input.
   */
  async setStaticFingerprint(kind: StaticTokenKind, input: { profileId: string } | { custom: CustomProfile }): Promise<void> {
    const record: StaticFingerprintRecord =
      'custom' in input
        ? { profileId: 'custom', custom: input.custom, assignedAt: Date.now() }
        : { profileId: input.profileId, assignedAt: Date.now() };
    await this.ctx.storage.put(`${STATIC_FINGERPRINT_PREFIX}${kind}`, record);
  }

  /** Read both static-fingerprint identities at once. Convenience for the admin GET. */
  async listStaticFingerprints(): Promise<{ userDefault: StaticFingerprintRecord | null; userPremium: StaticFingerprintRecord | null }> {
    const map = await this.ctx.storage.get<StaticFingerprintRecord>([
      `${STATIC_FINGERPRINT_PREFIX}user-default`,
      `${STATIC_FINGERPRINT_PREFIX}user-premium`,
    ]);
    return {
      userDefault: map.get(`${STATIC_FINGERPRINT_PREFIX}user-default`) ?? null,
      userPremium: map.get(`${STATIC_FINGERPRINT_PREFIX}user-premium`) ?? null,
    };
  }

  private async loadAllTokens(): Promise<TokenState[]> {
    const map = await this.ctx.storage.list<TokenState>({ prefix: TOKEN_KEY_PREFIX });
    return Array.from(map.values()).map(hydrateBudget);
  }

  private async getUpstreamCircuit(): Promise<IdentityCircuit | null> {
    const r = await this.ctx.storage.get<IdentityCircuit>(META_UPSTREAM_CIRCUIT_KEY);
    return r ?? null;
  }

  /** Apply a Cloudflare signal (if any) to the DO-wide upstream circuit. A no-op for every other outcome. */
  private async applyUpstreamCircuit(outcome: ReleaseInput, now: number): Promise<void> {
    const existing = await this.getUpstreamCircuit();
    const next = openUpstreamCircuit(existing, outcome, now);
    if (next === existing) return;
    if (!existing && next) {
      console.error('IDENTITY_GUARD circuit opened', { identity: 'upstream (DO-wide)', signal: next.signal, until: next.until });
    }
    if (next) {
      await this.ctx.storage.put(META_UPSTREAM_CIRCUIT_KEY, next);
    } else {
      await this.ctx.storage.delete(META_UPSTREAM_CIRCUIT_KEY);
    }
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
    if (t.status === 'invalid') {
      invalid++;
      continue;
    }
    if (t.globalCooldownUntil > now || (t.circuit && t.circuit.until > now)) {
      cooling++;
    } else {
      active++;
    }
  }
  return { count: inSlot.length, active, cooling, invalid };
}
