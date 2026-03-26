/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/proxy.spec
 * Integration tests for the catch-all Discord API proxy and rate limit interceptor.
 *
 * Uses {@link createApp} with a mock fetch to verify:
 * - Correct URL rewriting to `discord.com/api/v10`
 * - Authorization header injection (bot token by default, user token for guild paths)
 * - Host header stripping (prevents sending our proxy's domain to Discord)
 * - Custom client headers are forwarded
 * - 429 rate limit responses are intercepted and reformatted
 */

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/index';
import type { Bindings } from '../../src/types';
import { BROWSER_USER_AGENT } from '../../src/middleware/discord-context';

describe('Proxy Route & Introspection (Integration)', () => {
  it('should route proxy requests correctly to Discord API with correct headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = createApp(mockFetch as unknown as typeof fetch);

    const MOCK_ENV: Bindings = {
      AUTH_KEY: 'secret-key',
      DISCORD_TOKEN_BOT: 'bot-token',
      DISCORD_TOKEN_USER: 'user-token',
    };

    const req = new Request('http://localhost/users/@me', {
      method: 'GET',
      headers: {
        'x-auth-key': 'secret-key',
        Host: 'localhost',
        'Custom-Client-Header': '123',
      },
    });

    const res = await app.request(req, undefined, MOCK_ENV);
    const text = await res.text();
    expect(res.status === 200 ? '200' : `STATUS: ${res.status} TEXT: ${text}`).toBe('200');
    const json = JSON.parse(text);
    expect(json).toEqual({ success: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callUrl = mockFetch.mock.calls[0][0] as string;
    const callInit = mockFetch.mock.calls[0][1] as RequestInit;
    const callHeaders = callInit.headers as Headers;
    expect(callUrl).toBe('https://discord.com/api/v10/users/@me');
    expect(callHeaders.get('Authorization')).toBe('Bot bot-token');
    expect(callHeaders.has('Host')).toBe(false);
    expect(callHeaders.get('Custom-Client-Header')).toBe('123');
  });

  it('should pass User-Agent if path targets /guilds', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch);

    const MOCK_ENV: Bindings = {
      AUTH_KEY: 'secret-key',
      DISCORD_TOKEN_BOT: 'bot-token',
      DISCORD_TOKEN_USER: 'user-token',
    };

    const req = new Request('http://localhost/users/@me/guilds', {
      method: 'GET',
      headers: { 'x-auth-key': 'secret-key' },
    });

    const res = await app.request(req, undefined, MOCK_ENV);
    const text = await res.text();
    expect(res.status === 200 ? '200' : `STATUS: ${res.status} TEXT: ${text}`).toBe('200');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callInit = mockFetch.mock.calls[0][1] as RequestInit;
    const callHeaders = callInit.headers as Headers;
    expect(callHeaders.get('Authorization')).toBe('user-token');
    expect(callHeaders.get('User-Agent')).toBe(BROWSER_USER_AGENT);
  });

  it('should intercept 429 Too Many Requests and format response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: { 'Retry-After': '1.5' },
      }),
    );
    const app = createApp(mockFetch as unknown as typeof fetch);

    const MOCK_ENV: Bindings = {
      AUTH_KEY: 'secret-key',
      DISCORD_TOKEN_BOT: 'bot-token',
      DISCORD_TOKEN_USER: 'user-token',
    };

    const req = new Request('http://localhost/users/@me', {
      method: 'GET',
      headers: { 'x-auth-key': 'secret-key' },
    });

    const res = await app.request(req, undefined, MOCK_ENV);
    const text = await res.text();
    expect(res.status === 429 ? '429' : `STATUS: ${res.status} TEXT: ${text}`).toBe('429');
    const body = JSON.parse(text);
    expect(body).toEqual({
      error: 'Too Many Requests',
      retryAfter: 1.5,
    });
  });

  it('should preserve Retry-After and X-RateLimit-* headers on 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: {
          'Retry-After': '2.0',
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset-After': '2.0',
        },
      }),
    );
    const app = createApp(mockFetch as unknown as typeof fetch);

    const MOCK_ENV: Bindings = {
      AUTH_KEY: 'secret-key',
      DISCORD_TOKEN_BOT: 'bot-token',
      DISCORD_TOKEN_USER: 'user-token',
    };

    const req = new Request('http://localhost/users/@me', {
      method: 'GET',
      headers: { 'x-auth-key': 'secret-key' },
    });

    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('2.0');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('X-RateLimit-Reset-After')).toBe('2.0');
  });
});
