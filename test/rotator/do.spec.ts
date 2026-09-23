/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/do.spec
 * End-to-end tests for the TokenPoolDO via the test pool's real binding.
 * Each test uses a fresh DO id to avoid cross-test state leakage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { makeTokenState, STATIC_GUARD_PREFIX, PENDING_LEASE_CAP, TOKEN_KEY_PREFIX } from '../../src/rotator/do';
import { LEASE_TTL_MS } from '../../src/rotator/budget';
import type { TokenPoolDO } from '../../src/rotator/do';
import type { ReleaseInput, StaticIdentityState, TokenState } from '../../src/rotator/types';

const VALID_TOKEN = 'A'.repeat(40) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(40);
const VALID_TOKEN_2 = 'D'.repeat(40) + '.' + 'E'.repeat(10) + '.' + 'F'.repeat(40);
const ROUTE = 'GET:/guilds/:id/messages/search';
const GUILD_ID = '219564597349318656';

let counter = 0;
function freshStub() {
  const id = env.TOKEN_POOL.idFromName(`test-${Date.now()}-${counter++}`);
  return env.TOKEN_POOL.get(id) as DurableObjectStub<TokenPoolDO>;
}

/**
 * Backdate a registered token's `lastDispatchAt` to 0 so the next `acquire`
 * is never blocked by `MIN_DISPATCH_GAP_MS` - for tests that loop
 * acquire/release cycles on the SAME token to exercise unrelated behavior
 * (401 counting, guild ineligibility, no-eligible-token classification),
 * not the dispatch-gap floor itself (which has its own dedicated tests).
 */
async function clearDispatchGap(stub: DurableObjectStub<TokenPoolDO>, label: string): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const key = `${TOKEN_KEY_PREFIX}${label}`;
    const token = await state.storage.get<{ lastDispatchAt: number }>(key);
    if (token) {
      token.lastDispatchAt = 0;
      await state.storage.put(key, token);
    }
  });
}

/** Same as `clearDispatchGap`, for a static-guard identity keyed by hash rather than a pool token keyed by label. */
async function clearStaticDispatchGap(stub: DurableObjectStub<TokenPoolDO>, identityHash: string): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const key = `${STATIC_GUARD_PREFIX}${identityHash}`;
    const guard = await state.storage.get<{ lastDispatchAt: number }>(key);
    if (guard) {
      guard.lastDispatchAt = 0;
      await state.storage.put(key, guard);
    }
  });
}

describe('TokenPoolDO.register / list / countSlot', () => {
  it('registers a token and lists it as a public-safe summary', async () => {
    const stub = freshStub();
    const reg = await stub.register({ label: 'tok-1', slot: 'default', tokenSecret: VALID_TOKEN });
    expect(reg.ok).toBe(true);
    if (reg.ok) {
      expect(reg.label).toBe('tok-1');
      expect(reg.registeredAt).toBeGreaterThan(0);
    }

    const list = await stub.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('tok-1');
    expect(list[0].status).toBe('active');
    expect(list[0].slot).toBe('default');
    // Crucial: tokenSecret never leaks via list()
    expect(list[0]).not.toHaveProperty('tokenSecret');
  });

  it('rejects registration of an existing label', async () => {
    const stub = freshStub();
    await stub.register({ label: 'dup', slot: 'default', tokenSecret: VALID_TOKEN });
    const second = await stub.register({ label: 'dup', slot: 'default', tokenSecret: VALID_TOKEN_2 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('label-exists');
  });

  it('countSlot is per-slot', async () => {
    const stub = freshStub();
    await stub.register({ label: 'd1', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.register({ label: 'd2', slot: 'default', tokenSecret: VALID_TOKEN_2 });
    await stub.register({ label: 'p1', slot: 'premium', tokenSecret: VALID_TOKEN });
    expect(await stub.countSlot('default')).toBe(2);
    expect(await stub.countSlot('premium')).toBe(1);
  });

  it('unregister is idempotent', async () => {
    const stub = freshStub();
    await stub.register({ label: 'doomed', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.unregister('doomed');
    await stub.unregister('doomed'); // no throw
    expect(await stub.list()).toHaveLength(0);
  });
});

describe('TokenPoolDO.acquire', () => {
  it('returns the only registered token for the slot', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const result = await stub.acquire('default', ROUTE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.label).toBe('tok');
      expect(result.tokenSecret).toBe(VALID_TOKEN);
      expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('returns empty-pool when slot has zero registered tokens', async () => {
    const stub = freshStub();
    const result = await stub.acquire('default', ROUTE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty-pool');
  });

  it('strict slot isolation: default request never sees premium token', async () => {
    const stub = freshStub();
    await stub.register({ label: 'p', slot: 'premium', tokenSecret: VALID_TOKEN });
    const result = await stub.acquire('default', ROUTE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty-pool');
  });

  it('persists lastUsedAt and inFlightCount after acquire', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.acquire('default', ROUTE);
    const list = await stub.list();
    expect(list[0].inFlightCount).toBe(1);
    expect(list[0].lastUsedAt).toBeGreaterThan(0);
  });

  it('LRU: prefers the older lastUsedAt among two eligible tokens', async () => {
    const stub = freshStub();
    await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.register({ label: 'b', slot: 'default', tokenSecret: VALID_TOKEN_2 });

    // Acquire+release `a` so its lastUsedAt is "now"; `b` stays at 0 (LRU).
    const ra = await stub.acquireByLabel('a', 'default', ROUTE);
    if (!ra.ok) throw new Error('expected pinned acquire to succeed');
    await stub.release('a', ra.requestId, { status: 200, routeKey: ROUTE });

    // Clear `a`'s 1s dispatch-gap floor: otherwise `a` would be ineligible for
    // the acquire below and the choice of `b` would prove nothing about LRU
    // ordering, only that `a` was temporarily gated.
    await clearDispatchGap(stub, 'a');

    const next = await stub.acquire('default', ROUTE);
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.label).toBe('b');
  });
});

describe('TokenPoolDO.acquireByLabel', () => {
  it('returns the labeled token when active and matching slot', async () => {
    const stub = freshStub();
    await stub.register({ label: 'pinned', slot: 'default', tokenSecret: VALID_TOKEN });
    const result = await stub.acquireByLabel('pinned', 'default', ROUTE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.label).toBe('pinned');
      expect(result.tokenSecret).toBe(VALID_TOKEN);
      expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('persists lastUsedAt and inFlightCount on success', async () => {
    const stub = freshStub();
    await stub.register({ label: 'pinned', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.acquireByLabel('pinned', 'default', ROUTE);
    const list = await stub.list();
    expect(list[0].inFlightCount).toBe(1);
    expect(list[0].lastUsedAt).toBeGreaterThan(0);
  });

  it('returns no-eligible-token when the label is missing', async () => {
    const stub = freshStub();
    const result = await stub.acquireByLabel('nope', 'default', ROUTE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-eligible-token');
  });

  it('returns no-eligible-token when the slot mismatches', async () => {
    const stub = freshStub();
    await stub.register({ label: 'p', slot: 'premium', tokenSecret: VALID_TOKEN });
    const result = await stub.acquireByLabel('p', 'default', ROUTE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-eligible-token');
  });

  it('returns no-eligible-token when the token is invalid', async () => {
    const stub = freshStub();
    await stub.register({ label: 'bad', slot: 'default', tokenSecret: VALID_TOKEN });
    for (let i = 0; i < 3; i++) {
      const acq = await stub.acquire('default', ROUTE);
      if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
      await clearDispatchGap(stub, 'bad');
    }
    const result = await stub.acquireByLabel('bad', 'default', ROUTE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-eligible-token');
  });

  it('returns cooldown with the 429 bench retryAfter when the pinned token is globally cooling', async () => {
    const stub = freshStub();
    await stub.register({ label: 'cool', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE);
    if (!acq.ok) throw new Error('expected acquire to succeed');
    await stub.release(acq.label, acq.requestId, {
      status: 429,
      routeKey: ROUTE,
      retryAfterMs: 2000,
    });

    // Clear the 1s dispatch-gap floor first: with it in place the block below
    // would be reported at ~1000ms and could pass even if the 429 bench had
    // never been applied at all.
    await clearDispatchGap(stub, 'cool');
    const result = await stub.acquireByLabel('cool', 'default', ROUTE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cooldown');
      // The bench is retryAfterMs * COOLDOWN_BACKOFF_FACTOR (1.5) = 3000ms.
      expect(result.retryAfter).toBeGreaterThan(2000);
    }
  });

  it('returns no-eligible-token when the guild is not in the whitelist', async () => {
    const stub = freshStub();
    await stub.register({
      label: 'narrow',
      slot: 'default',
      tokenSecret: VALID_TOKEN,
      guildIds: ['111111111111111111'],
    });
    const result = await stub.acquireByLabel('narrow', 'default', ROUTE, GUILD_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-eligible-token');
  });

  it('assigns a fingerprintProfileId on first pinned acquire', async () => {
    const stub = freshStub();
    await stub.register({ label: 'fresh', slot: 'default', tokenSecret: VALID_TOKEN });
    const result = await stub.acquireByLabel('fresh', 'default', ROUTE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.fingerprintProfileId).toBe('string');
      expect(result.fingerprintProfileId.length).toBeGreaterThan(0);
    }
  });
});

describe('TokenPoolDO.release', () => {
  it('updates bucket state from response headers', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE);
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;

    const release: ReleaseInput = {
      status: 200,
      routeKey: ROUTE,
      discordBucketHash: 'b1',
      remaining: 4,
      resetAfterMs: 5000,
    };
    await stub.release(acq.label, acq.requestId, release);

    const list = await stub.list();
    expect(list[0].inFlightCount).toBe(0);
    expect(list[0].bucketCount).toBe(1);
  });

  it('marks token invalid after 3 consecutive 401s', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    for (let i = 0; i < 3; i++) {
      const acq = await stub.acquire('default', ROUTE);
      expect(acq.ok).toBe(true);
      if (!acq.ok) return;
      await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
      await clearDispatchGap(stub, 'tok');
    }
    const list = await stub.list();
    expect(list[0].status).toBe('invalid');
    expect(list[0].consecutive401s).toBe(3);
  });

  it('resets the 401 counter after a successful response', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });

    let acq = await stub.acquire('default', ROUTE);
    if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
    await clearDispatchGap(stub, 'tok');

    acq = await stub.acquire('default', ROUTE);
    if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
    await clearDispatchGap(stub, 'tok');

    acq = await stub.acquire('default', ROUTE);
    if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });

    const list = await stub.list();
    expect(list[0].consecutive401s).toBe(0);
    expect(list[0].status).toBe('active');
  });

  it('429 sets globalCooldownUntil to retryAfter * 1.5', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE);
    if (!acq.ok) return;

    const before = Date.now();
    await stub.release(acq.label, acq.requestId, {
      status: 429,
      routeKey: ROUTE,
      retryAfterMs: 2000,
    });
    const list = await stub.list();
    expect(list[0].globalCooldownUntil).toBeGreaterThanOrEqual(before + 3000);
    expect(list[0].globalCooldownUntil).toBeLessThanOrEqual(before + 3500);
  });

  it('drops duplicate release calls with same requestId', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE);
    if (!acq.ok) return;
    await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });
    await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });
    const list = await stub.list();
    // inFlightCount decremented exactly once; otherwise it would be -1 clamped to 0
    // but consecutive401s tracking would also be off. Defensive check via direct state.
    expect(list[0].inFlightCount).toBe(0);
  });

  it('records ineligibleGuilds on 50001 within a guild', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE, GUILD_ID);
    if (!acq.ok) throw new Error('expected acquire to succeed');

    await stub.release(acq.label, acq.requestId, {
      status: 403,
      routeKey: ROUTE,
      code: 50001,
      guildId: GUILD_ID,
    });

    // Clear the dispatch-gap floor, so the block below can only come from the
    // recorded guild ineligibility (and its retryAfter be the guild TTL, not
    // the ~1000ms gap).
    await clearDispatchGap(stub, 'tok');
    const next = await stub.acquire('default', ROUTE, GUILD_ID);
    expect(next.ok).toBe(false);
    if (!next.ok) {
      expect(next.reason).toBe('cooldown');
      expect(next.retryAfter).toBeGreaterThan(59 * 60 * 1000);
    }

    // But the same token is fine for a different guild
    const otherGuild = await stub.acquire('default', ROUTE, '111111111111111111');
    expect(otherGuild.ok).toBe(true);
  });

  it('release on a deleted token is a silent no-op', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE);
    if (!acq.ok) return;
    await stub.unregister('tok');
    // Should not throw
    await stub.release(acq.label, acq.requestId, { status: 200, routeKey: ROUTE });
  });
});

describe('TokenPoolDO in-flight reconciliation against pruned leases', () => {
  /** Overwrite a registered token with abandoned (past `LEASE_TTL_MS`) leases plus an inflated in-flight count. */
  async function seedAbandonedLease(
    stub: DurableObjectStub<TokenPoolDO>,
    label: string,
    inFlightCount: number,
  ): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
      const key = `${TOKEN_KEY_PREFIX}${label}`;
      const token = await state.storage.get<TokenState>(key);
      if (!token) throw new Error(`expected registered token ${label}`);
      await state.storage.put(key, {
        ...token,
        inFlightCount,
        lastDispatchAt: 0,
        leases: [{ requestId: 'abandoned', routeKey: ROUTE, leasedAt: Date.now() - LEASE_TTL_MS - 1000 }],
      });
    });
  }

  it('hydrates a legacy token row that has inFlightCount but no leases to zero in-flight', async () => {
    const stub = freshStub();
    const legacy: Record<string, unknown> = {
      ...makeTokenState({ label: 'legacy', slot: 'default', tokenSecret: VALID_TOKEN }, Date.now()),
      inFlightCount: 4,
    };
    // A `token:<label>` row written before leases existed: no `leases` field
    // at all, so no later release can ever match a lease on it and the stale
    // count could only stay inflated.
    delete legacy.leases;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`${TOKEN_KEY_PREFIX}legacy`, legacy);
    });

    const list = await stub.list();
    expect(list).toHaveLength(1);
    expect(list[0].inFlightCount).toBe(0);
  });

  it('acquire: an abandoned lease stops penalizing its token in LRU selection', async () => {
    const stub = freshStub();
    await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.register({ label: 'b', slot: 'default', tokenSecret: VALID_TOKEN_2 });

    // `b` was used most recently, so `a` can only be chosen if its abandoned
    // lease no longer counts as in-flight against it.
    const rb = await stub.acquireByLabel('b', 'default', ROUTE);
    if (!rb.ok) throw new Error('expected pinned acquire to succeed');
    await stub.release('b', rb.requestId, { status: 200, routeKey: ROUTE });
    await clearDispatchGap(stub, 'b');

    await seedAbandonedLease(stub, 'a', 1);

    const next = await stub.acquire('default', ROUTE);
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.label).toBe('a');
  });

  it('acquireByLabel: a pinned acquire does not inherit an abandoned lease in its in-flight count', async () => {
    const stub = freshStub();
    await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
    await seedAbandonedLease(stub, 'a', 1);

    const acq = await stub.acquireByLabel('a', 'default', ROUTE);
    expect(acq.ok).toBe(true);

    const list = await stub.list();
    // Exactly the one lease this acquire just issued - the abandoned one was
    // dropped rather than carried into the count.
    expect(list[0].inFlightCount).toBe(1);
  });

  it('release: settles against the surviving leases, never a count inflated by an abandoned lease', async () => {
    const stub = freshStub();
    await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
    await runInDurableObject(stub, async (_instance, state) => {
      const key = `${TOKEN_KEY_PREFIX}a`;
      const token = await state.storage.get<TokenState>(key);
      if (!token) throw new Error('expected registered token');
      await state.storage.put(key, {
        ...token,
        inFlightCount: 2,
        leases: [
          { requestId: 'abandoned', routeKey: ROUTE, leasedAt: Date.now() - LEASE_TTL_MS - 1000 },
          { requestId: 'live', routeKey: ROUTE, leasedAt: Date.now() },
        ],
      });
    });

    await stub.release('a', 'live', { status: 200, routeKey: ROUTE });

    const list = await stub.list();
    expect(list[0].inFlightCount).toBe(0);
  });
});

describe('TokenPoolDO fingerprint integration', () => {
  it('assigns a fingerprintProfileId on first acquire and persists it', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq1 = await stub.acquire('default', ROUTE);
    expect(acq1.ok).toBe(true);
    if (!acq1.ok) return;
    expect(typeof acq1.fingerprintProfileId).toBe('string');
    expect(acq1.fingerprintProfileId.length).toBeGreaterThan(0);

    // Subsequent acquires return the same id
    await stub.release(acq1.label, acq1.requestId, { status: 200, routeKey: ROUTE });
    // Clear the dispatch-gap floor so the second acquire really runs (and its
    // profile id is really read back from storage) rather than being reported
    // as a cooldown.
    await clearDispatchGap(stub, 'tok');
    const acq2 = await stub.acquire('default', ROUTE);
    expect(acq2.ok).toBe(true);
    if (!acq2.ok) return;
    expect(acq2.fingerprintProfileId).toBe(acq1.fingerprintProfileId);

    // Summary exposes the assignment
    const list = await stub.list();
    expect(list[0].fingerprintProfileId).toBe(acq1.fingerprintProfileId);
  });

  it('setTokenFingerprintProfile overrides the assignment', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const r = await stub.setTokenFingerprintProfile('tok', 'chrome-win-de');
    expect(r.ok).toBe(true);
    const acq = await stub.acquire('default', ROUTE);
    if (!acq.ok) return;
    expect(acq.fingerprintProfileId).toBe('chrome-win-de');
  });

  it('setTokenFingerprintProfile on missing label returns not-found', async () => {
    const stub = freshStub();
    const r = await stub.setTokenFingerprintProfile('nope', 'chrome-win-de');
    expect(r.ok).toBe(false);
  });

  it('a token registered with a retired registry id is reassigned to a template id on acquire', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.setTokenFingerprintProfile('tok', 'profile-chrome-win-de-1');
    const acq = await stub.acquire('default', ROUTE);
    if (!acq.ok) return;
    expect(acq.fingerprintProfileId).not.toBe('profile-chrome-win-de-1');
    expect(['chrome-win-de', 'chrome-win-en', 'chrome-mac-de', 'chrome-mac-en']).toContain(acq.fingerprintProfileId);
  });

  it('static fingerprint roundtrip per kind: template id', async () => {
    const stub = freshStub();
    let mapping = await stub.listStaticFingerprints();
    expect(mapping.userDefault).toBeNull();
    expect(mapping.userPremium).toBeNull();

    await stub.setStaticFingerprint('user-default', { profileId: 'chrome-win-de' });
    await stub.setStaticFingerprint('user-premium', { profileId: 'chrome-mac-en' });

    mapping = await stub.listStaticFingerprints();
    expect(mapping.userDefault?.profileId).toBe('chrome-win-de');
    expect(mapping.userPremium?.profileId).toBe('chrome-mac-en');

    const prepared = await stub.prepareStatic('irrelevant-hash-for-this-test', 'user-default');
    expect(prepared.fingerprint?.profileId).toBe('chrome-win-de');
  });

  it('static fingerprint roundtrip: custom clone profile', async () => {
    const stub = freshStub();
    const custom = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      superProperties: {
        os: 'Windows',
        browser: 'Chrome',
        device: '',
        system_locale: 'en-US',
        has_client_mods: false,
        browser_user_agent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        browser_version: '148.0.0.0',
        os_version: '10',
        referrer: '',
        referring_domain: '',
        referrer_current: '',
        referring_domain_current: '',
        release_channel: 'stable',
      },
      locale: 'en-US',
      timezone: 'America/New_York',
      clientHints: { 'Sec-CH-UA': '"Chromium";v="148"', 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"Windows"' },
    };
    await stub.setStaticFingerprint('user-premium', { custom });
    const mapping = await stub.listStaticFingerprints();
    expect(mapping.userPremium?.profileId).toBe('custom');
    expect(mapping.userPremium?.custom?.userAgent).toBe(custom.userAgent);
  });

  it('getClientVersions round-trips both records independently', async () => {
    const stub = freshStub();
    expect(await stub.getClientVersions()).toEqual({ build: null, chrome: null });
    await stub.setBuildNumberRecord({ buildNumber: 617136, fetchedAt: 1_700_000_000_000, source: 'scraped' });
    await stub.setChromeVersionRecord({ major: 148, fetchedAt: 1_700_000_000_000, source: 'scraped' });
    const versions = await stub.getClientVersions();
    expect(versions.build).toEqual({ buildNumber: 617136, fetchedAt: 1_700_000_000_000, source: 'scraped' });
    expect(versions.chrome).toEqual({ major: 148, fetchedAt: 1_700_000_000_000, source: 'scraped' });
  });

  it('loadAllTokens prefix scan does not pick up meta keys', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.setBuildNumberRecord({ buildNumber: 1, fetchedAt: 1, source: 'manual' });
    await stub.setStaticFingerprint('user-default', { profileId: 'chrome-win-de' });
    const list = await stub.list();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('tok');
  });
});

describe('TokenPoolDO static-identity guard: prepareStatic / leaseStatic / settleStatic', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it('prepareStatic is a pure read: never blocks, never mutates, no routeKey, no block for an unseen identity', async () => {
    const stub = freshStub();
    const prepared = await stub.prepareStatic(HASH_A, 'user-default');
    expect(prepared.fingerprint).toBeNull();
    expect(prepared.versions).toEqual({ build: null, chrome: null });
    expect(prepared.block).toBeNull();
  });

  it('leaseStatic succeeds on a fresh identity and returns a requestId', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    expect(lease.ok).toBe(true);
    if (lease.ok) expect(typeof lease.requestId).toBe('string');
  });

  it('after settleStatic with a 429, a subsequent leaseStatic for the same identityHash is blocked by the 429 bench', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 2000 });

    // Clear the 1s dispatch-gap floor first: with it still in place the block
    // below would be reported at ~1000ms and the test could pass even if the
    // 429 bench had never been applied.
    await clearStaticDispatchGap(stub, HASH_A);
    const second = await stub.leaseStatic(HASH_A, ROUTE);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.block.reason).toBe('cooldown');
      // retryAfterMs * COOLDOWN_BACKOFF_FACTOR (1.5) = 3000ms.
      expect(second.block.retryAfter).toBeGreaterThan(2000);
    }
  });

  it('a captcha signal opens a circuit that blocks this identity for about 30 minutes, surfaced by both leaseStatic and prepareStatic', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, { status: 400, routeKey: ROUTE, signal: 'captcha' });

    const second = await stub.leaseStatic(HASH_A, ROUTE);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.block.reason).toBe('cooldown');
      expect(second.block.signal).toBe('captcha');
      expect(second.block.retryAfter).toBeGreaterThan(29 * 60 * 1000);
    }

    // prepareStatic's read-only circuit peek sees the same open circuit
    // without ever attempting a lease - this is what lets the identity
    // middleware short-circuit a definitely-blocked static request before
    // it reaches downstream middleware, with nothing ever reserved.
    const prepared = await stub.prepareStatic(HASH_A, 'user-default');
    expect(prepared.block?.signal).toBe('captcha');
    expect(prepared.block?.retryAfter).toBeGreaterThan(29 * 60 * 1000);

    // A different identity's prepareStatic peek is unaffected.
    const preparedOther = await stub.prepareStatic(HASH_B, 'user-default');
    expect(preparedOther.block).toBeNull();
  });

  it('two static kinds sharing the same underlying token (same identityHash) share one guard record, keyed by hash not kind', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, { status: 400, routeKey: ROUTE, signal: 'captcha' });

    // Same identityHash: the circuit opened on a `user-default` request blocks
    // the next lease too, because the guard record is keyed by hash, never by
    // kind - the caller passes the identical hash regardless of which slot the
    // request came from.
    const gated = await stub.leaseStatic(HASH_A, ROUTE);
    expect(gated.ok).toBe(false);
    if (!gated.ok) {
      expect(gated.block.signal).toBe('captcha');
      expect(gated.block.retryAfter).toBeGreaterThan(29 * 60 * 1000);
    }

    // The read-only peek resolves the same hash-keyed guard for EITHER kind;
    // only the fingerprint lookup itself stays kind-scoped.
    const premiumPeek = await stub.prepareStatic(HASH_A, 'user-premium');
    expect(premiumPeek.block?.signal).toBe('captcha');
    expect(premiumPeek.fingerprint).toBeNull(); // no fingerprint was ever set for this kind

    // A different identity is unaffected by that circuit.
    const otherPeek = await stub.prepareStatic(HASH_B, 'user-premium');
    expect(otherPeek.block).toBeNull();
  });

  it('a different identityHash is an independent budget', async () => {
    const stub = freshStub();
    const leaseA = await stub.leaseStatic(HASH_A, ROUTE);
    if (!leaseA.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, leaseA.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 5000 });

    const leaseB = await stub.leaseStatic(HASH_B, ROUTE);
    expect(leaseB.ok).toBe(true);
  });

  it('settleStatic with an unknown requestId is a silent no-op', async () => {
    const stub = freshStub();
    await expect(stub.settleStatic(HASH_A, 'never-issued', { status: 200, routeKey: ROUTE })).resolves.toBeUndefined();
  });

  it('settleStatic with a mismatched routeKey does not consume the lease (defense against a malformed settle)', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, {
      status: 429,
      routeKey: 'GET:/some/other/route',
      retryAfterMs: 9999,
    });

    // The mismatched settle must not have applied its 429, nor consumed the
    // original lease - prove it by settling with the CORRECT routeKey now:
    // this must still find and remove the SAME original lease (a lease a
    // malformed settle had already silently consumed would make this a
    // no-op too, and the bogus 429/9999ms retryAfter would still show up).
    await stub.settleStatic(HASH_A, lease.requestId, { status: 200, routeKey: ROUTE });

    // With the lease genuinely settled clean and no fallout from the bogus
    // 429, a fresh lease (past the dispatch-gap floor) succeeds.
    await clearStaticDispatchGap(stub, HASH_A);
    const second = await stub.leaseStatic(HASH_A, ROUTE);
    expect(second.ok).toBe(true);
  });

  it('settleStatic is idempotent: a duplicate or unknown requestId applies nothing', async () => {
    const stub = freshStub();
    const before = Date.now();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 1000 });

    // The same requestId again, now with a far longer Retry-After: the lease is
    // already gone, so this must not extend the bench (1000ms * 1.5 = 1500ms;
    // the replay would make it 99999 * 1.5 = ~150000ms).
    await expect(
      stub.settleStatic(HASH_A, lease.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 99999 }),
    ).resolves.toBeUndefined();
    // An unknown id against an EXISTING guard record: same story.
    await expect(
      stub.settleStatic(HASH_A, 'never-issued', { status: 429, routeKey: ROUTE, retryAfterMs: 99999 }),
    ).resolves.toBeUndefined();

    await runInDurableObject(stub, async (_instance, state) => {
      const guard = await state.storage.get<StaticIdentityState>(`${STATIC_GUARD_PREFIX}${HASH_A}`);
      expect(guard?.leases).toEqual([]);
      expect(guard?.globalCooldownUntil).toBeGreaterThanOrEqual(before + 1500);
      expect(guard?.globalCooldownUntil).toBeLessThan(before + 5000);
    });
  });

  it('a Cloudflare signal opens the DO-wide upstream circuit, blocking every identity (leaseStatic, prepareStatic, and the pool)', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, { status: 403, routeKey: ROUTE, signal: 'cloudflare' });

    // A completely different identity (different hash) is also blocked, both at lease time and at the prepare-time peek.
    const other = await stub.leaseStatic(HASH_B, ROUTE);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.block.signal).toBe('cloudflare');
    const preparedOther = await stub.prepareStatic(HASH_B, 'user-default');
    expect(preparedOther.block?.signal).toBe('cloudflare');

    // The pool is blocked too - acquire on a registered token also sees the upstream circuit.
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE);
    expect(acq.ok).toBe(false);
  });

  it('rejects a new lease at PENDING_LEASE_CAP without evicting any still-outstanding lease', async () => {
    const stub = freshStub();
    // Seed PENDING_LEASE_CAP outstanding leases directly: driving this many
    // *real* leaseStatic calls would each trip MIN_DISPATCH_GAP_MS against
    // the identity's own immediately-prior call, which is a different
    // mechanism than the one under test here. Direct storage seeding
    // isolates the capacity check; the assertions below only ever call the
    // real `leaseStatic`/`settleStatic` RPCs.
    const now = Date.now();
    const seededLeases = Array.from({ length: PENDING_LEASE_CAP }, (_, i) => ({
      requestId: `seed-${i}`,
      routeKey: `GET:/seed-route-${i}`,
      leasedAt: now,
    }));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`${STATIC_GUARD_PREFIX}${HASH_A}`, {
        identityHash: HASH_A,
        lastSeenAt: now,
        lastDispatchAt: now - 10_000, // Well past MIN_DISPATCH_GAP_MS so only the capacity check is exercised below.
        bucketStates: {},
        routeToBucket: {},
        globalCooldownUntil: 0,
        circuit: null,
        leases: seededLeases,
      });
    });

    const overCap = await stub.leaseStatic(HASH_A, 'GET:/route-over-cap');
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.block.reason).toBe('capacity');

    // Settling one of the seeded leases frees capacity for the next real
    // lease - proves the rejected lease above never evicted a seeded entry.
    await stub.settleStatic(HASH_A, 'seed-0', { status: 200, routeKey: 'GET:/seed-route-0' });
    const afterSettle = await stub.leaseStatic(HASH_A, 'GET:/route-after-settle');
    expect(afterSettle.ok).toBe(true);
  });

  it('concurrent leaseStatic calls for the same identity never land two dispatches inside the 1s gap', async () => {
    const stub = freshStub();
    const results = await Promise.all([
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
    ]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    // Cloudflare's input gates serialize these five RPC calls against the same
    // DO instance's storage, so a call either sees a budget free of the 1s gap
    // (and is leased) or is blocked by it. Assert the invariant that actually
    // matters - two granted leases are never less than MIN_DISPATCH_GAP_MS
    // apart - rather than a fixed winner count, which depends on how much
    // wall-clock time the five round trips happen to take.
    const leasedAt = await runInDurableObject(stub, async (_instance, state) => {
      const guard = await state.storage.get<StaticIdentityState>(`${STATIC_GUARD_PREFIX}${HASH_A}`);
      return (guard?.leases ?? []).map((l) => l.leasedAt).sort((a, b) => a - b);
    });
    expect(leasedAt).toHaveLength(succeeded.length);
    for (let i = 1; i < leasedAt.length; i++) {
      expect(leasedAt[i] - leasedAt[i - 1]).toBeGreaterThanOrEqual(1000);
    }
  });

  it('leaseStatic calls for different identityHashes on the same DO instance are independent budgets, even issued concurrently', async () => {
    const stub = freshStub();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => stub.leaseStatic(`${i}`.repeat(64), ROUTE)));
    // Each call uses a distinct identityHash against the same DO instance, so
    // none contend with each other on lastDispatchAt, bucket state, or
    // leases - proving the guard is genuinely keyed per-hash rather than
    // accidentally shared DO-wide (only the upstream circuit is DO-wide).
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('settling one lease and rejecting several more never leaves a stale entry behind', async () => {
    // Deterministic by construction (sequential awaits, no real-concurrency
    // timing race needed): true concurrent-lease serialization is already
    // covered by the "issued concurrently" tests above and below. This test's
    // own unique claim - a rejected leaseStatic call never writes a ghost
    // entry to `leases` - does not depend on wall-clock racing at all.
    const stub = freshStub();
    const first = await stub.leaseStatic(HASH_A, 'GET:/concurrent-0');
    if (!first.ok) throw new Error('expected first lease to succeed');
    await stub.settleStatic(HASH_A, first.requestId, { status: 200, routeKey: 'GET:/concurrent-0' });

    // Force lastDispatchAt far into the future: under full-suite load, the
    // four leaseStatic RPC round-trips in the loop below can themselves
    // cumulatively consume real wall-clock time approaching or exceeding
    // MIN_DISPATCH_GAP_MS, which would let a later attempt legitimately
    // clear the gap on its own. A 60s-future timestamp gives every attempt
    // in the loop a wide safety margin regardless of RPC latency, without
    // touching the MIN_DISPATCH_GAP_MS behavior under test.
    await runInDurableObject(stub, async (_instance, state) => {
      const key = `${STATIC_GUARD_PREFIX}${HASH_A}`;
      const guard = await state.storage.get<{ lastDispatchAt: number }>(key);
      if (guard) {
        guard.lastDispatchAt = Date.now() + 60_000;
        await state.storage.put(key, guard);
      }
    });

    // Immediately (no wait) attempt 4 more leases on the SAME identity - all
    // must be blocked by MIN_DISPATCH_GAP_MS.
    for (let i = 1; i < 5; i++) {
      const attempt = await stub.leaseStatic(HASH_A, `GET:/concurrent-${i}`);
      expect(attempt.ok).toBe(false);
    }

    // The settled lease was removed, and none of the 4 rejected attempts left
    // a ghost entry behind - proves a rejected leaseStatic call never writes
    // to `leases` at all.
    await runInDurableObject(stub, async (_instance, state) => {
      const guard = await state.storage.get<{ leases: unknown[] }>(`${STATIC_GUARD_PREFIX}${HASH_A}`);
      expect(guard?.leases).toEqual([]);
    });
  });
});

describe('TokenPoolDO.reset and health', () => {
  it('reset returns the token to active and clears every bench', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    // 3x401 -> invalid. The gap is cleared between cycles, otherwise only the
    // first acquire would succeed and the token would never actually reach
    // the invalid state this test needs to reset.
    for (let i = 0; i < 3; i++) {
      const acq = await stub.acquire('default', ROUTE);
      expect(acq.ok).toBe(true);
      if (!acq.ok) throw new Error(`expected acquire ${i} to succeed`);
      await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
      await clearDispatchGap(stub, 'tok');
    }

    const before = await stub.list();
    expect(before[0].status).toBe('invalid');
    expect(before[0].consecutive401s).toBe(3);

    const reset = await stub.reset('tok');
    expect(reset.ok).toBe(true);

    const list = await stub.list();
    expect(list[0].status).toBe('active');
    expect(list[0].consecutive401s).toBe(0);
    expect(list[0].globalCooldownUntil).toBe(0);
  });

  it('reset on missing label returns ok:false', async () => {
    const stub = freshStub();
    const result = await stub.reset('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
  });

  it('health rolls up active vs cooling vs invalid per slot', async () => {
    const stub = freshStub();
    await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.register({ label: 'b', slot: 'default', tokenSecret: VALID_TOKEN_2 });
    await stub.register({ label: 'p', slot: 'premium', tokenSecret: VALID_TOKEN });

    // Force `b` to invalid via real acquire-then-release cycles (a fabricated
    // requestId is correctly rejected now that release() is lease-gated -
    // see the "release requestId/routeKey mismatch" defense). acquireByLabel
    // pins to `b` specifically so the LRU auto-selection never hits `a`.
    for (let i = 0; i < 3; i++) {
      const acq = await stub.acquireByLabel('b', 'default', ROUTE);
      if (!acq.ok) throw new Error(`expected ok acquire on iteration ${i}`);
      await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
      await clearDispatchGap(stub, 'b');
    }

    const health = await stub.health();
    expect(health.default.count).toBe(2);
    expect(health.default.invalid).toBe(1);
    expect(health.default.active).toBe(1);
    expect(health.premium.count).toBe(1);
    expect(health.premium.active).toBe(1);
  });

  it('health counts a suspended token as neither active nor cooling', async () => {
    const stub = freshStub();
    await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.register({ label: 's', slot: 'default', tokenSecret: VALID_TOKEN_2 });
    await runInDurableObject(stub, async (_instance, state) => {
      const key = `${TOKEN_KEY_PREFIX}s`;
      const token = await state.storage.get<TokenState>(key);
      if (!token) throw new Error('expected registered token');
      // Suspension is an operator state with no DO call of its own.
      await state.storage.put(key, { ...token, status: 'suspended' });
    });

    const health = await stub.health();
    expect(health.default.count).toBe(2);
    expect(health.default.active).toBe(1);
    expect(health.default.cooling).toBe(0);
    expect(health.default.invalid).toBe(0);
  });
});
