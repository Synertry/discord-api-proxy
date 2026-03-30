/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/auth.spec
 * Tests for the authentication middleware.
 *
 * Verifies rejection of missing/invalid API keys and acceptance via both
 * `x-auth-key` custom header and `Authorization` header (with and without
 * `Bearer` prefix).
 */

import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { authMiddleware } from '../../src/middleware/auth';
import type { Bindings } from '../../src/types';

describe('Auth Middleware', () => {
  /** Minimal Hono app with only the auth middleware and a success handler. */
  const app = new OpenAPIHono<{ Bindings: Bindings }>();
  app.use('*', authMiddleware);
  app.get('/', (c) => c.text('OK'));

  /** Test environment bindings. */
  const MOCK_ENV: Bindings = {
    AUTH_KEY: 'secret-key',
    DISCORD_TOKEN_BOT: 'bot-token',
    DISCORD_TOKEN_USER: 'user-token',
  };

  it('should return 401 if API key is missing', async () => {
    const res = await app.request('http://localhost/', {}, MOCK_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('should return 401 if API key is invalid', async () => {
    const res = await app.request(
      'http://localhost/',
      {
        headers: {
          'x-auth-key': 'wrong-key',
        },
      },
      MOCK_ENV,
    );
    expect(res.status).toBe(401);
  });

  it('should allow request with valid X-Auth-Key', async () => {
    const res = await app.request(
      'http://localhost/',
      {
        headers: {
          'x-auth-key': 'secret-key',
        },
      },
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('should allow request with valid Authorization header', async () => {
    const res = await app.request(
      'http://localhost/',
      {
        headers: {
          Authorization: 'secret-key',
        },
      },
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
  });

  it('should allow request with valid Authorization Bearer header', async () => {
    const res = await app.request(
      'http://localhost/',
      {
        headers: {
          Authorization: 'Bearer secret-key',
        },
      },
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
  });

  it('should return 503 if AUTH_KEY is not configured', async () => {
    const envWithoutAuthKey = { ...MOCK_ENV, AUTH_KEY: '' };
    const res = await app.request(
      'http://localhost/',
      {
        headers: { 'x-auth-key': 'secret-key' },
      },
      envWithoutAuthKey,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'Service misconfigured' });
  });
});
