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
 * v2: per-call acquire / release through the token-pool rotator.
 * Each Discord call:
 *   1. acquire(slot, routeKey, guildId) from the pool
 *   2. fetch with the acquired token's secret AND the matching browser fingerprint
 *   3. release(label, requestId, response) so the DO can update bucket state
 *   4. on 429, single retry with a fresh acquire (no recursion)
 *
 * Fingerprint: each acquired token carries its `fingerprintProfileId`. Combined
 * with the current Discord `build_number` (read once per request from the pool
 * DO and memoized), the client emits a full browser-like header set so the
 * upstream sees consistent identities across rotated calls.
 */

import { composeFingerprint } from '../../../../fingerprint/compose';
import { FALLBACK_BUILD_NUMBER, selectBuildNumber } from '../../../../fingerprint/build-number';
import { FALLBACK_PROFILE_ID, lookupProfile } from '../../../../fingerprint/profiles';
import { CHANNELS_FUN, CHILLZONE_GUILD_ID } from './constants';
import { deriveRouteKey } from '../../../../rotator/bucket';
import { extractReleaseInput, extractReleaseInputWithBody } from '../../../../rotator/release-input';
import type { TokenPoolClient } from '../../../../rotator/types';
import type { DiscordGuildMember, DiscordSearchResponse } from './types';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Per-call HTTP timeout. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Member-cache TTL: dedupes lookups when GAS hits /counts then /roles back-to-back. */
const MEMBER_CACHE_TTL_MS = 60_000;

/** Error thrown when Discord returns a non-2xx response. */
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

/**
 * Build the full per-request header set: Authorization + browser fingerprint
 * (User-Agent, X-Super-Properties, X-Discord-Locale, ...). Falls back through
 * profileId -> FALLBACK_PROFILE_ID if lookup fails.
 */
function buildHeaders(tokenSecret: string, profileId: string | undefined, buildNumber: number): Headers {
	const profile = lookupProfile(profileId ?? FALLBACK_PROFILE_ID) ?? lookupProfile(FALLBACK_PROFILE_ID);
	const headers = new Headers({ Authorization: tokenSecret });
	if (!profile) return headers;
	const fp = composeFingerprint(profile, buildNumber);
	for (const [k, v] of Object.entries(fp)) {
		headers.set(k, v);
	}
	return headers;
}

/** Public client surface consumed by the aggregator and roles handler. */
export interface BingoDiscordClient {
	countMessages(params: URLSearchParams): Promise<number>;
	fetchGuildMember(userId: string): Promise<DiscordGuildMember>;
	resolveFunChannels(): Promise<readonly string[]>;
}

/**
 * Constructs a per-request bingo Discord client backed by the token pool. The
 * build-number lookup is memoized inside this factory so the DO is hit at most
 * once per bingo request even when /counts fans out to 12-15 sub-fetches.
 */
export function createBingoDiscordClient(args: {
	readonly pool: TokenPoolClient;
	readonly fetcher: typeof fetch;
}): BingoDiscordClient {
	const { pool, fetcher } = args;

	let buildNumberPromise: Promise<number> | null = null;
	function getBuildNumber(): Promise<number> {
		if (!buildNumberPromise) {
			buildNumberPromise = (async () => {
				if (!pool.getBuildNumberRecord) return FALLBACK_BUILD_NUMBER;
				try {
					const record = await pool.getBuildNumberRecord();
					return selectBuildNumber(record, Date.now());
				} catch (err: unknown) {
					console.error('bingo build-number read failed:', err);
					return FALLBACK_BUILD_NUMBER;
				}
			})();
		}
		return buildNumberPromise;
	}

	async function fetchWithRotator(args2: {
		url: string;
		pathname: string;
		guildId?: string;
	}): Promise<Response> {
		const { url, pathname, guildId } = args2;
		const routeKey = deriveRouteKey('GET', pathname);

		const acq = await pool.acquire('default', routeKey, guildId);
		if (!acq.ok) {
			throw new DiscordApiError(429, `pool unavailable: reason=${acq.reason} retryAfter=${acq.retryAfter}`);
		}

		const buildNumber = await getBuildNumber();

		let response: Response;
		try {
			response = await fetcher(url, {
				method: 'GET',
				headers: buildHeaders(acq.tokenSecret, acq.fingerprintProfileId, buildNumber),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err: unknown) {
			await pool.release(acq.label, acq.requestId, { status: 599, routeKey });
			const message = err instanceof Error ? err.message : String(err);
			throw new DiscordApiError(0, `Network error: ${message}`);
		}

		const releaseInput =
			response.status === 403
				? await extractReleaseInputWithBody(response, routeKey, guildId)
				: extractReleaseInput(response, routeKey, guildId);
		await pool.release(acq.label, acq.requestId, releaseInput);

		if (response.status !== 429) return response;

		// Single retry with a fresh acquire on 429.
		const retry = await pool.acquire('default', routeKey, guildId);
		if (!retry.ok) return response; // No alternative; pass the original 429 through.

		const retryResponse = await fetcher(url, {
			method: 'GET',
			headers: buildHeaders(retry.tokenSecret, retry.fingerprintProfileId, buildNumber),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			throw new DiscordApiError(0, `Network error on retry: ${message}`);
		});

		const retryRelease =
			retryResponse.status === 403
				? await extractReleaseInputWithBody(retryResponse, routeKey, guildId)
				: extractReleaseInput(retryResponse, routeKey, guildId);
		await pool.release(retry.label, retry.requestId, retryRelease);
		return retryResponse;
	}

	async function getJson(pathname: string, query: URLSearchParams | undefined): Promise<{ response: Response; body: unknown }> {
		const search = query ? `?${query.toString()}` : '';
		const url = `${DISCORD_API_BASE}${pathname}${search}`;
		const response = await fetchWithRotator({
			url,
			pathname,
			guildId: CHILLZONE_GUILD_ID,
		});
		if (!response.ok) {
			const body = await response.text();
			throw new DiscordApiError(response.status, body);
		}
		const body = await response.json();
		return { response, body };
	}

	return {
		async countMessages(params: URLSearchParams): Promise<number> {
			const search = new URLSearchParams(params);
			search.set('limit', '1');
			const { body } = await getJson(`/guilds/${CHILLZONE_GUILD_ID}/messages/search`, search);
			const parsed = body as DiscordSearchResponse;
			if (typeof parsed.total_results !== 'number') {
				throw new DiscordApiError(0, 'Search response missing total_results');
			}
			return parsed.total_results;
		},

		async fetchGuildMember(userId: string): Promise<DiscordGuildMember> {
			const now = Date.now();
			const cached = memberCache.get(userId);
			if (cached && cached.expiresAt > now) return cached.value;

			const { body } = await getJson(`/guilds/${CHILLZONE_GUILD_ID}/members/${userId}`, undefined);
			const member = body as DiscordGuildMember;
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
}
