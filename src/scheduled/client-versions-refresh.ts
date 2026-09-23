/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module scheduled/client-versions-refresh
 * Scheduled handler: scrape both the Discord web `build_number` and the
 * current Chrome stable major, and persist each independently to the
 * token-pool DO's meta keys.
 *
 * Runs daily at 04:00 UTC (see `triggers.crons` in `wrangler.jsonc`). Also
 * invokable synchronously via `POST /admin/client-versions/refresh`.
 *
 * Build-number strategy:
 *   1. GET https://discord.com/login (cheap HTML page).
 *   2. Match `"BUILD_NUMBER":"(\d+)"` against `window.GLOBAL_ENV` (live shape
 *      as of 2026-09-21).
 *   3. Fall back to the older entry-bundle scrape (match the `/assets/web.*.js`
 *      URL, fetch it, match `build_number:"(\d+)"`) when the regex misses -
 *      the GLOBAL_ENV shape is Discord's own undocumented internal format and
 *      has drifted before.
 *
 * Chrome-major strategy: GET the Chrome version-history API for the current
 * Windows stable release and take the major component of `versions[0].version`.
 *
 * The two scrapes are fully independent: one failing never blocks or corrupts
 * the other's persisted record. Every failure is swallowed (logged, not
 * rethrown) - a broken scraper must NEVER write a bogus value that bricks
 * every user-token request. An untouched meta key just means `selectBuildNumber`
 * / `selectChromeMajor` fall back to the fallback constant once the relevant
 * staleness ceiling is crossed.
 */

import type { BuildNumberRecord, ChromeVersionRecord, ClientVersionRecords } from '../fingerprint/versions';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import type { TokenPoolDO } from '../rotator/do';
import type { Bindings } from '../types';

const CHROME_VERSION_HISTORY_URL = 'https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions?pageSize=1';
const USER_AGENT = 'discord-api-proxy/client-versions-refresh';

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Scrape and persist both version records. Each field is `null` when its own
 * scrape or persist failed (a record is only reported as refreshed once its
 * write actually landed); the caller decides whether that (or a total failure)
 * should surface as a 502.
 */
export async function refreshClientVersions(env: Bindings): Promise<ClientVersionRecords> {
  const stub = getPoolStub(env) as unknown as DurableObjectStub<TokenPoolDO>;
  const client = createTokenPoolClient(stub);
  void client; // unused; we call the DO RPCs directly because the wrapper omits the setter methods

  const [buildNumber, chromeMajor] = await Promise.all([scrapeBuildNumber(), scrapeChromeMajor()]);

  // Persist each record independently: the two are separate DO storage writes,
  // so a rejected write for one must not skip the other. A write failure is
  // logged and leaves only that field `null` rather than throwing the whole
  // refresh.
  let build: BuildNumberRecord | null = null;
  if (buildNumber !== null) {
    const record: BuildNumberRecord = { buildNumber, fetchedAt: Date.now(), source: 'scraped' };
    try {
      await stub.setBuildNumberRecord(record);
      build = record;
    } catch (err: unknown) {
      console.error('[client-versions] build_number persist failed:', err);
    }
  }

  let chrome: ChromeVersionRecord | null = null;
  if (chromeMajor !== null) {
    const record: ChromeVersionRecord = { major: chromeMajor, fetchedAt: Date.now(), source: 'scraped' };
    try {
      await stub.setChromeVersionRecord(record);
      chrome = record;
    } catch (err: unknown) {
      console.error('[client-versions] chrome major persist failed:', err);
    }
  }

  return { build, chrome };
}

/** Hono-shaped scheduled handler. */
export async function scheduledClientVersionsHandler(env: Bindings): Promise<void> {
  try {
    const { build, chrome } = await refreshClientVersions(env);
    if (build) {
      console.log(`[client-versions] build_number refreshed: ${build.buildNumber}`);
    } else {
      console.error('[client-versions] build_number scrape failed; DO meta untouched');
    }
    if (chrome) {
      console.log(`[client-versions] chrome major refreshed: ${chrome.major}`);
    } else {
      console.error('[client-versions] chrome major scrape failed; DO meta untouched');
    }
  } catch (err: unknown) {
    console.error('[client-versions] scheduled handler errored:', err);
  }
}

/**
 * Fetch and parse the Discord web build number. Tries the live
 * `window.GLOBAL_ENV` shape first, falls back to the entry-bundle scrape.
 * No exception escapes this function.
 */
async function scrapeBuildNumber(): Promise<number | null> {
  let html: string;
  try {
    const res = await fetch('https://discord.com/login', {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[client-versions] /login fetch returned ${res.status}`);
      return null;
    }
    html = await res.text();
  } catch (err: unknown) {
    console.error('[client-versions] /login fetch threw:', err);
    return null;
  }

  const globalEnvMatch = html.match(/"BUILD_NUMBER":"(\d+)"/);
  if (globalEnvMatch) {
    const n = parseInt(globalEnvMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // Discord hard rule: >= 1s between any two REST calls to a Discord host,
  // even a plain GET scrape - the fallback fetch below hits
  // discord.com/assets/*, the same host as the /login request above.
  await wait(1000);
  return await scrapeBuildNumberFromBundle(html);
}

/** Older fallback scrape: find the entry JS bundle and match `build_number:"(\d+)"` inside it. */
async function scrapeBuildNumberFromBundle(loginHtml: string): Promise<number | null> {
  const bundleMatch = loginHtml.match(/\/assets\/web\.[a-f0-9]+\.js/);
  if (!bundleMatch) {
    console.error('[client-versions] no BUILD_NUMBER and no entry bundle URL found in /login HTML');
    return null;
  }
  const bundleUrl = `https://discord.com${bundleMatch[0]}`;

  let bundle: string;
  try {
    const res = await fetch(bundleUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`[client-versions] bundle fetch returned ${res.status}`);
      return null;
    }
    bundle = await res.text();
  } catch (err: unknown) {
    console.error('[client-versions] bundle fetch threw:', err);
    return null;
  }

  const buildMatch = bundle.match(/build_number:"(\d+)"/);
  if (!buildMatch) {
    console.error('[client-versions] no build_number reference in bundle');
    return null;
  }
  const n = parseInt(buildMatch[1], 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error('[client-versions] parsed build_number is not a positive integer:', buildMatch[1]);
    return null;
  }
  return n;
}

/** Fetch and parse the current Chrome stable major for Windows. No exception escapes this function. */
async function scrapeChromeMajor(): Promise<number | null> {
  let json: unknown;
  try {
    const res = await fetch(CHROME_VERSION_HISTORY_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      console.error(`[client-versions] version-history fetch returned ${res.status}`);
      return null;
    }
    json = await res.json();
  } catch (err: unknown) {
    console.error('[client-versions] version-history fetch threw:', err);
    return null;
  }

  const versionString = extractFirstVersionString(json);
  if (typeof versionString !== 'string') {
    console.error('[client-versions] version-history response missing versions[0].version');
    return null;
  }
  const major = parseInt(versionString.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < 100 || major > 999) {
    console.error('[client-versions] parsed Chrome major out of plausible range:', versionString);
    return null;
  }
  return major;
}

/** Narrow the Chrome version-history JSON response to `versions[0].version` without an unchecked cast. */
function extractFirstVersionString(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null || !('versions' in json)) return undefined;
  const versions = json.versions;
  if (!Array.isArray(versions) || versions.length === 0) return undefined;
  const first: unknown = versions[0];
  if (typeof first !== 'object' || first === null || !('version' in first)) return undefined;
  const version = first.version;
  return typeof version === 'string' ? version : undefined;
}
