/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/discord-context
 * Selects the appropriate Discord authentication context for each request.
 *
 * Determines whether to use the **bot token** or **user token** based on:
 * 1. Explicit `x-proxy-context` header (`'user'` or `'bot'`)
 * 2. Path heuristic: requests targeting `/guilds` default to user token
 *
 * Token-kind is recorded as `discordTokenKind` (`'bot' | 'user-default' |
 * 'user-premium'`) so the proxy can compose the right header set: bot UA for
 * `'bot'`, per-identity browser fingerprint for the user kinds.
 *
 * For user-kind requests the middleware also reads the static-fingerprint
 * mapping from the token pool DO (one RPC) so the proxy can apply the operator-
 * chosen fingerprint when the request is NOT rotated (e.g. POST /channels/:id/messages).
 */

import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';
import type { AuthVariables } from './auth';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import type { StaticTokenKind, TokenPoolClient } from '../rotator/types';

/** Discriminates the token kind for downstream header composition. */
export type DiscordTokenKind = 'bot' | StaticTokenKind;

/** Context variables set by this middleware and consumed by downstream handlers. */
export type DiscordContextVariables = {
	/** The selected Discord authorization header value (e.g. `"Bot <token>"` or raw user token). */
	discordToken: string;
	/** Which token kind was selected. Drives proxy-side header composition. */
	discordTokenKind: DiscordTokenKind;
	/**
	 * Operator-set fingerprint profile id for the kind, if configured in the DO.
	 * Read once per static-user-token request. The proxy falls back through:
	 *   acquiredFingerprintProfileId -> staticFingerprintProfileId -> FALLBACK_PROFILE_ID
	 */
	staticFingerprintProfileId?: string;
	/** Optional fetch override injected during testing. */
	proxyFetch?: typeof fetch;
};

/**
 * Sets {@link DiscordContextVariables} on the request context for downstream handlers.
 *
 * Token selection priority:
 * 1. `x-proxy-context: user` -> user token + kind = `'user-{slot}'`
 * 2. `x-proxy-context: bot` -> bot token + kind = `'bot'`
 * 3. No header, path contains `/guilds` -> user token (fallback heuristic)
 * 4. No header, other paths -> bot token
 *
 * When the user-token branch is selected, the paired Discord user token is chosen
 * based on the `authSlot` set by `authMiddleware`:
 * - `default` -> `DISCORD_TOKEN_USER`
 * - `premium` -> `DISCORD_TOKEN_USER_PREMIUM` (errors 503 if not configured)
 */
export const discordContextMiddleware = createMiddleware<{
	Bindings: Bindings;
	Variables: DiscordContextVariables & AuthVariables & { tokenPoolClient?: TokenPoolClient };
}>(async (c, next) => {
	const path = c.req.path;
	const proxyContext = (c.req.header('x-proxy-context') || '').toLowerCase();

	let useUserToken = false;

	if (proxyContext === 'user') {
		useUserToken = true;
	} else if (proxyContext === 'bot') {
		useUserToken = false;
	} else {
		// Fallback: guild endpoints typically require user authentication
		useUserToken = path.includes('/guilds');
	}

	if (useUserToken) {
		const slot = c.get('authSlot');
		let userToken: string;
		let kind: DiscordTokenKind;
		if (slot === 'premium') {
			if (!c.env.DISCORD_TOKEN_USER_PREMIUM) {
				console.error('FATAL: AUTH_KEY_PREMIUM accepted but DISCORD_TOKEN_USER_PREMIUM is not configured');
				return c.json({ error: 'Service misconfigured' }, 503);
			}
			userToken = c.env.DISCORD_TOKEN_USER_PREMIUM;
			kind = 'user-premium';
		} else {
			userToken = c.env.DISCORD_TOKEN_USER;
			kind = 'user-default';
		}
		c.set('discordToken', userToken);
		c.set('discordTokenKind', kind);

		// Best-effort static-fingerprint lookup. Failures (no DO binding in
		// tests, RPC throw) leave the field unset and the proxy falls back
		// through the chain: acquired -> static -> FALLBACK_PROFILE_ID.
		const client = ensureClient(c);
		if (client?.getStaticFingerprint) {
			try {
				const record = await client.getStaticFingerprint(kind);
				if (record) c.set('staticFingerprintProfileId', record.profileId);
			} catch (err: unknown) {
				console.error('static-fingerprint lookup failed:', err);
			}
		}
	} else {
		c.set('discordToken', `Bot ${c.env.DISCORD_TOKEN_BOT}`);
		c.set('discordTokenKind', 'bot');
	}

	await next();
});

/**
 * Resolve the token-pool client, lazily constructing one from the DO binding
 * if none is set on the context yet. Returns undefined when no binding is
 * available (e.g. unit tests without a DO).
 */
function ensureClient(c: {
	env: Bindings;
	var: { tokenPoolClient?: TokenPoolClient };
	set: (key: 'tokenPoolClient', value: TokenPoolClient) => void;
}): TokenPoolClient | undefined {
	if (c.var.tokenPoolClient) return c.var.tokenPoolClient;
	if (!c.env.TOKEN_POOL || typeof c.env.TOKEN_POOL.idFromName !== 'function') return undefined;
	try {
		const stub = getPoolStub(c.env);
		const client = createTokenPoolClient(stub);
		c.set('tokenPoolClient', client);
		return client;
	} catch (err: unknown) {
		console.error('TOKEN_POOL binding unavailable (discord-context):', err);
		return undefined;
	}
}
