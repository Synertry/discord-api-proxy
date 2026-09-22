/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import {
  FALLBACK_PROFILE_ID,
  PROFILES,
  listProfileIds,
  lookupProfile,
  resolveTemplate,
  resolveProfileId,
  resolveCustom,
  validateCustomProfile,
} from '../../src/fingerprint/profiles';

const CHROME_MAJOR = 148;

describe('PROFILES registry', () => {
  it('exposes unique ids', () => {
    const ids = PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('FALLBACK_PROFILE_ID resolves to a known template', () => {
    expect(lookupProfile(FALLBACK_PROFILE_ID)).toBeDefined();
  });

  it('listProfileIds returns all registered ids in declaration order', () => {
    expect(listProfileIds()).toEqual(PROFILES.map((p) => p.id));
  });

  it('lookupProfile returns undefined for an unknown id', () => {
    expect(lookupProfile('does-not-exist')).toBeUndefined();
  });

  it('lookupProfile returns undefined for an inherited Object.prototype name (no prototype pollution)', () => {
    expect(lookupProfile('toString')).toBeUndefined();
    expect(lookupProfile('constructor')).toBeUndefined();
    expect(lookupProfile('hasOwnProperty')).toBeUndefined();
  });
});

describe('resolveTemplate', () => {
  it.each(PROFILES)('template %s resolves internally consistently', (template) => {
    const resolved = resolveTemplate(template, CHROME_MAJOR);
    expect(resolved.superProperties.browser_user_agent).toBe(resolved.userAgent);
    expect(resolved.superProperties.system_locale).toBe(resolved.locale);
    expect(resolved.superProperties.release_channel).toBe('stable');
    expect(resolved.userAgent).toContain(`Chrome/${CHROME_MAJOR}.0.0.0`);
    expect(resolved.superProperties.browser_version).toBe(`${CHROME_MAJOR}.0.0.0`);
  });

  it.each(PROFILES)('template %s OS field matches the UA platform', (template) => {
    const resolved = resolveTemplate(template, CHROME_MAJOR);
    if (resolved.userAgent.includes('Windows NT')) expect(resolved.superProperties.os).toBe('Windows');
    else if (resolved.userAgent.includes('Macintosh')) expect(resolved.superProperties.os).toBe('Mac OS X');
    else throw new Error(`Unrecognized UA platform for ${template.id}`);
  });

  it('varies User-Agent with the Chrome major', () => {
    const template = PROFILES[0];
    const a = resolveTemplate(template, 148);
    const b = resolveTemplate(template, 153);
    expect(a.userAgent).not.toBe(b.userAgent);
    expect(a.clientHints['Sec-CH-UA']).not.toBe(b.clientHints['Sec-CH-UA']);
  });
});

describe('resolveProfileId', () => {
  it('resolves a known id', () => {
    const resolved = resolveProfileId(PROFILES[0].id, CHROME_MAJOR);
    expect(resolved.id).toBe(PROFILES[0].id);
  });

  it('falls back to FALLBACK_PROFILE_ID for an unknown/retired id, never throws', () => {
    expect(resolveProfileId('profile-chrome-win-de-1', CHROME_MAJOR).id).toBe(FALLBACK_PROFILE_ID);
  });

  it('falls back to FALLBACK_PROFILE_ID when id is undefined', () => {
    expect(resolveProfileId(undefined, CHROME_MAJOR).id).toBe(FALLBACK_PROFILE_ID);
  });
});

describe('validateCustomProfile / resolveCustom', () => {
  const validInput = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    superProperties: {
      os: 'Windows',
      browser: 'Chrome',
      device: '',
      system_locale: 'en-US',
      browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      browser_version: '148.0.0.0',
      os_version: '10',
      release_channel: 'stable',
      // Dynamic/session fields a real capture also carries; must never survive validation.
      client_build_number: 617136,
      client_launch_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      launch_signature: 'ffffffff-1111-4222-8333-444444444444',
      client_heartbeat_session_id: '55555555-6666-4777-8888-999999999999',
      client_app_state: 'focused',
    },
    locale: 'en-US',
    timezone: 'America/New_York',
    clientHints: { 'Sec-CH-UA': '"Chromium";v="148"', 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"Windows"' },
  };

  it('accepts a well-formed custom profile', () => {
    const result = validateCustomProfile(validInput);
    expect(result.ok).toBe(true);
  });

  it('accepts superProperties as a base64 string', () => {
    const b64 = btoa(JSON.stringify(validInput.superProperties));
    const result = validateCustomProfile({ ...validInput, superProperties: b64 });
    expect(result.ok).toBe(true);
  });

  it('rejects a mismatched browser_user_agent', () => {
    const result = validateCustomProfile({ ...validInput, userAgent: 'something-else-entirely-that-is-long-enough' });
    expect(result).toEqual({ ok: false, reason: 'browser_user_agent-mismatch' });
  });

  it('rejects a too-short userAgent', () => {
    const result = validateCustomProfile({ ...validInput, userAgent: 'short' });
    expect(result).toEqual({ ok: false, reason: 'userAgent-invalid' });
  });

  it('rejects missing clientHints', () => {
    const { clientHints: _clientHints, ...rest } = validInput;
    const result = validateCustomProfile(rest);
    expect(result).toEqual({ ok: false, reason: 'clientHints-missing' });
  });

  it('rejects superProperties missing os/browser', () => {
    const result = validateCustomProfile({ ...validInput, superProperties: { foo: 'bar' } });
    expect(result.ok).toBe(false);
  });

  it('strips every dynamic/session field from superProperties, never echoes them back', () => {
    const result = validateCustomProfile(validInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sp = result.profile.superProperties as Record<string, unknown>;
    expect(sp.client_build_number).toBeUndefined();
    expect(sp.client_launch_id).toBeUndefined();
    expect(sp.launch_signature).toBeUndefined();
    expect(sp.client_heartbeat_session_id).toBeUndefined();
    expect(sp.client_app_state).toBeUndefined();
  });

  it('drops any clientHints key beyond the three allowlisted ones (no header-injection surface)', () => {
    const result = validateCustomProfile({
      ...validInput,
      clientHints: { ...validInput.clientHints, Authorization: 'Bearer evil', Cookie: 'session=evil' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.profile.clientHints)).toEqual(['Sec-CH-UA', 'Sec-CH-UA-Mobile', 'Sec-CH-UA-Platform']);
  });

  it('has_client_mods is always forced false regardless of the captured value', () => {
    const result = validateCustomProfile({ ...validInput, superProperties: { ...validInput.superProperties, has_client_mods: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.superProperties.has_client_mods).toBe(false);
  });

  it('resolveCustom produces a ResolvedProfile with id "custom" from a validated profile', () => {
    const result = validateCustomProfile(validInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolved = resolveCustom(result.profile);
    expect(resolved.id).toBe('custom');
    expect(resolved.userAgent).toBe(validInput.userAgent);
    expect(resolved.clientHints).toEqual(result.profile.clientHints);
  });

  it('rejects a CRLF-injected userAgent (header-splitting defense)', () => {
    const result = validateCustomProfile({ ...validInput, userAgent: `${validInput.userAgent}\r\nX-Injected: evil` });
    expect(result).toEqual({ ok: false, reason: 'userAgent-invalid' });
  });

  it('rejects a control character in a client hint', () => {
    const result = validateCustomProfile({
      ...validInput,
      clientHints: { ...validInput.clientHints, 'Sec-CH-UA': '"Chromium";v="148"\n' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-ASCII/unicode locale', () => {
    const result = validateCustomProfile({ ...validInput, locale: 'en-US\u0000' });
    expect(result).toEqual({ ok: false, reason: 'locale-invalid' });
  });

  it('rejects an oversized timezone value', () => {
    const result = validateCustomProfile({ ...validInput, timezone: 'A'.repeat(65) });
    expect(result).toEqual({ ok: false, reason: 'timezone-invalid' });
  });

  it('rejects base64 superProperties that decode to a JSON null instead of an object', () => {
    const result = validateCustomProfile({ ...validInput, superProperties: btoa('null') });
    expect(result).toEqual({ ok: false, reason: 'superProperties-not-object' });
  });

  it('rejects base64 superProperties that decode to a JSON array instead of an object', () => {
    const result = validateCustomProfile({ ...validInput, superProperties: btoa('[]') });
    expect(result).toEqual({ ok: false, reason: 'superProperties-not-object' });
  });

  it('rejects an inline (non-base64) superProperties array', () => {
    const result = validateCustomProfile({ ...validInput, superProperties: [] });
    expect(result).toEqual({ ok: false, reason: 'superProperties-not-object' });
  });
});
