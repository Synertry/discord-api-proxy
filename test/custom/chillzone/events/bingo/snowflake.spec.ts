/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { DISCORD_EPOCH, dateToSnowflake, snowflakeToDate } from '../../../../../src/custom/chillzone/events/bingo/snowflake';

describe('snowflake utilities', () => {
	it('returns "0" for the Discord epoch', () => {
		expect(dateToSnowflake(new Date(Number(DISCORD_EPOCH)))).toBe('0');
	});

	it('throws for dates before the Discord epoch', () => {
		expect(() => dateToSnowflake(new Date(Number(DISCORD_EPOCH) - 1))).toThrow(RangeError);
	});

	it('round-trips a known message ID timestamp at ms precision', () => {
		// 2026-05-11T00:00:00.000Z, the bingo event start.
		const start = new Date('2026-05-11T00:00:00.000Z');
		const id = dateToSnowflake(start);
		const recovered = snowflakeToDate(id);
		expect(recovered.toISOString()).toBe(start.toISOString());
	});

	it('produces strictly monotonic snowflakes for monotonically increasing dates', () => {
		const a = dateToSnowflake(new Date('2026-05-11T00:00:00.000Z'));
		const b = dateToSnowflake(new Date('2026-05-18T00:00:00.000Z'));
		const c = dateToSnowflake(new Date('2026-05-25T00:00:00.000Z'));
		expect(BigInt(a) < BigInt(b)).toBe(true);
		expect(BigInt(b) < BigInt(c)).toBe(true);
	});

	it('decodes a real Discord message snowflake to its embedded timestamp', () => {
		// id = 175928847299117063 -> 2016-04-30T11:18:25.796Z (per Discord docs example).
		const decoded = snowflakeToDate('175928847299117063');
		expect(decoded.toISOString()).toBe('2016-04-30T11:18:25.796Z');
	});
});
