/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { deriveRoles } from '../../../../../src/custom/chillzone/events/bingo/roles';
import {
	ROLE_MILLIONAIRES,
	ROLE_MULTI_MILLIONAIRES,
	ROLES_SUPREME,
} from '../../../../../src/custom/chillzone/events/bingo/constants';
import type { DiscordGuildMember } from '../../../../../src/custom/chillzone/events/bingo/types';

const TEST_USER_ID = '100000000000000001';
const SNAPSHOT_AT = new Date('2026-05-15T12:00:00.000Z');

function makeMember(roles: readonly string[]): DiscordGuildMember {
	return { user: { id: TEST_USER_ID }, roles };
}

describe('deriveRoles', () => {
	it('reports no Millionaires and no Supremes for an empty role list', () => {
		const result = deriveRoles(makeMember([]), SNAPSHOT_AT);
		expect(result.hasMillionaires).toBe(false);
		expect(result.supreme).toEqual({ I: false, II: false, III: false, all: false });
	});

	it('treats Millionaires alone as sq 12 hit', () => {
		const result = deriveRoles(makeMember([ROLE_MILLIONAIRES]), SNAPSHOT_AT);
		expect(result.hasMillionaires).toBe(true);
	});

	it('treats Multi-Millionaires alone as sq 12 hit', () => {
		const result = deriveRoles(makeMember([ROLE_MULTI_MILLIONAIRES]), SNAPSHOT_AT);
		expect(result.hasMillionaires).toBe(true);
	});

	it('flags partial Supreme tiers without setting `all`', () => {
		const result = deriveRoles(makeMember([ROLES_SUPREME[0], ROLES_SUPREME[1]]), SNAPSHOT_AT);
		expect(result.supreme).toEqual({ I: true, II: true, III: false, all: false });
	});

	it('sets `supreme.all` only when all three tiers are present', () => {
		const result = deriveRoles(makeMember([...ROLES_SUPREME]), SNAPSHOT_AT);
		expect(result.supreme).toEqual({ I: true, II: true, III: true, all: true });
	});

	it('echoes user.id and snapshotAt verbatim', () => {
		const result = deriveRoles(makeMember([]), SNAPSHOT_AT);
		expect(result.userId).toBe(TEST_USER_ID);
		expect(result.snapshotAt).toBe(SNAPSHOT_AT.toISOString());
	});

	it('ignores unrelated role IDs', () => {
		const result = deriveRoles(makeMember(['111111111111111111', '222222222222222222']), SNAPSHOT_AT);
		expect(result.hasMillionaires).toBe(false);
		expect(result.supreme.all).toBe(false);
	});
});
