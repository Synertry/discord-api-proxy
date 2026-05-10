/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/roles
 * Pure role-derivation logic for bingo squares 12 and 19.
 */

import { ROLE_MILLIONAIRES, ROLE_MULTI_MILLIONAIRES, ROLES_SUPREME } from './constants';
import type { DiscordGuildMember, RolesResult, SupremeFlags } from './types';

/**
 * Derives the role response shape consumed by the GAS spreadsheet.
 *
 * - sq 12: true if the member holds the Millionaires OR Multi-Millionaires role.
 * - sq 19: per-tier Supreme booleans plus the AND across all three tiers.
 */
export function deriveRoles(member: DiscordGuildMember, snapshotAt: Date): RolesResult {
	const roleSet = new Set(member.roles);

	const supreme: SupremeFlags = {
		I: roleSet.has(ROLES_SUPREME[0]),
		II: roleSet.has(ROLES_SUPREME[1]),
		III: roleSet.has(ROLES_SUPREME[2]),
		all: false,
	};
	supreme.all = supreme.I && supreme.II && supreme.III;

	return {
		userId: member.user.id,
		snapshotAt: snapshotAt.toISOString(),
		hasMillionaires: roleSet.has(ROLE_MILLIONAIRES) || roleSet.has(ROLE_MULTI_MILLIONAIRES),
		supreme,
	};
}
