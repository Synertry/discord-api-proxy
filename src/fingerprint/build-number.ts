/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/build-number
 * Cache-and-fallback helpers for the Discord client `build_number`.
 *
 * Live state is kept under `meta:discord-build-number` in the Durable Object.
 * The scheduled scraper (see `src/scheduled/build-number-refresh.ts`) writes
 * the value daily; this module exposes a pure `selectBuildNumber` that callers
 * use to decide whether the cached value is fresh enough to trust.
 *
 * The top half of this file (constants + pure functions) is runtime-agnostic.
 * The bottom half (`readBuildNumberFromDO`) is the Cloudflare-specific glue
 * and is isolated so the pure layer can be reused from any TypeScript runtime.
 */

/**
 * Storage key for the live build-number record inside `TokenPoolDO`.
 */
export const BUILD_NUMBER_META_KEY = 'meta:discord-build-number';

/**
 * Verified Discord web build number as of 2026-05-15. Source: scraped from
 * `https://discord.com/assets/web.d617eeb1fc2b0f34.js` (`build_number:"544143"`)
 * which is the entry chunk linked from `https://discord.com/login`.
 *
 * Update this constant when the scraper has been broken for so long that the
 * fallback path becomes the dominant code path - i.e. only as a safety net.
 * The scheduled scraper writes to the DO meta key within the first 24h after
 * deploy, so this constant is normally never read in production.
 */
export const FALLBACK_BUILD_NUMBER = 544143;

/**
 * 7-day staleness ceiling. If the scraper has not written a fresh value in
 * a full week, fall back to the constant rather than send a six-month-old
 * value that Discord may have rotated bot-detection signatures around.
 */
export const STALENESS_CEILING_MS = 7 * 24 * 60 * 60 * 1000;

export type BuildNumberSource = 'scraped' | 'manual' | 'fallback';

export interface BuildNumberRecord {
	buildNumber: number;
	/** Epoch ms when this record was written. */
	fetchedAt: number;
	source: BuildNumberSource;
}

/**
 * Pure selection function. Returns the stored `buildNumber` when the record
 * exists AND is fresher than `STALENESS_CEILING_MS`; otherwise returns
 * `FALLBACK_BUILD_NUMBER`.
 *
 * Workers-agnostic. No `Date.now()` call here so tests can pass a fixed `now`.
 */
export function selectBuildNumber(stored: BuildNumberRecord | null, now: number): number {
	if (!stored) return FALLBACK_BUILD_NUMBER;
	if (now - stored.fetchedAt > STALENESS_CEILING_MS) return FALLBACK_BUILD_NUMBER;
	if (!Number.isFinite(stored.buildNumber) || stored.buildNumber <= 0) return FALLBACK_BUILD_NUMBER;
	return stored.buildNumber;
}

// ===========================================================================
// Below this line: Cloudflare-specific glue. Do NOT add framework imports
// above this line so the pure layer stays runtime-agnostic.
// ===========================================================================

import type { TokenPoolDO } from '../rotator/do';

/**
 * Read the current build-number record from the DO. Returns null when unset.
 * Memoizes via Hono context elsewhere (one read per request).
 */
export async function readBuildNumberFromDO(
	stub: DurableObjectStub<TokenPoolDO>,
): Promise<BuildNumberRecord | null> {
	const record = await stub.getBuildNumberRecord();
	return record ?? null;
}
