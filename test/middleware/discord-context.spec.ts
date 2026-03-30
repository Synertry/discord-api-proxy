/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/discord-context.spec
 * Tests for the Discord context middleware.
 *
 * Validates token selection logic: bot vs user token based on path heuristics
 * and the `x-proxy-context` header override. Also verifies that browser
 * User-Agent is set only when using the user token.
 */

import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { discordContextMiddleware, BROWSER_USER_AGENT, type DiscordContextVariables } from '../../src/middleware/discord-context';
import type { Bindings } from '../../src/types';

describe('Discord Context Middleware', () => {
  /** Test app that echoes back the context variables set by the middleware. */
  const app = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();
  app.use('*', discordContextMiddleware);
  app.get('*', (c) =>
    c.json({
      discordToken: c.var.discordToken,
      discordUserAgent: c.var.discordUserAgent,
    }),
  );

  /** Test environment bindings. */
  const MOCK_ENV: Bindings = {
    AUTH_KEY: 'secret-key',
    DISCORD_TOKEN_BOT: 'bot-token',
    DISCORD_TOKEN_USER: 'user-token',
  };

  it('should assign bot token and no user-agent for normal paths', async () => {
    const res = await app.request('http://localhost/users/@me', {}, MOCK_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      discordToken: 'Bot bot-token',
    });
  });

  it('should assign user token and browser user-agent for paths including /guilds', async () => {
    const res = await app.request('http://localhost/users/@me/guilds', {}, MOCK_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      discordToken: 'user-token',
      discordUserAgent: BROWSER_USER_AGENT,
    });
  });
  it('should override with user token when X-Proxy-Context is user, despite not being /guilds', async () => {
    const res = await app.request(
      'http://localhost/users/@me',
      {
        headers: { 'X-Proxy-Context': 'user' },
      },
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      discordToken: 'user-token',
      discordUserAgent: BROWSER_USER_AGENT,
    });
  });

  it('should override with bot token when X-Proxy-Context is bot, despite being /guilds', async () => {
    const res = await app.request(
      'http://localhost/users/@me/guilds',
      {
        headers: { 'X-Proxy-Context': 'bot' },
      },
      MOCK_ENV,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      discordToken: 'Bot bot-token',
    });
  });
});
