/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/release-input
 * Parses a Discord Response into the ReleaseInput payload consumed by the
 * Durable Object's `release` RPC method.
 *
 * Relevant Discord rate-limit response headers (per docs/Topics/Rate Limits):
 *   X-RateLimit-Bucket        opaque bucket hash
 *   X-RateLimit-Limit         requests in this bucket window
 *   X-RateLimit-Remaining     requests remaining in this window
 *   X-RateLimit-Reset         absolute epoch seconds when the bucket resets
 *   X-RateLimit-Reset-After   seconds until reset (preferred; clock-skew safe)
 *   X-RateLimit-Global        true on global rate-limit
 *   X-RateLimit-Scope         "user" | "global" | "shared"
 *   Retry-After               on 429 only, seconds (may be fractional)
 *
 * Body for 429 may include a JSON `{ message, retry_after, global, code? }`.
 */

import type { ReleaseInput, RouteKey } from './types';

/**
 * Build a ReleaseInput from a Discord Response without consuming the body.
 * The body remains available to the caller (the proxy returns it to the consumer).
 *
 * `routeKey` is supplied by the caller because the Response object alone doesn't
 * carry the request method.
 */
export function extractReleaseInput(response: Response, routeKey: RouteKey, guildId?: string): ReleaseInput {
  const headers = response.headers;
  const bucket = headers.get('X-RateLimit-Bucket') ?? undefined;
  const remainingStr = headers.get('X-RateLimit-Remaining');
  const resetAfterStr = headers.get('X-RateLimit-Reset-After');
  const retryAfterStr = headers.get('Retry-After');

  const remaining = remainingStr !== null ? parseInt(remainingStr, 10) : undefined;
  const resetAfterSec = resetAfterStr !== null ? parseFloat(resetAfterStr) : undefined;
  const retryAfterSec = retryAfterStr !== null ? parseFloat(retryAfterStr) : undefined;

  return {
    status: response.status,
    routeKey,
    discordBucketHash: bucket,
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    resetAfterMs: Number.isFinite(resetAfterSec) ? Math.round(resetAfterSec! * 1000) : undefined,
    retryAfterMs: Number.isFinite(retryAfterSec) ? Math.round(retryAfterSec! * 1000) : undefined,
    guildId,
  };
}

/** Validate an RPC outcome before a lease-free upstream report can mutate shared state. */
export function isReleaseInput(value: unknown): value is ReleaseInput {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Partial<ReleaseInput>;
  return (
    Number.isInteger(input.status) &&
    input.status! >= 100 &&
    input.status! <= 599 &&
    typeof input.routeKey === 'string' &&
    input.routeKey.length > 0 &&
    (input.signal === undefined || input.signal === 'captcha' || input.signal === 'cloudflare') &&
    (input.discordBucketHash === undefined || typeof input.discordBucketHash === 'string') &&
    (input.guildId === undefined || typeof input.guildId === 'string') &&
    optionalNonnegativeNumber(input.remaining) &&
    optionalNonnegativeNumber(input.resetAfterMs) &&
    optionalNonnegativeNumber(input.retryAfterMs) &&
    (input.code === undefined || (Number.isInteger(input.code) && input.code >= 0))
  );
}

function optionalNonnegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
