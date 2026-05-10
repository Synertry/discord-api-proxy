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

	function buildApp(innerFetch?: typeof fetch) {
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
			const r = await fetcher('https://discord.com/api/v10/users/@me');
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

});
