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
 * a static-token fallback) and before `snowflakeValidatorMiddleware`.
 *
 * Selection is controlled by the optional `X-Proxy-Token` header:
 * - `static`             -> skip the rotator entirely; static token on context
 * - `<label>`            -> pin via `acquireByLabel`
 * - absent / `auto`      -> LRU `acquire`
 *
 * The acquired token's `fingerprintProfileId` is also recorded on context so
 * the proxy can compose matching fingerprint headers. The corresponding
 * `release` happens inside `src/routes/proxy.ts` after the Discord response.
 *
 * Failure modes:
 *   - reason='cooldown'           -> 429 with Retry-After (consumer-visible)
 *   - reason='empty-pool'         -> graceful pass-through to static token
 *   - reason='no-eligible-token'  -> 503 (operator-visible misconfig signal)
 *   - DO RPC throws               -> 503
 */

import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';
import type { AuthVariables } from './auth';
import type { DiscordContextVariables } from './discord-context';
import { parseProxyTokenHeader } from './proxy-token-header';
import { deriveRouteKey, extractGuildId, isRotatableRoute } from '../rotator/bucket';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import type { AcquireResult, RotatorVariables, Slot } from '../rotator/types';

export const tokenRotatorMiddleware = createMiddleware<{
	Bindings: Bindings;
	Variables: AuthVariables & DiscordContextVariables & RotatorVariables;
}>(async (c, next) => {
	const selector = parseProxyTokenHeader(c.req.header('X-Proxy-Token'));

	// Explicit static bypass: skip the rotator entirely. discord-context already
	// populated c.var.discordToken with the static fallback.
	if (selector === 'static') {
		await next();
		return;
	}

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

	let result: AcquireResult;
	try {
		if (selector === 'auto') {
			result = await client.acquire(slot, routeKey, guildId);
		} else {
			if (!client.acquireByLabel) {
				console.error('TOKEN_POOL client does not implement acquireByLabel');
				return c.json({ error: 'token pool unavailable' }, 503);
			}
			result = await client.acquireByLabel(selector.label, slot, routeKey, guildId);
		}
	} catch (err: unknown) {
		console.error('TOKEN_POOL acquire failed:', err);
		return c.json({ error: 'token pool unavailable' }, 503);
	}

	if (!result.ok) {
		// Graceful fallback: zero tokens registered for the slot -> use the static
		// token already on context. Only applies to the auto path; pinned requests
		// for a specific label must still surface 503 so operators see the misconfig.
		if (result.reason === 'empty-pool' && selector === 'auto') {
			await next();
			return;
		}
		if (result.reason === 'cooldown') {
			return c.json(
				{ error: 'Too Many Requests', retryAfter: Math.ceil(result.retryAfter / 1000) },
				429,
				{ 'Retry-After': String(Math.ceil(result.retryAfter / 1000)) },
			);
		}
		// no-eligible-token (or pinned empty-pool) -> 503 so misconfig is operator-visible
		return c.json({ error: 'token pool unavailable', reason: result.reason }, 503);
	}

	c.set('discordToken', result.tokenSecret);
	c.set('acquiredLabel', result.label);
	c.set('acquiredRequestId', result.requestId);
	if (result.fingerprintProfileId) {
		c.set('acquiredFingerprintProfileId', result.fingerprintProfileId);
	}

	await next();
});
