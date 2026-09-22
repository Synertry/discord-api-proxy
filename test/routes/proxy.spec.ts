/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/proxy.spec
 * Integration tests for the catch-all Discord API proxy: header allowlist,
 * fingerprint composition, message-body fill, opt-in typing, and - since
 * `proxy.ts` is now the only place that ever pairs acquire/release or
 * lease/settle - the pool-acquire and static-guard behaviors that used to
 * live in `test/middleware/token-rotator.spec.ts` (see that file's own
 * header comment: its cases move here, then it is deleted).
 *
 * `discordContextMiddleware` only picks a user token automatically for a
 * path containing `/guilds`; every other user-kind request in this file
 * sets `x-proxy-context: user` explicitly.
 */

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/index';
import type { Bindings } from '../../src/types';
import { composeBotUserAgent } from '../../src/fingerprint/compose';
import { FALLBACK_PROFILE_ID, resolveProfileId } from '../../src/fingerprint/profiles';
import { FALLBACK_CHROME_MAJOR } from '../../src/fingerprint/versions';
import type { AcquireResult, ReleaseInput, TokenPoolClient } from '../../src/rotator/types';

const MOCK_ENV: Bindings = {
  AUTH_KEY: 'secret-key',
  DISCORD_TOKEN_BOT: 'bot-token',
  DISCORD_TOKEN_USER: 'user-token',
  TOKEN_POOL: {} as DurableObjectNamespace,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function callInit(mockFetch: ReturnType<typeof vi.fn>, index = 0): RequestInit {
  return mockFetch.mock.calls[index][1] as RequestInit;
}

function callHeaders(mockFetch: ReturnType<typeof vi.fn>, index = 0): Headers {
  return callInit(mockFetch, index).headers as Headers;
}

function callUrl(mockFetch: ReturnType<typeof vi.fn>, index = 0): string {
  return mockFetch.mock.calls[index][0] as string;
}

describe('Proxy Route (bot path)', () => {
  it('forwards bot-token requests with a Discord-compliant bot UA and no super-properties', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    const app = createApp(mockFetch as unknown as typeof fetch);

    const req = new Request('http://localhost/users/@me', {
      method: 'GET',
      headers: { 'x-auth-key': 'secret-key', Host: 'localhost', 'Custom-Client-Header': '123' },
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(callUrl(mockFetch)).toBe('https://discord.com/api/v10/users/@me');
    const headers = callHeaders(mockFetch);
    expect(headers.get('Authorization')).toBe('Bot bot-token');
    expect(headers.has('Host')).toBe(false);
    // Custom-Client-Header is not on the forwarding allowlist - the old
    // clone-everything-except-a-blocklist behavior is gone; this now drops.
    expect(headers.has('Custom-Client-Header')).toBe(false);
    expect(headers.get('User-Agent')).toMatch(/^DiscordBot \(/);
    expect(headers.get('X-Super-Properties')).toBeNull();
  });

  it('uses BUILD_HASH in the bot User-Agent', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request('http://localhost/users/@me', { headers: { 'x-auth-key': 'secret-key' } });
    await app.request(req, undefined, MOCK_ENV);
    expect(callHeaders(mockFetch).get('User-Agent')).toBe(composeBotUserAgent(BUILD_HASH));
  });

  it('every outbound bot dispatch carries an AbortSignal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    await app.request(new Request('http://localhost/users/@me', { headers: { 'x-auth-key': 'secret-key' } }), undefined, MOCK_ENV);
    expect(callInit(mockFetch).signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards allowlisted inbound headers on a bot POST/PATCH (e.g. Content-Type for a JSON body)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request('http://localhost/channels/123456789012345678/messages', {
      method: 'POST',
      headers: { 'x-auth-key': 'secret-key', 'content-type': 'application/json', 'x-audit-log-reason': 'automod' },
      body: JSON.stringify({ content: 'hi' }),
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);
    const headers = callHeaders(mockFetch);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Audit-Log-Reason')).toBe('automod');
  });
});

describe('Proxy Route (static user path, header allowlist + fingerprint)', () => {
  it('forwards user-token requests with the FALLBACK fingerprint header set on /guilds paths', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch);

    const req = new Request('http://localhost/users/@me/guilds', { method: 'GET', headers: { 'x-auth-key': 'secret-key' } });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);

    const headers = callHeaders(mockFetch);
    expect(headers.get('Authorization')).toBe('user-token');
    const fallback = resolveProfileId(FALLBACK_PROFILE_ID, FALLBACK_CHROME_MAJOR);
    expect(headers.get('User-Agent')).toBe(fallback.userAgent);
    expect(headers.get('X-Super-Properties')).toBeTruthy();
    expect(headers.get('X-Discord-Locale')).toBe(fallback.locale);
    expect(headers.get('X-Debug-Options')).toBe('bugReporterEnabled');
    expect(headers.get('Origin')).toBe('https://discord.com');
    expect(headers.get('Referer')).toBe('https://discord.com/channels/@me');
    expect(headers.get('Sec-CH-UA')).toBeTruthy();
    expect(headers.get('X-Discord-Timezone')).toBeTruthy();
  });

  it('drops cf-*, x-forwarded-*, and the caller-supplied User-Agent, but keeps allowlisted headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch);

    const req = new Request('http://localhost/users/@me/guilds', {
      method: 'GET',
      headers: {
        'x-auth-key': 'secret-key',
        'cf-connecting-ip': '203.0.113.1',
        'x-forwarded-for': '203.0.113.1',
        'cf-ipcountry': 'DE',
        'user-agent': 'Bun/1.2',
        'x-audit-log-reason': 'because',
      },
    });
    await app.request(req, undefined, MOCK_ENV);

    const headers = callHeaders(mockFetch);
    expect(headers.has('cf-connecting-ip')).toBe(false);
    expect(headers.has('x-forwarded-for')).toBe(false);
    expect(headers.has('cf-ipcountry')).toBe(false);
    expect(headers.get('User-Agent')).not.toBe('Bun/1.2');
    expect(headers.get('X-Audit-Log-Reason')).toBe('because');
  });

  it('strips X-Proxy-Token and X-Proxy-Typing from the forwarded request', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const app = createApp(mockFetch as unknown as typeof fetch);

    const req = new Request('http://localhost/users/@me', {
      method: 'GET',
      headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user', 'X-Proxy-Token': 'static', 'X-Proxy-Typing': 'on' },
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);
    const headers = callHeaders(mockFetch);
    expect(headers.has('x-proxy-token')).toBe(false);
    expect(headers.has('x-proxy-typing')).toBe(false);
  });
});

describe('Proxy Route (429 interceptor)', () => {
  it('intercepts a genuine Discord 429 and reformats the response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Rate limited', { status: 429, headers: { 'Retry-After': '1.5' } }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request('http://localhost/users/@me', { method: 'GET', headers: { 'x-auth-key': 'secret-key' } });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe('Too Many Requests');
    expect(body.retryAfter).toBe(1.5);
  });

  it('preserves Retry-After and X-RateLimit-* headers on a genuine 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Rate limited', {
        status: 429,
        headers: { 'Retry-After': '2.0', 'X-RateLimit-Limit': '5', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '2.0' },
      }),
    );
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request('http://localhost/users/@me', { method: 'GET', headers: { 'x-auth-key': 'secret-key' } });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('2.0');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
  });

  it('preserves X-Proxy-Block through the reformat when the guard itself blocked the request', async () => {
    const mockFetch = vi.fn();
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 0 }),
      release: async () => undefined,
      prepareStatic: async () => ({ fingerprint: null, versions: { build: null, chrome: null }, block: null }),
      leaseStatic: async () => ({ ok: false, block: { reason: 'cooldown', retryAfter: 5000, signal: 'captcha' } }),
      settleStatic: async () => undefined,
    };
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const req = new Request('http://localhost/users/@me', {
      method: 'GET',
      headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user' },
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(429);
    expect(res.headers.get('X-Proxy-Block')).toBe('captcha');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('Proxy Route (message-send body fill and opt-in typing)', () => {
  function messagesUrl(id = '123456789012345678') {
    return `http://localhost/channels/${id}/messages`;
  }

  it('fills nonce/tts/flags on a JSON message-send body and sets X-Context-Properties', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request(messagesUrl(), {
      method: 'POST',
      headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = callInit(mockFetch);
    const sent = JSON.parse(init.body as string) as { content: string; nonce: string; tts: boolean; flags: number };
    expect(sent.content).toBe('hi');
    expect(sent.nonce).toMatch(/^\d{17,20}$/);
    expect(sent.tts).toBe(false);
    expect(sent.flags).toBe(0);
    expect(callHeaders(mockFetch).get('X-Context-Properties')).toBe('eyJsb2NhdGlvbiI6ImNoYXRfaW5wdXQifQ==');
  });

  it('does not overwrite an already-present nonce/tts/flags', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request(messagesUrl(), {
      method: 'POST',
      headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', nonce: 'caller-nonce', tts: true, flags: 64 }),
    });
    await app.request(req, undefined, MOCK_ENV);
    const sent = JSON.parse(callInit(mockFetch).body as string) as { nonce: string; tts: boolean; flags: number };
    expect(sent.nonce).toBe('caller-nonce');
    expect(sent.tts).toBe(true);
    expect(sent.flags).toBe(64);
  });

  it('forwards a malformed JSON body unchanged rather than crashing', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request(messagesUrl(), {
      method: 'POST',
      headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user', 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);
    expect(callInit(mockFetch).body).toBe('{not json');
  });

  it('with X-Proxy-Typing: on, dispatches /typing before /messages and waits at least 1000ms between them', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/typing')) return new Response(null, { status: 204 });
      return jsonResponse({ id: '1' });
    });
    const waitedMs: number[] = [];
    const app = createApp(mockFetch as unknown as typeof fetch, undefined, async (ms: number) => {
      waitedMs.push(ms);
    });
    const req = new Request(messagesUrl(), {
      method: 'POST',
      headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user', 'content-type': 'application/json', 'X-Proxy-Typing': 'on' },
      body: JSON.stringify({ content: 'hello there' }),
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(callUrl(mockFetch, 0)).toContain('/typing');
    expect(callUrl(mockFetch, 1)).toContain('/messages');
    expect(waitedMs.length).toBeGreaterThanOrEqual(1);
    expect(waitedMs[0]).toBeGreaterThanOrEqual(1000);
  });

  it('without X-Proxy-Typing, dispatches only /messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    const req = new Request(messagesUrl(), {
      method: 'POST',
      headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello there' }),
    });
    await app.request(req, undefined, MOCK_ENV);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(callUrl(mockFetch, 0)).toContain('/messages');
  });

  it('recomputes Content-Length after filling nonce/tts/flags grows the body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const app = createApp(mockFetch as unknown as typeof fetch);
    // A multibyte character means UTF-16 .length and UTF-8 byte length diverge,
    // so a naive .length-based Content-Length would still pass a weaker test.
    const originalBody = JSON.stringify({ content: '💩' });
    const req = new Request(messagesUrl(), {
      method: 'POST',
      headers: {
        'x-auth-key': 'secret-key',
        'x-proxy-context': 'user',
        'content-type': 'application/json',
        'content-length': String(originalBody.length),
      },
      body: originalBody,
    });
    await app.request(req, undefined, MOCK_ENV);
    const init = callInit(mockFetch);
    const sentBody = init.body as string;
    const declaredLength = Number(callHeaders(mockFetch).get('Content-Length'));
    expect(sentBody.length).toBeGreaterThan(originalBody.length); // filled body grew past the original
    expect(declaredLength).toBe(new TextEncoder().encode(sentBody).byteLength);
    expect(declaredLength).not.toBe(sentBody.length); // the multibyte emoji makes byte length != UTF-16 length
  });
});

describe('Proxy Route (pool acquire, auto selector)', () => {
  it('rotates on a pool-eligible route and uses the acquired secret', async () => {
    const acquire = vi.fn(async (): Promise<AcquireResult> => ({
      ok: true,
      label: 'tok-3',
      tokenSecret: 'POOLED_SECRET',
      requestId: 'req-1',
      fingerprintProfileId: 'chrome-win-de',
    }));
    const release = vi.fn(async () => undefined);
    const client: TokenPoolClient = { acquire, release };
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch, client);

    const req = new Request('http://localhost/guilds/219564597349318656/messages/search?author_id=999', {
      headers: { 'x-auth-key': 'secret-key' },
    });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);
    expect(callHeaders(mockFetch).get('Authorization')).toBe('POOLED_SECRET');
    expect(acquire).toHaveBeenCalledWith('default', 'GET:/guilds/:id/messages/search', '219564597349318656');
    expect(release).toHaveBeenCalledWith('tok-3', 'req-1', expect.objectContaining({ status: 200 }));
  });

  it('returns 429 with Retry-After when the pool is fully cooling', async () => {
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'cooldown', retryAfter: 4500 }),
      release: async () => undefined,
    };
    const mockFetch = vi.fn();
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const req = new Request('http://localhost/guilds/219564597349318656/messages/search', { headers: { 'x-auth-key': 'secret-key' } });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { retryAfter: number };
    expect(body.retryAfter).toBe(5);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls through to the static token when the pool is empty (graceful fallback)', async () => {
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 60_000 }),
      release: async () => undefined,
    };
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const req = new Request('http://localhost/guilds/219564597349318656/messages/search', { headers: { 'x-auth-key': 'secret-key' } });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(200);
    expect(callHeaders(mockFetch).get('Authorization')).toBe('user-token');
  });

  it('returns 503 when acquire throws (e.g. binding misconfigured)', async () => {
    const client: TokenPoolClient = {
      acquire: async () => {
        throw new Error('DO offline');
      },
      release: async () => undefined,
    };
    const mockFetch = vi.fn();
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const req = new Request('http://localhost/guilds/219564597349318656/messages/search', { headers: { 'x-auth-key': 'secret-key' } });
    const res = await app.request(req, undefined, MOCK_ENV);
    expect(res.status).toBe(503);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks rotation on POST /channels/:id/messages (message authorship stays static-only)', async () => {
    const acquire = vi.fn();
    const client: TokenPoolClient = { acquire, release: vi.fn() };
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/channels/123456789012345678/messages', {
        method: 'POST',
        headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user', 'content-type': 'application/json' },
        body: '{}',
      }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('retries once on a pool 429, waiting the shared backoff before the fresh acquire', async () => {
    let acquireCalls = 0;
    const acquire = vi.fn(async (): Promise<AcquireResult> => {
      acquireCalls += 1;
      return {
        ok: true,
        label: `tok-${acquireCalls}`,
        tokenSecret: `SECRET_${acquireCalls}`,
        requestId: `req-${acquireCalls}`,
        fingerprintProfileId: 'chrome-win-de',
      };
    });
    const release = vi.fn(async () => undefined);
    const client: TokenPoolClient = { acquire, release };
    const mockFetch = vi.fn().mockImplementation(async () => {
      if (acquireCalls === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '1' } });
      return new Response('OK', { status: 200 });
    });
    const waitedMs: number[] = [];
    const app = createApp(mockFetch as unknown as typeof fetch, client, async (ms: number) => {
      waitedMs.push(ms);
    });
    const res = await app.request(
      new Request('http://localhost/guilds/219564597349318656/messages/search', { headers: { 'x-auth-key': 'secret-key' } }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(callHeaders(mockFetch, 1).get('Authorization')).toBe('SECRET_2');
    expect(waitedMs.length).toBe(1);
    expect(waitedMs[0]).toBeGreaterThanOrEqual(1000);
    expect(release).toHaveBeenCalledWith('tok-1', 'req-1', expect.objectContaining({ status: 429 }));
    expect(release).toHaveBeenCalledWith('tok-2', 'req-2', expect.objectContaining({ status: 200 }));
  });

  it('releases the retry token when the retry dispatch itself throws (no lease leak)', async () => {
    let acquireCalls = 0;
    const acquire = vi.fn(async (): Promise<AcquireResult> => {
      acquireCalls += 1;
      return {
        ok: true,
        label: `tok-${acquireCalls}`,
        tokenSecret: `SECRET_${acquireCalls}`,
        requestId: `req-${acquireCalls}`,
        fingerprintProfileId: 'chrome-win-de',
      };
    });
    const release = vi.fn(async () => undefined);
    const client: TokenPoolClient = { acquire, release };
    const mockFetch = vi.fn().mockImplementation(async () => {
      if (acquireCalls === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '1' } });
      throw new Error('network down on retry');
    });
    const app = createApp(mockFetch as unknown as typeof fetch, client, async () => undefined);
    const res = await app.request(
      new Request('http://localhost/guilds/219564597349318656/messages/search', { headers: { 'x-auth-key': 'secret-key' } }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(500);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith('tok-1', 'req-1', expect.objectContaining({ status: 429 }));
    expect(release).toHaveBeenCalledWith('tok-2', 'req-2', expect.objectContaining({ status: 599 }));
  });
});

describe('Proxy Route (pool acquire, pinned label selector - no graceful fallback)', () => {
  it('pins via acquireByLabel and uses the returned secret', async () => {
    const acquire = vi.fn();
    const acquireByLabel = vi.fn(async (): Promise<AcquireResult> => ({
      ok: true,
      label: 'tok-local',
      tokenSecret: 'PINNED_SECRET',
      requestId: 'req-pin',
      fingerprintProfileId: 'chrome-win-de',
    }));
    const client: TokenPoolClient = { acquire, acquireByLabel, release: vi.fn(async () => undefined) };
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/guilds/219564597349318656/messages/search', {
        headers: { 'x-auth-key': 'secret-key', 'X-Proxy-Token': 'tok-local' },
      }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
    expect(callHeaders(mockFetch).get('Authorization')).toBe('PINNED_SECRET');
    expect(acquire).not.toHaveBeenCalled();
    expect(acquireByLabel).toHaveBeenCalledWith('tok-local', 'default', 'GET:/guilds/:id/messages/search', '219564597349318656');
  });

  it('returns 503 when the pinned label is not found (no graceful fallback)', async () => {
    const acquireByLabel = vi.fn(async (): Promise<AcquireResult> => ({ ok: false, reason: 'no-eligible-token', retryAfter: 60_000 }));
    const client: TokenPoolClient = { acquire: vi.fn(), acquireByLabel, release: vi.fn() };
    const mockFetch = vi.fn();
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/guilds/219564597349318656/messages/search', {
        headers: { 'x-auth-key': 'secret-key', 'X-Proxy-Token': 'nonexistent' },
      }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('no-eligible-token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 503 if the client lacks acquireByLabel entirely', async () => {
    const client: TokenPoolClient = { acquire: vi.fn(), release: vi.fn() };
    const mockFetch = vi.fn();
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/guilds/219564597349318656/messages/search', {
        headers: { 'x-auth-key': 'secret-key', 'X-Proxy-Token': 'tok-1' },
      }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(503);
  });
});

describe('Proxy Route (static-identity guard: lease-at-point-of-use)', () => {
  it('leases immediately before dispatch and settles immediately after, on the non-rotatable static path', async () => {
    const lease = vi.fn(async (_identityHash: string, _routeKey: string) => ({ ok: true as const, requestId: 'lease-1' }));
    const settle = vi.fn(async (_identityHash: string, _requestId: string, _outcome: ReleaseInput) => undefined);
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 0 }),
      release: async () => undefined,
      prepareStatic: async () => ({ fingerprint: null, versions: { build: null, chrome: null }, block: null }),
      leaseStatic: lease,
      settleStatic: settle,
    };
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/users/@me', { headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user' } }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
    expect(lease).toHaveBeenCalledWith(expect.any(String), 'GET:/users/@me');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][1]).toBe('lease-1');
    expect(settle.mock.calls[0][2].status).toBe(200);
  });

  it('returns 429 + X-Proxy-Block and never dispatches when leaseStatic blocks', async () => {
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 0 }),
      release: async () => undefined,
      prepareStatic: async () => ({ fingerprint: null, versions: { build: null, chrome: null }, block: null }),
      leaseStatic: async () => ({ ok: false, block: { reason: 'cooldown', retryAfter: 3000 } }),
      settleStatic: vi.fn(async () => undefined),
    };
    const mockFetch = vi.fn();
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/users/@me', { headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user' } }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('X-Proxy-Block')).toBe('bucket');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('settles with status 599 when the outbound fetch itself throws', async () => {
    const settle = vi.fn(async () => undefined);
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 0 }),
      release: async () => undefined,
      prepareStatic: async () => ({ fingerprint: null, versions: { build: null, chrome: null }, block: null }),
      leaseStatic: async () => ({ ok: true, requestId: 'lease-err' }),
      settleStatic: settle,
    };
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/users/@me', { headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user' } }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(500);
    expect(settle).toHaveBeenCalledWith(expect.any(String), 'lease-err', expect.objectContaining({ status: 599 }));
  });

  it('a client without leaseStatic (no DO binding) dispatches unguarded - the static path never errors', async () => {
    const client: TokenPoolClient = {
      acquire: async () => ({ ok: false, reason: 'empty-pool', retryAfter: 0 }),
      release: async () => undefined,
    };
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch, client);
    const res = await app.request(
      new Request('http://localhost/users/@me', { headers: { 'x-auth-key': 'secret-key', 'x-proxy-context': 'user' } }),
      undefined,
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
  });
});
