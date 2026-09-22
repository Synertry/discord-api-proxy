/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/discord-client
 * Typed wrapper around the shared cursor-paginated Discord message fetcher
 * (`custom/shared/paged-messages`) - pacing, lease-at-point-of-use guarding,
 * and 429/block retry all live there now, shared with hear-me-out.
 */

import { fetchAllMessages as fetchAllMessagesShared, DiscordApiError, IdentityBlockedError } from '../../../shared/paged-messages';
import type { PagerOptions } from '../../../shared/paged-messages';
import type { DiscordMessage } from './types';

/** Maximum messages per Discord API request. */
const PAGE_LIMIT = 100;

/** Safety cap to prevent unbounded pagination on very large channels. */
const MAX_MESSAGES = 5000;

export { DiscordApiError, IdentityBlockedError };

/**
 * Fetches all messages from a Discord channel using cursor-based pagination.
 * Messages are returned in Discord's default order (newest first).
 */
export function fetchAllMessages(opts: Omit<PagerOptions, 'maxMessages' | 'pageLimit'>): Promise<readonly DiscordMessage[]> {
  return fetchAllMessagesShared<DiscordMessage>({ ...opts, maxMessages: MAX_MESSAGES, pageLimit: PAGE_LIMIT });
}
