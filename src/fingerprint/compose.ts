/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/compose
 * Pure functions that compose the per-request fingerprint header set.
 *
 * Runtime-agnostic. No imports from `@hono/*` or `cloudflare:*`. Only
 * standard `TextEncoder`, `btoa`, etc.
 */

import type { FingerprintProfile } from './profiles';

/**
 * Compose the full set of user-token-side request headers for a given profile
 * and Discord client `build_number`. The header values are derived purely from
 * the profile + build number; no per-request state.
 *
 * The returned map is suitable to spread into a `Headers` object.
 */
export function composeFingerprint(profile: FingerprintProfile, buildNumber: number): Record<string, string> {
	const superPropsJson = JSON.stringify({
		...profile.superProperties,
		client_build_number: buildNumber,
	});
	const superPropsB64 = encodeBase64Utf8(superPropsJson);

	return {
		'User-Agent': profile.userAgent,
		'X-Super-Properties': superPropsB64,
		'X-Discord-Locale': profile.locale,
		'X-Debug-Options': 'bugReporterEnabled',
		Accept: '*/*',
		'Accept-Language': buildAcceptLanguage(profile.locale),
		Origin: 'https://discord.com',
		Referer: 'https://discord.com/channels/@me',
	};
}

/**
 * Compose the bot User-Agent string. Discord's API documentation requires bot
 * requests to identify themselves with a URL and version; the build hash is
 * injected at deploy time via the `BUILD_HASH` define so each rollout is
 * distinct in upstream logs.
 */
export function composeBotUserAgent(buildHash: string): string {
	return `DiscordBot (https://github.com/Synertry/discord-api-proxy, ${buildHash})`;
}

/**
 * Build the `Accept-Language` header from a Discord locale. Real browsers
 * advertise the primary locale plus a fallback chain with q-weights; we mimic
 * the typical `de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7` shape.
 */
function buildAcceptLanguage(locale: string): string {
	const primary = locale.toLowerCase();
	if (primary === 'en-us' || primary === 'en') {
		return 'en-US,en;q=0.9';
	}
	if (primary === 'de') {
		return 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';
	}
	if (primary.includes('-')) {
		const [, region] = primary.split('-');
		const base = primary.split('-')[0];
		return `${primary},${base};q=0.9,en-US;q=0.8,en;q=0.7${region ? '' : ''}`;
	}
	return `${primary},en-US;q=0.9,en;q=0.8`;
}

/**
 * Base64-encode a UTF-8 string. The Workers runtime exposes `btoa` but it only
 * handles Latin-1 input; the explicit encode-then-binary-string conversion is
 * what makes non-ASCII profile fields round-trip correctly.
 */
function encodeBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

/** Re-export profile lookup helpers so callers can `import` everything from one place. */
export { lookupProfile, listProfileIds, FALLBACK_PROFILE_ID } from './profiles';
export type { FingerprintProfile, SuperPropertiesTemplate } from './profiles';
