/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/constants
 * Hardcoded ChillZone identifiers and event window for the Bingo autotally.
 *
 * IDs are hardcoded per the project convention for ChillZone event endpoints
 * (the guild and its long-lived channels/roles are stable; the GAS consumer
 * does not need to plumb them through every request). All values here are
 * public Discord IDs, not secrets.
 */

/** ChillZone guild snowflake. */
export const CHILLZONE_GUILD_ID = '219564597349318656';

/** Roles consulted by sq 12 (millionaires climb). */
export const ROLE_MILLIONAIRES = '497654466523430913';
export const ROLE_MULTI_MILLIONAIRES = '556714900991377418';

/** Roles consulted by sq 19 (Supreme in every general). */
export const ROLES_SUPREME = ['942552217775390750', '942552240256864276', '950449913760739328'] as const;
export type SupremeTier = 'I' | 'II' | 'III';

/** General-chat channels for sq 2 weekly windowing (Discord Search filtered by channel_id). */
export const CHANNELS_GENERAL = [
	'627217930576199690', // gen1
	'627217971047038977', // gen2
	'701205521071341578', // gen3
] as const;

/** #counting channel + bot ID kept around for the v2 valid-count check (white_check_mark react). */
export const CHANNEL_COUNTING = '1220448774803951827';
export const COUNTING_BOT_ID = '510016054391734273';

/** #supporters channel + czbot ID kept around for the v2 vote-confirmation embed parser. */
export const CHANNEL_SUPPORTERS = '593126312982609921';
export const CZBOT_ID = '320731871359008768';

/**
 * Fun-channels live under this Discord category. Children are resolved at
 * request time via {@link resolveFunChannels} and cached per isolate.
 */
export const FUN_CATEGORY_ID = '627219207246970896';

/**
 * Event window. `.t` resets at Monday EOD ChillZone-server time; UTC midnight
 * is the safe v1 default. If the announcement's "after `.t` resets on the 11th"
 * turns out to mean a non-UTC midnight, flip these to the matching offset.
 */
export const EVENT_START = '2026-05-11T00:00:00.000Z';
export const EVENT_WEEK1_END = '2026-05-18T00:00:00.000Z';
export const EVENT_END = '2026-05-25T00:00:00.000Z';
