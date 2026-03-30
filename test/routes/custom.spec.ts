/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/custom.spec
 * Tests for the custom business logic route tree.
 *
 * Verifies the placeholder Cupid's Inbox endpoint and that the Kindness Cascade
 * route is mounted and validates its required query parameters.
 */

import { describe, it, expect } from 'vitest';
import { customRoutes } from '../../src/routes/custom';
import type { Bindings } from '../../src/types';

describe('Custom Routes', () => {
  /** Test environment bindings. */
  const MOCK_ENV: Bindings = {
    AUTH_KEY: 'secret-key',
    DISCORD_TOKEN_BOT: 'bot-token',
    DISCORD_TOKEN_USER: 'user-token',
  };

  it('should return placeholder tally for /chillzone/events/cupids-inbox', async () => {
    const res = await customRoutes.request('http://localhost/chillzone/events/cupids-inbox', {}, MOCK_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ tally: 0 });
  });

  it('should return 400 for /chillzone/events/kindness-cascade without required params', async () => {
    const res = await customRoutes.request('http://localhost/chillzone/events/kindness-cascade', {}, MOCK_ENV);
    expect(res.status).toBe(400);
  });
});
