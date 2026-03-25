/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module types
 * Shared type definitions for the discord-api-proxy worker.
 */

/**
 * Cloudflare Worker environment bindings.
 * These are configured in `wrangler.toml` and injected at runtime.
 */
export type Bindings = {
  /** Discord bot token (prefixed with `Bot ` when used in Authorization header). */
  DISCORD_TOKEN_BOT: string;
  /** Discord user token for endpoints that require user-level authentication (e.g. guild fetches). */
  DISCORD_TOKEN_USER: string;
  /** Secret key used to authenticate incoming requests to this proxy via `x-auth-key` or `Authorization`. */
  AUTH_KEY: string;
};

/**
 * Discord user object as returned by various Discord API endpoints.
 * Shape varies depending on the endpoint — guild member fetches nest the user
 * object and include guild-specific fields like `roles` and `nick`.
 */
export interface DiscordUser {
  id: string;
  username: string;
  /** Display name (may differ from username). */
  global_name?: string;
  avatar?: string;
  /** Guild roles — only present when fetched via guild member endpoints. */
  roles?: string[];
  /** Nested user object — present in guild member fetch responses. */
  user?: {
    id: string;
    username: string;
    global_name?: string;
    avatar?: string;
  };
  /** Guild-specific nickname, if set. */
  nick?: string;
}
