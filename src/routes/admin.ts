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
 *   POST   /admin/tokens                 register
 *   DELETE /admin/tokens/:label          unregister (idempotent)
 *   GET    /admin/tokens                 list (no tokenSecret in response)
 *   POST   /admin/tokens/:label/reset    clear consecutive401s + invalid status
 *   GET    /admin/health                 per-slot rollup
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import { enforcePoolCap, validateRegisterInput } from '../rotator/validators';
import type { RegisterInput } from '../rotator/types';
import type { TokenPoolDO } from '../rotator/do';

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
		if (!label || !/^[A-Za-z0-9._-]+$/.test(label) || label.length > 64) {
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
		if (!label || !/^[A-Za-z0-9._-]+$/.test(label) || label.length > 64) {
			return c.json({ error: 'invalid request' }, 400);
		}
		const stub = poolStub(c.env);
		const result = await stub.reset(label);
		if (!result.ok) {
			return c.json({ error: 'invalid request' }, 400);
		}
		return c.json({ ok: true });
	});

	// GET /admin/health
	admin.get('/health', async (c) => {
		const stub = poolStub(c.env);
		const health = await stub.health();
		return c.json(health);
	});

	return admin;
}
