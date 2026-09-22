/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { inspectResponse } from '../../src/rotator/signals';

const ROUTE_KEY = 'GET:/guilds/:id/messages/search';

describe('inspectResponse: 50001 body detection (migrated from extractReleaseInputWithBody)', () => {
  it('captures Discord error code 50001 from a 403 body', async () => {
    const r = new Response(JSON.stringify({ message: 'Missing Access', code: 50001 }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
    const input = await inspectResponse(r, ROUTE_KEY, '219564597349318656');
    expect(input.code).toBe(50001);
    expect(input.guildId).toBe('219564597349318656');
  });

  it('returns base ReleaseInput unchanged for non-inspectable statuses', async () => {
    const r = new Response('', { status: 200 });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.code).toBeUndefined();
    expect(input.signal).toBeUndefined();
  });

  it('does not consume the original response body (clone preserves it)', async () => {
    const r = new Response(JSON.stringify({ code: 50001 }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
    await inspectResponse(r, ROUTE_KEY);
    const text = await r.text();
    expect(text).toContain('50001');
  });

  it('survives a malformed JSON body without throwing', async () => {
    const r = new Response('not-json', { status: 403 });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.status).toBe(403);
    expect(input.code).toBeUndefined();
  });
});

describe('inspectResponse: captcha detection', () => {
  it('detects captcha_key in a 400 body', async () => {
    const r = new Response(JSON.stringify({ captcha_key: ['captcha-required'], captcha_sitekey: 'abc' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.signal).toBe('captcha');
  });

  it('a plain 403 with only a 50001 code carries no captcha signal', async () => {
    const r = new Response(JSON.stringify({ code: 50001 }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.signal).toBeUndefined();
    expect(input.code).toBe(50001);
  });
});

describe('inspectResponse: cloudflare detection', () => {
  it('detects a Cloudflare challenge page: non-JSON HTML body, no via header', async () => {
    const r = new Response('<html><body>Just a moment...</body></html>', {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.signal).toBe('cloudflare');
  });

  it('does not flag an HTML body that does carry a via header (unexpected, but not Cloudflare-shaped)', async () => {
    const r = new Response('<html>error</html>', {
      status: 503,
      headers: { 'Content-Type': 'text/html', via: '1.1 google' },
    });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.signal).toBeUndefined();
  });

  it('a plain 200 response is never inspected', async () => {
    const r = new Response('<html>nothing to see here</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.signal).toBeUndefined();
  });

  it('skips inspection above the size ceiling via Content-Length', async () => {
    const bigBody = 'x'.repeat(70_000);
    const r = new Response(bigBody, {
      status: 403,
      headers: { 'Content-Type': 'text/html', 'Content-Length': String(bigBody.length) },
    });
    const input = await inspectResponse(r, ROUTE_KEY);
    expect(input.signal).toBeUndefined();
  });
});
