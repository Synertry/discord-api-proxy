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

/**
 * #supporters channel + czbot ID. Sq 22 counts czbot-authored vote-confirmation
 * embeds that mention the user (`author_id=CZBOT_ID&mentions=user&channel_id=CHANNEL_SUPPORTERS`).
 * Counting raw user-authored messages here would over-count chitchat.
 */
export const CHANNEL_SUPPORTERS = '593126312982609921';
export const CZBOT_ID = '320731871359008768';

/**
 * Eligible fun channels for sq 25 ("1k+ msgs in all fun channels combined"),
 * ordered to match ChillZone's sidebar display.
 *
 * #counting leads the list because the aggregator reuses its message count
 * for sq 7 (`counting.total`) - one search call powers both squares.
 *
 * The full fun category (627219207246970896) contains 18 channels, but we
 * exclude:
 * - #gang-news (553692223259148302) - synertry's user token can't see it
 * - #mudae (960571084342718525) - temporarily locked, user-token search 403s
 *
 * If ChillZone reorganises the category mid-event, update this list.
 */
export const CHANNELS_FUN = [
	CHANNEL_COUNTING, // #counting (also drives sq 7 via counting.total)
	'491335575681630238', // #debate
	'1374809323112501310', // #help-me-choose
	'1098887351582867536', // #gaming
	'797895044925227068', // #poketwo
	'1222304713677209702', // #mudae-ll
	'584961122537570324', // #qotd
	'981284416380874812', // #quotes
	'374752833225883650', // #art
	'526182568861892618', // #compliment-above
	'374752900834000896', // #roast-the-person-above
	'526182495293669376', // #copypastas
	'974450941434675240', // #music
	'440684267325095936', // #pets
	'330248903968686080', // #memes
	'387008414867521536', // #social-medias
] as const;

/**
 * Event window. `.t` resets at Monday EOD ChillZone-server time; UTC midnight
 * is the safe v1 default. If the announcement's "after `.t` resets on the 11th"
 * turns out to mean a non-UTC midnight, flip these to the matching offset.
 */
export const EVENT_START = '2026-05-11T00:00:00.000Z';
export const EVENT_WEEK1_END = '2026-05-18T00:00:00.000Z';
export const EVENT_END = '2026-05-25T00:00:00.000Z';
