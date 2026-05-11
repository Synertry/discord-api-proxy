/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/bucket
 * Derives a route key from an HTTP method + Discord URL pathname.
 *
 * The route key is a *lookup* into per-token state, not the cooldown unit itself.
 * Cooldowns are keyed by Discord's actual `X-RateLimit-Bucket` response header
 * (see `routeToBucket` mapping in `TokenState`). Even if our normalization
 * collapses two routes that Discord considers separate buckets, the response
 * headers tell us each route's actual hash and the `routeToBucket` lookup
 * resolves correctly per route.
 *
 * Normalization rules:
 * - 17-20 digit snowflakes -> `:id`
 * - Literal sub-paths kept verbatim (`search`, `members`, `reactions`, `@me`,
 *   `archived`, `public`, `private`, `active`, `pins`, `bulk-delete`, `@original`)
 * - URL-encoded segments after `/reactions/` -> `:emoji`
 */

import type { RouteKey } from './types';

const SNOWFLAKE_REGEX = /^\d{17,20}$/;

const ROTATABLE_LITERALS = new Set([
	'search',
	'members',
	'reactions',
	'threads',
	'archived',
	'public',
	'private',
	'active',
	'@me',
	'@original',
	'pins',
	'bulk-delete',
	'messages',
	'channels',
	'guilds',
	'users',
	'roles',
	'webhooks',
	'applications',
	'interactions',
	'entitlements',
	'skus',
	'bans',
]);

/**
 * Normalize a Discord API pathname into a stable route key.
 *
 * Strips query strings if present (caller may pass a full URL pathname). Replaces
 * snowflakes and the segment immediately following `/reactions/` with `:id` and
 * `:emoji` placeholders respectively.
 *
 * @example
 * deriveRouteKey('GET', '/guilds/123/messages/search')
 *   // -> 'GET:/guilds/:id/messages/search'
 * deriveRouteKey('PUT', '/channels/123/messages/456/reactions/%E2%9C%85/@me')
 *   // -> 'PUT:/channels/:id/messages/:id/reactions/:emoji/@me'
 */
export function deriveRouteKey(method: string, pathname: string): RouteKey {
	const cleanPath = pathname.split('?')[0] ?? pathname;
	const segments = cleanPath.split('/').filter(Boolean);
	const out: string[] = [];

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const prev = i > 0 ? segments[i - 1] : '';

		if (prev === 'reactions') {
			out.push(':emoji');
			continue;
		}

		if (SNOWFLAKE_REGEX.test(segment)) {
			out.push(':id');
			continue;
		}

		// Discord paths start with /api/v10 sometimes when called with full URL;
		// keep `api` and `v10` literals so the key is stable either way.
		out.push(segment.toLowerCase());
	}

	const upperMethod = method.toUpperCase();
	const path = '/' + out.join('/');
	return `${upperMethod}:${path}`;
}

/**
 * Path allowlist for rotation. The middleware passes through (no rotation) when
 * `false` is returned, leaving the originally-routed static token in place.
 *
 * Allowlisted: read-only Discord routes that don't act on behalf of one specific
 * user. Default-denied: anything that mutates state or identifies authorship
 * (e.g. POST /channels/:id/messages, PUT /reactions/:emoji/@me).
 */
export function isRotatableRoute(method: string, pathname: string): boolean {
	const key = deriveRouteKey(method, pathname);
	return ROTATABLE_ALLOWLIST.has(key);
}

/**
 * Authoritative allowlist of route keys eligible for token rotation.
 * Update intentionally - non-GET methods and account-bound paths must never rotate.
 */
const ROTATABLE_ALLOWLIST = new Set<RouteKey>([
	'GET:/guilds/:id/messages/search',
	'GET:/channels/:id/messages',
	'GET:/channels/:id/messages/:id',
	'GET:/guilds/:id/members',
	'GET:/guilds/:id/members/search',
	'GET:/guilds/:id/members/:id',
	'GET:/guilds/:id/threads/active',
	'GET:/channels/:id/threads/archived/public',
	'GET:/channels/:id/threads/archived/private',
	'GET:/channels/:id',
	'GET:/users/:id',
]);

/** Exported for testing. */
export const _ROTATABLE_ALLOWLIST = ROTATABLE_ALLOWLIST;

/**
 * Extract a guild ID from a Discord pathname for ineligibility tracking.
 * Returns the snowflake immediately following `guilds/` if present.
 */
export function extractGuildId(pathname: string): string | undefined {
	const segments = pathname.split('?')[0]?.split('/').filter(Boolean) ?? [];
	for (let i = 0; i < segments.length - 1; i++) {
		if (segments[i].toLowerCase() === 'guilds' && SNOWFLAKE_REGEX.test(segments[i + 1])) {
			return segments[i + 1];
		}
	}
	return undefined;
}
