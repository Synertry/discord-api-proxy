/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/profiles
 * Whitelist of realistic Discord-client fingerprint profiles.
 *
 * PORTABILITY: this file is deliberately runtime-agnostic. No imports from
 * `@hono/*`, `cloudflare:*`, or any binding type, so the registry stays
 * usable from any TypeScript runtime.
 *
 * Each profile is internally consistent: the `userAgent` header value matches
 * the `browser_user_agent` field inside `superProperties`; `locale` matches
 * `system_locale`; the `os` / `os_version` shape matches the platform implied
 * by the UA. `client_build_number` is the only field substituted at request
 * time (see `compose.ts`).
 *
 * Profiles are operator-chosen, non-secret IDs; treat them as public values.
 */

/** Super-properties (sent as base64 in `X-Super-Properties`) before build_number is injected. */
export interface SuperPropertiesTemplate {
	os: string;
	browser: string;
	device: string;
	system_locale: string;
	browser_user_agent: string;
	browser_version: string;
	os_version: string;
	referrer: string;
	referring_domain: string;
	referrer_current: string;
	referring_domain_current: string;
	release_channel: string;
	client_event_source: null;
}

export interface FingerprintProfile {
	id: string;
	userAgent: string;
	locale: string;
	superProperties: SuperPropertiesTemplate;
}

/** Operator-chosen default profile id used when a token has no assignment yet. */
export const FALLBACK_PROFILE_ID = 'profile-chrome-win-de-1';

/**
 * Registered profiles. To add or remove a profile, edit this constant and
 * ensure each entry passes the consistency invariants (see test/fingerprint/profiles.spec.ts).
 *
 * Mix: 4 Chrome-on-Windows, 2 Chrome-on-macOS, 2 Firefox-on-Linux, 1 Safari-on-macOS,
 * 2 Discord Desktop (Electron). DE-heavy with en-US sprinkles.
 */
export const PROFILES: readonly FingerprintProfile[] = [
	{
		id: 'profile-chrome-win-de-1',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		locale: 'de',
		superProperties: {
			os: 'Windows',
			browser: 'Chrome',
			device: '',
			system_locale: 'de',
			browser_user_agent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			browser_version: '120.0.0.0',
			os_version: '10',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-chrome-win-de-2',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
		locale: 'de',
		superProperties: {
			os: 'Windows',
			browser: 'Chrome',
			device: '',
			system_locale: 'de',
			browser_user_agent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
			browser_version: '121.0.0.0',
			os_version: '10',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-chrome-win-en-1',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
		locale: 'en-US',
		superProperties: {
			os: 'Windows',
			browser: 'Chrome',
			device: '',
			system_locale: 'en-US',
			browser_user_agent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
			browser_version: '122.0.0.0',
			os_version: '10',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-chrome-win-de-3',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
		locale: 'de',
		superProperties: {
			os: 'Windows',
			browser: 'Chrome',
			device: '',
			system_locale: 'de',
			browser_user_agent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
			browser_version: '123.0.0.0',
			os_version: '10',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-chrome-mac-de-1',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
		locale: 'de',
		superProperties: {
			os: 'Mac OS X',
			browser: 'Chrome',
			device: '',
			system_locale: 'de',
			browser_user_agent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
			browser_version: '121.0.0.0',
			os_version: '10.15.7',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-chrome-mac-en-1',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
		locale: 'en-US',
		superProperties: {
			os: 'Mac OS X',
			browser: 'Chrome',
			device: '',
			system_locale: 'en-US',
			browser_user_agent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
			browser_version: '122.0.0.0',
			os_version: '10.15.7',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-firefox-linux-de-1',
		userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
		locale: 'de',
		superProperties: {
			os: 'Linux',
			browser: 'Firefox',
			device: '',
			system_locale: 'de',
			browser_user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
			browser_version: '122.0',
			os_version: '',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-firefox-linux-en-1',
		userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
		locale: 'en-US',
		superProperties: {
			os: 'Linux',
			browser: 'Firefox',
			device: '',
			system_locale: 'en-US',
			browser_user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
			browser_version: '123.0',
			os_version: '',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-safari-mac-de-1',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
		locale: 'de',
		superProperties: {
			os: 'Mac OS X',
			browser: 'Safari',
			device: '',
			system_locale: 'de',
			browser_user_agent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
			browser_version: '17.2',
			os_version: '10.15.7',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-electron-win-de-1',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.293 Chrome/120.0.6099.291 Electron/28.2.1 Safari/537.36',
		locale: 'de',
		superProperties: {
			os: 'Windows',
			browser: 'Discord Client',
			device: '',
			system_locale: 'de',
			browser_user_agent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.293 Chrome/120.0.6099.291 Electron/28.2.1 Safari/537.36',
			browser_version: '28.2.1',
			os_version: '10',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
	{
		id: 'profile-electron-mac-en-1',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.305 Chrome/122.0.6261.156 Electron/29.4.0 Safari/537.36',
		locale: 'en-US',
		superProperties: {
			os: 'Mac OS X',
			browser: 'Discord Client',
			device: '',
			system_locale: 'en-US',
			browser_user_agent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.305 Chrome/122.0.6261.156 Electron/29.4.0 Safari/537.36',
			browser_version: '29.4.0',
			os_version: '10.15.7',
			referrer: '',
			referring_domain: '',
			referrer_current: '',
			referring_domain_current: '',
			release_channel: 'stable',
			client_event_source: null,
		},
	},
];

const BY_ID: ReadonlyMap<string, FingerprintProfile> = new Map(PROFILES.map((p) => [p.id, p]));

/** Look up a profile by id. Returns undefined for unknown ids. */
export function lookupProfile(id: string): FingerprintProfile | undefined {
	return BY_ID.get(id);
}

/** Return all profile ids in their declared order. Non-secret operator metadata. */
export function listProfileIds(): readonly string[] {
	return PROFILES.map((p) => p.id);
}
