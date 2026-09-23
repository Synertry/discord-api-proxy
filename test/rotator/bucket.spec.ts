/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { deriveRouteKey, deriveBudgetKey, topLevelResource, isRotatableRoute, extractGuildId } from '../../src/rotator/bucket';

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

describe('deriveBudgetKey', () => {
	it('keeps the channel id literal while normalizing the message id', () => {
		expect(deriveBudgetKey('GET', '/channels/123456789012345678/messages/223456789012345678')).toBe(
			'GET:/channels/123456789012345678/messages/:id',
		);
	});

	it('keeps the guild id literal', () => {
		expect(deriveBudgetKey('GET', '/guilds/219564597349318656/messages/search')).toBe(
			'GET:/guilds/219564597349318656/messages/search',
		);
	});

	it('never keeps a webhook token in either key (it is a credential; keys are persisted and logged)', () => {
		const path = '/webhooks/123456789012345678/AbCdEf-GhI/messages/223456789012345678';
		expect(deriveBudgetKey('POST', path)).toBe('POST:/webhooks/123456789012345678/:token/messages/:id');
		expect(deriveRouteKey('POST', path)).toBe('POST:/webhooks/:id/:token/messages/:id');
		expect(deriveBudgetKey('POST', path).toLowerCase()).not.toContain('abcdef');
		expect(deriveRouteKey('POST', path).toLowerCase()).not.toContain('abcdef');
	});

	it('keeps the top-level id when the resource segment is not lowercase, so scoping still applies', () => {
		const key = deriveBudgetKey('GET', '/Channels/123456789012345678/messages');
		expect(key).toBe('GET:/channels/123456789012345678/messages');
		expect(topLevelResource(key)).toBe('channels/123456789012345678');
	});

	it('keeps the channel id for the typing route so it scopes to that channel', () => {
		expect(deriveBudgetKey('POST', '/channels/123456789012345678/typing')).toBe('POST:/channels/123456789012345678/typing');
	});

	it.each([
		['GET', '/users/@me'],
		['GET', '/users/123456789012345678'],
		['GET', '/guilds/not-a-snowflake/messages'],
		['GET', '/api/v10/channels/123456789012345678/messages'],
		['GET', '/invites/abcdef'],
	])('normalizes %s %s exactly like deriveRouteKey when there is no literal top-level id to keep', (method, path) => {
		expect(deriveBudgetKey(method, path)).toBe(deriveRouteKey(method, path));
	});

	it('strips query strings before normalizing', () => {
		expect(deriveBudgetKey('GET', '/guilds/219564597349318656/messages/search?author_id=999')).toBe(
			'GET:/guilds/219564597349318656/messages/search',
		);
	});
});

describe('topLevelResource', () => {
	it('returns the literal top-level resource of a budget key', () => {
		expect(topLevelResource('GET:/channels/123456789012345678/messages/:id')).toBe('channels/123456789012345678');
		expect(topLevelResource('GET:/guilds/219564597349318656/messages/search')).toBe('guilds/219564597349318656');
		expect(topLevelResource('POST:/webhooks/123456789012345678/:token/messages/:id')).toBe('webhooks/123456789012345678');
	});

	it.each([
		['a normalized route key', 'GET:/channels/:id/messages'],
		['a non-resource path', 'GET:/users/@me'],
		['a resource path with a non-snowflake id', 'GET:/guilds/foo/messages'],
		['a methodless key', '/guilds/219564597349318656/messages'],
	])('returns undefined for %s', (_label, key) => {
		expect(topLevelResource(key)).toBeUndefined();
	});
});

describe('isRotatableRoute', () => {
	it.each([
		['GET', '/guilds/219564597349318656/messages/search'],
		['GET', '/channels/123456789012345678/messages'],
		['GET', '/channels/123456789012345678/messages/987654321098765432'],
		['GET', '/guilds/219564597349318656/channels'],
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
