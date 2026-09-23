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
 * `release`/`settleStatic` call always applies `openUpstreamCircuit`
 * as a second, explicit step.
 */

import { DurableObject } from 'cloudflare:workers';
import { applyOutcome, evaluateBudget, grantLease, openUpstreamCircuit, pruneLeases } from './budget';
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
  IdentityBlock,
  IdentityCircuit,
  IneligibleGuild,
  LeaseStaticResult,
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

/** An empty budget for a newly-seen identity (pool or static). */
function emptyBudget(): BucketBudget {
  return { bucketStates: {}, routeToBucket: {}, globalCooldownUntil: 0, circuit: null, lastDispatchAt: 0, leases: [] };
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
    leases: raw.leases ?? [],
  };
}

/**
 * Hydrate a pool token read from storage. A `token:<label>` row persisted
 * before leases existed carries an `inFlightCount` but no `leases` field at
 * all. With no lease on the record, no later `release` can ever match one, so
 * that count could only stay inflated (and keep the token penalized in LRU
 * selection) forever: start such a token from zero in-flight.
 */
function hydrateToken(raw: TokenState): TokenState {
  const hydrated = hydrateBudget(raw);
  if (raw.leases !== undefined) return hydrated;
  return { ...hydrated, inFlightCount: 0 };
}

/**
 * Drop a pool token's abandoned leases and reconcile `inFlightCount` to the
 * leases that remain: the count is what LRU selection orders by, so a lease
 * past `LEASE_TTL_MS` must stop counting against its token, not merely stop
 * being listed. Returns the input unchanged when nothing was pruned (leaving
 * `inFlightCount` - which normally equals `leases.length` - untouched).
 */
function pruneTokenLeases(token: TokenState, now: number): TokenState {
  const pruned = pruneLeases(token, now);
  if (pruned === token) return token;
  return { ...pruned, inFlightCount: pruned.leases.length };
}

/** A fresh, empty guard for a static identity never seen before. */
function freshStaticGuard(identityHash: string, now: number): StaticIdentityState {
  return { identityHash, lastSeenAt: now, ...emptyBudget() };
}

/** Hydrate a static-guard record read from storage, tolerating a record written before a field existed. */
function hydrateStaticGuard(raw: StaticIdentityState, identityHash: string): StaticIdentityState {
  return { ...hydrateBudget(raw), identityHash };
}

/**
 * TokenPoolDO holds the token pool and the static-identity guard. Bound as
 * `TOKEN_POOL` in wrangler.jsonc. Single instance: callers resolve via
 * `idFromName('token-pool-v1')`.
 */
export class TokenPoolDO extends DurableObject<Bindings> {
  /**
   * Tail of this instance's mutation queue. Every read-modify-write RPC
   * (acquire, acquireByLabel, release, leaseStatic, settleStatic, register,
   * reset, setTokenFingerprintProfile) runs through `#serialize`, so two calls
   * can never both read the same record, both decide from it, and have the
   * later write silently discard the earlier one. Input gates are documented
   * to prevent that interleaving for storage calls, but a lost lease (two
   * concurrent `leaseStatic` calls both granted, one persisted) was observed
   * under concurrent load in the Workers test runtime, and a dropped lease is
   * exactly the double dispatch this guard exists to prevent - so the
   * ordering is made explicit instead of assumed. Reads stay unqueued.
   */
  #mutationTail: Promise<unknown> = Promise.resolve();

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(fn);
    // The queue only tracks completion; `run` still rejects to its own caller.
    this.#mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Acquire a token for the given slot + route. Updates lastUsedAt and
   * inFlightCount on the chosen token; persists immediately. If the chosen
   * token has no `fingerprintProfileId` yet, assigns one deterministically.
   */
  async acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
    return this.#serialize(() => this.#acquire(slot, routeKey, guildId));
  }

  async #acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
    const now = Date.now();
    const [rawTokens, upstreamCircuit] = await Promise.all([this.loadAllTokens(), this.getUpstreamCircuit()]);
    const tokens = rawTokens.map((raw) => pruneTokenLeases(raw, now));

    const result = chooseToken(tokens, slot, routeKey, now, guildId, upstreamCircuit);
    if (!result.chosen) {
      return result.unavailable!;
    }

    const requestId = crypto.randomUUID();
    const t = grantLease(result.chosen, routeKey, requestId, now);
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
      requestId,
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
    return this.#serialize(() => this.#acquireByLabel(label, slot, routeKey, guildId));
  }

  async #acquireByLabel(label: string, slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
    const now = Date.now();
    const [raw, upstreamCircuit] = await Promise.all([
      this.ctx.storage.get<TokenState>(`${TOKEN_KEY_PREFIX}${label}`),
      this.getUpstreamCircuit(),
    ]);
    if (!raw) {
      return { ok: false, reason: 'no-eligible-token', retryAfter: 60_000 };
    }
    const hydrated = pruneTokenLeases(hydrateToken(raw), now);

    const verdict = evaluateTokenEligibility(hydrated, slot, routeKey, now, guildId, upstreamCircuit);
    if (!verdict.ok) {
      if (verdict.reason === 'cooldown') {
        return { ok: false, reason: 'cooldown', retryAfter: verdict.retryAfter };
      }
      return { ok: false, reason: 'no-eligible-token', retryAfter: 60_000 };
    }

    const requestId = crypto.randomUUID();
    const t = grantLease(hydrated, routeKey, requestId, now);
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
      requestId,
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
    return this.#serialize(() => this.#release(label, requestId, outcome));
  }

  async #release(label: string, requestId: string, outcome: ReleaseInput): Promise<void> {
    const now = Date.now();
    const raw = await this.ctx.storage.get<TokenState>(`${TOKEN_KEY_PREFIX}${label}`);
    if (!raw) return; // Token deleted before release; drop silently.
    const t = pruneTokenLeases(hydrateToken(raw), now);

    // Stale-write guard: duplicate or out-of-order
    if (t.lastReleaseRequestId === requestId) return;
    if (t.lastReleaseAt > now) return;

    // Lease-gated: ONLY a still-outstanding lease with this exact requestId
    // AND matching routeKey authorizes ANY mutation below - checked before
    // touching inFlightCount, the 401 counter, or any budget/circuit state,
    // so an unknown, already-settled, pruned-as-abandoned, or routeKey-
    // mismatched requestId is a complete no-op with zero storage writes and
    // zero side effects (including never reaching `applyUpstreamCircuit`,
    // which is DO-wide - a bogus release must never be able to trip it).
    const lease = t.leases.find((l) => l.requestId === requestId);
    if (!lease || lease.routeKey !== outcome.routeKey) {
      console.error('IDENTITY_GUARD release requestId/routeKey mismatch or unknown, dropping', {
        identity: `pool:${label}`,
        requestId,
        routeKey: outcome.routeKey,
      });
      return;
    }

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
    const budgetAfter = applyOutcome(t, requestId, outcome, now);
    t.bucketStates = budgetAfter.bucketStates;
    t.routeToBucket = budgetAfter.routeToBucket;
    t.globalCooldownUntil = budgetAfter.globalCooldownUntil;
    t.circuit = budgetAfter.circuit;
    t.leases = budgetAfter.leases;
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
   * Read-only identity peek: fingerprint for `kind` (kind-keyed, operator UX)
   * + live client versions (DO-wide), plus a circuit-only `block` for
   * `identityHash` when the DO-wide upstream circuit or this identity's own
   * captcha circuit is currently open. No bucket/dispatch-gap check (that
   * only happens at `leaseStatic` time), no lease, no mutation, never
   * creates a guard record for a hash that hasn't leased yet. Called once
   * per request by the identity middleware to build the response headers
   * and to let it short-circuit an already-blocked identity early.
   */
  async prepareStatic(identityHash: string, kind: StaticTokenKind): Promise<StaticPrepareResult> {
    const now = Date.now();
    const guardKey = `${STATIC_GUARD_PREFIX}${identityHash}`;
    const map = await this.ctx.storage.get<unknown>([
      `${STATIC_FINGERPRINT_PREFIX}${kind}`,
      BUILD_NUMBER_META_KEY,
      CHROME_VERSION_META_KEY,
      guardKey,
      META_UPSTREAM_CIRCUIT_KEY,
    ]);

    const upstreamCircuit = (map.get(META_UPSTREAM_CIRCUIT_KEY) as IdentityCircuit | undefined) ?? null;
    const guardCircuit = (map.get(guardKey) as StaticIdentityState | undefined)?.circuit ?? null;
    let block: IdentityBlock | null = null;
    if (upstreamCircuit && upstreamCircuit.until > now) {
      block = { reason: 'cooldown', retryAfter: upstreamCircuit.until - now, signal: upstreamCircuit.signal };
    } else if (guardCircuit && guardCircuit.until > now) {
      block = { reason: 'cooldown', retryAfter: guardCircuit.until - now, signal: guardCircuit.signal };
    }

    return {
      fingerprint: (map.get(`${STATIC_FINGERPRINT_PREFIX}${kind}`) as StaticFingerprintRecord | undefined) ?? null,
      versions: {
        build: (map.get(BUILD_NUMBER_META_KEY) as BuildNumberRecord | undefined) ?? null,
        chrome: (map.get(CHROME_VERSION_META_KEY) as ChromeVersionRecord | undefined) ?? null,
      },
      block,
    };
  }

  /**
   * Reserve the budget for one outbound fetch on `routeKey`, immediately
   * before dispatching it. `identityHash` (see `token-hash.ts`) is the ONLY
   * identity-scoping argument, never `kind` - not even for logging, which
   * uses a truncated hash instead so it never doubles as a second, kind-keyed
   * identity label in the logs. On success, records the issued lease so
   * `settleStatic` can validate against it; rejects with `reason: 'capacity'`
   * at `PENDING_LEASE_CAP` rather than evicting a still-outstanding lease.
   */
  async leaseStatic(identityHash: string, routeKey: RouteKey): Promise<LeaseStaticResult> {
    return this.#serialize(() => this.#leaseStatic(identityHash, routeKey));
  }

  async #leaseStatic(identityHash: string, routeKey: RouteKey): Promise<LeaseStaticResult> {
    const now = Date.now();
    const guardKey = `${STATIC_GUARD_PREFIX}${identityHash}`;
    const [raw, upstreamCircuit] = await Promise.all([this.ctx.storage.get<StaticIdentityState>(guardKey), this.getUpstreamCircuit()]);
    const hydrated: StaticIdentityState = raw ? hydrateStaticGuard(raw, identityHash) : freshStaticGuard(identityHash, now);
    const guard = pruneLeases(hydrated, now);

    const eligibility = evaluateBudget(guard, routeKey, now, upstreamCircuit);
    if (!eligibility.ok) {
      return { ok: false, block: { reason: 'cooldown', retryAfter: eligibility.retryAfter, signal: eligibility.signal } };
    }
    if (guard.leases.length >= PENDING_LEASE_CAP) {
      console.error('IDENTITY_GUARD pending-lease cap reached', { identity: `static:${identityHash.slice(0, 8)}`, cap: PENDING_LEASE_CAP });
      return { ok: false, block: { reason: 'capacity', retryAfter: 1000 } };
    }

    const requestId = crypto.randomUUID();
    const leased = grantLease(guard, routeKey, requestId, now);
    leased.lastSeenAt = now;
    await this.ctx.storage.put(guardKey, leased);

    return { ok: true, requestId };
  }

  /**
   * Settle a lease immediately after its fetch completes. Lease-gated: ONLY
   * a still-outstanding lease with this exact `requestId` AND matching
   * `routeKey` authorizes ANY mutation - checked before touching
   * `bucketStates`/`circuit`/the DO-wide upstream circuit, so an unknown,
   * already-settled, pruned-as-abandoned, or routeKey-mismatched requestId
   * is a complete no-op with zero storage writes and zero side effects.
   */
  async settleStatic(identityHash: string, requestId: string, outcome: ReleaseInput): Promise<void> {
    return this.#serialize(() => this.#settleStatic(identityHash, requestId, outcome));
  }

  async #settleStatic(identityHash: string, requestId: string, outcome: ReleaseInput): Promise<void> {
    const now = Date.now();
    const guardKey = `${STATIC_GUARD_PREFIX}${identityHash}`;
    const raw = await this.ctx.storage.get<StaticIdentityState>(guardKey);
    if (!raw) return;
    const guard = pruneLeases(hydrateStaticGuard(raw, identityHash), now);

    const lease = guard.leases.find((l) => l.requestId === requestId);
    if (!lease || lease.routeKey !== outcome.routeKey) {
      console.error('IDENTITY_GUARD settle requestId/routeKey mismatch or unknown, dropping', {
        identity: `static:${identityHash.slice(0, 8)}`,
        requestId,
        routeKey: outcome.routeKey,
      });
      return;
    }

    const before = guard.circuit;
    const after = applyOutcome(guard, requestId, outcome, now);
    guard.bucketStates = after.bucketStates;
    guard.routeToBucket = after.routeToBucket;
    guard.globalCooldownUntil = after.globalCooldownUntil;
    guard.circuit = after.circuit;
    guard.leases = after.leases;
    guard.lastSeenAt = now;
    if (!before && guard.circuit) {
      console.error('IDENTITY_GUARD circuit opened', {
        identity: `static:${identityHash.slice(0, 8)}`,
        signal: guard.circuit.signal,
        until: guard.circuit.until,
      });
    }

    await Promise.all([this.ctx.storage.put(guardKey, guard), this.applyUpstreamCircuit(outcome, now)]);
  }

  /** Register a new token. Caller must enforce pool cap before calling. */
  async register(input: RegisterInput): Promise<{ ok: true; label: string; registeredAt: number } | { ok: false; reason: 'label-exists' }> {
    return this.#serialize(() => this.#register(input));
  }

  async #register(input: RegisterInput): Promise<{ ok: true; label: string; registeredAt: number } | { ok: false; reason: 'label-exists' }> {
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
    // Queued too: a bare delete running between a queued `release`'s read and
    // write would be undone when that release re-persists the token.
    return this.#serialize(() => this.ctx.storage.delete(`${TOKEN_KEY_PREFIX}${label}`).then(() => undefined));
  }

  /** Reset a token to active status (operator action after fixing whatever caused 401s). */
  async reset(label: string): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
    return this.#serialize(() => this.#reset(label));
  }

  async #reset(label: string): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
    const key = `${TOKEN_KEY_PREFIX}${label}`;
    const raw = await this.ctx.storage.get<TokenState>(key);
    if (!raw) return { ok: false, reason: 'not-found' };
    const t = hydrateToken(raw);
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
    return this.#serialize(() => this.#setTokenFingerprintProfile(label, profileId));
  }

  async #setTokenFingerprintProfile(label: string, profileId: string): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
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
    return Array.from(map.values()).map(hydrateToken);
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
    // A suspended token is out of rotation for an operator reason, so it is
    // neither available (active) nor temporarily benched (cooling).
    if (t.status !== 'active') continue;
    if (t.globalCooldownUntil > now || (t.circuit && t.circuit.until > now)) {
      cooling++;
    } else {
      active++;
    }
  }
  return { count: inSlot.length, active, cooling, invalid };
}
