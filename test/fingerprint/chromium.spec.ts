/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { formatChromiumUserAgent, greasedBrandList, clientHints } from '../../src/fingerprint/chromium';

describe('greasedBrandList', () => {
  it('matches the known answer for major 131', () => {
    expect(greasedBrandList(131)).toBe('"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
  });

  it('scatters the grease brand to the last position for major 148', () => {
    expect(greasedBrandList(148)).toBe('"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"');
  });

  it('scatters the grease brand to the middle position for major 153', () => {
    expect(greasedBrandList(153)).toBe('"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"');
  });

  it('scatters the grease brand to the last position for major 124', () => {
    expect(greasedBrandList(124)).toBe('"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"');
  });

  it('scatters the grease brand to the last position for major 130', () => {
    expect(greasedBrandList(130)).toBe('"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"');
  });

  it('is deterministic for the same major', () => {
    expect(greasedBrandList(140)).toBe(greasedBrandList(140));
  });

  it('varies grease brand/version across majors', () => {
    expect(greasedBrandList(131)).not.toBe(greasedBrandList(132));
  });
});

describe('formatChromiumUserAgent', () => {
  it('embeds the major on Windows', () => {
    const ua = formatChromiumUserAgent('Windows', 148);
    expect(ua).toContain('Chrome/148.0.0.0');
    expect(ua).toContain('Windows NT 10.0; Win64; x64');
  });

  it('embeds the major on macOS', () => {
    const ua = formatChromiumUserAgent('macOS', 148);
    expect(ua).toContain('Chrome/148.0.0.0');
    expect(ua).toContain('Macintosh; Intel Mac OS X 10_15_7');
  });
});

describe('clientHints', () => {
  it('quotes the platform value', () => {
    expect(clientHints('Windows', 148)['Sec-CH-UA-Platform']).toBe('"Windows"');
    expect(clientHints('macOS', 148)['Sec-CH-UA-Platform']).toBe('"macOS"');
  });

  it('always reports desktop (non-mobile)', () => {
    expect(clientHints('Windows', 148)['Sec-CH-UA-Mobile']).toBe('?0');
  });
});
