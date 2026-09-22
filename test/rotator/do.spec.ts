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
import { STATIC_GUARD_PREFIX, PENDING_LEASE_CAP, TOKEN_KEY_PREFIX } from '../../src/rotator/do';
import type { TokenPoolDO } from '../../src/rotator/do';
import type { ReleaseInput } from '../../src/rotator/types';

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

  it('LRU: prefers the older lastUsedAt among multiple tokens', async () => {
    const stub = freshStub();
    await stub.register({ label: 'a', slot: 'default', tokenSecret: VALID_TOKEN });
    await stub.register({ label: 'b', slot: 'default', tokenSecret: VALID_TOKEN_2 });

    // Acquire+release `a` so its lastUsedAt is "now"; `b` stays at 0 (LRU).
    const ra = await stub.acquire('default', ROUTE);
    expect(ra.ok).toBe(true);
    if (!ra.ok) return;
    await stub.release(ra.label, ra.requestId, { status: 200, routeKey: ROUTE });

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

  it('returns cooldown with retryAfter when globally cooling', async () => {
    const stub = freshStub();
    await stub.register({ label: 'cool', slot: 'default', tokenSecret: VALID_TOKEN });
    const acq = await stub.acquire('default', ROUTE);
    if (!acq.ok) return;
    await stub.release(acq.label, acq.requestId, {
      status: 429,
      routeKey: ROUTE,
      retryAfterMs: 2000,
    });
    const result = await stub.acquireByLabel('cool', 'default', ROUTE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cooldown');
      expect(result.retryAfter).toBeGreaterThan(0);
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
    if (!acq.ok) return;

    await stub.release(acq.label, acq.requestId, {
      status: 403,
      routeKey: ROUTE,
      code: 50001,
      guildId: GUILD_ID,
    });

    // Subsequent acquire for the same guild should fail (token marked ineligible)
    const next = await stub.acquire('default', ROUTE, GUILD_ID);
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason).toBe('cooldown');

    // But the same token is fine for a different guild
    await clearDispatchGap(stub, 'tok');
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
    const acq2 = await stub.acquire('default', ROUTE);
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

  it('after settleStatic with a 429, a subsequent leaseStatic for the same identityHash is blocked with cooldown', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 2000 });

    const second = await stub.leaseStatic(HASH_A, ROUTE);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.block.reason).toBe('cooldown');
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

  it('two static kinds sharing the same underlying token (same identityHash) share one budget, not two', async () => {
    const stub = freshStub();
    const leaseDefault = await stub.leaseStatic(HASH_A, ROUTE);
    if (!leaseDefault.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, leaseDefault.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 5000 });

    // Same identityHash: still blocked, because the budget is keyed by hash,
    // never by kind - the caller passes the identical hash regardless of
    // which slot (`user-default` vs `user-premium`) the request came from.
    const leasePremium = await stub.leaseStatic(HASH_A, ROUTE);
    expect(leasePremium.ok).toBe(false);

    // prepareStatic for either kind sees the same shared circuit/fingerprint
    // state too, since only the identityHash - not the kind - selects the
    // guard record; only the fingerprint lookup itself stays kind-scoped.
    const preparedDefault = await stub.prepareStatic(HASH_A, 'user-default');
    const preparedPremium = await stub.prepareStatic(HASH_A, 'user-premium');
    expect(preparedDefault.block).toEqual(preparedPremium.block);
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

  it('settleStatic is idempotent: a duplicate call with the same requestId does not double-apply', async () => {
    const stub = freshStub();
    const lease = await stub.leaseStatic(HASH_A, ROUTE);
    if (!lease.ok) throw new Error('expected ok lease');
    await stub.settleStatic(HASH_A, lease.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 1000 });
    // Second call with the same requestId: already removed from leases, so this is a no-op.
    await expect(
      stub.settleStatic(HASH_A, lease.requestId, { status: 429, routeKey: ROUTE, retryAfterMs: 99999 }),
    ).resolves.toBeUndefined();
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

  it('concurrent leaseStatic calls for the same identity serialize correctly: only one succeeds within the dispatch-gap floor', async () => {
    const stub = freshStub();
    const results = await Promise.all([
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
      stub.leaseStatic(HASH_A, ROUTE),
    ]);
    const succeeded = results.filter((r) => r.ok);
    // Cloudflare's input gates serialize these five RPC calls against the
    // same DO instance's storage, so exactly one sees a fresh (lastDispatchAt
    // === 0) budget; the other four each observe the prior call's write and
    // are correctly blocked by MIN_DISPATCH_GAP_MS, proving no double-lease
    // race exists even when the calls are issued concurrently from the Worker.
    expect(succeeded).toHaveLength(1);
    const requestIds = new Set(succeeded.map((r) => (r.ok ? r.requestId : null)));
    expect(requestIds.size).toBe(1);
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
  it('reset returns active and clears cooldowns', async () => {
    const stub = freshStub();
    await stub.register({ label: 'tok', slot: 'default', tokenSecret: VALID_TOKEN });
    // 3x401 -> invalid
    for (let i = 0; i < 3; i++) {
      const acq = await stub.acquire('default', ROUTE);
      if (acq.ok) await stub.release(acq.label, acq.requestId, { status: 401, routeKey: ROUTE });
    }
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
});
