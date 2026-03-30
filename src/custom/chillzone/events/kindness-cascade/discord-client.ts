/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/discord-client
 * Paginated Discord API client for fetching all messages in a channel.
 *
 * Uses cursor-based pagination via the `before` query parameter, fetching
 * in batches of {@link PAGE_LIMIT} (100, Discord's maximum per request).
 * Stops at {@link MAX_MESSAGES} (5 000) to prevent unbounded requests on
 * very large channels.
 */

import type { DiscordMessage } from './types';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Maximum messages per Discord API request. */
const PAGE_LIMIT = 100;

/** Safety cap to prevent unbounded pagination on large channels. */
const MAX_MESSAGES = 5000;

/**
 * Error thrown when the Discord API returns a non-2xx response.
 * Carries the HTTP status code for upstream error handling (e.g. 403 → "Cannot access channel").
 */
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
 * Fetches all messages from a Discord channel using cursor-based pagination.
 *
 * Messages are returned in Discord's default order (newest first). The function
 * accepts a `fetchFn` parameter to support Cloudflare Workers' bound fetch and
 * test mocking.
 *
 * @param channelId - The Discord channel to fetch messages from.
 * @param token     - Authorization header value (e.g. `"Bot <token>"` or user token).
 * @param fetchFn   - Fetch implementation (allows injection for Workers proxy and tests).
 * @returns All messages up to {@link MAX_MESSAGES}, in newest-first order.
 * @throws {DiscordApiError} If any paginated request returns a non-2xx status.
 */
export async function fetchAllMessages(channelId: string, token: string, fetchFn: typeof fetch): Promise<readonly DiscordMessage[]> {
  const allMessages: DiscordMessage[] = [];
  let cursor: string | undefined;

  // Authorization header is identical for every page — construct once
  const headers = new Headers({ Authorization: token });

  while (allMessages.length < MAX_MESSAGES) {
    let url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${PAGE_LIMIT}`;
    if (cursor) {
      url += `&before=${cursor}`;
    }

    const response = await fetchFn(url, { method: 'GET', headers });

    if (!response.ok) {
      const body = await response.text();
      throw new DiscordApiError(response.status, body);
    }

    const json = await response.json();
    if (!Array.isArray(json)) {
      throw new DiscordApiError(response.status, 'Unexpected response format');
    }
    const batch = json as DiscordMessage[];

    if (batch.length === 0) break;

    allMessages.push(...batch);

    // Incomplete batch means we've reached the oldest message
    if (batch.length < PAGE_LIMIT) break;

    // Use the oldest message in this batch as the cursor for the next page
    cursor = batch[batch.length - 1].id;
  }

  return allMessages;
}
