/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/snowflake
 * Discord snowflake <-> Date utilities used to build min_id / max_id windows
 * for the message-search calls.
 *
 * Snowflake layout (high to low bits): 42 bits ms since Discord epoch, 5 bits
 * worker, 5 bits process, 12 bits increment. Dropping the low 22 bits and
 * adding the epoch yields the message timestamp.
 *
 * @see https://discord.com/developers/docs/reference#snowflakes
 */

/** Discord epoch (2015-01-01T00:00:00Z) in milliseconds. */
export const DISCORD_EPOCH = 1420070400000n;

/**
 * Converts a {@link Date} to the smallest snowflake that sorts at or after it.
 * The 22 low bits are zeroed which is fine for `min_id` / `max_id` window bounds.
 */
export const dateToSnowflake = (date: Date): string => {
	const ms = BigInt(date.getTime());
	if (ms < DISCORD_EPOCH) {
		throw new RangeError(`Date ${date.toISOString()} is before Discord epoch`);
	}
	return ((ms - DISCORD_EPOCH) << 22n).toString();
};

/** Inverse of {@link dateToSnowflake}; truncates to ms precision. */
export const snowflakeToDate = (id: string): Date => {
	const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
	return new Date(Number(ms));
};
