/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/discord-context
 * Selects the appropriate Discord authentication context for each request.
 *
 * Determines whether to use the **bot token** or **user token** based on:
 * 1. Explicit `x-proxy-context` header (`'user'` or `'bot'`)
 * 2. Path heuristic: requests targeting `/guilds` default to user token
 *
 * When user token is selected, a browser-like `User-Agent` is also set to
 * avoid Discord's bot-detection on user-authenticated endpoints.
 */

import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';

/** Browser-like User-Agent sent with user-token requests to avoid bot detection. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Context variables set by this middleware and consumed by downstream handlers. */
export type DiscordContextVariables = {
  /** The selected Discord authorization header value (e.g. `"Bot <token>"` or raw user token). */
  discordToken: string;
  /** Browser User-Agent string, set only when using the user token. */
  discordUserAgent?: string;
  /** Optional fetch override injected during testing. */
  proxyFetch?: typeof fetch;
};

/**
 * Sets {@link DiscordContextVariables} on the request context for downstream handlers.
 *
 * Token selection priority:
 * 1. `x-proxy-context: user` → user token + browser User-Agent
 * 2. `x-proxy-context: bot` → bot token (no custom User-Agent)
 * 3. No header, path contains `/guilds` → user token (fallback heuristic)
 * 4. No header, other paths → bot token
 */
export const discordContextMiddleware = createMiddleware<{ Bindings: Bindings; Variables: DiscordContextVariables }>(async (c, next) => {
  const path = c.req.path;
  const proxyContext = (c.req.header('x-proxy-context') || '').toLowerCase();

  let useUserToken = false;

  if (proxyContext === 'user') {
    useUserToken = true;
  } else if (proxyContext === 'bot') {
    useUserToken = false;
  } else {
    // Fallback: guild endpoints typically require user authentication
    useUserToken = path.includes('/guilds');
  }

  if (useUserToken) {
    c.set('discordToken', c.env.DISCORD_TOKEN_USER);
    c.set('discordUserAgent', BROWSER_USER_AGENT);
  } else {
    c.set('discordToken', `Bot ${c.env.DISCORD_TOKEN_BOT}`);
    c.set('discordUserAgent', undefined);
  }

  await next();
});
