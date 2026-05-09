/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { aggregateCounts } from '../../../../../src/custom/chillzone/events/bingo/aggregator';
import {
	CHANNELS_GENERAL,
	CHANNEL_COUNTING,
	CHANNEL_SUPPORTERS,
	EVENT_END,
	EVENT_START,
	EVENT_WEEK1_END,
} from '../../../../../src/custom/chillzone/events/bingo/constants';
import { dateToSnowflake } from '../../../../../src/custom/chillzone/events/bingo/snowflake';
import type { BingoDiscordClient } from '../../../../../src/custom/chillzone/events/bingo/discord-client';

const USER_ID = '100000000000000001';
const FUN_CHANNEL_IDS = ['800000000000000001', '800000000000000002'] as const;

const startId = dateToSnowflake(new Date(EVENT_START));
const week1EndId = dateToSnowflake(new Date(EVENT_WEEK1_END));
const endId = dateToSnowflake(new Date(EVENT_END));

function key(params: URLSearchParams): string {
	const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
	return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

interface MockBuilder {
	on(params: Record<string, string>, total: number): MockBuilder;
	build(): BingoDiscordClient;
	calls: () => readonly string[];
}

function mockClient(funChannels: readonly string[] = FUN_CHANNEL_IDS): MockBuilder {
	const handlers = new Map<string, number>();
	const observed: string[] = [];

	const builder: MockBuilder = {
		on(params, total) {
			handlers.set(key(new URLSearchParams(params)), total);
			return builder;
		},
		calls: () => observed,
		build(): BingoDiscordClient {
			return {
				async countMessages(params) {
					const k = key(params);
					observed.push(k);
					if (!handlers.has(k)) throw new Error(`unexpected search call: ${k}`);
					return handlers.get(k) ?? 0;
				},
				async fetchGuildMember() {
					throw new Error('fetchGuildMember should not be called by aggregateCounts');
				},
				async resolveFunChannels() {
					return funChannels;
				},
			};
		},
	};

	return builder;
}

describe('aggregateCounts', () => {
	it('sums weekly totals into msgsTotal and reports lifetime total separately', async () => {
		const client = mockClient([])
			.on({ author_id: USER_ID, min_id: startId, max_id: week1EndId }, 5000)
			.on({ author_id: USER_ID, min_id: week1EndId, max_id: endId }, 7000)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: startId, max_id: week1EndId }, 100)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: week1EndId, max_id: endId }, 100)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: startId, max_id: week1EndId }, 100)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: week1EndId, max_id: endId }, 100)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: startId, max_id: week1EndId }, 100)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: week1EndId, max_id: endId }, 100)
			.on({ author_id: USER_ID, channel_id: CHANNEL_COUNTING, min_id: startId, max_id: endId }, 312)
			.on({ author_id: USER_ID, channel_id: CHANNEL_SUPPORTERS, min_id: startId, max_id: endId }, 18)
			.on({ author_id: USER_ID }, 489210)
			.build();

		const result = await aggregateCounts(client, USER_ID);
		expect(result.userId).toBe(USER_ID);
		expect(result.msgsWeek1).toBe(5000);
		expect(result.msgsWeek2).toBe(7000);
		expect(result.msgsTotal).toBe(12000);
		expect(result.msgsTotalGuildAllTime).toBe(489210);
		expect(result.counting.total).toBe(312);
		expect(result.supporters.total).toBe(18);
		expect(result.fun.total).toBe(0);
		expect(result.fun.byChannel).toEqual({});
	});

	it('builds per-general weekly buckets keyed by channel id', async () => {
		const client = mockClient([])
			.on({ author_id: USER_ID, min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: startId, max_id: week1EndId }, 800)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: week1EndId, max_id: endId }, 750)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: startId, max_id: week1EndId }, 320)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: week1EndId, max_id: endId }, 300)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: startId, max_id: week1EndId }, 100)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: week1EndId, max_id: endId }, 80)
			.on({ author_id: USER_ID, channel_id: CHANNEL_COUNTING, min_id: startId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNEL_SUPPORTERS, min_id: startId, max_id: endId }, 0)
			.on({ author_id: USER_ID }, 0)
			.build();

		const result = await aggregateCounts(client, USER_ID);
		expect(result.generals).toEqual({
			[CHANNELS_GENERAL[0]]: { week1: 800, week2: 750 },
			[CHANNELS_GENERAL[1]]: { week1: 320, week2: 300 },
			[CHANNELS_GENERAL[2]]: { week1: 100, week2: 80 },
		});
	});

	it('aggregates fun-channel totals from the resolver output', async () => {
		const client = mockClient(FUN_CHANNEL_IDS)
			.on({ author_id: USER_ID, min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNEL_COUNTING, min_id: startId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNEL_SUPPORTERS, min_id: startId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: FUN_CHANNEL_IDS[0], min_id: startId, max_id: endId }, 200)
			.on({ author_id: USER_ID, channel_id: FUN_CHANNEL_IDS[1], min_id: startId, max_id: endId }, 543)
			.on({ author_id: USER_ID }, 0)
			.build();

		const result = await aggregateCounts(client, USER_ID);
		expect(result.fun.total).toBe(743);
		expect(result.fun.byChannel).toEqual({
			[FUN_CHANNEL_IDS[0]]: 200,
			[FUN_CHANNEL_IDS[1]]: 543,
		});
	});

	it('echoes the configured event window in the response', async () => {
		const client = mockClient([])
			.on({ author_id: USER_ID, min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[0], min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[1], min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: startId, max_id: week1EndId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNELS_GENERAL[2], min_id: week1EndId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNEL_COUNTING, min_id: startId, max_id: endId }, 0)
			.on({ author_id: USER_ID, channel_id: CHANNEL_SUPPORTERS, min_id: startId, max_id: endId }, 0)
			.on({ author_id: USER_ID }, 0)
			.build();

		const result = await aggregateCounts(client, USER_ID);
		expect(result.window).toEqual({
			start: EVENT_START,
			week1End: EVENT_WEEK1_END,
			end: EVENT_END,
		});
	});
});
