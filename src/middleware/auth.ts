/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/auth
 * Authentication middleware for the discord-api-proxy.
 *
 * Validates incoming requests against a shared secret (`AUTH_KEY` binding).
 * Accepts the key via either the `x-auth-key` custom header or the standard
 * `Authorization` header (with optional `Bearer ` prefix).
 */

import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';

/**
 * Compares two strings in constant time to prevent timing-based attacks.
 *
 * Uses the Web Crypto API's `timingSafeEqual` (available in Cloudflare Workers)
 * so that an attacker cannot measure response time differences to determine
 * correct key prefix characters byte-by-byte.
 *
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @returns `true` if the strings are identical, `false` otherwise.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) {
    // Perform a dummy comparison against itself so that the function's execution
    // time stays roughly constant regardless of whether lengths match. Without
    // this, an attacker could probe key length by measuring the early return.
    crypto.subtle.timingSafeEqual(aBytes, aBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

/** Which configured auth key the incoming request matched. */
export type AuthSlot = 'default' | 'premium';

/**
 * Context variables set by this middleware and consumed by downstream handlers.
 *
 * `authSlot` is typed optional so downstream middleware that runs without
 * {@link authMiddleware} first (e.g. isolated tests) sees the correct
 * `undefined` state instead of a false `AuthSlot` guarantee.
 */
export type AuthVariables = {
  authSlot?: AuthSlot;
};

/**
 * Rejects requests that do not provide a valid API key.
 *
 * Checks two header sources (in order):
 * 1. `x-auth-key` - custom header for direct key authentication
 * 2. `Authorization` - standard header, with `Bearer ` prefix stripped if present
 *
 * Compares against both `AUTH_KEY` (default) and `AUTH_KEY_PREMIUM` (optional)
 * using constant-time comparison. The matched slot is recorded on the request
 * context so downstream middleware (e.g. `discordContextMiddleware`) can route
 * to the paired Discord token.
 *
 * Returns 401 with `{ error: 'Unauthorized' }` if the key is missing or invalid.
 */
export const authMiddleware = createMiddleware<{ Bindings: Bindings; Variables: AuthVariables }>(async (c, next) => {
  if (!c.env.AUTH_KEY) {
    console.error('FATAL: AUTH_KEY binding is not configured');
    return c.json({ error: 'Service misconfigured' }, 503);
  }

  const provided = c.req.header('x-auth-key') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '');

  if (!provided) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Always run both comparisons through `timingSafeEqual` so response time does
  // not leak (a) which slot the attacker's guess resembled, or (b) whether the
  // premium slot is configured at all. When AUTH_KEY_PREMIUM is absent we fall
  // back to comparing against AUTH_KEY as a constant-length dummy, then discard
  // the result via the `premiumConfigured` guard.
  const premiumConfigured = Boolean(c.env.AUTH_KEY_PREMIUM);
  const matchedDefault = timingSafeEqual(provided, c.env.AUTH_KEY);
  const matchedPremium = timingSafeEqual(provided, c.env.AUTH_KEY_PREMIUM ?? c.env.AUTH_KEY);

  if (matchedDefault) {
    c.set('authSlot', 'default');
  } else if (premiumConfigured && matchedPremium) {
    c.set('authSlot', 'premium');
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});
