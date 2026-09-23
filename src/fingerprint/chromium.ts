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
 * so a generated profile's client hints look like a real Chrome install of the
 * same major rather than a static placeholder.
 *
 * Verified against two independent live captures on 2026-09-21: a Chromium 148
 * Electron/Discord desktop client sent the two-brand
 * `"Not/A)Brand";v="99", "Chromium";v="148"` list, and Edge 153 sent
 * `"Microsoft Edge";v="153", "Not_A Brand";v="8", "Chromium";v="153"`. Neither
 * of those flavors is generated here. This module emits plain Chrome's
 * three-brand form - the grease brand plus `Chromium` and `Google Chrome`,
 * scattered into Chromium's per-major order - which is what the templates in
 * `profiles.ts` claim to be; a clone of any other flavor is registered
 * verbatim through the operator-captured custom-profile path.
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
 * placeholder brand (`Not?A?Brand`-shaped) plus the real `Chromium` and
 * `Google Chrome` brands, in one of six fixed orders.
 *
 * Chromium scatters rather than gathers: for the entry list
 * `[grease, Chromium, Google Chrome]` it writes `shuffled[order[i]] = list[i]`,
 * so position `order[i]` receives entry `i`. The two 3-cycle orders
 * (`major % 6` in {3, 4}) are where that differs from reading the entries out
 * in `order` sequence - major 148 (order `[2, 0, 1]`) therefore starts with
 * `Chromium`, not with the grease brand.
 *
 * Known answers: major 131 `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`;
 * major 148 `"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"`.
 */
export function greasedBrandList(major: number): string {
  const greaseChar1 = GREASE_CHARS[major % GREASE_CHARS.length];
  const greaseChar2 = GREASE_CHARS[(major + 1) % GREASE_CHARS.length];
  const greaseVersion = GREASE_VERSIONS[major % GREASE_VERSIONS.length];
  const greaseBrand = `Not${greaseChar1}A${greaseChar2}Brand`;

  const entries: readonly (readonly [string, string])[] = [
    [greaseBrand, greaseVersion],
    ['Chromium', String(major)],
    ['Google Chrome', String(major)],
  ];
  const order = GREASE_ORDERS[major % GREASE_ORDERS.length];
  const shuffled: (readonly [string, string])[] = [];
  for (let i = 0; i < order.length; i += 1) shuffled[order[i]] = entries[i];
  return shuffled.map(([brand, version]) => `"${brand}";v="${version}"`).join(', ');
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
