/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { subrequestLoggerMiddleware } from '../../src/middleware/subrequest-logger';
import type { DiscordContextVariables } from '../../src/middleware/discord-context';

describe('subrequestLoggerMiddleware', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	function buildApp(innerFetch?: typeof fetch, target = 'https://discord.com/api/v10/users/@me') {
		const app = new OpenAPIHono<{ Variables: DiscordContextVariables }>();
		if (innerFetch) {
			app.use('*', async (c, next) => {
				c.set('proxyFetch', innerFetch);
				await next();
			});
		}
		app.use('*', subrequestLoggerMiddleware);
		app.get('/probe', async (c) => {
			const fetcher = c.var.proxyFetch ?? fetch;
			const r = await fetcher(target);
			return c.text(`status=${r.status}`);
		});
		return app;
	}

	it('wraps proxyFetch and logs one line per outbound call', async () => {
		const innerFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
		const app = buildApp(innerFetch);

		const res = await app.request('http://localhost/probe');
		expect(res.status).toBe(200);
		expect(innerFetch).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledTimes(1);
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toMatch(/^\[subreq\] 200/);
		expect(line).toContain('/users/@me');
	});

	it('logs ERR with reason when the inner fetch throws', async () => {
		const boom = vi.fn(async () => {
			throw new Error('AbortError: timeout');
		}) as unknown as typeof fetch;
		const app = buildApp(boom);

		const res = await app.request('http://localhost/probe');
		// The throw bubbles to Hono's onError handler -> 500
		expect([500, 502]).toContain(res.status);
		expect(logSpy).toHaveBeenCalledTimes(1);
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toMatch(/^\[subreq\] ERR/);
		expect(line).toContain('AbortError');
	});

	it.each([
		['webhook', 'https://discord.com/api/v10/webhooks/123456789012345678/SeCrEtToKeN-1/messages/@original?wait=true', '/webhooks/123456789012345678/:token/messages/@original?wait=true'],
		['interaction', 'https://discord.com/api/v10/interactions/123456789012345678/SeCrEtToKeN-1/callback', '/interactions/123456789012345678/:token/callback'],
		[
			'percent-encoded webhook id',
			'https://discord.com/api/v10/webhooks/%3123456789012345678/SeCrEtToKeN-1/messages',
			'/webhooks/%3123456789012345678/:token/messages',
		],
		['percent-encoded webhooks marker', 'https://discord.com/api/v10/%77ebhooks/123456789012345678/SeCrEtToKeN-1', '/%77ebhooks/123456789012345678/:token'],
		['invite code', 'https://discord.com/api/v10/invites/SeCrEtToKeN-1?with_counts=true', '/invites/:code?with_counts=<redacted>'],
	])('never writes a %s token to the log', async (_kind, target, expected) => {
		const innerFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
		const app = buildApp(innerFetch, target);

		await app.request('http://localhost/probe');
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).not.toContain('SeCrEtToKeN');
		expect(line).toContain(expected);
	});

	it('redacts query values other than paging cursors and limits', async () => {
		const innerFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
		const target =
			'https://discord.com/api/v10/guilds/123456789012345678/messages/search?author_id=987654321098765432&content=hello%20there&limit=25&max_id=111111111111111111';
		const app = buildApp(innerFetch, target);

		await app.request('http://localhost/probe');
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain('/guilds/123456789012345678/messages/search?author_id=<redacted>&content=<redacted>&limit=25&max_id=111111111111111111');
		expect(line).not.toContain('987654321098765432');
		expect(line).not.toContain('hello');
	});

	it('redacts a value under an allowlisted key unless it is a plain number or boolean, and masks unknown keys, so caller text cannot hide there', async () => {
		const innerFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
		const target =
			'https://discord.com/api/v10/channels/123456789012345678/messages?before=private-text&limit=secret&wait=%0Aforged%20line&after=222222222222222222&bad%0Akey=1';
		const app = buildApp(innerFetch, target);

		await app.request('http://localhost/probe');
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain(
			'/channels/123456789012345678/messages?before=<redacted>&limit=<redacted>&wait=<redacted>&after=222222222222222222&<key>=<redacted>',
		);
		expect(line).not.toMatch(/private|secret|forged|bad|\n/);
	});

	it.each([
		['an empty segment before an invite code', 'https://discord.com/api/v10/invites//secret-code', '/invites//:code', /secret/],
		['an encoded separator hiding a webhook marker', 'https://discord.com/api/v10/webhooks%2F123456789012345678/secret-token', '/:opaque/:opaque', /secret|webhooks/],
		['caller text in an arbitrary segment', 'https://discord.com/api/v10/channels/123456789012345678/Private%20Text', '/channels/123456789012345678/:opaque', /Private/],
		['a lowercase key that is not a Discord parameter', 'https://discord.com/api/v10/users/@me?privatecode=1&limit=5', '/users/@me?<key>=<redacted>&limit=5', /privatecode/],
	])('masks %s', async (_kind, target, expected, forbidden) => {
		const innerFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
		const app = buildApp(innerFetch, target);

		await app.request('http://localhost/probe');
		const line = logSpy.mock.calls[0][0] as string;
		expect(line).toContain(expected);
		expect(line).not.toMatch(forbidden);
	});
});
