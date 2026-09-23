/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/token-hash
 * Computes the SHA-256 hex digest of a static Discord token, used as the
 * static-identity guard's storage key (see `types.ts`'s module doc for why:
 * `DISCORD_TOKEN_USER` and `DISCORD_TOKEN_USER_PREMIUM` may be the same
 * underlying token, so kind alone is not a safe budget/circuit key).
 *
 * Computed in the Worker; only the hash crosses the DO RPC boundary, never
 * the raw token. Runtime-agnostic: `crypto.subtle` is a global in both
 * Workers and Node 19+.
 */

/** Full 64-character lowercase hex SHA-256 digest of the given token. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
