/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module index
 * Application entry point and Hono app factory for the discord-api-proxy worker.
 *
 * Assembles the middleware sieve (auth → context → snowflake validation) and mounts
 * route trees (custom business logic, then catch-all Discord proxy). The sieve layers
 * are numbered to document their evaluation order.
 *
 * Exports both a {@link createApp} factory (for testing with injected fetch) and a
 * default app instance (for Cloudflare Workers runtime).
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Bindings } from './types';
import type { DiscordContextVariables } from './middleware/discord-context';

import { authMiddleware } from './middleware/auth';
import { discordContextMiddleware } from './middleware/discord-context';
import { snowflakeValidatorMiddleware } from './middleware/snowflake-validator';

import { customRoutes } from './routes/custom';
import { proxyRoute } from './routes/proxy';

/**
 * Creates and configures the Hono application with all middleware and routes.
 *
 * The middleware sieve processes requests in this order:
 * 1. **Rate limit interceptor** — Post-processing: reformats 429 responses, preserves Discord rate-limit headers
 * 2. **Auth validation** — Rejects unauthenticated requests
 * 3. **Discord context** — Selects bot/user token and user-agent
 * 4. **Snowflake validation** — Validates Discord IDs in URL path segments
 * 5. **Custom routes** — Business logic endpoints (e.g. Kindness Cascade)
 * 6. **Proxy forwarder** — Catch-all that forwards to Discord API
 *
 * @param mockFetch - Optional fetch override for integration tests.
 * @returns Configured Hono app instance.
 */
export function createApp(mockFetch?: typeof fetch) {
  const app = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();

  // Inject mock fetch for testing — makes it available via c.var.proxyFetch
  if (mockFetch) {
    app.use('*', async (c, next) => {
      c.set('proxyFetch', mockFetch);
      await next();
    });
  }

  // Sieve Layer 1: Rate Limit Interceptor (post-processing)
  // Runs AFTER downstream handlers to intercept 429 responses
  // and reformat them into a consistent JSON envelope, preserving
  // the original Retry-After and X-RateLimit-* headers from Discord.
  app.use('*', async (c, next) => {
    await next();

    if (c.res.status === 429) {
      const original = c.res;
      const retryAfter = original.headers.get('Retry-After');

      // Preserve rate-limit headers from the original response
      const preservedHeaders = new Headers();
      original.headers.forEach((v, k) => {
        if (k.toLowerCase() === 'retry-after' || k.toLowerCase().startsWith('x-ratelimit-')) {
          preservedHeaders.set(k, v);
        }
      });
      preservedHeaders.set('Content-Type', 'application/json');

      c.res = new Response(
        JSON.stringify({
          error: 'Too Many Requests',
          retryAfter: retryAfter ? parseFloat(retryAfter) : null,
        }),
        { status: 429, headers: preservedHeaders },
      );
    }
  });

  // Sieve Layer 2: Auth Validation
  app.use('*', authMiddleware);

  // Sieve Layer 3: Context Parsing (token selection + user-agent)
  app.use('*', discordContextMiddleware);

  // Sieve Layer 4: Snowflake Validation (Discord ID format checks)
  app.use('*', snowflakeValidatorMiddleware);

  // Sieve Layer 5: Custom Business Logic Routes (mounted under /custom)
  app.route('/custom', customRoutes);

  // Sieve Layer 6: Catch-All Proxy Forwarder (everything else → Discord API)
  app.route('/', proxyRoute);

  /** Global error handler — logs full error internally, returns generic message to client. */
  app.onError((err, c) => {
    console.error('HONO ERROR:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}

/** Default app instance exported for Cloudflare Workers runtime. */
export default createApp();
