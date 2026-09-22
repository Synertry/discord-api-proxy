/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateBudget,
  applyOutcome,
  openUpstreamCircuit,
  markDispatched,
  retryDelayMs,
  CAPTCHA_CIRCUIT_MS,
  CLOUDFLARE_CIRCUIT_MS,
  BUCKET_STATES_CAP,
} from '../../src/rotator/budget';
import type { BucketBudget, IdentityCircuit } from '../../src/rotator/types';

const NOW = 1_700_000_000_000;

function emptyBudget(): BucketBudget {
  return { bucketStates: {}, routeToBucket: {}, globalCooldownUntil: 0, circuit: null, lastDispatchAt: 0 };
}

describe('evaluateBudget', () => {
  it('is ok for a fresh budget', () => {
    expect(evaluateBudget(emptyBudget(), 'GET:/users/@me', NOW)).toEqual({ ok: true });
  });

  it('blocks on an active global cooldown', () => {
    const budget = { ...emptyBudget(), globalCooldownUntil: NOW + 5000 };
    const result = evaluateBudget(budget, 'GET:/users/@me', NOW);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: 5000 });
  });

  it('blocks on an exhausted bucket for the route', () => {
    const budget: BucketBudget = {
      bucketStates: { 'bucket-a': { remaining: 0, resetAt: NOW + 3000 } },
      routeToBucket: { 'GET:/users/@me': 'bucket-a' },
      globalCooldownUntil: 0,
      circuit: null,
      lastDispatchAt: 0,
    };
    const result = evaluateBudget(budget, 'GET:/users/@me', NOW);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: 3000 });
  });

  it('is ok when the bucket has remaining requests', () => {
    const budget: BucketBudget = {
      bucketStates: { 'bucket-a': { remaining: 3, resetAt: NOW + 3000 } },
      routeToBucket: { 'GET:/users/@me': 'bucket-a' },
      globalCooldownUntil: 0,
      circuit: null,
      lastDispatchAt: 0,
    };
    expect(evaluateBudget(budget, 'GET:/users/@me', NOW)).toEqual({ ok: true });
  });

  it('blocks on an open identity circuit (captcha)', () => {
    const circuit: IdentityCircuit = { signal: 'captcha', until: NOW + CAPTCHA_CIRCUIT_MS, openedAt: NOW };
    const budget = { ...emptyBudget(), circuit };
    const result = evaluateBudget(budget, 'GET:/users/@me', NOW);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: CAPTCHA_CIRCUIT_MS, signal: 'captcha' });
  });

  it('blocks every identity when the DO-wide upstream circuit is open, even with a clean budget', () => {
    const upstream: IdentityCircuit = { signal: 'cloudflare', until: NOW + CLOUDFLARE_CIRCUIT_MS, openedAt: NOW };
    const result = evaluateBudget(emptyBudget(), 'GET:/users/@me', NOW, upstream);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: CLOUDFLARE_CIRCUIT_MS, signal: 'cloudflare' });
  });

  it('the upstream circuit takes precedence over a merely-cooling budget', () => {
    const upstream: IdentityCircuit = { signal: 'cloudflare', until: NOW + 1000, openedAt: NOW };
    const budget = { ...emptyBudget(), globalCooldownUntil: NOW + 99999 };
    const result = evaluateBudget(budget, 'GET:/users/@me', NOW, upstream);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: 1000, signal: 'cloudflare' });
  });

  it('an expired circuit no longer blocks', () => {
    const circuit: IdentityCircuit = { signal: 'captcha', until: NOW - 1, openedAt: NOW - 100 };
    const budget = { ...emptyBudget(), circuit };
    expect(evaluateBudget(budget, 'GET:/users/@me', NOW)).toEqual({ ok: true });
  });

  it('blocks a second dispatch under MIN_DISPATCH_GAP_MS since the last one, regardless of route or bucket remaining', () => {
    const budget = { ...emptyBudget(), lastDispatchAt: NOW - 200 };
    const result = evaluateBudget(budget, 'GET:/users/@me', NOW);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: 800 });
  });

  it('allows a dispatch once MIN_DISPATCH_GAP_MS has elapsed', () => {
    const budget = { ...emptyBudget(), lastDispatchAt: NOW - 1000 };
    expect(evaluateBudget(budget, 'GET:/users/@me', NOW)).toEqual({ ok: true });
  });

  it('a fresh identity (lastDispatchAt: 0) is never gap-blocked on its first dispatch', () => {
    expect(evaluateBudget(emptyBudget(), 'GET:/users/@me', NOW)).toEqual({ ok: true });
  });

  it('the dispatch-gap floor applies identity-wide, independent of which route is being dispatched', () => {
    const budget = { ...emptyBudget(), lastDispatchAt: NOW - 500 };
    const result = evaluateBudget(budget, 'POST:/channels/:id/typing', NOW);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: 500 });
  });
});
describe('markDispatched', () => {
  it('sets lastDispatchAt without touching any other field', () => {
    const budget = emptyBudget();
    const result = markDispatched(budget, NOW);
    expect(result).toEqual({ ...budget, lastDispatchAt: NOW });
  });

  it('is immutable: never mutates the input', () => {
    const budget = emptyBudget();
    markDispatched(budget, NOW);
    expect(budget.lastDispatchAt).toBe(0);
  });
});

describe('retryDelayMs', () => {
  it('applies the 1.5x backoff factor to a given retryAfterMs', () => {
    expect(retryDelayMs({ retryAfterMs: 2000 })).toBe(3000);
  });

  it('floors at 1000ms even for a very short retryAfterMs', () => {
    expect(retryDelayMs({ retryAfterMs: 10 })).toBe(1000);
  });

  it('defaults to 1000ms base when retryAfterMs is absent', () => {
    expect(retryDelayMs({})).toBe(1500);
  });
});

describe('applyOutcome', () => {
  it('is immutable: never mutates the input budget', () => {
    const budget = emptyBudget();
    const snapshot = JSON.parse(JSON.stringify(budget));
    applyOutcome(budget, { status: 429, routeKey: 'GET:/x', retryAfterMs: 2000 }, NOW);
    expect(budget).toEqual(snapshot);
  });

  it('a 429 sets globalCooldownUntil to retryAfter * 1.5', () => {
    const result = applyOutcome(emptyBudget(), { status: 429, routeKey: 'GET:/x', retryAfterMs: 2000 }, NOW);
    expect(result.globalCooldownUntil).toBe(NOW + 3000);
  });

  it('records a per-bucket update from the discordBucketHash', () => {
    const result = applyOutcome(
      emptyBudget(),
      { status: 200, routeKey: 'GET:/x', discordBucketHash: 'b1', remaining: 5, resetAfterMs: 4000 },
      NOW,
    );
    expect(result.bucketStates.b1).toEqual({ remaining: 5, resetAt: NOW + 4000 });
    expect(result.routeToBucket['GET:/x']).toBe('b1');
  });

  it('a captcha signal opens a 30-minute identity circuit', () => {
    const result = applyOutcome(emptyBudget(), { status: 400, routeKey: 'GET:/x', signal: 'captcha' }, NOW);
    expect(result.circuit).toEqual({ signal: 'captcha', until: NOW + CAPTCHA_CIRCUIT_MS, openedAt: NOW });
  });

  it("never opens a circuit for a cloudflare signal (that is the DO-wide caller's job, not this budget's)", () => {
    const result = applyOutcome(emptyBudget(), { status: 403, routeKey: 'GET:/x', signal: 'cloudflare' }, NOW);
    expect(result.circuit).toBeNull();
  });

  it('a clean 2xx after an expired captcha circuit clears it', () => {
    const budget = { ...emptyBudget(), circuit: { signal: 'captcha' as const, until: NOW - 1, openedAt: NOW - 100 } };
    const result = applyOutcome(budget, { status: 200, routeKey: 'GET:/x' }, NOW);
    expect(result.circuit).toBeNull();
  });

  it('never clears a cloudflare-flavored circuit sitting in an identity budget (it should never be there, but if it is, leave it for the DO-wide path to own)', () => {
    const budget = { ...emptyBudget(), circuit: { signal: 'cloudflare' as const, until: NOW - 1, openedAt: NOW - 100 } };
    const result = applyOutcome(budget, { status: 200, routeKey: 'GET:/x' }, NOW);
    expect(result.circuit).toEqual(budget.circuit);
  });

  it('evicts the oldest-reset buckets once over the cap', () => {
    let budget = emptyBudget();
    for (let i = 0; i < BUCKET_STATES_CAP + 5; i++) {
      budget = applyOutcome(
        budget,
        { status: 200, routeKey: `GET:/r${i}`, discordBucketHash: `b${i}`, remaining: 1, resetAfterMs: i * 1000 },
        NOW,
      );
    }
    expect(Object.keys(budget.bucketStates).length).toBe(BUCKET_STATES_CAP);
    expect(budget.bucketStates.b0).toBeUndefined();
  });
});

describe('openUpstreamCircuit', () => {
  it('opens a cloudflare circuit on that signal', () => {
    const result = openUpstreamCircuit(null, { status: 403, routeKey: 'GET:/x', signal: 'cloudflare' }, NOW);
    expect(result).toEqual({ signal: 'cloudflare', until: NOW + CLOUDFLARE_CIRCUIT_MS, openedAt: NOW });
  });

  it('honors an explicit retryAfterMs over the default', () => {
    const result = openUpstreamCircuit(null, { status: 403, routeKey: 'GET:/x', signal: 'cloudflare', retryAfterMs: 60000 }, NOW);
    expect(result?.until).toBe(NOW + 60000);
  });

  it('leaves an existing non-cloudflare-signal state unchanged', () => {
    const existing: IdentityCircuit = { signal: 'cloudflare', until: NOW + 5000, openedAt: NOW };
    const result = openUpstreamCircuit(existing, { status: 200, routeKey: 'GET:/x' }, NOW);
    expect(result).toEqual(existing);
  });

  it('clears an expired upstream circuit on a clean 2xx', () => {
    const existing: IdentityCircuit = { signal: 'cloudflare', until: NOW - 1, openedAt: NOW - 100 };
    const result = openUpstreamCircuit(existing, { status: 200, routeKey: 'GET:/x' }, NOW);
    expect(result).toBeNull();
  });
});
