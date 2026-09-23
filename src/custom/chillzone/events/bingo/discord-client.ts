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
 * v3: per-call acquire / release through the token-pool rotator, on the
 * shared header composer (`composeRequestHeaders`) and response inspector
 * (`inspectResponse`) every other Discord caller in this codebase uses.
 * Each Discord call:
 *   1. acquire(slot, routeKey, guildId) from the pool - with a backoff-and-
 *      retry loop on `{ ok: false, reason: 'cooldown' }`, since a `/counts`
 *      fan-out of 12-15 sub-fetches on the same identity routinely wants the
 *      same recently-used token faster than the identity-wide dispatch-gap
 *      floor allows; this is expected backpressure, not an error.
 *   2. fetch with the acquired token's secret and its composed fingerprint
 *   3. release(label, requestId, outcome) so the DO can update bucket state
 *   4. on a live 429, a single retry with one fresh acquire (no loop) after
 *      waiting the shared `retryDelayMs` backoff - matching every other 429
 *      retry path in this codebase.
 *
 * Live client versions are read once per request (memoized) and reused for
 * every fingerprint composed within it, since they are DO-wide, not
 * per-token - unlike the fingerprint *profile*, which is per-acquired-token.
 */

import { composeRequestHeaders } from '../../../../fingerprint/headers';
import { resolveClientVersions } from '../../../../fingerprint/versions';
import { resolveProfileId } from '../../../../fingerprint/profiles';
import { CHANNELS_FUN, CHILLZONE_GUILD_ID } from './constants';
import { deriveBudgetKey } from '../../../../rotator/bucket';
import { inspectResponse } from '../../../../rotator/signals';
import { retryDelayMs } from '../../../../rotator/budget';
import type { AcquireSuccess, ClientVersions, ReleaseInput, RouteKey, TokenPoolClient } from '../../../../rotator/types';
import type { DiscordGuildMember, DiscordSearchResponse } from './types';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Per-call HTTP timeout. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Member-cache TTL: dedupes lookups when GAS hits /counts then /roles back-to-back. */
const MEMBER_CACHE_TTL_MS = 60_000;

/** Cap on the acquire-cooldown backoff loop - bounds worst-case latency on a sustained busy pool rather than retrying forever. */
const MAX_ACQUIRE_ATTEMPTS = 5;

/** Longest single cooldown worth waiting out. Anything longer (an open captcha/Cloudflare circuit, a long bucket reset) fails fast with a 429 instead of stalling the request for minutes; mirrors the shared pager's block-wait cap. */
const MAX_ACQUIRE_WAIT_MS = 5000;

/** Longest live-429 Retry-After worth waiting out before a retry. A longer bench passes the original 429 through instead of stalling the caller for minutes. */
const MAX_429_RETRY_WAIT_MS = 15_000;

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

const defaultWait = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Public client surface consumed by the aggregator and roles handler. */
export interface BingoDiscordClient {
  countMessages(params: URLSearchParams): Promise<number>;
  fetchGuildMember(userId: string): Promise<DiscordGuildMember>;
  resolveFunChannels(): Promise<readonly string[]>;
}

/**
 * Constructs a per-request bingo Discord client backed by the token pool. The
 * client-versions lookup is memoized inside this factory so the DO is hit at
 * most once per bingo request even when /counts fans out to 12-15 sub-fetches.
 */
export function createBingoDiscordClient(args: {
  readonly pool: TokenPoolClient;
  readonly fetcher: typeof fetch;
  readonly wait?: (ms: number) => Promise<void>;
}): BingoDiscordClient {
  const { pool, fetcher } = args;
  const wait = args.wait ?? defaultWait;

  let versionsPromise: Promise<ClientVersions> | null = null;
  function getVersions(): Promise<ClientVersions> {
    if (!versionsPromise) {
      versionsPromise = (async () => {
        if (!pool.getClientVersions) return resolveClientVersions(null, Date.now());
        try {
          const records = await pool.getClientVersions();
          return resolveClientVersions(records, Date.now());
        } catch (err: unknown) {
          console.error('bingo client-versions read failed:', err);
          return resolveClientVersions(null, Date.now());
        }
      })();
    }
    return versionsPromise;
  }

  async function buildHeaders(acq: AcquireSuccess, versions: ClientVersions): Promise<Headers> {
    return composeRequestHeaders({
      token: acq.tokenSecret,
      tokenKind: 'user-default',
      identity: {
        key: `pool:${acq.label}`,
        kind: 'pool',
        label: acq.label,
        profile: resolveProfileId(acq.fingerprintProfileId, versions.chromeMajor),
      },
      versions,
    });
  }

  /** Acquire with a backoff-and-retry loop on routine cooldown backpressure. Throws `DiscordApiError(429, ...)` on any non-cooldown failure, on a cooldown longer than `MAX_ACQUIRE_WAIT_MS`, or once `MAX_ACQUIRE_ATTEMPTS` is exhausted. */
  async function acquireWithBackoff(routeKey: RouteKey, guildId: string | undefined): Promise<AcquireSuccess> {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const result = await pool.acquire('default', routeKey, guildId);
      if (result.ok) return result;
      if (result.reason !== 'cooldown' || result.retryAfter > MAX_ACQUIRE_WAIT_MS) {
        throw new DiscordApiError(429, `pool unavailable: reason=${result.reason} retryAfter=${result.retryAfter}`);
      }
      await wait(Math.max(1000, result.retryAfter));
    }
    throw new DiscordApiError(429, 'pool unavailable: exhausted acquire retries under sustained cooldown');
  }

  async function fetchWithRotator(args2: { url: string; pathname: string; guildId?: string }): Promise<Response> {
    const { url, pathname, guildId } = args2;
    const routeKey = deriveBudgetKey('GET', pathname);

    const acq = await acquireWithBackoff(routeKey, guildId);
    const versions = await getVersions();

    let response: Response;
    let outcome: ReleaseInput;
    let released = false;
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: await buildHeaders(acq, versions),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      outcome = await inspectResponse(response, routeKey, guildId);
      await pool.release(acq.label, acq.requestId, outcome);
      released = true;
    } catch (err: unknown) {
      if (!released) {
        await pool.release(acq.label, acq.requestId, { status: 599, routeKey }).catch((cleanupErr: unknown) => {
          console.error('bingo discord-client release cleanup failed:', cleanupErr);
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new DiscordApiError(0, `Network error: ${message}`);
    }

    if (response.status !== 429) return response;

    // Live 429: wait the shared backoff, then a single fresh acquire + retry
    // (no loop - a second sustained cooldown just passes the original 429
    // through). A Retry-After longer than the cap passes the original 429
    // straight through too, rather than stalling the request for minutes.
    const retryDelay = retryDelayMs(outcome);
    if (retryDelay > MAX_429_RETRY_WAIT_MS) return response;

    await wait(retryDelay);
    const retry = await pool.acquire('default', routeKey, guildId);
    if (!retry.ok) return response;

    let retryReleased = false;
    try {
      const retryResponse = await fetcher(url, {
        method: 'GET',
        headers: await buildHeaders(retry, versions),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const retryOutcome = await inspectResponse(retryResponse, routeKey, guildId);
      await pool.release(retry.label, retry.requestId, retryOutcome);
      retryReleased = true;
      return retryResponse;
    } catch (err: unknown) {
      if (!retryReleased) {
        await pool.release(retry.label, retry.requestId, { status: 599, routeKey }).catch((cleanupErr: unknown) => {
          console.error('bingo discord-client retry release cleanup failed:', cleanupErr);
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new DiscordApiError(0, `Network error on retry: ${message}`);
    }
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
