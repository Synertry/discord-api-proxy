/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { FALLBACK_PROFILE_ID, PROFILES, listProfileIds, lookupProfile } from '../../src/fingerprint/profiles';

describe('FingerprintProfile registry', () => {
	it('has at least 8 profiles', () => {
		expect(PROFILES.length).toBeGreaterThanOrEqual(8);
	});

	it('exposes unique ids', () => {
		const ids = PROFILES.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('FALLBACK_PROFILE_ID resolves to a known profile', () => {
		expect(lookupProfile(FALLBACK_PROFILE_ID)).toBeDefined();
	});

	it('listProfileIds returns all registered ids in declaration order', () => {
		expect(listProfileIds()).toEqual(PROFILES.map((p) => p.id));
	});

	it.each(PROFILES.map((p) => [p.id, p] as const))(
		'profile %s is internally consistent',
		(_id, profile) => {
			// UA header value matches the embedded super-property value
			expect(profile.superProperties.browser_user_agent).toBe(profile.userAgent);
			// Locale matches the embedded system_locale
			expect(profile.superProperties.system_locale).toBe(profile.locale);
			// release_channel is non-empty (matches Discord's expectation)
			expect(profile.superProperties.release_channel).toBe('stable');
			// client_event_source is exactly null (not the string 'null')
			expect(profile.superProperties.client_event_source).toBeNull();
		},
	);

	it.each(PROFILES.map((p) => [p.id, p] as const))(
		'profile %s OS field matches the UA platform',
		(_id, profile) => {
			const ua = profile.userAgent;
			const os = profile.superProperties.os;
			if (ua.includes('Windows NT')) expect(os).toBe('Windows');
			else if (ua.includes('Macintosh')) expect(os).toBe('Mac OS X');
			else if (ua.includes('X11; Linux')) expect(os).toBe('Linux');
			else throw new Error(`Unrecognized UA platform in profile ${profile.id}`);
		},
	);

	it.each(PROFILES.map((p) => [p.id, p] as const))(
		'profile %s browser field matches the UA',
		(_id, profile) => {
			const ua = profile.userAgent;
			const browser = profile.superProperties.browser;
			if (ua.includes('discord/')) expect(browser).toBe('Discord Client');
			else if (ua.includes('Firefox/')) expect(browser).toBe('Firefox');
			else if (ua.includes('Chrome/') && !ua.includes('Safari/605')) expect(browser).toBe('Chrome');
			else if (ua.includes('Safari/605')) expect(browser).toBe('Safari');
			else throw new Error(`Unrecognized UA browser in profile ${profile.id}`);
		},
	);

	it('lookupProfile returns undefined for an unknown id', () => {
		expect(lookupProfile('does-not-exist')).toBeUndefined();
	});
});
