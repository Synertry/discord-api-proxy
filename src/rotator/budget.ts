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

import type { BucketBudget, RouteKey, ReleaseInput, IdentityCircuit, AbuseSignal } from './types';

/** How long a captcha challenge blocks the specific identity that triggered it. */
export const CAPTCHA_CIRCUIT_MS = 30 * 60 * 1000;

/** Default duration a Cloudflare/edge-level block circuits the whole DO for, when the response carried no `Retry-After`. */
export const CLOUDFLARE_CIRCUIT_MS = 10 * 60 * 1000;

/** 429 cooldown backoff: bench the identity for `retryAfter * this factor`, matching Discord's own guidance to back off further than the bare minimum. */
export const COOLDOWN_BACKOFF_FACTOR = 1.5;

/** LRU eviction cap on per-identity bucket entries (shared with the pool's existing cap). */
export const BUCKET_STATES_CAP = 200;

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

export type BudgetEligibility = { ok: true } | { ok: false; reason: 'cooldown'; retryAfter: number; signal?: AbuseSignal };

/**
 * Evaluate whether an identity (pool token or static identity) can dispatch
 * a request on `routeKey` right now. Collects every active constraint (the
 * DO-wide upstream circuit, the identity's own circuit, its global cooldown,
 * the identity-wide dispatch-gap floor, the specific bucket's cooldown) and
 * reports the *soonest* one clearing, matching the pre-existing pool
 * behavior of picking the soonest of several simultaneous constraints
 * (global cooldown, bucket, guild-ineligibility) rather than the latest -
 * `retryAfter` is a "worth rechecking around here" hint, not a guarantee the
 * identity is unblocked by every constraint at that instant.
 */
export function evaluateBudget(
  budget: BucketBudget,
  routeKey: RouteKey,
  now: number,
  upstreamCircuit?: IdentityCircuit | null,
): BudgetEligibility {
  const candidates: { at: number; signal?: AbuseSignal }[] = [];

  if (upstreamCircuit && upstreamCircuit.until > now) {
    candidates.push({ at: upstreamCircuit.until, signal: upstreamCircuit.signal });
  }
  if (budget.circuit && budget.circuit.until > now) {
    candidates.push({ at: budget.circuit.until, signal: budget.circuit.signal });
  }
  if (budget.globalCooldownUntil > now) {
    candidates.push({ at: budget.globalCooldownUntil });
  }
  if (budget.lastDispatchAt > 0 && now - budget.lastDispatchAt < MIN_DISPATCH_GAP_MS) {
    candidates.push({ at: budget.lastDispatchAt + MIN_DISPATCH_GAP_MS });
  }
  const bucketHash = budget.routeToBucket[routeKey];
  if (bucketHash) {
    const bucket = budget.bucketStates[bucketHash];
    if (bucket && bucket.remaining <= 0 && bucket.resetAt > now) {
      candidates.push({ at: bucket.resetAt });
    }
  }

  if (candidates.length === 0) return { ok: true };
  const soonest = candidates.reduce((a, b) => (a.at < b.at ? a : b));
  return { ok: false, reason: 'cooldown', retryAfter: soonest.at - now, signal: soonest.signal };
}

/**
 * Apply one Discord response outcome to a budget: the 429 bench, the
 * per-bucket update, and - on a captcha signal only - opening this
 * identity's own circuit. Pure: returns a new object, never mutates
 * `budget`.
 *
 * Deliberately does NOT act on `outcome.signal === 'cloudflare'`: a
 * Cloudflare/edge block is DO-wide (shared egress IP), not scoped to
 * whichever identity happened to trigger it. Callers must separately check
 * `outcome.signal === 'cloudflare'` and apply `openUpstreamCircuit` to the
 * DO's single `meta:upstream-circuit` record instead - see the module doc.
 */
export function applyOutcome(budget: BucketBudget, outcome: ReleaseInput, now: number): BucketBudget {
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
    routeToBucket = { ...routeToBucket, [outcome.routeKey]: outcome.discordBucketHash };
    bucketStates = evictOldestBucketsIfOverCap(bucketStates);
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

  return { bucketStates, routeToBucket, globalCooldownUntil, circuit, lastDispatchAt: budget.lastDispatchAt };
}

/** Mark an identity as having just dispatched a request, for the `MIN_DISPATCH_GAP_MS` floor. Pure: returns a new object. Called at lease/acquire time, never at settle time - the gap is about dispatch timing, not completion timing. */
export function markDispatched<T extends BucketBudget>(budget: T, now: number): T {
  return { ...budget, lastDispatchAt: now };
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
