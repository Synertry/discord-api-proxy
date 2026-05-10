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

/**
 * Async variant for paths that want to parse a 50001 from the response body
 * to populate `code` (so the DO can mark the token ineligible for the guild).
 *
 * Caller responsibility: only invoke when status is 403 and you're willing to
 * consume the body (clones the response first to keep the original readable).
 */
export async function extractReleaseInputWithBody(
	response: Response,
	routeKey: RouteKey,
	guildId?: string,
): Promise<ReleaseInput> {
	const base = extractReleaseInput(response, routeKey, guildId);
	if (response.status !== 403) return base;

	try {
		const clone = response.clone();
		const text = await clone.text();
		if (text.length === 0) return base;
		const body = JSON.parse(text) as { code?: number };
		if (typeof body?.code === 'number') {
			return { ...base, code: body.code };
		}
	} catch (err: unknown) {
		// Body parse failed - surface the base ReleaseInput, drop the code.
		// Logging would leak the body; keep silent at this layer.
		void err;
	}
	return base;
}
