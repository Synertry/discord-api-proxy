/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/proxy-token-header
 * Parser for the `X-Proxy-Token` request header that controls per-request
 * token-pool selection. Pure - no Hono / Workers dependencies, fully testable
 * in isolation.
 *
 * Semantics:
 * - absent / empty / null / undefined / `'auto'` -> `'auto'` (default LRU)
 * - `'static'` -> `'static'` (skip the rotator, use the static token on context)
 * - anything else (after trim) -> `{ label }` (pin to that registered pool token)
 *
 * Comparison is case-sensitive on the reserved values so label collisions with
 * `'auto'` / `'static'` are explicit operator choices.
 */

export type ProxyTokenSelector = 'auto' | 'static' | { label: string };

/**
 * Parse the value of an `X-Proxy-Token` request header into a selector.
 * Whitespace is trimmed before classification.
 */
export function parseProxyTokenHeader(value: string | null | undefined): ProxyTokenSelector {
	if (value === null || value === undefined) return 'auto';
	const trimmed = value.trim();
	if (trimmed === '' || trimmed === 'auto') return 'auto';
	if (trimmed === 'static') return 'static';
	return { label: trimmed };
}
