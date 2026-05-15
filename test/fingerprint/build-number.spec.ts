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
	STALENESS_CEILING_MS,
	selectBuildNumber,
} from '../../src/fingerprint/build-number';

describe('selectBuildNumber', () => {
	const NOW = 1_700_000_000_000;

	it('returns FALLBACK when no record exists', () => {
		expect(selectBuildNumber(null, NOW)).toBe(FALLBACK_BUILD_NUMBER);
	});

	it('returns the stored value when fresh', () => {
		const r = { buildNumber: 700_000, fetchedAt: NOW - 60_000, source: 'scraped' as const };
		expect(selectBuildNumber(r, NOW)).toBe(700_000);
	});

	it('returns FALLBACK when record is older than the staleness ceiling', () => {
		const r = {
			buildNumber: 700_000,
			fetchedAt: NOW - STALENESS_CEILING_MS - 1,
			source: 'scraped' as const,
		};
		expect(selectBuildNumber(r, NOW)).toBe(FALLBACK_BUILD_NUMBER);
	});

	it('returns FALLBACK when stored buildNumber is non-positive or non-finite', () => {
		expect(
			selectBuildNumber({ buildNumber: 0, fetchedAt: NOW, source: 'scraped' }, NOW),
		).toBe(FALLBACK_BUILD_NUMBER);
		expect(
			selectBuildNumber({ buildNumber: -1, fetchedAt: NOW, source: 'manual' }, NOW),
		).toBe(FALLBACK_BUILD_NUMBER);
		expect(
			selectBuildNumber(
				{ buildNumber: Number.NaN as unknown as number, fetchedAt: NOW, source: 'fallback' },
				NOW,
			),
		).toBe(FALLBACK_BUILD_NUMBER);
	});
});
