/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/subrequest-logger
 * Wraps `c.var.proxyFetch` with a per-call structured `console.log`.
 *
 * Wrangler's request-line summary lands at end-of-response, hiding which
 * Discord subcall is slow or retrying mid-flight. A `/custom/...` request
 * can fan out 20+ Discord calls; without per-subcall logs the worker is a
 * black box for the duration of the response.
 *
 * After this middleware runs, every consumer that uses `c.var.proxyFetch`
 * (the catch-all proxy route, all custom feature modules) emits one line
 * per outbound Discord call:
 *
 *     [subreq] 200    214ms GET   /guilds/<id>/messages/search?author_id=<redacted>&limit=25
 *     [subreq] 429   1024ms GET   /guilds/<id>/messages/search?author_id=<redacted>&limit=25
 *     [subreq] ERR    100ms GET   /channels/<id>/messages   (network: AbortError)
 *
 * Pure observability - no behavior change. Lives near the bottom of the
 * sieve so unauthenticated 401s do not generate noise.
 */

import { createMiddleware } from 'hono/factory';
import type { DiscordContextVariables } from './discord-context';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * The log line keeps only what is known to be safe and useful for
 * diagnostics; everything else is caller-shaped and masked. It cannot redact
 * the platform's own invocation log of the inbound request URL
 * (`observability.logs.invocation_logs`).
 *
 * Path: credential segments are replaced by position (webhook and
 * interaction tokens two non-empty segments after their marker, invite codes
 * one after); any other segment is printed as sent only when its decoded form
 * is a snowflake or count, a lowercase route word, or `@me`/`@original`, else
 * `:opaque`. A segment hiding an encoded `/` or `\` masks the rest of the path.
 */
const CREDENTIAL_SEGMENTS: ReadonlyMap<string, { readonly offset: number; readonly placeholder: string }> = new Map([
	['webhooks', { offset: 2, placeholder: ':token' }],
	['interactions', { offset: 2, placeholder: ':token' }],
	['invites', { offset: 1, placeholder: ':code' }],
]);
const LOGGABLE_SEGMENT = /^(?:\d{1,20}|[a-z][a-z0-9_-]{0,31}|@me|@original)$/;

/** Percent-decodes ASCII escapes for classification only (the log always prints the raw segment), so `%77ebhooks` or an encoded id is still recognized. */
function decodeAscii(segment: string): string {
	return segment.replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function redactPath(path: string): string {
	const segments = path.split('/');
	const decoded = segments.map(decodeAscii);
	// Offsets count non-empty segments only, so `/invites//code` cannot land the mask on an empty segment.
	const nonEmpty = decoded.flatMap((segment, i) => (segment === '' ? [] : [i]));
	const credentials = new Map(
		nonEmpty.flatMap((index, n) => {
			const rule = CREDENTIAL_SEGMENTS.get(decoded[index].toLowerCase());
			const target = rule === undefined ? undefined : nonEmpty[n + rule.offset];
			return rule !== undefined && target !== undefined ? [[target, rule.placeholder] as const] : [];
		}),
	);
	const hiddenSeparator = decoded.findIndex((segment) => segment.includes('/') || segment.includes('\\'));
	return segments
		.map((segment, i) => {
			if (segment === '') return segment;
			if (hiddenSeparator !== -1 && i >= hiddenSeparator) return ':opaque';
			return credentials.get(i) ?? (LOGGABLE_SEGMENT.test(decoded[i]) ? segment : ':opaque');
		})
		.join('/');
}

/** Query keys whose values are safe to log: paging cursors and limits, never caller-authored text or ids of people. */
const LOGGED_QUERY_VALUES: ReadonlySet<string> = new Set(['limit', 'before', 'after', 'around', 'offset', 'wait', 'min_id', 'max_id']);
/** Known Discord query parameter names printed as keys (their values stay redacted unless listed above); any other name is caller text, printed as `<key>`. */
const LOGGED_QUERY_KEYS: ReadonlySet<string> = new Set([
	...LOGGED_QUERY_VALUES,
	'author_id',
	'author_type',
	'channel_id',
	'content',
	'has',
	'include_nsfw',
	'mentions',
	'pinned',
	'sort_by',
	'sort_order',
	'thread_id',
	'type',
	'with_counts',
	'with_expiration',
]);
/** Even under an allowlisted key, only a snowflake, a count, or a boolean is printed; the caller controls the query, so anything else is redacted. */
const LOGGABLE_VALUE = /^(?:\d{1,20}|true|false)$/;

/** Re-serializes a query string keeping only known keys and well-formed paging values. */
function redactQuery(query: string): string {
	const parts: string[] = [];
	for (const [key, value] of new URLSearchParams(query)) {
		const shownKey = LOGGED_QUERY_KEYS.has(key) ? key : '<key>';
		const shownValue = LOGGED_QUERY_VALUES.has(key) && LOGGABLE_VALUE.test(value) ? value : '<redacted>';
		parts.push(`${shownKey}=${shownValue}`);
	}
	return parts.join('&');
}

/** Strips the Discord API prefix to keep the log line scannable, redacts path-borne credentials, and redacts query values. */
function shortenUrl(url: string): string {
	const short = url.startsWith(DISCORD_API_BASE) ? url.slice(DISCORD_API_BASE.length) || '/' : url;
	const queryStart = short.indexOf('?');
	const path = redactPath(queryStart === -1 ? short : short.slice(0, queryStart));
	return queryStart === -1 ? path : `${path}?${redactQuery(short.slice(queryStart + 1))}`;
}

/** Extracts a printable URL from RequestInfo regardless of input shape. */
function extractUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/** Builds a logging fetch wrapper around the given inner fetch implementation. */
function wrapWithLogging(inner: typeof fetch): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = extractUrl(input);
		const method = init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');
		const t0 = Date.now();
		try {
			const res = await inner(input, init);
			const ms = Date.now() - t0;
			console.log(`[subreq] ${String(res.status).padEnd(3)} ${String(ms).padStart(5)}ms ${method.padEnd(5)} ${shortenUrl(url)}`);
			return res;
		} catch (err: unknown) {
			const ms = Date.now() - t0;
			const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			console.log(`[subreq] ERR ${String(ms).padStart(5)}ms ${method.padEnd(5)} ${shortenUrl(url)}   (${reason})`);
			throw err;
		}
	}) as typeof fetch;
}

/**
 * Hono middleware that replaces `c.var.proxyFetch` (defaulting to the global
 * `fetch`) with a logging wrapper for the duration of the request.
 *
 * Composes cleanly with the existing test injection - `createApp(mockFetch)`
 * sets `c.var.proxyFetch = mockFetch` first, then this middleware wraps it,
 * so test runs also produce the streaming logs.
 */
export const subrequestLoggerMiddleware = createMiddleware<{ Variables: DiscordContextVariables }>(async (c, next) => {
	const inner = c.var.proxyFetch ?? fetch;
	c.set('proxyFetch', wrapWithLogging(inner));
	await next();
});
