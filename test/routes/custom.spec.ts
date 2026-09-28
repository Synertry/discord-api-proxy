/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/custom.spec
 * Tests for the custom route skeleton: with no feature module mounted, every
 * `/custom/*` path is answered by the router itself and never forwarded to
 * Discord.
 */

import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/index';
import type { Bindings } from '../../src/types';

const MOCK_ENV: Bindings = {
  AUTH_KEY: 'secret-key',
  DISCORD_TOKEN_BOT: 'bot-token',
  DISCORD_TOKEN_USER: 'user-token',
  TOKEN_POOL: {} as DurableObjectNamespace,
};

describe('Custom Routes', () => {
  it.each(['/custom/anything/at/all', '/custom'])('answers 404 for unmatched %s without forwarding it to Discord', async (path) => {
    const mockFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const app = createApp(mockFetch as unknown as typeof fetch);

    const res = await app.request(`http://localhost${path}`, { headers: { 'x-auth-key': 'secret-key' } }, MOCK_ENV);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
