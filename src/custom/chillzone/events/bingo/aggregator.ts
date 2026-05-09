/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/aggregator
 * Orchestrates the sequence of Discord searches that produce a {@link CountsResult}.
 *
 * Calls the supplied {@link BingoDiscordClient} sequentially - never `Promise.all` -
 * to stay friendly to Discord's per-route bucket. Each invocation issues
 * 11 + |fun channels| Discord searches (per the plan's "Discord call budget" table)
 * plus one channels-list call on cold-start per isolate.
 */

import {
	CHANNELS_GENERAL,
	CHANNEL_COUNTING,
	CHANNEL_SUPPORTERS,
	EVENT_END,
	EVENT_START,
	EVENT_WEEK1_END,
} from './constants';
import { dateToSnowflake } from './snowflake';
import type { BingoDiscordClient } from './discord-client';
import type { CountsResult, EventWindow, FunChannelCounts, GeneralWeeklyCounts } from './types';

/** Pre-computed snowflake bounds for the event window. */
function buildBounds(): { startId: string; week1EndId: string; endId: string; window: EventWindow } {
	const startId = dateToSnowflake(new Date(EVENT_START));
	const week1EndId = dateToSnowflake(new Date(EVENT_WEEK1_END));
	const endId = dateToSnowflake(new Date(EVENT_END));
	return {
		startId,
		week1EndId,
		endId,
		window: { start: EVENT_START, week1End: EVENT_WEEK1_END, end: EVENT_END },
	};
}

/** Search params for a per-author window (no channel filter). */
function authorWindowParams(authorId: string, minId: string, maxId: string): URLSearchParams {
	return new URLSearchParams({ author_id: authorId, min_id: minId, max_id: maxId });
}

/** Search params for a per-author, per-channel window. */
function channelWindowParams(authorId: string, channelId: string, minId: string, maxId: string): URLSearchParams {
	return new URLSearchParams({ author_id: authorId, channel_id: channelId, min_id: minId, max_id: maxId });
}

/** Aggregates the full /counts result for one user. */
export async function aggregateCounts(client: BingoDiscordClient, userId: string): Promise<CountsResult> {
	const bounds = buildBounds();

	// 1-2: weekly totals (no channel filter) - drive squares 1, 4, 13.
	const msgsWeek1 = await client.countMessages(authorWindowParams(userId, bounds.startId, bounds.week1EndId));
	const msgsWeek2 = await client.countMessages(authorWindowParams(userId, bounds.week1EndId, bounds.endId));

	// 3-8: per-general per-week (sq 2 tip-off).
	const generals: Record<string, GeneralWeeklyCounts> = {};
	for (const channelId of CHANNELS_GENERAL) {
		const week1 = await client.countMessages(channelWindowParams(userId, channelId, bounds.startId, bounds.week1EndId));
		const week2 = await client.countMessages(channelWindowParams(userId, channelId, bounds.week1EndId, bounds.endId));
		generals[channelId] = { week1, week2 };
	}

	// 9: counting (sq 7).
	const countingTotal = await client.countMessages(channelWindowParams(userId, CHANNEL_COUNTING, bounds.startId, bounds.endId));

	// 10: supporters (sq 22).
	const supportersTotal = await client.countMessages(channelWindowParams(userId, CHANNEL_SUPPORTERS, bounds.startId, bounds.endId));

	// 11..N: fun-channels expansion + per-channel windows (sq 25).
	const funChannelIds = await client.resolveFunChannels();
	const funByChannel: Record<string, number> = {};
	let funTotal = 0;
	for (const channelId of funChannelIds) {
		const count = await client.countMessages(channelWindowParams(userId, channelId, bounds.startId, bounds.endId));
		funByChannel[channelId] = count;
		funTotal += count;
	}
	const fun: FunChannelCounts = { total: funTotal, byChannel: funByChannel };

	// Last: lifetime total (sq 18 baseline) - no window, no channel filter.
	const msgsTotalGuildAllTime = await client.countMessages(new URLSearchParams({ author_id: userId }));

	return {
		userId,
		window: bounds.window,
		msgsWeek1,
		msgsWeek2,
		msgsTotal: msgsWeek1 + msgsWeek2,
		msgsTotalGuildAllTime,
		generals,
		counting: { total: countingTotal },
		supporters: { total: supportersTotal },
		fun,
	};
}
