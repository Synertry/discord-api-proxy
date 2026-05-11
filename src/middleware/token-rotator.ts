/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/token-rotator
 * Sieve layer 3.5: token-pool acquire on rotatable paths.
 *
 * Runs after `discordContextMiddleware` (so `c.var.discordToken` already holds
 * a static-token fallback) and before `snowflakeValidatorMiddleware`. For
 * paths in the rotation allowlist, calls `tokenPoolClient.acquire(...)` and
 * overwrites `c.var.discordToken` with the acquired token's secret.
 *
 * The corresponding `release` happens inside `src/routes/proxy.ts` after the
 * Discord response comes back. Bingo's discord-client manages its own
 * acquire/release lifecycle since it doesn't go through the proxy route.
 *
 * Failure modes:
 *   - reason='cooldown' -> 429 with Retry-After (consumer-visible)
 *   - reason='empty-pool' / 'no-eligible-token' -> 503 (operator-visible)
 *   - DO RPC throws (e.g. binding misconfigured) -> 503
 */

import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';
import type { AuthVariables } from './auth';
import type { DiscordContextVariables } from './discord-context';
import { deriveRouteKey, extractGuildId, isRotatableRoute } from '../rotator/bucket';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import type { RotatorVariables, Slot } from '../rotator/types';

/**
 * Token-pool acquire middleware. No-op for non-rotatable paths.
 *
 * Reads `c.var.authSlot` to decide which pool to draw from. If the rotator
 * succeeds, `c.var.discordToken` is overwritten with the acquired token (no
 * `Bot ` prefix - rotated tokens are always user tokens) and the
 * `discordUserAgent` from `discordContextMiddleware` is preserved.
 */
export const tokenRotatorMiddleware = createMiddleware<{
	Bindings: Bindings;
	Variables: AuthVariables & DiscordContextVariables & RotatorVariables;
}>(async (c, next) => {
	if (!isRotatableRoute(c.req.method, c.req.path)) {
		await next();
		return;
	}

	const slot: Slot = c.var.authSlot === 'premium' ? 'premium' : 'default';
	const routeKey = deriveRouteKey(c.req.method, c.req.path);
	const guildId = extractGuildId(c.req.path);

	let client = c.var.tokenPoolClient;
	if (!client) {
		try {
			const stub = getPoolStub(c.env, slot);
			client = createTokenPoolClient(stub);
			c.set('tokenPoolClient', client);
		} catch (err: unknown) {
			console.error('TOKEN_POOL binding unavailable:', err);
			return c.json({ error: 'token pool unavailable' }, 503);
		}
	}

	let result;
	try {
		result = await client.acquire(slot, routeKey, guildId);
	} catch (err: unknown) {
		console.error('TOKEN_POOL acquire failed:', err);
		return c.json({ error: 'token pool unavailable' }, 503);
	}

	if (!result.ok) {
		if (result.reason === 'cooldown') {
			return c.json(
				{ error: 'Too Many Requests', retryAfter: Math.ceil(result.retryAfter / 1000) },
				429,
				{
					'Retry-After': String(Math.ceil(result.retryAfter / 1000)),
				},
			);
		}
		// empty-pool or no-eligible-token -> 503 so misconfiguration is operator-visible
		return c.json({ error: 'token pool unavailable', reason: result.reason }, 503);
	}

	c.set('discordToken', result.tokenSecret);
	c.set('acquiredLabel', result.label);
	c.set('acquiredRequestId', result.requestId);

	await next();
});
