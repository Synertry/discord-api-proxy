/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { deriveRouteKey, isRotatableRoute, extractGuildId } from '../../src/rotator/bucket';

describe('deriveRouteKey', () => {
	it('replaces snowflakes with :id and uppercases the method', () => {
		expect(deriveRouteKey('get', '/guilds/219564597349318656/messages/search')).toBe(
			'GET:/guilds/:id/messages/search',
		);
	});

	it('handles channel + message ID together', () => {
		expect(deriveRouteKey('GET', '/channels/123456789012345678/messages/987654321098765432')).toBe(
			'GET:/channels/:id/messages/:id',
		);
	});

	it('preserves search sub-path on members route', () => {
		expect(deriveRouteKey('GET', '/guilds/123456789012345678/members/search?query=foo')).toBe(
			'GET:/guilds/:id/members/search',
		);
	});

	it('replaces emoji segments after /reactions/ with :emoji', () => {
		expect(
			deriveRouteKey(
				'PUT',
				'/channels/123456789012345678/messages/987654321098765432/reactions/%E2%9C%85/@me',
			),
		).toBe('PUT:/channels/:id/messages/:id/reactions/:emoji/@me');
	});

	it('preserves @me literal for self-references', () => {
		expect(deriveRouteKey('GET', '/users/@me')).toBe('GET:/users/@me');
	});

	it('handles paths without leading slash equivalence', () => {
		// Splits on `/`, filter(Boolean) drops empty strings - leading slash is the same as not.
		expect(deriveRouteKey('GET', '/channels/123456789012345678')).toBe('GET:/channels/:id');
	});

	it('strips query strings before normalizing', () => {
		expect(deriveRouteKey('GET', '/guilds/123456789012345678/messages/search?author_id=999')).toBe(
			'GET:/guilds/:id/messages/search',
		);
	});

	it('lowercases literal segments to keep keys stable', () => {
		expect(deriveRouteKey('GET', '/Guilds/123456789012345678/Members')).toBe('GET:/guilds/:id/members');
	});

	it('keeps multi-word literals intact', () => {
		expect(deriveRouteKey('GET', '/channels/123456789012345678/threads/archived/public')).toBe(
			'GET:/channels/:id/threads/archived/public',
		);
	});
});

describe('isRotatableRoute', () => {
	it.each([
		['GET', '/guilds/219564597349318656/messages/search'],
		['GET', '/channels/123456789012345678/messages'],
		['GET', '/channels/123456789012345678/messages/987654321098765432'],
		['GET', '/guilds/219564597349318656/members'],
		['GET', '/guilds/219564597349318656/members/search?query=foo'],
		['GET', '/guilds/219564597349318656/members/987654321098765432'],
		['GET', '/guilds/219564597349318656/threads/active'],
		['GET', '/channels/123456789012345678/threads/archived/public'],
		['GET', '/channels/123456789012345678/threads/archived/private'],
		['GET', '/channels/123456789012345678'],
		['GET', '/users/987654321098765432'],
	])('allows %s %s', (method, path) => {
		expect(isRotatableRoute(method, path)).toBe(true);
	});

	it.each([
		// Account-bound: must use originally-routed token
		['GET', '/users/@me'],
		['GET', '/users/@me/guilds'],
		// Mutating routes: rotation would change the acting user
		['POST', '/channels/123456789012345678/messages'],
		['PATCH', '/guilds/219564597349318656/members/987654321098765432'],
		['PUT', '/guilds/219564597349318656/bans/987654321098765432'],
		['DELETE', '/guilds/219564597349318656/bans/987654321098765432'],
		['PUT', '/channels/123456789012345678/messages/987654321098765432/reactions/%E2%9C%85/@me'],
		['DELETE', '/channels/123456789012345678/messages/987654321098765432/reactions/%E2%9C%85/@me'],
	])('blocks %s %s', (method, path) => {
		expect(isRotatableRoute(method, path)).toBe(false);
	});
});

describe('extractGuildId', () => {
	it('returns the snowflake immediately following /guilds/', () => {
		expect(extractGuildId('/guilds/219564597349318656/messages/search')).toBe('219564597349318656');
	});

	it('returns undefined when path has no guild segment', () => {
		expect(extractGuildId('/channels/123456789012345678/messages')).toBeUndefined();
	});

	it('returns undefined when guild id position is non-snowflake', () => {
		expect(extractGuildId('/guilds/foo/messages')).toBeUndefined();
	});

	it('strips query strings before scanning', () => {
		expect(extractGuildId('/guilds/219564597349318656/messages?after=999')).toBe('219564597349318656');
	});
});
