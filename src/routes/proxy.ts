/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/proxy
 * Catch-all reverse proxy that forwards unmatched requests to the Discord API.
 *
 * Rewrites the request URL from `/{path}` to `https://discord.com/api/v10/{path}`,
 * injects the appropriate authorization token, composes per-identity fingerprint
 * headers (or the Discord-compliant bot UA), and streams the response back to
 * the client. Supports all HTTP methods including request body forwarding for
 * POST/PUT/PATCH/DELETE.
 *
 * Token-pool integration: when `tokenRotatorMiddleware` acquired a pooled token
 * for this request, `c.var.acquiredLabel + acquiredRequestId` are set. After the
 * upstream response comes back, we extract Discord's rate-limit headers and call
 * `tokenPoolClient.release(...)`. On 429 with another eligible token available
 * for the same route, we retry exactly once with a fresh acquire (no recursion).
 *
 * Fingerprint: every user-token-bound request receives a full browser-like
 * header set (User-Agent, X-Super-Properties, X-Discord-Locale, ...). Bot-token
 * requests receive a Discord-compliant `DiscordBot (...)` UA only.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Bindings } from '../types';
import type { AuthVariables } from '../middleware/auth';
import type { DiscordContextVariables, DiscordTokenKind } from '../middleware/discord-context';
import { composeBotUserAgent, composeFingerprint } from '../fingerprint/compose';
import { FALLBACK_PROFILE_ID, lookupProfile } from '../fingerprint/profiles';
import { FALLBACK_BUILD_NUMBER, selectBuildNumber } from '../fingerprint/build-number';
import { deriveRouteKey, extractGuildId, isRotatableRoute } from '../rotator/bucket';
import { extractReleaseInput, extractReleaseInputWithBody } from '../rotator/release-input';
import type { RotatorVariables, Slot, TokenPoolClient } from '../rotator/types';

/** Catch-all proxy route - forwards any unmatched request to Discord API v10. */
export const proxyRoute = new OpenAPIHono<{
	Bindings: Bindings;
	Variables: DiscordContextVariables & AuthVariables & RotatorVariables;
}>();

/** Internal headers that must not be forwarded to the Discord API. */
const STRIPPED_HEADERS = new Set(['host', 'x-auth-key', 'x-proxy-context']);

type SafeInit = RequestInit & { duplex?: 'half' };

proxyRoute.all('/*', async (c) => {
	const url = new URL(c.req.url);
	const method = c.req.method;
	const discordUrl = `https://discord.com/api/v10${url.pathname}${url.search}`;
	const kind: DiscordTokenKind = c.var.discordTokenKind ?? 'bot';

	try {
		// Clone incoming headers, stripping internal proxy headers and Host
		const cleanHeaders = new Headers();
		c.req.raw.headers.forEach((v, k) => {
			if (!STRIPPED_HEADERS.has(k.toLowerCase())) cleanHeaders.set(k, v);
		});

		// Inject Discord auth from context middleware
		cleanHeaders.set('Authorization', c.var.discordToken);

		// Apply fingerprint or bot UA based on token kind
		await applyClientHeaders(c, cleanHeaders, kind);

		// Build fetch init - include body + duplex for methods that carry a payload
		const safeInit: SafeInit = { method, headers: cleanHeaders };
		if (method !== 'GET' && method !== 'HEAD') {
			safeInit.body = c.req.raw.body;
			safeInit.duplex = 'half'; // Required for streaming request bodies in Workers
		}

		const fetcher = c.var.proxyFetch ?? fetch;
		const response = await fetcher(discordUrl, safeInit as RequestInit);

		// Token-pool release-and-retry path. Only runs when the rotator middleware
		// acquired a pooled token for this request (acquiredLabel set).
		const acquiredLabel = c.var.acquiredLabel;
		const acquiredRequestId = c.var.acquiredRequestId;
		const client = c.var.tokenPoolClient;

		if (acquiredLabel && acquiredRequestId && client && isRotatableRoute(method, url.pathname)) {
			const routeKey = deriveRouteKey(method, url.pathname);
			const guildId = extractGuildId(url.pathname);

			// 50001 -> need to read the body to capture the Discord error code
			const releaseInput =
				response.status === 403
					? await extractReleaseInputWithBody(response, routeKey, guildId)
					: extractReleaseInput(response, routeKey, guildId);
			await client.release(acquiredLabel, acquiredRequestId, releaseInput);

			// Auto-retry: single attempt with a fresh acquire on 429.
			if (response.status === 429) {
				const slot: Slot = c.var.authSlot === 'premium' ? 'premium' : 'default';
				let retry;
				try {
					retry = await client.acquire(slot, routeKey, guildId);
				} catch (err: unknown) {
					console.error('TOKEN_POOL retry acquire failed:', err);
					return response;
				}
				if (!retry.ok) return response; // No alternative token; pass the original 429 through.

				const retryHeaders = new Headers(cleanHeaders);
				retryHeaders.set('Authorization', retry.tokenSecret);
				// Refresh fingerprint to match the new token's identity
				rewriteFingerprintForRetry(retryHeaders, retry.fingerprintProfileId, c);

				const retryInit: SafeInit = { method, headers: retryHeaders };
				if (method !== 'GET' && method !== 'HEAD') {
					retryInit.body = c.req.raw.body;
					retryInit.duplex = 'half';
				}
				const retryResponse = await fetcher(discordUrl, retryInit as RequestInit);
				const retryRelease =
					retryResponse.status === 403
						? await extractReleaseInputWithBody(retryResponse, routeKey, guildId)
						: extractReleaseInput(retryResponse, routeKey, guildId);
				await client.release(retry.label, retry.requestId, retryRelease);
				return retryResponse;
			}
		}

		return response;
	} catch (err: unknown) {
		console.error('PROXY ERR:', err);

		// On thrown errors after a successful acquire, release the token with a
		// synthetic 599 status so its inFlightCount returns to zero. Best effort.
		const acquiredLabel = c.var.acquiredLabel;
		const acquiredRequestId = c.var.acquiredRequestId;
		const client = c.var.tokenPoolClient;
		if (acquiredLabel && acquiredRequestId && client) {
			const routeKey = deriveRouteKey(method, url.pathname);
			try {
				await client.release(acquiredLabel, acquiredRequestId, { status: 599, routeKey });
			} catch (releaseErr: unknown) {
				console.error('PROXY ERR: release also failed:', releaseErr);
			}
		}
		return c.json({ error: 'Proxy error' }, 500);
	}
});

/**
 * Apply the per-kind client identification headers to a Headers object.
 *
 * - bot: only `User-Agent: DiscordBot (..., <build hash>)`. No super-properties.
 * - user-*: full browser fingerprint header set composed from the resolved
 *   profile and current Discord client `build_number`.
 *
 * Profile resolution order: acquired -> static -> FALLBACK_PROFILE_ID.
 */
async function applyClientHeaders(
	c: { var: DiscordContextVariables & RotatorVariables; env: Bindings },
	headers: Headers,
	kind: DiscordTokenKind,
): Promise<void> {
	if (kind === 'bot') {
		headers.set('User-Agent', composeBotUserAgent(BUILD_HASH));
		return;
	}

	const profileId =
		c.var.acquiredFingerprintProfileId ??
		c.var.staticFingerprintProfileId ??
		FALLBACK_PROFILE_ID;
	const profile = lookupProfile(profileId) ?? lookupProfile(FALLBACK_PROFILE_ID);
	if (!profile) {
		console.error('Unknown fingerprint profile and FALLBACK_PROFILE_ID is unresolvable:', profileId);
		return;
	}

	const buildNumber = await resolveBuildNumber(c.var.tokenPoolClient);
	const fingerprintHeaders = composeFingerprint(profile, buildNumber);
	for (const [k, v] of Object.entries(fingerprintHeaders)) {
		headers.set(k, v);
	}
}

/**
 * Rewrite User-Agent + X-Super-Properties + X-Discord-Locale + ... when the
 * proxy retries with a different pool token. Falls back to the existing
 * headers if profile lookup fails.
 */
function rewriteFingerprintForRetry(
	headers: Headers,
	profileId: string | undefined,
	c: { var: DiscordContextVariables & RotatorVariables },
): void {
	const id = profileId ?? c.var.staticFingerprintProfileId ?? FALLBACK_PROFILE_ID;
	const profile = lookupProfile(id) ?? lookupProfile(FALLBACK_PROFILE_ID);
	if (!profile) return;
	// Reuse the existing X-Super-Properties build_number; rebuilding it would
	// require a second DO read on the retry path.
	const xsp = headers.get('X-Super-Properties');
	let buildNumber = FALLBACK_BUILD_NUMBER;
	if (xsp) {
		buildNumber = decodeBuildNumberFromSuperProps(xsp) ?? FALLBACK_BUILD_NUMBER;
	}
	const newHeaders = composeFingerprint(profile, buildNumber);
	for (const [k, v] of Object.entries(newHeaders)) {
		headers.set(k, v);
	}
}

/**
 * Decode the embedded `client_build_number` from a base64 `X-Super-Properties`
 * header. Returns undefined when the header is missing or malformed.
 */
function decodeBuildNumberFromSuperProps(base64Value: string): number | undefined {
	try {
		const binary = atob(base64Value);
		const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
		const json = new TextDecoder().decode(bytes);
		const parsed = JSON.parse(json) as { client_build_number?: number };
		if (typeof parsed.client_build_number === 'number') return parsed.client_build_number;
	} catch (err: unknown) {
		console.error('decode X-Super-Properties failed:', err);
	}
	return undefined;
}

/**
 * Read the current Discord build number through the pool client when
 * available; fall back to FALLBACK_BUILD_NUMBER otherwise. One DO round trip
 * per request (the build-number meta key is small).
 */
async function resolveBuildNumber(client: TokenPoolClient | undefined): Promise<number> {
	if (!client?.getBuildNumberRecord) return FALLBACK_BUILD_NUMBER;
	try {
		const record = await client.getBuildNumberRecord();
		return selectBuildNumber(record, Date.now());
	} catch (err: unknown) {
		console.error('build-number read failed:', err);
		return FALLBACK_BUILD_NUMBER;
	}
}
