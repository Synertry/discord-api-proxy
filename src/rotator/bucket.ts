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
 * - A webhook token (`/webhooks/<id>/<token>/...`) -> `:token` in BOTH keys:
 *   it is a credential, and route keys are persisted in Durable Object
 *   storage and written to logs
 *
 * Two keys are derived from the same path:
 * - `deriveRouteKey` - the fully normalized *route type*, used for the
 *   rotation allowlist and every route-type decision (message-send body
 *   fill, typing, `X-Context-Properties`).
 * - `deriveBudgetKey` - identical, except a literal top-level resource id
 *   (`channels`/`guilds`/`webhooks`) is preserved. Every rate-limit
 *   budget/lease/settle call uses this one, so two top-level resources never
 *   share one cooldown row.
 */

import type { RouteKey } from './types';

const SNOWFLAKE_REGEX = /^\d{17,20}$/;

/** Top-level Discord resources whose literal id `deriveBudgetKey` preserves. */
const BUDGET_ID_RESOURCES: ReadonlySet<string> = new Set(['channels', 'guilds', 'webhooks']);

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
	return buildRouteKey(method, pathname, false);
}

/**
 * Budget-scoped sibling of `deriveRouteKey`, used for every rate-limit
 * budget, lease, settle, release, acquire, and response-inspection call.
 *
 * Identical to `deriveRouteKey` except that when the FIRST path segment is
 * `channels`, `guilds`, or `webhooks` and the second is a snowflake, that
 * snowflake is kept literally. Every other segment normalizes exactly as
 * `deriveRouteKey` does, including a webhook token, which becomes `:token`
 * so the credential never reaches storage or logs (a webhook is scoped by
 * its id alone).
 *
 * Discord's `X-RateLimit-Bucket` hash is opaque and can cover more than one
 * top-level resource, so scoping the stored cooldown row by the literal
 * resource (see `topLevelResource`) keeps two channels or guilds
 * independent instead of sharing - and overwriting - one row.
 *
 * @example
 * deriveBudgetKey('GET', '/channels/123456789012345678/messages/223456789012345678')
 *   // -> 'GET:/channels/123456789012345678/messages/:id'
 * deriveBudgetKey('GET', '/guilds/219564597349318656/messages/search')
 *   // -> 'GET:/guilds/219564597349318656/messages/search'
 * deriveBudgetKey('GET', '/users/@me')
 *   // -> 'GET:/users/@me'
 */
export function deriveBudgetKey(method: string, pathname: string): RouteKey {
	return buildRouteKey(method, pathname, true);
}

/**
 * Shared normalization for both derivations. `preserveTopLevelId` keeps the
 * first path segment's literal snowflake instead of collapsing it to `:id`,
 * as documented on `deriveRouteKey` / `deriveBudgetKey`.
 */
function buildRouteKey(method: string, pathname: string, preserveTopLevelId: boolean): RouteKey {
	const cleanPath = pathname.split('?')[0] ?? pathname;
	const segments = cleanPath.split('/').filter(Boolean);

	const top = segments[0]?.toLowerCase();
	const hasTopLevelId = top !== undefined && BUDGET_ID_RESOURCES.has(top) && SNOWFLAKE_REGEX.test(segments[1] ?? '');
	const preservedIdIndex = preserveTopLevelId && hasTopLevelId ? 1 : -1;
	const webhookTokenIndex = hasTopLevelId && top === 'webhooks' ? 2 : -1;

	const out: string[] = [];

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];

		if (i === webhookTokenIndex) {
			out.push(':token');
			continue;
		}

		if (i === preservedIdIndex) {
			out.push(segment);
			continue;
		}

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
 * The budget-scoped top-level resource of a `deriveBudgetKey` route key:
 * `channels/<id>`, `guilds/<id>`, or `webhooks/<id>`. Returns `undefined`
 * for every key without a literal top-level id - which is every
 * `deriveRouteKey` key (they carry `:id`), and any path not starting with
 * one of `BUDGET_ID_RESOURCES`.
 */
export function topLevelResource(routeKey: RouteKey): string | undefined {
	const separator = routeKey.indexOf(':');
	if (separator < 0) return undefined;
	const segments = routeKey.slice(separator + 1).split('/').filter(Boolean);
	const top = segments[0];
	const id = segments[1];
	if (top === undefined || id === undefined || !BUDGET_ID_RESOURCES.has(top) || !SNOWFLAKE_REGEX.test(id)) {
		return undefined;
	}
	return `${top}/${id}`;
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
	'GET:/guilds/:id/channels',
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
