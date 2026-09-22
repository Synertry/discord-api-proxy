/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module scheduled/build-number-refresh
 * Scheduled handler: scrape Discord's current web `build_number` and persist
 * it to the token-pool DO meta key.
 *
 * Runs daily at 04:00 UTC (see `triggers.crons` in `wrangler.jsonc`). Also
 * invokable synchronously via `POST /admin/build-number/refresh`.
 *
 * Strategy:
 *   1. GET https://discord.com/login (cheap HTML page).
 *   2. Extract the entry-chunk URL matching `/assets/web.[a-f0-9]+.js`.
 *   3. Fetch that JS bundle.
 *   4. Match `build_number:"(\d+)"` and parse.
 *
 * Failure is swallowed (logged, but not rethrown): a broken scraper must NEVER
 * write a bogus value that bricks every user-token request. The DO meta key
 * is left untouched and `selectBuildNumber` will fall back to the constant
 * once the staleness ceiling is crossed.
 */

import type { BuildNumberRecord } from '../fingerprint/build-number';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import type { TokenPoolDO } from '../rotator/do';
import type { Bindings } from '../types';

/**
 * Scrape and persist. Returns the new record on success, or null when the
 * scrape failed (caller decides whether to surface 502 or just log).
 */
export async function refreshBuildNumber(env: Bindings): Promise<BuildNumberRecord | null> {
	const scraped = await scrapeBuildNumber();
	if (scraped == null) return null;

	const record: BuildNumberRecord = {
		buildNumber: scraped,
		fetchedAt: Date.now(),
		source: 'scraped',
	};

	const stub = getPoolStub(env) as unknown as DurableObjectStub<TokenPoolDO>;
	const client = createTokenPoolClient(stub);
	void client; // unused; we call the DO RPC directly because the wrapper omits setBuildNumberRecord
	await stub.setBuildNumberRecord(record);
	return record;
}

/** Hono-shaped scheduled handler. */
export async function scheduledBuildNumberHandler(env: Bindings): Promise<void> {
	try {
		const record = await refreshBuildNumber(env);
		if (record) {
			console.log(`[build-number] refreshed: ${record.buildNumber} (source=${record.source})`);
		} else {
			console.error('[build-number] scrape failed; DO meta untouched');
		}
	} catch (err: unknown) {
		console.error('[build-number] scheduled handler errored:', err);
	}
}

/**
 * Fetch and parse. Returns the parsed build number, or null on any failure.
 * No exception escapes this function.
 */
async function scrapeBuildNumber(): Promise<number | null> {
	let html: string;
	try {
		const res = await fetch('https://discord.com/login', {
			headers: { 'User-Agent': 'discord-api-proxy/build-number-refresh' },
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			console.error(`[build-number] /login fetch returned ${res.status}`);
			return null;
		}
		html = await res.text();
	} catch (err: unknown) {
		console.error('[build-number] /login fetch threw:', err);
		return null;
	}

	const bundleMatch = html.match(/\/assets\/web\.[a-f0-9]+\.js/);
	if (!bundleMatch) {
		console.error('[build-number] no entry bundle URL found in /login HTML');
		return null;
	}
	const bundleUrl = `https://discord.com${bundleMatch[0]}`;

	let bundle: string;
	try {
		const res = await fetch(bundleUrl, {
			headers: { 'User-Agent': 'discord-api-proxy/build-number-refresh' },
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) {
			console.error(`[build-number] bundle fetch returned ${res.status}`);
			return null;
		}
		bundle = await res.text();
	} catch (err: unknown) {
		console.error('[build-number] bundle fetch threw:', err);
		return null;
	}

	const buildMatch = bundle.match(/build_number:"(\d+)"/);
	if (!buildMatch) {
		console.error('[build-number] no build_number reference in bundle');
		return null;
	}
	const n = parseInt(buildMatch[1], 10);
	if (!Number.isFinite(n) || n <= 0) {
		console.error('[build-number] parsed build_number is not a positive integer:', buildMatch[1]);
		return null;
	}
	return n;
}
