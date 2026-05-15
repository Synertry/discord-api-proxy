/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { composeBotUserAgent, composeFingerprint } from '../../src/fingerprint/compose';
import { FALLBACK_PROFILE_ID, lookupProfile } from '../../src/fingerprint/profiles';

const profile = lookupProfile(FALLBACK_PROFILE_ID)!;

describe('composeFingerprint', () => {
	it('produces the full header set for a profile', () => {
		const headers = composeFingerprint(profile, 544143);
		expect(headers['User-Agent']).toBe(profile.userAgent);
		expect(headers['X-Discord-Locale']).toBe(profile.locale);
		expect(headers['X-Debug-Options']).toBe('bugReporterEnabled');
		expect(headers.Accept).toBe('*/*');
		expect(headers.Origin).toBe('https://discord.com');
		expect(headers.Referer).toBe('https://discord.com/channels/@me');
		expect(headers['X-Super-Properties']).toMatch(/^[A-Za-z0-9+/=]+$/);
	});

	it('is deterministic for a given (profile, buildNumber) pair', () => {
		const a = composeFingerprint(profile, 544143);
		const b = composeFingerprint(profile, 544143);
		expect(a).toEqual(b);
	});

	it('X-Super-Properties decodes to JSON with the supplied build number', () => {
		const headers = composeFingerprint(profile, 544143);
		const decoded = atob(headers['X-Super-Properties']);
		const parsed = JSON.parse(decoded) as { client_build_number: number; browser_user_agent: string };
		expect(parsed.client_build_number).toBe(544143);
		expect(parsed.browser_user_agent).toBe(profile.userAgent);
	});

	it('Accept-Language matches the locale shape (en-US case)', () => {
		const enProfile = { ...profile, locale: 'en-US' };
		const headers = composeFingerprint(enProfile, 1);
		expect(headers['Accept-Language']).toBe('en-US,en;q=0.9');
	});

	it('Accept-Language matches the locale shape (de case)', () => {
		const deProfile = { ...profile, locale: 'de' };
		const headers = composeFingerprint(deProfile, 1);
		expect(headers['Accept-Language']).toMatch(/^de-DE,de;q=/);
	});
});

describe('composeBotUserAgent', () => {
	it('returns a Discord-compliant bot UA with the given build hash', () => {
		const ua = composeBotUserAgent('abc1234');
		expect(ua).toBe('DiscordBot (https://github.com/Synertry/discord-api-proxy, abc1234)');
	});
});
