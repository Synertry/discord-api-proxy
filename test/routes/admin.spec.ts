/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createApp } from '../../src/index';
import { pickProfileId } from '../../src/rotator/do';
import { FALLBACK_PROFILE_ID, listProfileIds } from '../../src/fingerprint/profiles';
import { createTokenPoolClient, getPoolStub } from '../../src/rotator/client';

const VALID_TOKEN = 'A'.repeat(40) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(40);
const VALID_TOKEN_2 = 'D'.repeat(40) + '.' + 'E'.repeat(10) + '.' + 'F'.repeat(40);

const ADMIN_KEY = 'admin-key-for-tests';
const PROXY_KEY = 'proxy-key-for-tests';

const ENV_OVERRIDE = {
  ...env,
  AUTH_KEY: PROXY_KEY,
  AUTH_KEY_ADMIN: ADMIN_KEY,
  DISCORD_TOKEN_BOT: 'BOT',
  DISCORD_TOKEN_USER: 'STATIC_USER',
};

function admin() {
  return createApp();
}

let labelCounter = 0;
function nextLabel(): string {
  return `tok-${Date.now()}-${labelCounter++}`;
}

async function adminPost(app: ReturnType<typeof admin>, path: string, body: unknown, key = ADMIN_KEY) {
  return app.request(
    `http://localhost${path}`,
    {
      method: 'POST',
      headers: { 'x-auth-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    ENV_OVERRIDE,
  );
}

async function adminGet(app: ReturnType<typeof admin>, path: string, key = ADMIN_KEY) {
  return app.request(`http://localhost${path}`, { headers: { 'x-auth-key': key } }, ENV_OVERRIDE);
}

async function adminDelete(app: ReturnType<typeof admin>, path: string, key = ADMIN_KEY) {
  return app.request(`http://localhost${path}`, { method: 'DELETE', headers: { 'x-auth-key': key } }, ENV_OVERRIDE);
}

describe('admin auth', () => {
  it('returns 401 without an auth key', async () => {
    const app = admin();
    const res = await app.request('http://localhost/admin/tokens', {}, ENV_OVERRIDE);
    expect(res.status).toBe(401);
  });

  it('returns 401 when proxy AUTH_KEY is supplied (privilege isolation)', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/tokens', PROXY_KEY);
    expect(res.status).toBe(401);
  });

  it('returns 503 when AUTH_KEY_ADMIN is not configured', async () => {
    const app = admin();
    const noAdmin = { ...ENV_OVERRIDE, AUTH_KEY_ADMIN: undefined };
    const res = await app.request('http://localhost/admin/tokens', { headers: { 'x-auth-key': 'whatever' } }, noAdmin);
    expect(res.status).toBe(503);
  });

  it('accepts the admin key', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/tokens');
    expect(res.status).toBe(200);
  });
});

describe('admin POST /tokens', () => {
  it('registers a valid token and returns 201', async () => {
    const app = admin();
    const label = nextLabel();
    const res = await adminPost(app, '/admin/tokens', {
      label,
      slot: 'default',
      tokenSecret: VALID_TOKEN,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { label: string; registeredAt: number };
    expect(body.label).toBe(label);
    expect(body.registeredAt).toBeGreaterThan(0);
  });

  it('rejects malformed payload with 400', async () => {
    const app = admin();
    const res = await adminPost(app, '/admin/tokens', { label: 'has space', slot: 'default', tokenSecret: VALID_TOKEN });
    expect(res.status).toBe(400);
  });

  it('rejects token with header-injection characters', async () => {
    const app = admin();
    const res = await adminPost(app, '/admin/tokens', {
      label: nextLabel(),
      slot: 'default',
      tokenSecret: VALID_TOKEN.slice(0, 50) + '\r\nX-Inject: bad',
    });
    expect(res.status).toBe(400);
  });

  it('returns the same generic 400 for "label exists" and "invalid format" (constant-time)', async () => {
    const app = admin();
    const label = nextLabel();
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });

    const dup = await adminPost(app, '/admin/tokens', {
      label,
      slot: 'default',
      tokenSecret: VALID_TOKEN_2,
    });
    const bad = await adminPost(app, '/admin/tokens', {
      label: 'has space',
      slot: 'default',
      tokenSecret: VALID_TOKEN,
    });
    expect(dup.status).toBe(400);
    expect(bad.status).toBe(400);
    const dupBody = (await dup.json()) as { error: string };
    const badBody = (await bad.json()) as { error: string };
    expect(dupBody.error).toBe(badBody.error);
  });
});

describe('admin GET /tokens never returns the secret', () => {
  it('omits tokenSecret from list responses', async () => {
    const app = admin();
    const label = nextLabel();
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });

    const res = await adminGet(app, '/admin/tokens');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    const ours = body.tokens.find((t) => t.label === label);
    expect(ours).toBeDefined();
    expect(ours).not.toHaveProperty('tokenSecret');
  });
});

describe('admin DELETE /tokens/:label', () => {
  it('returns 204 and removes the token', async () => {
    const app = admin();
    const label = nextLabel();
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
    const del = await adminDelete(app, `/admin/tokens/${label}`);
    expect(del.status).toBe(204);
  });

  it('is idempotent on missing label (still 204)', async () => {
    const app = admin();
    const del = await adminDelete(app, `/admin/tokens/never-existed`);
    expect(del.status).toBe(204);
  });

  it('rejects label with disallowed characters with 400', async () => {
    const app = admin();
    const del = await adminDelete(app, `/admin/tokens/has%20space`);
    expect(del.status).toBe(400);
  });
});

describe('admin POST /tokens/:label/reset', () => {
  it('returns 200 on existing label', async () => {
    const app = admin();
    const label = nextLabel();
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
    const res = await adminPost(app, `/admin/tokens/${label}/reset`, {});
    expect(res.status).toBe(200);
  });

  it('returns 400 for missing label', async () => {
    const app = admin();
    const res = await adminPost(app, `/admin/tokens/never-existed/reset`, {});
    expect(res.status).toBe(400);
  });
});

describe('admin fingerprint endpoints', () => {
  it('GET /admin/fingerprint/profiles returns the registry ids + fallback', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/fingerprint/profiles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileIds: string[]; fallbackProfileId: string };
    expect(body.profileIds.length).toBeGreaterThanOrEqual(4);
    expect(body.profileIds).toContain(body.fallbackProfileId);
  });

  it('POST /admin/tokens/:label/fingerprint validates profileId and returns 400 on unknown', async () => {
    const app = admin();
    const label = nextLabel();
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
    const bad = await adminPost(app, `/admin/tokens/${label}/fingerprint`, { profileId: 'nonsense' });
    expect(bad.status).toBe(400);
  });

  it('POST /admin/tokens/:label/fingerprint sets the assignment', async () => {
    const app = admin();
    const label = nextLabel();
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
    const ok = await adminPost(app, `/admin/tokens/${label}/fingerprint`, {
      profileId: 'chrome-win-de',
    });
    expect(ok.status).toBe(200);

    // GET /tokens reflects the override
    const list = await adminGet(app, '/admin/tokens');
    const body = (await list.json()) as { tokens: Array<{ label: string; fingerprintProfileId?: string }> };
    const ours = body.tokens.find((t) => t.label === label);
    expect(ours?.fingerprintProfileId).toBe('chrome-win-de');
  });

  it('POST /admin/static-fingerprint sets per-kind mapping; GET returns it', async () => {
    const app = admin();
    const set = await adminPost(app, '/admin/static-fingerprint', {
      kind: 'user-default',
      profileId: 'chrome-win-de',
    });
    expect(set.status).toBe(200);
    const got = await adminGet(app, '/admin/static-fingerprint');
    expect(got.status).toBe(200);
    const body = (await got.json()) as { userDefault: { profileId: string } | null; userPremium: { profileId: string } | null };
    expect(body.userDefault?.profileId).toBe('chrome-win-de');
  });

  it('POST /admin/static-fingerprint rejects unknown kind with 400', async () => {
    const app = admin();
    const res = await adminPost(app, '/admin/static-fingerprint', {
      kind: 'admin-user',
      profileId: 'chrome-win-de',
    });
    expect(res.status).toBe(400);
  });

  it('POST /admin/static-fingerprint rejects unknown profileId with 400', async () => {
    const app = admin();
    const res = await adminPost(app, '/admin/static-fingerprint', {
      kind: 'user-default',
      profileId: 'made-up',
    });
    expect(res.status).toBe(400);
  });

  it('POST /admin/static-fingerprint rejects a body with both profileId and custom', async () => {
    const app = admin();
    const res = await adminPost(app, '/admin/static-fingerprint', {
      kind: 'user-default',
      profileId: 'chrome-win-de',
      custom: {},
    });
    expect(res.status).toBe(400);
  });

  it('GET /admin/client-versions returns both records as null before any scrape', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/client-versions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { build: unknown; chrome: unknown };
    expect(body.build).toBeNull();
    expect(body.chrome).toBeNull();
  });

  it('POST /admin/static-fingerprint registers a custom profile; GET reflects profileId "custom"', async () => {
    const app = admin();
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const set = await adminPost(app, '/admin/static-fingerprint', {
      kind: 'user-premium',
      custom: {
        userAgent,
        superProperties: { os: 'Windows', browser: 'Chrome', browser_user_agent: userAgent, system_locale: 'de-DE' },
        clientHints: {
          'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="131"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"Windows"',
        },
        locale: 'de-DE',
        timezone: 'Europe/Berlin',
      },
    });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as { ok: boolean; kind: string; profileId: string };
    expect(setBody.profileId).toBe('custom');

    const got = await adminGet(app, '/admin/static-fingerprint');
    const body = (await got.json()) as {
      userPremium: { profileId: string; assignedAt: number; custom?: { userAgent: string; os: string; browser: string } } | null;
    };
    expect(body.userPremium?.profileId).toBe('custom');
    // Compact summary only - the full superProperties/clientHints blob a
    // custom registration carries must never leak through this listing.
    expect(body.userPremium?.custom?.userAgent).toBe(userAgent);
    expect(body.userPremium?.custom?.os).toBe('Windows');
    expect(body.userPremium).not.toHaveProperty('clientHints');
    expect(body.userPremium?.custom).not.toHaveProperty('clientHints');
    expect(body.userPremium?.custom).not.toHaveProperty('superProperties');
    expect(body.userPremium?.custom).not.toHaveProperty('browser_version');
  });

  it('POST /admin/static-fingerprint rejects an invalid custom profile with the validator reason', async () => {
    const app = admin();
    const res = await adminPost(app, '/admin/static-fingerprint', { kind: 'user-default', custom: { userAgent: 'short' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe('userAgent-invalid');
  });

  it('all fingerprint endpoints require admin auth (401 without key)', async () => {
    const app = admin();
    const unauthenticated = await app.request('http://localhost/admin/fingerprint/profiles', {}, ENV_OVERRIDE);
    expect(unauthenticated.status).toBe(401);
  });
});

describe('admin GET /health', () => {
  it('returns per-slot rollup', async () => {
    const app = admin();
    await adminPost(app, '/admin/tokens', {
      label: nextLabel(),
      slot: 'default',
      tokenSecret: VALID_TOKEN,
    });
    await adminPost(app, '/admin/tokens', {
      label: nextLabel(),
      slot: 'premium',
      tokenSecret: VALID_TOKEN_2,
    });
    const res = await adminGet(app, '/admin/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { default: { count: number }; premium: { count: number } };
    expect(body.default.count).toBeGreaterThanOrEqual(1);
    expect(body.premium.count).toBeGreaterThanOrEqual(1);
  });
});

describe('admin GET /admin/identity', () => {
  it('returns exactly one of kind or label as required, 400 on both or neither', async () => {
    const app = admin();
    const neither = await adminGet(app, '/admin/identity');
    expect(neither.status).toBe(400);
    const both = await adminGet(app, '/admin/identity?kind=user-default&label=x');
    expect(both.status).toBe(400);
  });

  it('rejects an unknown kind with 400', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/identity?kind=admin-user');
    expect(res.status).toBe(400);
  });

  it('previews the static identity for a configured kind, with the token redacted', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/identity?kind=user-default');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      identityKey: string;
      profileId: string;
      headers: Record<string, string>;
      superProperties: Record<string, unknown>;
      gatewayProperties: Record<string, unknown>;
    };
    expect(body.identityKey).toMatch(/^static:/);
    expect(body.headers.authorization).toBe('<redacted>');
    expect(body.headers['user-agent']).toBeTruthy();
    expect(body.superProperties).toBeTruthy();
    expect(body.gatewayProperties).toBeTruthy();
  });

  it('returns 404 for a kind whose token is not configured', async () => {
    const app = admin();
    const noPremium = { ...ENV_OVERRIDE, DISCORD_TOKEN_USER_PREMIUM: undefined };
    const res = await app.request(
      'http://localhost/admin/identity?kind=user-premium',
      { headers: { 'x-auth-key': ADMIN_KEY } },
      noPremium,
    );
    expect(res.status).toBe(404);
  });

  it('previews a registered pool token by label', async () => {
    const app = admin();
    const label = nextLabel();
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });
    const res = await adminGet(app, `/admin/identity?label=${label}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identityKey: string; headers: Record<string, string> };
    expect(body.identityKey).toBe(`pool:${label}`);
    expect(body.headers.authorization).toBe('<redacted>');
  });

  it('previews the deterministic label-hash profile a first acquire() will assign, for a never-acquired label', async () => {
    const app = admin();
    // Fixed label: its pickProfileId result must differ from the fallback,
    // which is asserted below. A timestamped label can hash to the fallback,
    // making an equality assertion pass even for a preview that always
    // returns the fallback.
    const label = 'preview-token';
    await adminPost(app, '/admin/tokens', { label, slot: 'default', tokenSecret: VALID_TOKEN });

    const expectedProfileId = pickProfileId(label, listProfileIds());
    expect(expectedProfileId).not.toBe(FALLBACK_PROFILE_ID);

    // Registering does NOT acquire the token, so fingerprintProfileId is still
    // unset at this point - the preview must resolve the SAME profile a real
    // first acquire() would assign via pickProfileId, not the unrelated
    // fallback template.
    const res = await adminGet(app, `/admin/identity?label=${label}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileId: string };
    expect(body.profileId).toBe(expectedProfileId);

    // An actual first acquire() assigns exactly that profile.
    const client = createTokenPoolClient(getPoolStub(env));
    if (!client.acquireByLabel) throw new Error('pool client unexpectedly lacks acquireByLabel');
    const acquired = await client.acquireByLabel(label, 'default', 'GET:/guilds/219564597349318656/messages/search');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error(`acquire unexpectedly unavailable: ${acquired.reason}`);
    expect(acquired.fingerprintProfileId).toBe(expectedProfileId);
  });

  it('rejects an explicitly-empty label sent alongside a kind as 400', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/identity?kind=user-default&label=');
    expect(res.status).toBe(400);
  });

  it('rejects an empty single selector as 400', async () => {
    const app = admin();
    const emptyLabel = await adminGet(app, '/admin/identity?label=');
    expect(emptyLabel.status).toBe(400);
    const emptyKind = await adminGet(app, '/admin/identity?kind=');
    expect(emptyKind.status).toBe(400);
  });

  it('returns 404 for an unregistered label', async () => {
    const app = admin();
    const res = await adminGet(app, '/admin/identity?label=never-registered');
    expect(res.status).toBe(404);
  });
});

describe('admin POST /admin/client-versions/refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 502 with an error body when neither record could be refreshed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    const app = admin();
    const res = await adminPost(app, '/admin/client-versions/refresh', {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('neither client-version record refreshed');
  });

  it('persists both records on a successful scrape of both sources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'https://discord.com/login') {
          return new Response('<html>"BUILD_NUMBER":"123456"</html>', { status: 200 });
        }
        if (url.startsWith('https://versionhistory.googleapis.com/')) {
          return new Response(JSON.stringify({ versions: [{ version: '131.0.6778.86' }] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const app = admin();
    const res = await adminPost(app, '/admin/client-versions/refresh', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { build: { buildNumber: number } | null; chrome: { major: number } | null };
    expect(body.build?.buildNumber).toBe(123456);
    expect(body.chrome?.major).toBe(131);

    // GET /admin/client-versions now reflects the persisted records.
    const got = await adminGet(app, '/admin/client-versions');
    const gotBody = (await got.json()) as { build: { buildNumber: number } | null; chrome: { major: number } | null };
    expect(gotBody.build?.buildNumber).toBe(123456);
    expect(gotBody.chrome?.major).toBe(131);
  });
});
