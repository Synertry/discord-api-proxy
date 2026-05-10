/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module bingo/discord-client
 * Low-level Discord API client used by the bingo aggregator and roles handler.
 *
 * Two network operations + one constant accessor:
 * - {@link BingoDiscordClient.countMessages} reads `total_results` from
 *   `GET /guilds/{guildId}/messages/search` (limit=1 to keep the payload small).
 * - {@link BingoDiscordClient.fetchGuildMember} fetches one guild member,
 *   memoised in an isolate-scope cache for 60s.
 * - {@link BingoDiscordClient.resolveFunChannels} returns the hardcoded
 *   {@link CHANNELS_FUN} list (no Discord call) - the dynamic category resolver
 *   was traded away for a curated allowlist that excludes 403-prone members.
 *
 * All Discord calls go through {@link fetchWithRetry} which applies the
 * standard 1.5x backoff / 0.85x decay around 429 / 5xx responses, honors
 * `Retry-After`, and times out after 60s. The aggregator awaits each call
 * sequentially - never `Promise.all` - to stay friendly to the per-route bucket.
 */

import { CHANNELS_FUN, CHILLZONE_GUILD_ID } from './constants';
import type { DiscordGuildMember, DiscordSearchResponse } from './types';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Per-call HTTP timeout. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Floor between consecutive calls within one /counts request. */
const MIN_DELAY_MS = 250;

/** Initial spacing - same as the floor; back-off can push it higher. */
const START_DELAY_MS = 250;

/** Cap to keep adaptive back-off from spiraling. */
const MAX_DELAY_MS = 8_000;

/** Multiplier applied on every 429 / 5xx. */
const BACKOFF_FACTOR = 1.5;

/** Decay multiplier applied after a streak of 200 OKs. */
const DECAY_FACTOR = 0.85;

/** Streak length that earns one decay step. */
const DECAY_STREAK = 10;

/** Per-call retry budget. */
const MAX_RETRIES = 3;

/** Member-cache TTL: dedupes lookups when GAS hits /counts then /roles back-to-back. */
const MEMBER_CACHE_TTL_MS = 60_000;

/** Error thrown when Discord returns a non-2xx response after retries are exhausted. */
export class DiscordApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
	) {
		super(`Discord API error: ${status}`);
		this.name = 'DiscordApiError';
	}
}

/** Per-isolate member cache with short TTL. */
const memberCache = new Map<string, { value: DiscordGuildMember; expiresAt: number }>();

/** Adaptive rate-limiter state, kept in module scope so all calls share the bucket. */
const rateState = { delayMs: START_DELAY_MS, successStreak: 0 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Strips the Discord API prefix to keep streaming logs grep-friendly. */
function shortenUrl(url: string): string {
	return url.startsWith(DISCORD_API_BASE) ? url.slice(DISCORD_API_BASE.length) : url;
}

/**
 * Streaming structured log for one Discord call. Wrangler dev tail emits each
 * line as it happens, so a `/counts` request prints ~26 lines in real time
 * instead of nothing for ~20s and a single status code at the end.
 *
 * Format keeps the leading `[bingo]` tag for easy `wrangler tail | grep bingo`.
 */
function logSubrequest(args: { status: number | string; ms: number; retries: number; url: string; outcome: 'ok' | 'retry' | 'fail' }): void {
	console.log(`[bingo] ${args.outcome.padEnd(5)} ${String(args.status).padEnd(4)} ${String(args.ms).padStart(5)}ms r=${args.retries} ${shortenUrl(args.url)}`);
}

/**
 * Issues a Discord API GET with adaptive 429 / 5xx handling.
 *
 * The backoff schedule mirrors `scripts/socialize-interaction-stats.ts::fetchWithRetry`:
 * - On 429 / 5xx: multiply current delay by {@link BACKOFF_FACTOR} (capped at {@link MAX_DELAY_MS}),
 *   honor `Retry-After` if present, retry up to {@link MAX_RETRIES} times.
 * - On 2xx: track a success streak; after every {@link DECAY_STREAK} successes, multiply the
 *   delay by {@link DECAY_FACTOR} (floored at {@link MIN_DELAY_MS}).
 *
 * @throws {DiscordApiError} when retries are exhausted or a 4xx other than 429 is returned.
 */
async function fetchWithRetry(url: string, headers: Headers, fetchFn: typeof fetch): Promise<Response> {
	let attempt = 0;

	while (true) {
		// Pre-call spacing - keeps a single request under Discord's burst limits.
		await sleep(rateState.delayMs);

		const t0 = Date.now();
		let response: Response;
		try {
			response = await fetchFn(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err: unknown) {
			const ms = Date.now() - t0;
			const message = err instanceof Error ? err.message : String(err);
			if (attempt >= MAX_RETRIES) {
				logSubrequest({ status: `NET:${message.slice(0, 20)}`, ms, retries: attempt, url, outcome: 'fail' });
				throw new DiscordApiError(0, `Network error after ${attempt} retries: ${message}`);
			}
			logSubrequest({ status: `NET:${message.slice(0, 20)}`, ms, retries: attempt, url, outcome: 'retry' });
			rateState.delayMs = Math.min(rateState.delayMs * BACKOFF_FACTOR, MAX_DELAY_MS);
			rateState.successStreak = 0;
			attempt += 1;
			continue;
		}

		const ms = Date.now() - t0;

		if (response.ok) {
			logSubrequest({ status: response.status, ms, retries: attempt, url, outcome: 'ok' });
			rateState.successStreak += 1;
			if (rateState.successStreak >= DECAY_STREAK) {
				rateState.delayMs = Math.max(rateState.delayMs * DECAY_FACTOR, MIN_DELAY_MS);
				rateState.successStreak = 0;
			}
			return response;
		}

		const transient = response.status === 429 || (response.status >= 500 && response.status <= 599);
		if (!transient || attempt >= MAX_RETRIES) {
			logSubrequest({ status: response.status, ms, retries: attempt, url, outcome: 'fail' });
			const body = await response.text();
			throw new DiscordApiError(response.status, body);
		}

		logSubrequest({ status: response.status, ms, retries: attempt, url, outcome: 'retry' });
		const retryAfterHeader = response.headers.get('retry-after');
		const retryAfterMs = retryAfterHeader ? Math.max(0, parseFloat(retryAfterHeader) * 1000) : 0;

		rateState.successStreak = 0;
		rateState.delayMs = Math.min(rateState.delayMs * BACKOFF_FACTOR, MAX_DELAY_MS);
		const wait = Math.max(rateState.delayMs, retryAfterMs);
		await sleep(wait);
		attempt += 1;
	}
}

/** Builds the user-token Authorization headers used for every bingo subrequest. */
function buildHeaders(token: string, userAgent: string | undefined): Headers {
	const headers = new Headers({ Authorization: token });
	if (userAgent) headers.set('User-Agent', userAgent);
	return headers;
}

/** Public client surface consumed by the aggregator and roles handler. */
export interface BingoDiscordClient {
	countMessages(params: URLSearchParams): Promise<number>;
	fetchGuildMember(userId: string): Promise<DiscordGuildMember>;
	resolveFunChannels(): Promise<readonly string[]>;
}

/**
 * Constructs a per-request Discord client bound to the caller's token, user-agent,
 * and (optionally injected) fetch implementation.
 */
export function createBingoDiscordClient(args: {
	readonly token: string;
	readonly userAgent: string | undefined;
	readonly fetcher: typeof fetch;
}): BingoDiscordClient {
	const { token, userAgent, fetcher } = args;
	const headers = buildHeaders(token, userAgent);

	return {
		async countMessages(params: URLSearchParams): Promise<number> {
			const search = new URLSearchParams(params);
			search.set('limit', '1');
			const url = `${DISCORD_API_BASE}/guilds/${CHILLZONE_GUILD_ID}/messages/search?${search.toString()}`;
			const response = await fetchWithRetry(url, headers, fetcher);
			const body = (await response.json()) as DiscordSearchResponse;
			if (typeof body.total_results !== 'number') {
				throw new DiscordApiError(response.status, 'Search response missing total_results');
			}
			return body.total_results;
		},

		async fetchGuildMember(userId: string): Promise<DiscordGuildMember> {
			const now = Date.now();
			const cached = memberCache.get(userId);
			if (cached && cached.expiresAt > now) return cached.value;

			const url = `${DISCORD_API_BASE}/guilds/${CHILLZONE_GUILD_ID}/members/${userId}`;
			const response = await fetchWithRetry(url, headers, fetcher);
			const member = (await response.json()) as DiscordGuildMember;
			memberCache.set(userId, { value: member, expiresAt: now + MEMBER_CACHE_TTL_MS });
			return member;
		},

		async resolveFunChannels(): Promise<readonly string[]> {
			return CHANNELS_FUN;
		},
	};
}

/** Test helper: clears all module-scope caches. */
export function __resetBingoClientCachesForTests(): void {
	memberCache.clear();
	rateState.delayMs = START_DELAY_MS;
	rateState.successStreak = 0;
}
