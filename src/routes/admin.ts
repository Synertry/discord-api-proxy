/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/admin
 * Admin sub-app for token-pool registry management.
 *
 * Mounted at `/admin` BEFORE the main sieve so it has its own auth chain.
 * Auth key is `AUTH_KEY_ADMIN` (distinct from `AUTH_KEY` and `AUTH_KEY_PREMIUM`)
 * to prevent privilege escalation by ordinary proxy consumers.
 *
 * NOT exported in the public OpenAPI doc - this is a separate `OpenAPIHono`
 * instance whose `.doc()` is intentionally never called by the parent app.
 *
 * Endpoints (all M2M, no CORS):
 *   POST   /admin/tokens                          register
 *   DELETE /admin/tokens/:label                   unregister (idempotent)
 *   GET    /admin/tokens                          list (no tokenSecret in response)
 *   POST   /admin/tokens/:label/reset             clear consecutive401s + invalid status
 *   POST   /admin/tokens/:label/fingerprint       set fingerprintProfileId override
 *   GET    /admin/health                          per-slot rollup
 *   GET    /admin/fingerprint/profiles            list known fingerprint profile ids
 *   GET    /admin/static-fingerprint              get the static-token fingerprint mapping
 *   POST   /admin/static-fingerprint              set fingerprint identity for a static-token kind
 *   GET    /admin/build-number                    current Discord build_number record
 *   POST   /admin/build-number/refresh            synchronous scrape + persist
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';
import { FALLBACK_PROFILE_ID, listProfileIds } from '../fingerprint/profiles';
import { refreshBuildNumber } from '../scheduled/build-number-refresh';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import { isKnownProfileId, type TokenPoolDO } from '../rotator/do';
import { enforcePoolCap, validateRegisterInput } from '../rotator/validators';
import type { RegisterInput, StaticTokenKind } from '../rotator/types';

const STATIC_KINDS: ReadonlySet<StaticTokenKind> = new Set<StaticTokenKind>(['user-default', 'user-premium']);
const LABEL_REGEX = /^[A-Za-z0-9._-]+$/;
const LABEL_MAX_LEN = 64;

/** Constant-time bearer comparison; same shape as src/middleware/auth.ts */
function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.byteLength !== bBytes.byteLength) {
		// Constant-time-shaped failure: dummy compare then false
		crypto.subtle.timingSafeEqual(aBytes, aBytes);
		return false;
	}
	return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

/**
 * Admin authentication middleware. Fail-closed: if `AUTH_KEY_ADMIN` is not
 * configured, every admin endpoint returns 503 (rather than silently letting
 * `AUTH_KEY` accept admin operations).
 */
const adminAuthMiddleware = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
	if (!c.env.AUTH_KEY_ADMIN) {
		return c.json({ error: 'Service misconfigured' }, 503);
	}

	const provided =
		c.req.header('x-auth-key') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	if (!provided) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
	if (!timingSafeEqual(provided, c.env.AUTH_KEY_ADMIN)) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
	await next();
});

/** Resolve the DO stub for admin operations. */
function poolStub(env: Bindings) {
	return getPoolStub(env) as unknown as DurableObjectStub<TokenPoolDO>;
}

/** Validate a label path param. Returns true when usable. */
function isValidLabel(label: string | undefined): label is string {
	return !!label && LABEL_REGEX.test(label) && label.length <= LABEL_MAX_LEN;
}

/**
 * Build the admin sub-app. Returns an `OpenAPIHono` instance; the caller mounts
 * it via `app.route('/admin', adminRoutes)` in `src/index.ts` BEFORE the main
 * sieve so admin traffic skips the proxy auth chain.
 */
export function buildAdminRoutes(): OpenAPIHono<{ Bindings: Bindings }> {
	const admin = new OpenAPIHono<{ Bindings: Bindings }>();

	admin.use('*', adminAuthMiddleware);

	// POST /admin/tokens
	admin.post('/tokens', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (err: unknown) {
			void err;
			return c.json({ error: 'invalid request' }, 400);
		}

		const validation = validateRegisterInput(body);
		if (!validation.ok) {
			return c.json({ error: validation.error }, 400);
		}
		const input: RegisterInput = validation.value;

		const stub = poolStub(c.env);
		const client = createTokenPoolClient(stub);
		void client; // not used here; we call the DO RPC directly for register

		const count = await stub.countSlot(input.slot);
		const cap = enforcePoolCap(count);
		if (!cap.ok) {
			return c.json({ error: cap.error }, 400);
		}

		const result = await stub.register(input);
		if (!result.ok) {
			// Constant-time error shape: same generic message as format/cap errors
			return c.json({ error: 'invalid request' }, 400);
		}
		return c.json({ label: result.label, registeredAt: result.registeredAt }, 201);
	});

	// DELETE /admin/tokens/:label
	admin.delete('/tokens/:label', async (c) => {
		const label = c.req.param('label');
		if (!isValidLabel(label)) {
			return c.json({ error: 'invalid request' }, 400);
		}
		const stub = poolStub(c.env);
		await stub.unregister(label);
		return c.body(null, 204);
	});

	// GET /admin/tokens
	admin.get('/tokens', async (c) => {
		const stub = poolStub(c.env);
		const tokens = await stub.list();
		return c.json({ tokens });
	});

	// POST /admin/tokens/:label/reset
	admin.post('/tokens/:label/reset', async (c) => {
		const label = c.req.param('label');
		if (!isValidLabel(label)) {
			return c.json({ error: 'invalid request' }, 400);
		}
		const stub = poolStub(c.env);
		const result = await stub.reset(label);
		if (!result.ok) {
			return c.json({ error: 'invalid request' }, 400);
		}
		return c.json({ ok: true });
	});

	// POST /admin/tokens/:label/fingerprint
	admin.post('/tokens/:label/fingerprint', async (c) => {
		const label = c.req.param('label');
		if (!isValidLabel(label)) {
			return c.json({ error: 'invalid request' }, 400);
		}
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (err: unknown) {
			void err;
			return c.json({ error: 'invalid request' }, 400);
		}
		const profileId = (body as { profileId?: unknown })?.profileId;
		if (typeof profileId !== 'string' || !isKnownProfileId(profileId)) {
			return c.json({ error: 'invalid request' }, 400);
		}
		const stub = poolStub(c.env);
		const result = await stub.setTokenFingerprintProfile(label, profileId);
		if (!result.ok) {
			return c.json({ error: 'invalid request' }, 400);
		}
		return c.json({ ok: true, label, profileId });
	});

	// GET /admin/health
	admin.get('/health', async (c) => {
		const stub = poolStub(c.env);
		const health = await stub.health();
		return c.json(health);
	});

	// GET /admin/fingerprint/profiles
	admin.get('/fingerprint/profiles', (c) => {
		return c.json({
			profileIds: listProfileIds(),
			fallbackProfileId: FALLBACK_PROFILE_ID,
		});
	});

	// GET /admin/static-fingerprint
	admin.get('/static-fingerprint', async (c) => {
		const stub = poolStub(c.env);
		const mapping = await stub.listStaticFingerprints();
		return c.json(mapping);
	});

	// POST /admin/static-fingerprint
	admin.post('/static-fingerprint', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (err: unknown) {
			void err;
			return c.json({ error: 'invalid request' }, 400);
		}
		const kind = (body as { kind?: unknown })?.kind;
		const profileId = (body as { profileId?: unknown })?.profileId;
		if (typeof kind !== 'string' || !STATIC_KINDS.has(kind as StaticTokenKind)) {
			return c.json({ error: 'invalid request' }, 400);
		}
		if (typeof profileId !== 'string' || !isKnownProfileId(profileId)) {
			return c.json({ error: 'invalid request' }, 400);
		}
		const stub = poolStub(c.env);
		await stub.setStaticFingerprint(kind as StaticTokenKind, profileId);
		return c.json({ ok: true, kind, profileId });
	});

	// GET /admin/build-number
	admin.get('/build-number', async (c) => {
		const stub = poolStub(c.env);
		const record = await stub.getBuildNumberRecord();
		return c.json(record);
	});

	// POST /admin/build-number/refresh
	admin.post('/build-number/refresh', async (c) => {
		const record = await refreshBuildNumber(c.env);
		if (!record) {
			return c.json({ error: 'scrape failed' }, 502);
		}
		return c.json(record);
	});

	return admin;
}
