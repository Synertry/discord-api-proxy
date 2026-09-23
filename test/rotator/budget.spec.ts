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
  pruneLeases,
  grantLease,
  retryDelayMs,
  CAPTCHA_CIRCUIT_MS,
  CLOUDFLARE_CIRCUIT_MS,
  BUCKET_STATES_CAP,
  ROUTE_TO_BUCKET_CAP,
  ROUTE_KEY_MAX_LENGTH,
  LEASE_TTL_MS,
  UNKNOWN_BUCKET_RETRY_MS,
} from '../../src/rotator/budget';
import type { BucketBudget, IdentityCircuit, Lease } from '../../src/rotator/types';

const NOW = 1_700_000_000_000;

function emptyBudget(): BucketBudget {
  return { bucketStates: {}, routeToBucket: {}, globalCooldownUntil: 0, circuit: null, lastDispatchAt: 0, leases: [] };
}

function lease(overrides: Partial<Lease> = {}): Lease {
  return { requestId: 'req-1', routeKey: 'GET:/users/@me', leasedAt: NOW, ...overrides };
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
      leases: [],
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
      leases: [],
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

  it('a circuit takes precedence over a shorter dispatch-gap candidate, and keeps its signal', () => {
    // A captcha circuit (30 min out) must win over the 1s dispatch-gap floor
    // that would otherwise report a much sooner (but factually wrong -
    // still-circuited) retryAfter, and must keep the `signal` the caller
    // needs to know WHY it's blocked.
    const circuit: IdentityCircuit = { signal: 'captcha', until: NOW + CAPTCHA_CIRCUIT_MS, openedAt: NOW };
    const budget = { ...emptyBudget(), circuit, lastDispatchAt: NOW - 200 };
    const result = evaluateBudget(budget, 'GET:/users/@me', NOW);
    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: CAPTCHA_CIRCUIT_MS, signal: 'captcha' });
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

  describe('in-flight lease accounting on a known bucket', () => {
    it('two in-flight leases against a bucket with remaining=2 exhaust it: a third dispatch is blocked', () => {
      const budget: BucketBudget = {
        ...emptyBudget(),
        bucketStates: { b1: { remaining: 2, resetAt: NOW + 5000 } },
        routeToBucket: { 'GET:/x': 'b1' },
        leases: [
          lease({ requestId: 'a', bucket: 'b1', leasedAt: NOW - 2000 }),
          lease({ requestId: 'b', bucket: 'b1', leasedAt: NOW - 2000 }),
        ],
      };
      const result = evaluateBudget(budget, 'GET:/x', NOW);
      expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: 5000 });
    });

    it('one in-flight lease against a bucket with remaining=2 still allows a second dispatch', () => {
      const budget: BucketBudget = {
        ...emptyBudget(),
        bucketStates: { b1: { remaining: 2, resetAt: NOW + 5000 } },
        routeToBucket: { 'GET:/x': 'b1' },
        leases: [lease({ requestId: 'a', bucket: 'b1', leasedAt: NOW - 2000 })],
      };
      expect(evaluateBudget(budget, 'GET:/x', NOW)).toEqual({ ok: true });
    });

    it('a lease against a DIFFERENT bucket does not count against this one', () => {
      const budget: BucketBudget = {
        ...emptyBudget(),
        bucketStates: { b1: { remaining: 1, resetAt: NOW + 5000 }, b2: { remaining: 0, resetAt: NOW + 5000 } },
        routeToBucket: { 'GET:/x': 'b1', 'GET:/y': 'b2' },
        leases: [lease({ requestId: 'a', bucket: 'b2', leasedAt: NOW - 2000 })],
      };
      expect(evaluateBudget(budget, 'GET:/x', NOW)).toEqual({ ok: true });
    });

    it('this is the actual gap MIN_DISPATCH_GAP_MS alone cannot close: a slow in-flight dispatch still blocks a second one well past the 1s floor', () => {
      const budget: BucketBudget = {
        ...emptyBudget(),
        bucketStates: { b1: { remaining: 1, resetAt: NOW + 30000 } },
        routeToBucket: { 'GET:/x': 'b1' },
        // Leased 5s ago (well past MIN_DISPATCH_GAP_MS=1000) and still outstanding - its response just hasn't come back yet.
        leases: [lease({ requestId: 'a', bucket: 'b1', leasedAt: NOW - 5000 })],
        lastDispatchAt: NOW - 5000,
      };
      const result = evaluateBudget(budget, 'GET:/x', NOW);
      expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: 30000 });
    });
  });

  describe('in-flight lease accounting on an unknown/stale bucket', () => {
    it('a lease against a route whose bucket has never been learned blocks a second dispatch (single-probe)', () => {
      const budget: BucketBudget = {
        ...emptyBudget(),
        leases: [lease({ requestId: 'a', routeKey: 'GET:/x', bucket: undefined, leasedAt: NOW - 2000 })],
      };
      const result = evaluateBudget(budget, 'GET:/x', NOW);
      expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: UNKNOWN_BUCKET_RETRY_MS });
    });

    it('a lease against a route whose bucket reset window already elapsed also single-probes', () => {
      const budget: BucketBudget = {
        ...emptyBudget(),
        bucketStates: { b1: { remaining: 5, resetAt: NOW - 1 } },
        routeToBucket: { 'GET:/x': 'b1' },
        leases: [lease({ requestId: 'a', bucket: 'b1', leasedAt: NOW - 2000 })],
      };
      const result = evaluateBudget(budget, 'GET:/x', NOW);
      expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfter: UNKNOWN_BUCKET_RETRY_MS });
    });

    it('with zero in-flight leases, an unknown bucket does not block', () => {
      expect(evaluateBudget(emptyBudget(), 'GET:/x', NOW)).toEqual({ ok: true });
    });
  });
});

describe('pruneLeases', () => {
  it('drops leases past LEASE_TTL_MS', () => {
    const budget = { ...emptyBudget(), leases: [lease({ requestId: 'old', leasedAt: NOW - LEASE_TTL_MS - 1 })] };
    expect(pruneLeases(budget, NOW).leases).toEqual([]);
  });

  it('keeps leases within LEASE_TTL_MS', () => {
    const l = lease({ requestId: 'fresh', leasedAt: NOW - 1000 });
    const budget = { ...emptyBudget(), leases: [l] };
    expect(pruneLeases(budget, NOW).leases).toEqual([l]);
  });

  it('is immutable: returns a new object when leases change, never mutates the input', () => {
    const budget = { ...emptyBudget(), leases: [lease({ requestId: 'old', leasedAt: NOW - LEASE_TTL_MS - 1 })] };
    const snapshot = JSON.parse(JSON.stringify(budget));
    pruneLeases(budget, NOW);
    expect(budget).toEqual(snapshot);
  });

  it('returns the SAME reference when nothing was pruned (cheap no-op detection)', () => {
    const l = lease({ requestId: 'fresh', leasedAt: NOW - 1000 });
    const budget = { ...emptyBudget(), leases: [l] };
    expect(pruneLeases(budget, NOW)).toBe(budget);
  });
});

describe('grantLease', () => {
  it('appends a lease with the bucket resolved from routeToBucket, and sets lastDispatchAt', () => {
    const budget = { ...emptyBudget(), routeToBucket: { 'GET:/x': 'b1' } };
    const result = grantLease(budget, 'GET:/x', 'req-new', NOW);
    expect(result.leases).toEqual([{ requestId: 'req-new', routeKey: 'GET:/x', bucket: 'b1', leasedAt: NOW }]);
    expect(result.lastDispatchAt).toBe(NOW);
  });

  it('leaves bucket undefined when the route has never been learned', () => {
    const result = grantLease(emptyBudget(), 'GET:/never-seen', 'req-new', NOW);
    expect(result.leases[0].bucket).toBeUndefined();
  });

  it('is immutable: never mutates the input budget', () => {
    const budget = emptyBudget();
    const snapshot = JSON.parse(JSON.stringify(budget));
    grantLease(budget, 'GET:/x', 'req-new', NOW);
    expect(budget).toEqual(snapshot);
  });

  it('appends onto existing leases rather than replacing them', () => {
    const existing = lease({ requestId: 'existing' });
    const budget = { ...emptyBudget(), leases: [existing] };
    const result = grantLease(budget, 'GET:/x', 'req-new', NOW);
    expect(result.leases).toHaveLength(2);
    expect(result.leases[0]).toEqual(existing);
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
    applyOutcome(budget, null, { status: 429, routeKey: 'GET:/x', retryAfterMs: 2000 }, NOW);
    expect(budget).toEqual(snapshot);
  });

  it('a 429 sets globalCooldownUntil to retryAfter * 1.5', () => {
    const result = applyOutcome(emptyBudget(), null, { status: 429, routeKey: 'GET:/x', retryAfterMs: 2000 }, NOW);
    expect(result.globalCooldownUntil).toBe(NOW + 3000);
  });

  it('records a per-bucket update from the discordBucketHash', () => {
    const result = applyOutcome(
      emptyBudget(),
      null,
      { status: 200, routeKey: 'GET:/x', discordBucketHash: 'b1', remaining: 5, resetAfterMs: 4000 },
      NOW,
    );
    expect(result.bucketStates.b1).toEqual({ remaining: 5, resetAt: NOW + 4000 });
    expect(result.routeToBucket['GET:/x']).toBe('b1');
  });

  it('a captcha signal opens a 30-minute identity circuit', () => {
    const result = applyOutcome(emptyBudget(), null, { status: 400, routeKey: 'GET:/x', signal: 'captcha' }, NOW);
    expect(result.circuit).toEqual({ signal: 'captcha', until: NOW + CAPTCHA_CIRCUIT_MS, openedAt: NOW });
  });

  it("never opens a circuit for a cloudflare signal (that is the DO-wide caller's job, not this budget's)", () => {
    const result = applyOutcome(emptyBudget(), null, { status: 403, routeKey: 'GET:/x', signal: 'cloudflare' }, NOW);
    expect(result.circuit).toBeNull();
  });

  it('a clean 2xx after an expired captcha circuit clears it', () => {
    const budget = { ...emptyBudget(), circuit: { signal: 'captcha' as const, until: NOW - 1, openedAt: NOW - 100 } };
    const result = applyOutcome(budget, null, { status: 200, routeKey: 'GET:/x' }, NOW);
    expect(result.circuit).toBeNull();
  });

  it('never clears a cloudflare-flavored circuit sitting in an identity budget (it should never be there, but if it is, leave it for the DO-wide path to own)', () => {
    const budget = { ...emptyBudget(), circuit: { signal: 'cloudflare' as const, until: NOW - 1, openedAt: NOW - 100 } };
    const result = applyOutcome(budget, null, { status: 200, routeKey: 'GET:/x' }, NOW);
    expect(result.circuit).toEqual(budget.circuit);
  });

  it('evicts the oldest-reset buckets once over the cap', () => {
    let budget = emptyBudget();
    for (let i = 0; i < BUCKET_STATES_CAP + 5; i++) {
      budget = applyOutcome(
        budget,
        null,
        { status: 200, routeKey: `GET:/r${i}`, discordBucketHash: `b${i}`, remaining: 1, resetAfterMs: i * 1000 },
        NOW,
      );
    }
    expect(Object.keys(budget.bucketStates).length).toBe(BUCKET_STATES_CAP);
    expect(budget.bucketStates.b0).toBeUndefined();
    // A route whose bucket was evicted must not keep a dangling mapping behind.
    expect(budget.routeToBucket['GET:/r0']).toBeUndefined();
    expect(Object.keys(budget.routeToBucket).length).toBe(BUCKET_STATES_CAP);
  });

  it('bounds route mappings that all share one bucket, keeping the most recently seen routes', () => {
    // Caller-chosen paths with non-snowflake segments (e.g. /invites/<code>)
    // each derive a distinct route key while Discord reports one shared bucket.
    let budget = emptyBudget();
    const outcomeFor = (i: number) => ({ status: 200, routeKey: `GET:/invites/code${i}`, discordBucketHash: 'shared', remaining: 5, resetAfterMs: 1000 });
    for (let i = 0; i < ROUTE_TO_BUCKET_CAP + 50; i++) {
      budget = applyOutcome(budget, null, outcomeFor(i), NOW);
      // Keep route 0 hot: a route seen again must count as recent, not be evicted by age of first insert.
      if (i % 10 === 0) budget = applyOutcome(budget, null, outcomeFor(0), NOW);
    }
    expect(Object.keys(budget.routeToBucket).length).toBe(ROUTE_TO_BUCKET_CAP);
    expect(budget.routeToBucket['GET:/invites/code0']).toBe('shared');
    expect(budget.routeToBucket[`GET:/invites/code${ROUTE_TO_BUCKET_CAP + 49}`]).toBe('shared');
    expect(budget.routeToBucket['GET:/invites/code1']).toBeUndefined();
  });

  it('never records a mapping for an oversized route key, but still learns the bucket state', () => {
    // A caller-chosen path can be kilobytes long; 400 of those would blow past the DO's per-value size limit.
    const longRoute = `GET:/invites/${'a'.repeat(ROUTE_KEY_MAX_LENGTH)}`;
    const result = applyOutcome(emptyBudget(), null, { status: 200, routeKey: longRoute, discordBucketHash: 'b1', remaining: 3, resetAfterMs: 1000 }, NOW);
    expect(result.routeToBucket[longRoute]).toBeUndefined();
    expect(result.bucketStates.b1).toEqual({ remaining: 3, resetAt: NOW + 1000 });
  });

  describe('bucket scoping per top-level resource', () => {
    const CHANNEL_A = 'GET:/channels/111111111111111111/messages';
    const CHANNEL_B = 'GET:/channels/222222222222222222/messages';

    it('keeps two channels that share one Discord bucket hash independent', () => {
      // B learns the shared hash first, then A reports the same hash
      // exhausted: A's row must not take B down with it...
      let budget = applyOutcome(
        emptyBudget(),
        null,
        { status: 200, routeKey: CHANNEL_B, discordBucketHash: 'shared', remaining: 5, resetAfterMs: 1000 },
        NOW,
      );
      budget = applyOutcome(
        budget,
        null,
        { status: 200, routeKey: CHANNEL_A, discordBucketHash: 'shared', remaining: 0, resetAfterMs: 5000 },
        NOW,
      );

      expect(evaluateBudget(budget, CHANNEL_A, NOW)).toEqual({ ok: false, reason: 'cooldown', retryAfter: 5000 });
      expect(evaluateBudget(budget, CHANNEL_B, NOW)).toEqual({ ok: true });

      // ...and A's exhausted row survives B's next response.
      budget = applyOutcome(
        budget,
        null,
        { status: 200, routeKey: CHANNEL_B, discordBucketHash: 'shared', remaining: 5, resetAfterMs: 1000 },
        NOW,
      );

      expect(evaluateBudget(budget, CHANNEL_A, NOW)).toEqual({ ok: false, reason: 'cooldown', retryAfter: 5000 });
      expect(evaluateBudget(budget, CHANNEL_B, NOW)).toEqual({ ok: true });
    });

    it('scopes two webhooks that share one Discord bucket hash by webhook id', () => {
      const webhookA = 'POST:/webhooks/123456789012345678/:token/messages';
      const webhookB = 'POST:/webhooks/223456789012345678/:token/messages';
      let budget = applyOutcome(
        emptyBudget(),
        null,
        { status: 200, routeKey: webhookB, discordBucketHash: 'shared', remaining: 5, resetAfterMs: 1000 },
        NOW,
      );
      budget = applyOutcome(
        budget,
        null,
        { status: 200, routeKey: webhookA, discordBucketHash: 'shared', remaining: 0, resetAfterMs: 5000 },
        NOW,
      );

      expect(evaluateBudget(budget, webhookA, NOW)).toEqual({ ok: false, reason: 'cooldown', retryAfter: 5000 });
      expect(evaluateBudget(budget, webhookB, NOW)).toEqual({ ok: true });
    });

    it('still lets normalized route keys with no literal top-level id share one row', () => {
      const search = 'GET:/guilds/:id/messages/search';
      const channels = 'GET:/guilds/:id/channels';
      let budget = applyOutcome(
        emptyBudget(),
        null,
        { status: 200, routeKey: search, discordBucketHash: 'shared', remaining: 0, resetAfterMs: 5000 },
        NOW,
      );
      expect(evaluateBudget(budget, channels, NOW).ok).toBe(true);

      budget = applyOutcome(
        budget,
        null,
        { status: 200, routeKey: channels, discordBucketHash: 'shared', remaining: 5, resetAfterMs: 1000 },
        NOW,
      );
      expect(evaluateBudget(budget, search, NOW)).toEqual({ ok: true });
    });
  });

  describe('requestId-gated settlement', () => {
    it('applies the outcome and removes the matching lease when requestId and routeKey both match', () => {
      const l = lease({ requestId: 'req-1', routeKey: 'GET:/x' });
      const budget = { ...emptyBudget(), leases: [l] };
      const result = applyOutcome(budget, 'req-1', { status: 429, routeKey: 'GET:/x', retryAfterMs: 2000 }, NOW);
      expect(result.leases).toEqual([]);
      expect(result.globalCooldownUntil).toBe(NOW + 3000);
    });

    it('is a complete no-op (same reference) for an unknown requestId - no lease to remove, nothing applied', () => {
      const budget = { ...emptyBudget(), leases: [lease({ requestId: 'real' })] };
      const result = applyOutcome(budget, 'never-issued', { status: 429, routeKey: 'GET:/x', retryAfterMs: 2000 }, NOW);
      expect(result).toBe(budget);
      expect(result.globalCooldownUntil).toBe(0);
    });

    it('is a complete no-op for a routeKey-mismatched settle (right id, wrong route) - defense against a malformed settle', () => {
      const l = lease({ requestId: 'req-1', routeKey: 'GET:/real-route' });
      const budget = { ...emptyBudget(), leases: [l] };
      const result = applyOutcome(budget, 'req-1', { status: 429, routeKey: 'GET:/spoofed-route', retryAfterMs: 2000 }, NOW);
      expect(result).toBe(budget);
      expect(result.leases).toEqual([l]);
    });

    it('leaves OTHER outstanding leases untouched when settling one', () => {
      const a = lease({ requestId: 'a', routeKey: 'GET:/x' });
      const b = lease({ requestId: 'b', routeKey: 'GET:/y' });
      const budget = { ...emptyBudget(), leases: [a, b] };
      const result = applyOutcome(budget, 'a', { status: 200, routeKey: 'GET:/x' }, NOW);
      expect(result.leases).toEqual([b]);
    });
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
