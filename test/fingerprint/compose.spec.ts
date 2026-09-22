/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { composeBotUserAgent, composeFingerprint, composeSuperProperties, composeGatewayProperties } from '../../src/fingerprint/compose';
import { resolveProfileId } from '../../src/fingerprint/profiles';
import { deriveFingerprintSession } from '../../src/fingerprint/session';

const VERSIONS = { buildNumber: 617136, chromeMajor: 148 };
const NOW = 1_700_000_000_000;

async function fixture(id = 'chrome-win-de') {
  const profile = resolveProfileId(id, VERSIONS.chromeMajor);
  const session = await deriveFingerprintSession(`test:${id}`, NOW);
  return { profile, session };
}

describe('composeFingerprint', () => {
  it('produces the full header set for a profile', async () => {
    const { profile, session } = await fixture();
    const headers = composeFingerprint(profile, VERSIONS, session);
    expect(headers['User-Agent']).toBe(profile.userAgent);
    expect(headers['X-Discord-Locale']).toBe(profile.locale);
    expect(headers['X-Discord-Timezone']).toBe(profile.timezone);
    expect(headers['X-Debug-Options']).toBe('bugReporterEnabled');
    expect(headers.Accept).toBe('*/*');
    expect(headers['Accept-Encoding']).toBe('gzip, deflate, br, zstd');
    expect(headers.Priority).toBe('u=0, i');
    expect(headers.Origin).toBe('https://discord.com');
    expect(headers.Referer).toBe('https://discord.com/channels/@me');
    expect(headers['Sec-Fetch-Dest']).toBe('empty');
    expect(headers['Sec-Fetch-Mode']).toBe('cors');
    expect(headers['Sec-Fetch-Site']).toBe('same-origin');
    expect(headers['Sec-CH-UA']).toBe(profile.clientHints['Sec-CH-UA']);
    expect(headers['X-Super-Properties']).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('is deterministic for the same (profile, versions, session) triple', async () => {
    const { profile, session } = await fixture();
    const a = composeFingerprint(profile, VERSIONS, session);
    const b = composeFingerprint(profile, VERSIONS, session);
    expect(a).toEqual(b);
  });

  it('X-Super-Properties decodes to JSON with the supplied build number and session ids', async () => {
    const { profile, session } = await fixture();
    const headers = composeFingerprint(profile, VERSIONS, session);
    const parsed = JSON.parse(atob(headers['X-Super-Properties'])) as Record<string, unknown>;
    expect(parsed.client_build_number).toBe(VERSIONS.buildNumber);
    expect(parsed.browser_user_agent).toBe(profile.userAgent);
    expect(parsed.client_launch_id).toBe(session.clientLaunchId);
    expect(parsed.launch_signature).toBe(session.launchSignature);
    expect(parsed.client_heartbeat_session_id).toBe(session.clientHeartbeatSessionId);
    expect(parsed.client_app_state).toBe('focused');
  });

  it('Accept-Language matches the locale shape (en-US case)', async () => {
    const { profile, session } = await fixture('chrome-win-en');
    const headers = composeFingerprint(profile, VERSIONS, session);
    expect(headers['Accept-Language']).toBe('en-US,en;q=0.9');
  });

  it('Accept-Language matches the locale shape (de case)', async () => {
    const { profile, session } = await fixture('chrome-win-de');
    const headers = composeFingerprint(profile, VERSIONS, session);
    expect(headers['Accept-Language']).toMatch(/^de-DE,de;q=/);
  });
});

describe('composeSuperProperties', () => {
  it('places dynamic fields after static ones in the real-capture key order', async () => {
    const { profile, session } = await fixture();
    const props = composeSuperProperties(profile, VERSIONS, session);
    const keys = Object.keys(props);
    const releaseChannelIdx = keys.indexOf('release_channel');
    const buildNumberIdx = keys.indexOf('client_build_number');
    const appStateIdx = keys.indexOf('client_app_state');
    expect(releaseChannelIdx).toBeGreaterThanOrEqual(0);
    expect(buildNumberIdx).toBeGreaterThan(releaseChannelIdx);
    expect(appStateIdx).toBe(keys.length - 1);
  });
});

describe('composeGatewayProperties', () => {
  it('extends the HTTP super-properties with the two gateway-only fields', async () => {
    const { profile, session } = await fixture();
    const httpProps = composeSuperProperties(profile, VERSIONS, session);
    const gatewayProps = composeGatewayProperties(profile, VERSIONS, session);
    expect(gatewayProps).toMatchObject(httpProps);
    expect(gatewayProps.is_fast_connect).toBe(false);
    expect(gatewayProps.gateway_connect_reasons).toBe('AppSkeleton');
  });
});

describe('composeBotUserAgent', () => {
  it('returns a Discord-compliant bot UA with the given build hash', () => {
    const ua = composeBotUserAgent('abc1234');
    expect(ua).toBe('DiscordBot (https://github.com/Synertry/discord-api-proxy, abc1234)');
  });
});
