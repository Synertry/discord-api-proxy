/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/static-guard
 * Thin per-request wrapper around `TokenPoolClient.leaseStatic`/`settleStatic`,
 * closed over the identity's pre-computed hash (`identityHash`, see
 * `token-hash.ts`) so callers (`proxy.ts`, the shared paged-messages pager)
 * never handle the raw token when leasing budget - and never pass `kind`
 * either, since the guard is never kind-keyed (see `types.ts`'s module
 * doc). Also the shared 429/block response envelope for both the identity
 * middleware's early circuit short-circuit and every point-of-use lease
 * rejection.
 */

import type { Context } from 'hono';
import type { IdentityBlock, ReleaseInput, RouteKey, TokenPoolClient } from './types';

/** Per-request lease/settle pair, closed over the identity's pre-computed hash. */
export interface StaticGuard {
  lease(routeKey: RouteKey): Promise<{ ok: true; requestId: string } | { ok: false; block: IdentityBlock }>;
  settle(requestId: string, outcome: ReleaseInput): Promise<void>;
}

/** Thrown when a point-of-use lease is rejected; callers map it to `blockResponse`. */
export class IdentityBlockedError extends Error {
  constructor(public readonly block: IdentityBlock) {
    super(`identity blocked: ${block.reason}${block.signal ? ` (${block.signal})` : ''}`);
    this.name = 'IdentityBlockedError';
  }
}

/**
 * Build a `StaticGuard` for one static identity, or `undefined` when the
 * client doesn't implement the guard RPCs (e.g. a test mock exercising only
 * the pool path, or - in production - an unexpected client shape). A missing
 * guard means the static path runs unguarded, never that it errors: the
 * static token path stays first-class with zero DO binding.
 */
export function createStaticGuard(client: TokenPoolClient, identityHash: string): StaticGuard | undefined {
  if (!client.leaseStatic || !client.settleStatic) return undefined;
  const leaseStatic = client.leaseStatic;
  const settleStatic = client.settleStatic;
  return {
    lease: (routeKey) => leaseStatic(identityHash, routeKey),
    settle: (requestId, outcome) => settleStatic(identityHash, requestId, outcome),
  };
}

/** 429 envelope for a pre-emptive guard block (circuit, cooldown, or capacity) - never a genuine Discord response. */
export function blockResponse(c: Context, block: IdentityBlock): Response {
  const retryAfterSeconds = Math.ceil(block.retryAfter / 1000);
  return c.json({ error: 'Too Many Requests', retryAfter: retryAfterSeconds }, 429, {
    'Retry-After': String(retryAfterSeconds),
    'X-Proxy-Block': block.signal ?? (block.reason === 'capacity' ? 'capacity' : 'bucket'),
  });
}
