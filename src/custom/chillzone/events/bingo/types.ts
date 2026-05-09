/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/types
 * Domain types for the ChillZone Bingo autotally pipeline.
 */

import type { SupremeTier } from './constants';

// ---------------------------------------------------------------------------
// Discord API types (subset used by bingo)
// ---------------------------------------------------------------------------

/** Subset of `GET /guilds/{id}/messages/search` response we read. */
export interface DiscordSearchResponse {
	readonly total_results: number;
}

/** Subset of `GET /guilds/{id}/channels` response we read. */
export interface DiscordGuildChannel {
	readonly id: string;
	readonly type: number;
	readonly parent_id: string | null;
	readonly name?: string;
}

/** Subset of `GET /guilds/{id}/members/{userId}` response we read. */
export interface DiscordGuildMember {
	readonly user: { readonly id: string };
	readonly roles: readonly string[];
}

// ---------------------------------------------------------------------------
// Domain types - response payloads
// ---------------------------------------------------------------------------

/** Inclusive event window expressed as ISO 8601 strings. */
export interface EventWindow {
	start: string;
	week1End: string;
	end: string;
}

/** Per-channel, per-week message count for the three general chats (sq 2). */
export interface GeneralWeeklyCounts {
	week1: number;
	week2: number;
}

/** Per-channel breakdown for the fun-channels aggregate (sq 25). */
export interface FunChannelCounts {
	total: number;
	byChannel: Record<string, number>;
}

/** Aggregate counts result returned by the `/counts` endpoint. */
export interface CountsResult {
	userId: string;
	window: EventWindow;
	msgsWeek1: number;
	msgsWeek2: number;
	msgsTotal: number;
	msgsTotalGuildAllTime: number;
	generals: Record<string, GeneralWeeklyCounts>;
	counting: { total: number };
	supporters: { total: number };
	fun: FunChannelCounts;
}

/** Per-tier Supreme-role boolean map plus the AND across all tiers (sq 19). */
export interface SupremeFlags {
	I: boolean;
	II: boolean;
	III: boolean;
	all: boolean;
}

/** Aggregate role result returned by the `/roles` endpoint. */
export interface RolesResult {
	userId: string;
	snapshotAt: string;
	hasMillionaires: boolean;
	supreme: SupremeFlags;
}

export type { SupremeTier };
