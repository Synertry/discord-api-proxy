/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { composeRequestHeaders } from '../../src/fingerprint/headers';
import { resolveProfileId } from '../../src/fingerprint/profiles';

const VERSIONS = { buildNumber: 617136, chromeMajor: 148 };
const NOW = 1_700_000_000_000;

describe('composeRequestHeaders', () => {
  it('drops cf-* / x-forwarded-* / x-real-ip / cdn-loop / the caller UA / x-proxy-* from inbound', async () => {
    const inbound = new Headers({
      'cf-connecting-ip': '203.0.113.5',
      'cf-ipcountry': 'US',
      'x-forwarded-for': '203.0.113.5',
      'x-real-ip': '203.0.113.5',
      'cdn-loop': 'cloudflare',
      'user-agent': 'Bun/1.2',
      'accept-encoding': 'identity',
      'x-proxy-token': 'static',
      'x-proxy-context': 'user',
    });
    const headers = await composeRequestHeaders({ token: 'Bot abc', tokenKind: 'bot', buildHash: 'deadbeef', inbound, now: NOW });
    for (const dropped of [
      'cf-connecting-ip',
      'cf-ipcountry',
      'x-forwarded-for',
      'x-real-ip',
      'cdn-loop',
      'x-proxy-token',
      'x-proxy-context',
    ]) {
      expect(headers.has(dropped)).toBe(false);
    }
    // The caller's own User-Agent is dropped; the composer sets its own.
    expect(headers.get('user-agent')).not.toBe('Bun/1.2');
  });

  it('keeps allowlisted inbound headers (content-type, x-audit-log-reason)', async () => {
    const inbound = new Headers({ 'content-type': 'application/json', 'x-audit-log-reason': 'cleanup' });
    const headers = await composeRequestHeaders({ token: 'Bot abc', tokenKind: 'bot', buildHash: 'deadbeef', inbound, now: NOW });
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-audit-log-reason')).toBe('cleanup');
  });

  it('drops an inbound header named after an Object.prototype member (no prototype pollution in the allowlist check)', async () => {
    const inbound = new Headers({ constructor: 'evil', toString: 'evil', hasownproperty: 'evil' });
    const headers = await composeRequestHeaders({ token: 'Bot abc', tokenKind: 'bot', buildHash: 'deadbeef', inbound, now: NOW });
    expect(headers.has('constructor')).toBe(false);
    expect(headers.has('toString')).toBe(false);
    expect(headers.has('hasownproperty')).toBe(false);
  });

  it('bot kind carries no super-properties/client-hint headers', async () => {
    const headers = await composeRequestHeaders({ token: 'Bot abc', tokenKind: 'bot', buildHash: 'deadbeef', now: NOW });
    expect(headers.has('x-super-properties')).toBe(false);
    expect(headers.has('sec-ch-ua')).toBe(false);
    expect(headers.get('user-agent')).toContain('DiscordBot');
  });

  it('user kind without an identity still yields a full fallback fingerprint set', async () => {
    const headers = await composeRequestHeaders({ token: 'user-token', tokenKind: 'user-default', versions: VERSIONS, now: NOW });
    expect(headers.get('x-super-properties')).toBeTruthy();
    expect(headers.get('sec-ch-ua')).toBeTruthy();
    expect(headers.get('user-agent')).toContain('Chrome/148.0.0.0');
  });

  it("user kind with an identity uses that identity's resolved profile", async () => {
    const profile = resolveProfileId('chrome-mac-de', VERSIONS.chromeMajor);
    const headers = await composeRequestHeaders({
      token: 'user-token',
      tokenKind: 'user-default',
      identity: { key: 'pool:label-1', kind: 'pool', label: 'label-1', profile },
      versions: VERSIONS,
      now: NOW,
    });
    expect(headers.get('user-agent')).toBe(profile.userAgent);
    expect(headers.get('x-discord-locale')).toBe('de');
  });

  it('a tampered clientHints object cannot inject Authorization/Cookie/X-Proxy-* headers (defense-in-depth against a future validation bug)', async () => {
    const profile = resolveProfileId('chrome-win-de', VERSIONS.chromeMajor);
    const maliciousProfile = {
      ...profile,
      clientHints: {
        ...profile.clientHints,
        Authorization: 'Bearer attacker-controlled',
        Cookie: 'session=evil',
        'X-Proxy-Token': 'static',
      },
    };
    const headers = await composeRequestHeaders({
      token: 'user-token-real',
      tokenKind: 'user-default',
      identity: { key: 'static:user-default', kind: 'static', profile: maliciousProfile },
      versions: VERSIONS,
      now: NOW,
    });
    expect(headers.get('authorization')).toBe('user-token-real');
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('x-proxy-token')).toBe(false);
  });

  it('Authorization is replaced, never appended, even if inbound had one', async () => {
    const inbound = new Headers({ authorization: 'Bearer attacker-controlled' });
    const headers = await composeRequestHeaders({ token: 'Bot real-token', tokenKind: 'bot', buildHash: 'deadbeef', inbound, now: NOW });
    expect(headers.get('authorization')).toBe('Bot real-token');
  });
});
