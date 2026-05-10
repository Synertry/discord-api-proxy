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

import { CHANNELS_GENERAL, CHANNEL_COUNTING, CHANNEL_SUPPORTERS, CZBOT_ID, EVENT_END, EVENT_START, EVENT_WEEK1_END } from './constants';
import { dateToSnowflake } from './snowflake';
import { DiscordApiError, type BingoDiscordClient } from './discord-client';
import type { CountsResult, EventWindow, FunChannelCounts, GeneralWeeklyCounts } from './types';

/** Default event window pulled from {@link constants}. */
export const DEFAULT_EVENT_WINDOW: EventWindow = {
	start: EVENT_START,
	week1End: EVENT_WEEK1_END,
	end: EVENT_END,
};

/** Pre-computed snowflake bounds for the supplied window. */
function buildBounds(window: EventWindow): { startId: string; week1EndId: string; endId: string; window: EventWindow } {
	const startId = dateToSnowflake(new Date(window.start));
	const week1EndId = dateToSnowflake(new Date(window.week1End));
	const endId = dateToSnowflake(new Date(window.end));
	return { startId, week1EndId, endId, window };
}

/** Search params for a per-author window (no channel filter). */
function authorWindowParams(authorId: string, minId: string, maxId: string): URLSearchParams {
	return new URLSearchParams({ author_id: authorId, min_id: minId, max_id: maxId });
}

/** Search params for a per-author, per-channel window. */
function channelWindowParams(authorId: string, channelId: string, minId: string, maxId: string): URLSearchParams {
	return new URLSearchParams({ author_id: authorId, channel_id: channelId, min_id: minId, max_id: maxId });
}

/**
 * Search params for sq 22 ("Vote 30 times for CZ in #supporters").
 *
 * The valid signal is czbot's vote-confirmation embed which mentions the
 * voting user. We count those (`author_id=czbot&mentions=user`) rather than
 * raw user-authored messages in #supporters, which would over-count by any
 * casual chitchat. Empirically: a known voter who voted 157 times reports
 * 157 czbot mentions; a non-voter reports 0.
 */
function supportersVoteParams(userId: string, minId: string, maxId: string): URLSearchParams {
	return new URLSearchParams({
		author_id: CZBOT_ID,
		mentions: userId,
		channel_id: CHANNEL_SUPPORTERS,
		min_id: minId,
		max_id: maxId,
	});
}

/**
 * Aggregates the full /counts result for one user.
 *
 * @param window Optional override; defaults to {@link DEFAULT_EVENT_WINDOW}.
 *               Useful for stress-testing against a populated historical
 *               window while the real event window is still in the future.
 */
export async function aggregateCounts(
	client: BingoDiscordClient,
	userId: string,
	window: EventWindow = DEFAULT_EVENT_WINDOW,
): Promise<CountsResult> {
	const bounds = buildBounds(window);

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

	// 9: supporters (sq 22) - czbot vote-confirmations mentioning the user.
	const supportersTotal = await client.countMessages(supportersVoteParams(userId, bounds.startId, bounds.endId));

	// 10..N: fun-channels expansion + per-channel windows (sq 25).
	// CHANNELS_FUN includes CHANNEL_COUNTING so the same search call drives
	// sq 7 (counting.total) and sq 25 (fun.total) - no double-fetch. 403 on a
	// gated channel is swallowed (treat as zero) so a single locked channel
	// can't fail the whole /counts response.
	const funChannelIds = await client.resolveFunChannels();
	const funByChannel: Record<string, number> = {};
	let funTotal = 0;
	for (const channelId of funChannelIds) {
		let count = 0;
		try {
			count = await client.countMessages(channelWindowParams(userId, channelId, bounds.startId, bounds.endId));
		} catch (err: unknown) {
			if (err instanceof DiscordApiError && err.status === 403) {
				console.warn(`bingo: fun-channel ${channelId} returned 403, treating count as 0`);
			} else {
				throw err;
			}
		}
		funByChannel[channelId] = count;
		funTotal += count;
	}
	const fun: FunChannelCounts = { total: funTotal, byChannel: funByChannel };
	const countingTotal = funByChannel[CHANNEL_COUNTING] ?? 0;

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
