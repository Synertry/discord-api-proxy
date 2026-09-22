/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module custom/shared/paged-messages
 * Shared cursor-paginated Discord message fetcher for the in-worker custom
 * routes (kindness-cascade, hear-me-out) that read an entire channel's
 * history. Replaces each route's own near-identical pager with one
 * implementation that additionally:
 *
 * - Leases the identity's static guard immediately before each page's fetch
 *   and settles it immediately after (same lease-at-point-of-use discipline
 *   as proxy.ts), enforcing `minGapMs` pacing between pages regardless of
 *   Discord's own bucket state - the Discord hard rule's "never send
 *   back-to-back requests" floor applies to a 50-page channel dump exactly
 *   as much as to a single proxied call.
 * - Retries a live 429 with the shared `retryDelayMs` backoff, matching
 *   every other 429 retry path in this codebase.
 * - Surfaces a guard block as `IdentityBlockedError` (re-exported from
 *   `rotator/static-guard`) after one short wait-and-retry, rather than
 *   failing the whole fetch on the first pre-emptive block.
 *
 * Headers are composed ONCE by the caller (via `composeRequestHeaders`) and
 * passed in - unlike the fingerprint, `Authorization` never changes between
 * pages of the same channel dump, so there is no need to recompose per page.
 */

import { retryDelayMs } from '../../rotator/budget';
import { inspectResponse } from '../../rotator/signals';
import { IdentityBlockedError } from '../../rotator/static-guard';
import type { StaticGuard } from '../../rotator/static-guard';
import type { RouteKey } from '../../rotator/types';

export { IdentityBlockedError } from '../../rotator/static-guard';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MESSAGES_ROUTE: RouteKey = 'GET:/channels/:id/messages';
const DEFAULT_MIN_GAP_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Cap on retrying a guard block by waiting it out - a longer block (a captcha circuit, for instance) should fail fast instead of stalling the whole channel dump. */
const MAX_BLOCK_WAIT_MS = 5000;
/** Cap on retrying a live Discord 429 for one page before giving up. */
const MAX_429_RETRIES = 3;

const defaultWait = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Minimal shape every paged message type must satisfy. */
export interface PagedMessage {
  id: string;
}

export interface PagerOptions {
  channelId: string;
  headers: Headers;
  fetcher: typeof fetch;
  guard?: StaticGuard;
  maxMessages: number;
  pageLimit: number;
  minGapMs?: number;
  timeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}

/** Error thrown when the Discord API returns a non-2xx response for a page. Carries the HTTP status code for upstream error handling. */
export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Discord API error: ${status}`);
    this.name = 'DiscordApiError';
  }
}

/**
 * Fetch all messages from a Discord channel using cursor-based pagination,
 * paced and guarded per the module doc above. Messages are returned in
 * Discord's default order (newest first).
 */
export async function fetchAllMessages<T extends PagedMessage>(opts: PagerOptions): Promise<readonly T[]> {
  const minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wait = opts.wait ?? defaultWait;

  const allMessages: T[] = [];
  let cursor: string | undefined;
  let lastPageStartedAt: number | undefined;

  while (allMessages.length < opts.maxMessages) {
    if (lastPageStartedAt !== undefined) {
      const elapsed = Date.now() - lastPageStartedAt;
      if (elapsed < minGapMs) await wait(minGapMs - elapsed);
    }
    lastPageStartedAt = Date.now();

    const url = buildPageUrl(opts.channelId, opts.pageLimit, cursor);
    const batch = await fetchOnePage<T>(url, opts, wait);

    if (batch.length === 0) break;
    const remaining = opts.maxMessages - allMessages.length;
    allMessages.push(...(batch.length > remaining ? batch.slice(0, remaining) : batch));
    if (allMessages.length >= opts.maxMessages) break; // Cap reached - no further page needed, so a malformed last-id in this batch is moot.

    // Incomplete batch means we've reached the oldest message.
    if (batch.length < opts.pageLimit) break;

    const lastId = batch[batch.length - 1]?.id;
    if (typeof lastId !== 'string') {
      throw new DiscordApiError(0, 'Malformed pagination: last message missing id');
    }
    cursor = lastId;
  }

  return allMessages;
}

function buildPageUrl(channelId: string, pageLimit: number, cursor: string | undefined): string {
  let url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${pageLimit}`;
  if (cursor) url += `&before=${cursor}`;
  return url;
}

/** Fetch and parse one page, leasing the guard immediately before and settling immediately after, with 429 and guard-block retry. */
async function fetchOnePage<T extends PagedMessage>(url: string, opts: PagerOptions, wait: (ms: number) => Promise<void>): Promise<T[]> {
  for (let attempt429 = 0; attempt429 <= MAX_429_RETRIES; attempt429++) {
    const lease = await leaseWithOneRetry(opts.guard, wait);

    let response: Response;
    try {
      response = await opts.fetcher(url, {
        method: 'GET',
        headers: opts.headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (lease) await opts.guard?.settle(lease.requestId, { status: 599, routeKey: MESSAGES_ROUTE }).catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      throw new DiscordApiError(0, `Network error: ${message}`);
    }

    const outcome = await inspectResponse(response, MESSAGES_ROUTE);
    if (lease) {
      await opts.guard?.settle(lease.requestId, outcome);
    }

    if (response.status === 429 && attempt429 < MAX_429_RETRIES) {
      await wait(retryDelayMs(outcome));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new DiscordApiError(response.status, body);
    }

    const json = await response.json();
    if (!Array.isArray(json)) {
      throw new DiscordApiError(response.status, 'Unexpected response format');
    }
    return json as T[];
  }

  throw new DiscordApiError(429, 'exhausted 429 retries');
}

/** Lease the guard, waiting out one short block (<= MAX_BLOCK_WAIT_MS) and retrying once; a longer or repeated block throws. Returns undefined when there is no guard at all (static path stays first-class with zero DO binding). */
async function leaseWithOneRetry(
  guard: StaticGuard | undefined,
  wait: (ms: number) => Promise<void>,
): Promise<{ requestId: string } | undefined> {
  if (!guard) return undefined;

  const first = await guard.lease(MESSAGES_ROUTE);
  if (first.ok) return first;
  if (first.block.retryAfter > MAX_BLOCK_WAIT_MS) throw new IdentityBlockedError(first.block);

  await wait(first.block.retryAfter);
  const second = await guard.lease(MESSAGES_ROUTE);
  if (!second.ok) throw new IdentityBlockedError(second.block);
  return second;
}
