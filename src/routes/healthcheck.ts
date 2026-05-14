/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/healthcheck
 * Public, unauthenticated liveness probe.
 *
 * Mounted at `/healthcheck` BEFORE the sieve (auth) so it is reachable from any
 * client, including phone browsers, without a key. Returns a compact JSON body
 * plus build metadata for at-a-glance "which version is running" checks.
 *
 * NOT included in the public OpenAPI doc (no `.doc()` call on this sub-app).
 * NOT a deep health check - it does not touch the Durable Object, Discord, or
 * any external service. Liveness only. Operator-grade health (per-slot rollup)
 * lives behind `AUTH_KEY_ADMIN` at `GET /admin/health`.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Bindings } from '../types';

/**
 * Build the public healthcheck sub-app. Mounted with `app.route('/healthcheck', buildHealthcheckRoute())`.
 */
export function buildHealthcheckRoute(): OpenAPIHono<{ Bindings: Bindings }> {
	const health = new OpenAPIHono<{ Bindings: Bindings }>();

	health.get('/', (c) => {
		return c.json(
			{
				status: 'ok',
				service: 'discord-api-proxy',
				build: {
					hash: BUILD_HASH,
					timestamp: BUILD_TIMESTAMP,
				},
				time: new Date().toISOString(),
			},
			200,
			{
				// Defeat any intermediate CDN caching so mobile browsers see live state.
				'Cache-Control': 'no-store',
			},
		);
	});

	return health;
}
