/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/identity.spec
 * Tests `identityMiddleware`'s current, deliberately narrow contract: it
 * never acquires or leases anything, only resolves a read-only fallback
 * identity and records a `PoolPlan` for pool-eligible routes. Pool
 * acquire/release and static lease/settle behaviors are NOT tested here -
 * they live in `test/routes/proxy.spec.ts`, which owns the acquire/release
 * pairing (the middleware that used to do it, and its spec, are gone).
 */

import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { identityMiddleware } from '../../src/middleware/identity';
import { hashToken } from '../../src/rotator/token-hash';
import type { Bindings } from '../../src/types';
import type { AuthVariables } from '../../src/middleware/auth';
import type { DiscordContextVariables } from '../../src/middleware/discord-context';
import type { PoolPlan, RequestIdentity, RotatorVariables, StaticPrepareResult, TokenPoolClient } from '../../src/rotator/types';
import type { ClientVersions } from '../../src/fingerprint/versions';

type Vars = AuthVariables & DiscordContextVariables & RotatorVariables;

/** Shape of every probe handler's JSON body in this file. */
type IdentityProbeBody = {
  identity: RequestIdentity | null;
  poolPlan: PoolPlan | null;
  clientVersions: ClientVersions | null;
};

const MOCK_ENV: Bindings = {
  DISCORD_TOKEN_BOT: 'BOT',
  DISCORD_TOKEN_USER: 'STATIC_USER',
  AUTH_KEY: 'k',
  TOKEN_POOL: {} as DurableObjectNamespace, // unused; tests inject a client directly via a mock
};

const EMPTY_PREPARE: StaticPrepareResult = { fingerprint: null, versions: { build: null, chrome: null }, block: null };

function buildApp(
  opts: {
    client?: TokenPoolClient;
    discordToken?: string;
    discordTokenKind?: DiscordContextVariables['discordTokenKind'];
    authSlot?: 'default' | 'premium';
  } = {},
) {
  const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Vars }>();
  app.use('*', async (c, next) => {
    c.set('authSlot', opts.authSlot ?? 'default');
    c.set('discordToken', opts.discordToken ?? 'STATIC_USER');
    c.set('discordTokenKind', opts.discordTokenKind ?? 'user-default');
    if (opts.client) c.set('tokenPoolClient', opts.client);
    await next();
  });
  app.use('*', identityMiddleware);
  app.all('/*', (c) =>
    c.json({
      identity: c.var.identity ?? null,
      poolPlan: c.var.poolPlan ?? null,
      clientVersions: c.var.clientVersions ?? null,
    }),
  );
  return app;
}

function mockClient(overrides: Partial<TokenPoolClient> = {}): TokenPoolClient {
  return {
    acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 0 }),
    release: async () => undefined,
    prepareStatic: async () => EMPTY_PREPARE,
    ...overrides,
  };
}

describe('identityMiddleware', () => {
  it('never resolves an identity for bot requests, and never touches the client', async () => {
    const client = mockClient({
      prepareStatic: async () => {
        throw new Error('must not be called for bot');
      },
    });
    const app = buildApp({ client, discordTokenKind: 'bot' });
    const res = await app.request('/users/@me', {}, MOCK_ENV);
    const body = (await res.json()) as IdentityProbeBody;
    expect(body.identity).toBeNull();
    expect(body.poolPlan).toBeNull();
  });

  it('resolves a hash-keyed static identity on a non-rotatable path, and never sets a poolPlan', async () => {
    const client = mockClient();
    const app = buildApp({ client, discordToken: 'STATIC_USER', discordTokenKind: 'user-default' });
    const res = await app.request('/users/@me', {}, MOCK_ENV);
    const body = (await res.json()) as IdentityProbeBody;
    const expectedHash = await hashToken('STATIC_USER');
    expect(body.identity?.key).toBe(`static:${expectedHash}`);
    expect(body.identity?.kind).toBe('static');
    expect(body.identity?.staticKind).toBe('user-default');
    expect(body.poolPlan).toBeNull();
  });

  it('never calls acquire, acquireByLabel, leaseStatic, or settleStatic - it only reads', async () => {
    let acquireCalled = false;
    let leaseCalled = false;
    const client = mockClient({
      acquire: async () => {
        acquireCalled = true;
        return { ok: false, reason: 'empty-pool', retryAfter: 0 };
      },
      leaseStatic: async () => {
        leaseCalled = true;
        return { ok: true, requestId: 'x' };
      },
    });
    const app = buildApp({ client });
    await app.request('/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
    await app.request('/users/@me', {}, MOCK_ENV);
    expect(acquireCalled).toBe(false);
    expect(leaseCalled).toBe(false);
  });

  it('records a poolPlan with selector "auto" and the budget key on a rotatable path with no X-Proxy-Token header', async () => {
    const client = mockClient();
    const app = buildApp({ client });
    const res = await app.request('/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
    const body = (await res.json()) as IdentityProbeBody;
    expect(body.poolPlan).toEqual({
      slot: 'default',
      selector: 'auto',
      // The budget key keeps the literal guild id (rate-limit state is scoped
      // per top-level resource); the rotation allowlist still reads the
      // normalized `GET:/guilds/:id/messages/search`.
      routeKey: 'GET:/guilds/219564597349318656/messages/search',
      guildId: '219564597349318656',
    });
    // The fallback identity is still resolved even on a pool-eligible route -
    // proxy.ts needs it for the empty-pool/no-eligible-token fallback path.
    expect(body.identity).not.toBeNull();
  });

  it('forwards the premium slot in the poolPlan when authSlot is premium', async () => {
    const client = mockClient();
    const app = buildApp({ client, authSlot: 'premium' });
    const res = await app.request('/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
    const body = (await res.json()) as IdentityProbeBody;
    expect(body.poolPlan?.slot).toBe('premium');
  });

  it('X-Proxy-Token: <label> pins the poolPlan selector to that label', async () => {
    const client = mockClient();
    const app = buildApp({ client });
    const res = await app.request('/guilds/219564597349318656/messages/search', { headers: { 'X-Proxy-Token': 'alt-1' } }, MOCK_ENV);
    const body = (await res.json()) as IdentityProbeBody;
    expect(body.poolPlan?.selector).toEqual({ label: 'alt-1' });
  });

  it('X-Proxy-Token: static skips the pool entirely, even on an otherwise-rotatable path', async () => {
    const client = mockClient();
    const app = buildApp({ client });
    const res = await app.request('/guilds/219564597349318656/messages/search', { headers: { 'X-Proxy-Token': 'static' } }, MOCK_ENV);
    const body = (await res.json()) as IdentityProbeBody;
    expect(body.poolPlan).toBeNull();
    expect(body.identity).not.toBeNull();
  });

  it('returns 503 when the binding throws and the caller pinned a specific label', async () => {
    const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Vars }>();
    app.use('*', async (c, next) => {
      c.set('authSlot', 'default');
      c.set('discordToken', 'STATIC_USER');
      c.set('discordTokenKind', 'user-default');
      // No client seeded and no valid TOKEN_POOL binding -> getPoolStub throws.
      await next();
    });
    app.use('*', identityMiddleware);
    app.all('/*', (c) => c.json({ reached: true }));
    const res = await app.request('/guilds/219564597349318656/messages/search', { headers: { 'X-Proxy-Token': 'alt-1' } }, MOCK_ENV);
    expect(res.status).toBe(503);
  });

  it('falls through gracefully (200, poolPlan still set) when the binding throws and the selector is auto', async () => {
    const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Vars }>();
    app.use('*', async (c, next) => {
      c.set('authSlot', 'default');
      c.set('discordToken', 'STATIC_USER');
      c.set('discordTokenKind', 'user-default');
      await next();
    });
    app.use('*', identityMiddleware);
    app.all('/*', (c) => c.json({ poolPlan: c.var.poolPlan ?? null }));
    const res = await app.request('/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { poolPlan: PoolPlan | null };
    expect(body.poolPlan?.selector).toBe('auto');
  });

  it('a client without prepareStatic still resolves a fallback identity with no guard/block', async () => {
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 0 }),
      release: async () => undefined,
    };
    const app = buildApp({ client });
    const res = await app.request('/users/@me', {}, MOCK_ENV);
    const body = (await res.json()) as IdentityProbeBody;
    expect(body.identity).not.toBeNull();
    expect(body.identity?.profile).toBeDefined();
  });

  it('short-circuits with 429 + X-Proxy-Block when the static identity has an open circuit AND the route is not pool-eligible', async () => {
    const client = mockClient({
      prepareStatic: async () => ({ ...EMPTY_PREPARE, block: { reason: 'cooldown', retryAfter: 1_800_000, signal: 'captcha' } }),
    });
    const app = buildApp({ client });
    const res = await app.request('/users/@me', {}, MOCK_ENV);
    expect(res.status).toBe(429);
    expect(res.headers.get('X-Proxy-Block')).toBe('captcha');
  });

  it('does NOT short-circuit a pool-eligible request just because the unrelated static fallback identity is blocked', async () => {
    const client = mockClient({
      prepareStatic: async () => ({ ...EMPTY_PREPARE, block: { reason: 'cooldown', retryAfter: 1_800_000, signal: 'captcha' } }),
    });
    const app = buildApp({ client });
    const res = await app.request('/guilds/219564597349318656/messages/search', {}, MOCK_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as IdentityProbeBody;
    expect(body.poolPlan).not.toBeNull();
  });

  it('does NOT pre-block a /custom request on an open static circuit - those handlers lease at their own point of use', async () => {
    const client = mockClient({
      prepareStatic: async () => ({ ...EMPTY_PREPARE, block: { reason: 'cooldown', retryAfter: 1_800_000, signal: 'captcha' } }),
    });
    const app = buildApp({ client });
    // Bingo is pool-only: it never leases the static guard, so a static
    // captcha circuit must not reject the request before its handler runs
    // (the request itself is rejected at the pool, not here).
    const res = await app.request('/custom/chillzone/events/bingo/participant/987654321098765432/counts', {}, MOCK_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Proxy-Block')).toBeNull();
  });

  it('X-Proxy-Token: static DOES short-circuit on a block, since the static identity is then guaranteed to be used', async () => {
    const client = mockClient({
      prepareStatic: async () => ({ ...EMPTY_PREPARE, block: { reason: 'cooldown', retryAfter: 5000 } }),
    });
    const app = buildApp({ client });
    const res = await app.request('/guilds/219564597349318656/messages/search', { headers: { 'X-Proxy-Token': 'static' } }, MOCK_ENV);
    expect(res.status).toBe(429);
    expect(res.headers.get('X-Proxy-Block')).toBe('bucket');
  });

  it('DUAL-SLOT COLLISION: the same underlying token configured for both static kinds resolves to the exact same identity key, so its fingerprint session never diverges even though the operator-facing "kind" differs', async () => {
    const client = mockClient();
    const appDefault = buildApp({ client, discordToken: 'SHARED_TOKEN', discordTokenKind: 'user-default' });
    const appPremium = buildApp({ client, discordToken: 'SHARED_TOKEN', discordTokenKind: 'user-premium' });

    const resDefault = await appDefault.request('/users/@me', {}, MOCK_ENV);
    const resPremium = await appPremium.request('/users/@me', {}, MOCK_ENV);
    const bodyDefault = (await resDefault.json()) as IdentityProbeBody;
    const bodyPremium = (await resPremium.json()) as IdentityProbeBody;

    expect(bodyDefault.identity?.key).toBe(bodyPremium.identity?.key);
    // staticKind still differs - that's the operator-UX-only axis (which
    // slot's fingerprint *profile* applies); the identity KEY (what the
    // guard and the session derivation both key off) must not.
    expect(bodyDefault.identity?.staticKind).toBe('user-default');
    expect(bodyPremium.identity?.staticKind).toBe('user-premium');

    // prepareStatic itself is called with the SAME hash for both kinds -
    // this is what makes the guard (leaseStatic/settleStatic downstream in
    // proxy.ts) and the session/identity key agree on which physical token
    // is being rate-limited and fingerprinted.
    const seenHashes = new Set<string>();
    const spyClient = mockClient({
      prepareStatic: async (identityHash) => {
        seenHashes.add(identityHash);
        return EMPTY_PREPARE;
      },
    });
    await buildApp({ client: spyClient, discordToken: 'SHARED_TOKEN', discordTokenKind: 'user-default' }).request(
      '/users/@me',
      {},
      MOCK_ENV,
    );
    await buildApp({ client: spyClient, discordToken: 'SHARED_TOKEN', discordTokenKind: 'user-premium' }).request(
      '/users/@me',
      {},
      MOCK_ENV,
    );
    expect(seenHashes.size).toBe(1);
  });

  it('a different underlying token resolves to a different identity key even for the same kind', async () => {
    const client = mockClient();
    const appA = buildApp({ client, discordToken: 'TOKEN_A', discordTokenKind: 'user-default' });
    const appB = buildApp({ client, discordToken: 'TOKEN_B', discordTokenKind: 'user-default' });
    const bodyA = (await (await appA.request('/users/@me', {}, MOCK_ENV)).json()) as IdentityProbeBody;
    const bodyB = (await (await appB.request('/users/@me', {}, MOCK_ENV)).json()) as IdentityProbeBody;
    expect(bodyA.identity?.key).not.toBe(bodyB.identity?.key);
  });
});
