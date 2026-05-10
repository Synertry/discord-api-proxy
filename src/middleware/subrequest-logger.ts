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
 *     [subreq] 200    214ms GET   /guilds/<id>/messages/search?author_id=...
 *     [subreq] 429   1024ms GET   /guilds/<id>/messages/search?author_id=...
 *     [subreq] ERR    100ms GET   /channels/<id>/messages   (network: AbortError)
 *
 * Pure observability - no behavior change. Lives near the bottom of the
 * sieve so unauthenticated 401s do not generate noise.
 */

import { createMiddleware } from 'hono/factory';
import type { DiscordContextVariables } from './discord-context';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Strips the Discord API prefix to keep the log line scannable. */
function shortenUrl(url: string): string {
	return url.startsWith(DISCORD_API_BASE) ? url.slice(DISCORD_API_BASE.length) || '/' : url;
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
