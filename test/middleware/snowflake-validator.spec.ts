/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/snowflake-validator.spec
 * Tests for the snowflake ID validation middleware.
 *
 * Verifies that valid snowflakes pass through, `@me` is exempted for users
 * and applications, and invalid snowflakes produce a Discord-API-compatible
 * 400 error response with the correct field name and error code.
 */

import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { snowflakeValidatorMiddleware } from '../../src/middleware/snowflake-validator';

describe('Snowflake Validator Middleware', () => {
  /** Test app with only the snowflake validator and a passthrough handler. */
  const app = new OpenAPIHono();
  app.use('*', snowflakeValidatorMiddleware);
  app.get('*', (c) => c.text('OK'));

  it('should allow valid snowflakes', async () => {
    const res = await app.request('http://localhost/guilds/206904180185628673/members');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('should allow @me for users and applications', async () => {
    const resUsers = await app.request('http://localhost/users/@me/guilds');
    expect(resUsers.status).toBe(200);

    const resApps = await app.request('http://localhost/applications/@me');
    expect(resApps.status).toBe(200);
  });

  it('should reject invalid snowflakes and format like Discord API', async () => {
    const res = await app.request('http://localhost/guilds/{{guildId}}/members');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      message: 'Invalid Form Body',
      code: 50035,
      errors: {
        guild_id: {
          _errors: [
            {
              code: 'NUMBER_TYPE_COERCE',
              message: 'Value "{{guildId}}" is not snowflake.',
            },
          ],
        },
      },
    });
  });

  it('should allow @original for messages (interaction response references)', async () => {
    const res = await app.request('http://localhost/webhooks/12345678901234567/token/messages/@original');
    expect(res.status).toBe(200);
  });

  it('should reject non-numeric strings', async () => {
    const res = await app.request('http://localhost/channels/abc/messages/123');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({
      message: 'Invalid Form Body',
      code: 50035,
      errors: {
        channel_id: {
          _errors: [
            {
              code: 'NUMBER_TYPE_COERCE',
              message: 'Value "abc" is not snowflake.',
            },
          ],
        },
      },
    });
  });
});
