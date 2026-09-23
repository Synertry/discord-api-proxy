/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/budget
 * Pure rate-limit budget evaluation shared by pool tokens (`TokenState`) and
 * static identities (`StaticIdentityState`): both extend `BucketBudget`, so
 * `evaluateBudget` / `applyOutcome` operate on either without caring which.
 *
 * Two circuit layers: `evaluateBudget` takes an optional `upstreamCircuit`
 * parameter for the DO-wide Cloudflare/edge-block circuit (shared egress IP
 * - a Cloudflare challenge affects every identity in the pool, not just the
 * one that triggered it), checked before the identity's own per-identity
 * circuit (captcha - specific to that identity/account).
 */

import type { BucketBudget, RouteKey, ReleaseInput, IdentityCircuit, AbuseSignal, Lease } from './types';

/** How long a captcha challenge blocks the specific identity that triggered it. */
export const CAPTCHA_CIRCUIT_MS = 30 * 60 * 1000;

/** Default duration a Cloudflare/edge-level block circuits the whole DO for, when the response carried no `Retry-After`. */
export const CLOUDFLARE_CIRCUIT_MS = 10 * 60 * 1000;

/** 429 cooldown backoff: bench the identity for `retryAfter * this factor`, matching Discord's own guidance to back off further than the bare minimum. */
export const COOLDOWN_BACKOFF_FACTOR = 1.5;

/** LRU eviction cap on per-identity bucket entries (shared with the pool's existing cap). */
export const BUCKET_STATES_CAP = 200;

/**
 * Cap on per-identity route -> bucket mappings. Pool tokens only ever see the
 * rotatable allowlist, but a static identity serves arbitrary caller paths, and
 * paths with non-snowflake segments (e.g. `/invites/<code>`) each derive a
 * distinct route key while Discord reports one shared bucket, so without this
 * cap the persisted record would grow with every new path. Losing a mapping is
 * safe: `evaluateBudget` treats the route as an unknown bucket and probes it one
 * request at a time until a response re-teaches it.
 */
export const ROUTE_TO_BUCKET_CAP = 400;

/** Longest route key worth remembering a bucket mapping for. Real Discord route keys are well under 100 characters; a caller-chosen path can be kilobytes long, and together with `ROUTE_TO_BUCKET_CAP` this keeps the persisted record far below the SQLite-backed DO's 2 MB per-value limit. */
export const ROUTE_KEY_MAX_LENGTH = 256;

/**
 * Minimum spacing between two dispatched requests for the *same* identity
 * (token or static identity), regardless of route - the Discord hard rule's
 * "never send back-to-back requests" floor, enforced per-identity so the
 * pool's whole purpose (N tokens = N independent budgets = higher aggregate
 * throughput) is preserved; each token is still individually paced against
 * itself. Per-bucket `remaining` tracking alone cannot enforce this, since
 * two concurrent leases for the same identity can both observe
 * `remaining > 0` before either has actually dispatched.
 */
export const MIN_DISPATCH_GAP_MS = 1000;

/** A lease older than this is treated as abandoned (its request crashed or hung before settling) and pruned lazily by `pruneLeases`. Comfortably above the outbound fetch's own `AbortSignal.timeout(60_000)` (see `proxy.ts`) so a legitimately slow-but-live request is never pruned out from under its own eventual settle. */
export const LEASE_TTL_MS = 90_000;

/** Cooldown reported when a route's bucket is unknown or its reset window has elapsed and a lease is already in flight for it: probe one request at a time until a fresh response re-teaches the bucket, rather than letting an unbounded number of concurrent requests through blind. */
export const UNKNOWN_BUCKET_RETRY_MS = 1000;

export type BudgetEligibility = { ok: true } | { ok: false; reason: 'cooldown'; retryAfter: number; signal?: AbuseSignal };

/**
 * Evaluate whether an identity (pool token or static identity) can dispatch
 * a request on `routeKey` right now. Collects every active constraint (the
 * DO-wide upstream circuit, the identity's own circuit, its global cooldown,
 * the identity-wide dispatch-gap floor, and per-bucket in-flight-adjusted
 * remaining) and reports the soonest one to clear once no circuit is open -
 * `retryAfter` is a hint worth rechecking around, never a guarantee every
 * constraint has cleared by then.
 *
 * Call `pruneLeases` before this so `budget.leases` reflects only genuinely
 * outstanding dispatches - `evaluateBudget` itself never prunes (it is pure
 * and read-only, no timestamp-dependent side channel).
 */
export function evaluateBudget(
  budget: BucketBudget,
  routeKey: RouteKey,
  now: number,
  upstreamCircuit?: IdentityCircuit | null,
): BudgetEligibility {
  // Circuits are a hard gate, not a quota timer: an open circuit blocks
  // dispatch for its FULL remaining duration regardless of whether some
  // other quota candidate (the dispatch-gap floor, a per-bucket reset)
  // happens to clear sooner - reporting the sooner one would both lie about
  // when a retry can actually succeed (the circuit is still open) and drop
  // the `signal` the caller needs to know WHY (captcha vs cloudflare) it is
  // blocked. Checked first, and returned immediately when open - never
  // pooled into the soonest-of-everything reduction below.
  if (upstreamCircuit && upstreamCircuit.until > now) {
    return { ok: false, reason: 'cooldown', retryAfter: upstreamCircuit.until - now, signal: upstreamCircuit.signal };
  }
  if (budget.circuit && budget.circuit.until > now) {
    return { ok: false, reason: 'cooldown', retryAfter: budget.circuit.until - now, signal: budget.circuit.signal };
  }

  // Quota-style candidates ARE genuinely racing, independent windows (a
  // pre-existing, deliberately tested contract: global=5s + bucket=2s +
  // guild=3s reports 2s, the MIN, not even 3s) - `retryAfter` here is only
  // ever "worth rechecking around", never a guarantee every constraint has
  // cleared, so reporting the soonest one is correct once no circuit is open.
  const candidates: { at: number }[] = [];
  if (budget.globalCooldownUntil > now) {
    candidates.push({ at: budget.globalCooldownUntil });
  }
  if (budget.lastDispatchAt > 0 && now - budget.lastDispatchAt < MIN_DISPATCH_GAP_MS) {
    candidates.push({ at: budget.lastDispatchAt + MIN_DISPATCH_GAP_MS });
  }

  // In-flight-adjusted bucket accounting: `MIN_DISPATCH_GAP_MS` alone is
  // NOT sufficient to prevent over-committing a low-`remaining` bucket - a
  // slow-to-respond dispatch can leave a second, later dispatch (well past
  // the 1s floor) seeing a stale `remaining > 0` before the first one's
  // response has come back to decrement it via header. Counting `leases`
  // still outstanding for this bucket closes that gap.
  const bucketHash = budget.routeToBucket[routeKey];
  const inFlight = budget.leases.filter((l) => (bucketHash ? l.bucket === bucketHash : l.routeKey === routeKey)).length;
  const bucketState = bucketHash ? budget.bucketStates[bucketHash] : undefined;
  const bucketFresh = bucketState !== undefined && bucketState.resetAt > now;
  if (bucketFresh) {
    if (bucketState!.remaining - inFlight <= 0) {
      candidates.push({ at: bucketState!.resetAt });
    }
  } else if (inFlight >= 1) {
    // Bucket never learned for this route, or its reset window already
    // elapsed (stale remaining count) - probe one at a time until a fresh
    // response re-teaches it, rather than letting unbounded concurrency
    // through blind.
    candidates.push({ at: now + UNKNOWN_BUCKET_RETRY_MS });
  }

  if (candidates.length === 0) return { ok: true };
  const soonest = candidates.reduce((a, b) => (a.at < b.at ? a : b));
  return { ok: false, reason: 'cooldown', retryAfter: soonest.at - now };
}

/** Drop leases past `LEASE_TTL_MS`: their request evidently crashed or hung before settling. Pure. */
export function pruneLeases<T extends BucketBudget>(budget: T, now: number): T {
  const leases = budget.leases.filter((l) => now - l.leasedAt < LEASE_TTL_MS);
  if (leases.length === budget.leases.length) return budget;
  return { ...budget, leases };
}

/**
 * Grant a lease for one dispatch: record it (with the bucket resolved from
 * `routeToBucket`, if already known) and mark `lastDispatchAt` for the
 * `MIN_DISPATCH_GAP_MS` floor. Pure. Called at acquire/acquireByLabel/
 * leaseStatic time - the `requestId` is generated by the caller so it can
 * be returned to the Worker for the matching settle.
 */
export function grantLease<T extends BucketBudget>(budget: T, routeKey: RouteKey, requestId: string, now: number): T {
  const lease: Lease = { requestId, routeKey, bucket: budget.routeToBucket[routeKey], leasedAt: now };
  return { ...budget, leases: [...budget.leases, lease], lastDispatchAt: now };
}

/**
 * Apply one Discord response outcome to a budget: the 429 bench, the
 * per-bucket update, and - on a captcha signal only - opening this
 * identity's own circuit. Pure: returns a new object, never mutates
 * `budget`.
 *
 * `requestId` gates the whole thing: when non-null, the outcome is applied
 * (and that lease removed from `leases`) ONLY if a still-outstanding lease
 * with that exact `requestId` AND matching `routeKey` is found - an unknown
 * id (already settled, replayed, or pruned-as-abandoned) and a malformed/
 * mismatched settle (right id, wrong route) are both a complete no-op, the
 * budget returned unchanged. Pass `null` only for pure/test-only evaluation
 * that intentionally bypasses lease gating.
 *
 * Deliberately does NOT act on `outcome.signal === 'cloudflare'`: a
 * Cloudflare/edge block is DO-wide (shared egress IP), not scoped to
 * whichever identity happened to trigger it. Callers must separately check
 * `outcome.signal === 'cloudflare'` and apply `openUpstreamCircuit` to the
 * DO's single `meta:upstream-circuit` record instead - see the module doc.
 */
export function applyOutcome(budget: BucketBudget, requestId: string | null, outcome: ReleaseInput, now: number): BucketBudget {
  let leases = budget.leases;
  if (requestId !== null) {
    const lease = leases.find((l) => l.requestId === requestId);
    if (!lease || lease.routeKey !== outcome.routeKey) {
      return budget;
    }
    leases = leases.filter((l) => l.requestId !== requestId);
  }

  let globalCooldownUntil = budget.globalCooldownUntil;
  if (outcome.status === 429) {
    const retryAfterMs = outcome.retryAfterMs ?? 1000;
    globalCooldownUntil = Math.max(globalCooldownUntil, now + Math.ceil(retryAfterMs * COOLDOWN_BACKOFF_FACTOR));
  }

  let bucketStates = budget.bucketStates;
  let routeToBucket = budget.routeToBucket;
  if (outcome.discordBucketHash) {
    bucketStates = {
      ...bucketStates,
      [outcome.discordBucketHash]: { remaining: outcome.remaining ?? 0, resetAt: now + (outcome.resetAfterMs ?? 0) },
    };
    bucketStates = evictOldestBucketsIfOverCap(bucketStates);
    routeToBucket = recordRouteBucket(routeToBucket, outcome.routeKey, outcome.discordBucketHash, bucketStates);
  }

  let circuit = budget.circuit;
  if (outcome.signal === 'captcha') {
    circuit = { signal: 'captcha', until: now + CAPTCHA_CIRCUIT_MS, openedAt: now };
  } else if (circuit && circuit.signal === 'captcha' && circuit.until <= now && outcome.status >= 200 && outcome.status < 300) {
    // A clean 2xx after an expired captcha circuit clears it; an expired-
    // but-unrefreshed circuit would otherwise linger in storage forever
    // with no live effect. Never clears a 'cloudflare' circuit here - that
    // one lives in the DO-wide record, not this identity's budget.
    circuit = null;
  }

  return { bucketStates, routeToBucket, globalCooldownUntil, circuit, lastDispatchAt: budget.lastDispatchAt, leases };
}

/**
 * The one shared 429-backoff delay, used by every caller that retries a
 * Discord request after a rate limit: the proxy's pool-token retry, the
 * shared paged-messages fetcher, and the custom clients' own retry loops.
 * `Math.max(1000, ...)` enforces the Discord hard rule floor (at least 1s
 * between REST calls) even when Discord's own `Retry-After` is shorter or
 * absent; `COOLDOWN_BACKOFF_FACTOR` backs off further than the bare minimum.
 */
export function retryDelayMs(outcome: { retryAfterMs?: number }): number {
  return Math.max(1000, Math.ceil((outcome.retryAfterMs ?? 1000) * COOLDOWN_BACKOFF_FACTOR));
}

/**
 * Compute the DO-wide upstream circuit update for a detected Cloudflare
 * signal. Pure; the caller (`do.ts`) persists the result to the single
 * `meta:upstream-circuit` record shared by every identity in the DO.
 * Returns the existing circuit unchanged when the outcome carries no
 * Cloudflare signal (including clearing on a clean 2xx once expired).
 */
export function openUpstreamCircuit(existing: IdentityCircuit | null, outcome: ReleaseInput, now: number): IdentityCircuit | null {
  if (outcome.signal === 'cloudflare') {
    return { signal: 'cloudflare', until: now + (outcome.retryAfterMs ?? CLOUDFLARE_CIRCUIT_MS), openedAt: now };
  }
  if (existing && existing.signal === 'cloudflare' && existing.until <= now && outcome.status >= 200 && outcome.status < 300) {
    return null;
  }
  return existing;
}

/** Trim `bucketStates` to `BUCKET_STATES_CAP` entries by evicting the rows with the smallest `resetAt` (oldest reset, most likely already expired). Pure. */
function evictOldestBucketsIfOverCap(bucketStates: BucketBudget['bucketStates']): BucketBudget['bucketStates'] {
  const entries = Object.entries(bucketStates);
  if (entries.length <= BUCKET_STATES_CAP) return bucketStates;
  entries.sort(([, a], [, b]) => a.resetAt - b.resetAt);
  const trimmed = entries.slice(entries.length - BUCKET_STATES_CAP);
  return Object.fromEntries(trimmed);
}

/**
 * Record `routeKey -> bucketHash` as the most recently seen mapping, drop every
 * mapping whose bucket is no longer tracked in `bucketStates` (evicted above),
 * and keep at most `ROUTE_TO_BUCKET_CAP` of the most recently seen routes.
 * Recency is insertion order: the route is removed and re-appended on every
 * sighting. Route keys always contain `:` and `/`, so they are never
 * integer-like and object insertion order holds. Pure.
 */
function recordRouteBucket(
  routeToBucket: BucketBudget['routeToBucket'],
  routeKey: RouteKey,
  bucketHash: string,
  bucketStates: BucketBudget['bucketStates'],
): BucketBudget['routeToBucket'] {
  const kept = Object.entries(routeToBucket).filter(([key, hash]) => key !== routeKey && Object.hasOwn(bucketStates, hash));
  if (routeKey.length <= ROUTE_KEY_MAX_LENGTH && Object.hasOwn(bucketStates, bucketHash)) kept.push([routeKey, bucketHash]);
  return Object.fromEntries(kept.slice(-ROUTE_TO_BUCKET_CAP));
}
