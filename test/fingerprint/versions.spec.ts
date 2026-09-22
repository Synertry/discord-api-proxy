/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import {
  FALLBACK_BUILD_NUMBER,
  FALLBACK_CHROME_MAJOR,
  BUILD_STALENESS_MS,
  CHROME_STALENESS_MS,
  selectBuildNumber,
  selectChromeMajor,
  resolveClientVersions,
} from '../../src/fingerprint/versions';

const NOW = 1_700_000_000_000;

describe('selectBuildNumber', () => {
  it('returns FALLBACK when no record exists', () => {
    expect(selectBuildNumber(null, NOW)).toBe(FALLBACK_BUILD_NUMBER);
  });

  it('returns the stored value when fresh', () => {
    const r = { buildNumber: 700_000, fetchedAt: NOW - 60_000, source: 'scraped' as const };
    expect(selectBuildNumber(r, NOW)).toBe(700_000);
  });

  it('returns FALLBACK when record is older than the staleness ceiling', () => {
    const r = { buildNumber: 700_000, fetchedAt: NOW - BUILD_STALENESS_MS - 1, source: 'scraped' as const };
    expect(selectBuildNumber(r, NOW)).toBe(FALLBACK_BUILD_NUMBER);
  });

  it('returns FALLBACK when stored buildNumber is non-positive or non-finite', () => {
    expect(selectBuildNumber({ buildNumber: 0, fetchedAt: NOW, source: 'scraped' }, NOW)).toBe(FALLBACK_BUILD_NUMBER);
    expect(selectBuildNumber({ buildNumber: -1, fetchedAt: NOW, source: 'manual' }, NOW)).toBe(FALLBACK_BUILD_NUMBER);
    expect(selectBuildNumber({ buildNumber: Number.NaN as unknown as number, fetchedAt: NOW, source: 'fallback' }, NOW)).toBe(
      FALLBACK_BUILD_NUMBER,
    );
  });
});

describe('selectChromeMajor', () => {
  it('returns FALLBACK when no record exists', () => {
    expect(selectChromeMajor(null, NOW)).toBe(FALLBACK_CHROME_MAJOR);
  });

  it('returns the stored major when fresh', () => {
    const r = { major: 148, fetchedAt: NOW - 60_000, source: 'scraped' as const };
    expect(selectChromeMajor(r, NOW)).toBe(148);
  });

  it('returns FALLBACK when record is older than 35 days', () => {
    const r = { major: 148, fetchedAt: NOW - CHROME_STALENESS_MS - 1, source: 'scraped' as const };
    expect(selectChromeMajor(r, NOW)).toBe(FALLBACK_CHROME_MAJOR);
  });

  it('returns FALLBACK when stored major is non-integer or below 100', () => {
    expect(selectChromeMajor({ major: 42, fetchedAt: NOW, source: 'scraped' }, NOW)).toBe(FALLBACK_CHROME_MAJOR);
    expect(selectChromeMajor({ major: 148.5, fetchedAt: NOW, source: 'scraped' }, NOW)).toBe(FALLBACK_CHROME_MAJOR);
  });
});

describe('resolveClientVersions', () => {
  it('falls back to both defaults when records is null', () => {
    expect(resolveClientVersions(null, NOW)).toEqual({ buildNumber: FALLBACK_BUILD_NUMBER, chromeMajor: FALLBACK_CHROME_MAJOR });
  });

  it('resolves fresh build and chrome records independently', () => {
    const records = {
      build: { buildNumber: 617136, fetchedAt: NOW - 1000, source: 'scraped' as const },
      chrome: { major: 153, fetchedAt: NOW - 1000, source: 'scraped' as const },
    };
    expect(resolveClientVersions(records, NOW)).toEqual({ buildNumber: 617136, chromeMajor: 153 });
  });

  it('falls back one field independently when only it is stale', () => {
    const records = {
      build: { buildNumber: 617136, fetchedAt: NOW - 1000, source: 'scraped' as const },
      chrome: { major: 148, fetchedAt: NOW - CHROME_STALENESS_MS - 1, source: 'scraped' as const },
    };
    expect(resolveClientVersions(records, NOW)).toEqual({ buildNumber: 617136, chromeMajor: FALLBACK_CHROME_MAJOR });
  });
});
