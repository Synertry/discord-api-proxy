/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/chromium
 * Pure port of Chromium's greased `Sec-CH-UA` brand-list generation
 * (`GetGreasedUserAgentBrandVersion` in `components/embedder_support/user_agent_utils.cc`),
 * so a generated profile's client hints look like a real Chrome/Edge install
 * of the same major rather than a static placeholder.
 *
 * Verified against two independent live captures on 2026-09-21: Chromium 148
 * produced `"Not/A)Brand";v="99", "Chromium";v="148"` (Electron/Discord
 * desktop) and Edge 153 produced `"Microsoft Edge";v="153", "Not_A Brand";v="8", "Chromium";v="153"`
 * (browser). Only the Chromium-flavored two-brand form (grease + Chromium)
 * is generated here; the registry in `profiles.ts` sticks to plain Chrome,
 * which also carries a `"Google Chrome"` brand alongside `"Chromium"`.
 *
 * No imports: this file is runtime-agnostic by construction.
 */

export type Platform = 'Windows' | 'macOS';

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'] as const;
const GREASE_VERSIONS = ['8', '99', '24'] as const;
const GREASE_ORDERS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** Format a Chromium-family `User-Agent` string for the given platform and major version. */
export function formatChromiumUserAgent(platform: Platform, major: number): string {
  const platformToken = platform === 'Windows' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Port of Chromium's greased brand-version list: a deterministic, per-major
 * placeholder brand (`Not?A?Brand`-shaped) interleaved with the real
 * `Chromium` and `Google Chrome` brands, in one of six fixed orders.
 *
 * Known answer (verified against Chromium's own algorithm for major 131):
 * `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`.
 */
export function greasedBrandList(major: number): string {
  const greaseChar1 = GREASE_CHARS[major % GREASE_CHARS.length];
  const greaseChar2 = GREASE_CHARS[(major + 1) % GREASE_CHARS.length];
  const greaseVersion = GREASE_VERSIONS[major % GREASE_VERSIONS.length];
  const greaseBrand = `Not${greaseChar1}A${greaseChar2}Brand`;

  const entries: readonly [string, string][] = [
    [greaseBrand, greaseVersion],
    ['Chromium', String(major)],
    ['Google Chrome', String(major)],
  ];
  const order = GREASE_ORDERS[major % GREASE_ORDERS.length];
  return order
    .map((i) => entries[i])
    .map(([brand, version]) => `"${brand}";v="${version}"`)
    .join(', ');
}

/** Client-hint headers for a generated profile of the given platform and Chrome major. */
export function clientHints(
  platform: Platform,
  major: number,
): { 'Sec-CH-UA': string; 'Sec-CH-UA-Mobile': '?0'; 'Sec-CH-UA-Platform': string } {
  return {
    'Sec-CH-UA': greasedBrandList(major),
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': platform === 'Windows' ? '"Windows"' : '"macOS"',
  };
}
