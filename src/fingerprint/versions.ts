/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/versions
 * Cache-and-fallback helpers for the two version numbers a realistic client
 * fingerprint depends on: Discord's own `client_build_number` and the
 * Chromium stable major the client's `User-Agent` / `Sec-CH-UA` claim.
 *
 * Live state is kept under `meta:discord-build-number` and
 * `meta:chrome-version` in the Durable Object. The scheduled scraper (see
 * `src/scheduled/client-versions-refresh.ts`) writes both values daily; this
 * module exposes pure `selectBuildNumber` / `selectChromeMajor` that callers
 * use to decide whether the cached value is fresh enough to trust.
 *
 * Runtime-agnostic: no imports from `@hono/*` or `cloudflare:*`.
 */

/** Storage key for the live build-number record inside `TokenPoolDO`. */
export const BUILD_NUMBER_META_KEY = 'meta:discord-build-number';

/** Storage key for the live Chrome-stable-major record inside `TokenPoolDO`. */
export const CHROME_VERSION_META_KEY = 'meta:chrome-version';

/**
 * Verified Discord web build number as of 2026-09-21. Source: `window.GLOBAL_ENV`
 * on `https://discord.com/login` (`"BUILD_NUMBER":"617136"`), cross-checked
 * against a live `X-Super-Properties` capture from both the Discord desktop
 * client and a browser session on the same day.
 *
 * Update this constant when the scraper has been broken for so long that the
 * fallback path becomes the dominant code path - i.e. only as a safety net.
 * The scheduled scraper writes to the DO meta key within the first 24h after
 * deploy, so this constant is normally never read in production.
 */
export const FALLBACK_BUILD_NUMBER = 617136;

/**
 * Chrome stable major as of 2026-09-21, cross-checked against a live browser
 * capture's `Sec-CH-UA` / `User-Agent`. Chrome ships a new stable major on a
 * ~4-week cadence, so this drifts; the daily scraper is the source of truth.
 */
export const FALLBACK_CHROME_MAJOR = 153;

/** 7-day staleness ceiling for the Discord build number. */
export const BUILD_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 35-day staleness ceiling for the Chrome major. Chrome ships every ~4 weeks;
 * anything older than that means the scraper itself is broken, not just due
 * for its next run.
 */
export const CHROME_STALENESS_MS = 35 * 24 * 60 * 60 * 1000;

export type BuildNumberSource = 'scraped' | 'manual' | 'fallback';

export interface BuildNumberRecord {
  buildNumber: number;
  /** Epoch ms when this record was written. */
  fetchedAt: number;
  source: BuildNumberSource;
}

export interface ChromeVersionRecord {
  major: number;
  /** Epoch ms when this record was written. */
  fetchedAt: number;
  source: BuildNumberSource;
}

export interface ClientVersionRecords {
  build: BuildNumberRecord | null;
  chrome: ChromeVersionRecord | null;
}

export interface ClientVersions {
  buildNumber: number;
  chromeMajor: number;
}

/**
 * Pure selection function. Returns the stored `buildNumber` when the record
 * exists AND is fresher than `BUILD_STALENESS_MS`; otherwise returns
 * `FALLBACK_BUILD_NUMBER`.
 *
 * Workers-agnostic. No `Date.now()` call here so tests can pass a fixed `now`.
 */
export function selectBuildNumber(stored: BuildNumberRecord | null, now: number): number {
  if (!stored) return FALLBACK_BUILD_NUMBER;
  if (now - stored.fetchedAt > BUILD_STALENESS_MS) return FALLBACK_BUILD_NUMBER;
  if (!Number.isFinite(stored.buildNumber) || stored.buildNumber <= 0) return FALLBACK_BUILD_NUMBER;
  return stored.buildNumber;
}

/**
 * Pure selection function for the Chrome stable major. Same shape as
 * `selectBuildNumber`; floors at 100 since no relevant Chrome major has ever
 * been below three digits.
 */
export function selectChromeMajor(stored: ChromeVersionRecord | null, now: number): number {
  if (!stored) return FALLBACK_CHROME_MAJOR;
  if (now - stored.fetchedAt > CHROME_STALENESS_MS) return FALLBACK_CHROME_MAJOR;
  if (!Number.isInteger(stored.major) || stored.major < 100) return FALLBACK_CHROME_MAJOR;
  return stored.major;
}

/** Resolve both version numbers at once from a `ClientVersionRecords` snapshot (or null when the DO has neither). */
export function resolveClientVersions(records: ClientVersionRecords | null, now: number): ClientVersions {
  return {
    buildNumber: selectBuildNumber(records?.build ?? null, now),
    chromeMajor: selectChromeMajor(records?.chrome ?? null, now),
  };
}
