/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
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
import type { AuthVariables } from './middleware/auth';
import type { DiscordContextVariables } from './middleware/discord-context';

import { authMiddleware } from './middleware/auth';
import { discordContextMiddleware } from './middleware/discord-context';
import { snowflakeValidatorMiddleware } from './middleware/snowflake-validator';
import { subrequestLoggerMiddleware } from './middleware/subrequest-logger';
import { identityMiddleware } from './middleware/identity';

import { customRoutes } from './routes/custom';
import { proxyRoute } from './routes/proxy';
import { buildAdminRoutes } from './routes/admin';
import { buildHealthcheckRoute } from './routes/healthcheck';
import { scheduledClientVersionsHandler } from './scheduled/client-versions-refresh';

import type { RotatorVariables, TokenPoolClient } from './rotator/types';

// Re-export Durable Object class for the wrangler binding to discover.
export { TokenPoolDO } from './rotator/do';

/**
 * Creates and configures the Hono application with all middleware and routes.
 *
 * The middleware sieve processes requests in this order:
 * 1. **Rate limit interceptor** - Post-processing: reformats 429 responses, preserves Discord rate-limit headers
 * 2. **Auth validation** - Rejects unauthenticated requests
 * 3. **Discord context** - Selects bot/user token and user-agent
 * 4. **Snowflake validation** - Validates Discord IDs in URL path segments
 * 5. **Custom routes** - Business logic endpoints (e.g. Kindness Cascade)
 * 6. **Proxy forwarder** - Catch-all that forwards to Discord API
 *
 * @param mockFetch - Optional fetch override for integration tests.
 * @param mockTokenPool - Optional in-memory TokenPoolClient for tests; bypasses the real DO.
 * @param mockWait - Optional wait/sleep override for integration tests (typing pre-send delay, 429 retry backoff).
 * @returns Configured Hono app instance.
 */
export function createApp(mockFetch?: typeof fetch, mockTokenPool?: TokenPoolClient, mockWait?: (ms: number) => Promise<void>) {
  const app = new OpenAPIHono<{
    Bindings: Bindings;
    Variables: DiscordContextVariables & AuthVariables & RotatorVariables;
  }>();

  // Inject mock fetch, token-pool client, and/or wait for testing
  if (mockFetch || mockTokenPool || mockWait) {
    app.use('*', async (c, next) => {
      if (mockFetch) c.set('proxyFetch', mockFetch);
      if (mockTokenPool) c.set('tokenPoolClient', mockTokenPool);
      if (mockWait) c.set('proxyWait', mockWait);
      await next();
    });
  }

  // Public healthcheck at /healthcheck (mounted BEFORE the sieve so it is
  // reachable without an auth key - phone browsers, status pages, uptime
  // monitors). Liveness only; does not probe the DO or Discord. NOT in the
  // public OpenAPI doc.
  app.route('/healthcheck', buildHealthcheckRoute());

  // Admin sub-app at /admin (mounted BEFORE the main sieve so it has its own
  // auth chain via AUTH_KEY_ADMIN; not exported in the public OpenAPI doc).
  app.route('/admin', buildAdminRoutes());

  // Sieve Layer 1: Rate Limit Interceptor (post-processing)
  // Runs AFTER downstream handlers to intercept 429 responses
  // and reformat them into a consistent JSON envelope, preserving
  // the original Retry-After, X-RateLimit-*, and X-Proxy-* headers -
  // the last of these carries the identity guard's block signal
  // (`X-Proxy-Block: bucket|capacity|captcha|cloudflare`, see
  // `rotator/static-guard.ts`) through this reformat untouched, since a
  // guard block is itself constructed as a 429 and passes through here
  // exactly like a genuine Discord rate limit.
  app.use('*', async (c, next) => {
    await next();

    if (c.res.status === 429) {
      const original = c.res;
      const retryAfter = original.headers.get('Retry-After');

      // Preserve rate-limit and proxy-signal headers from the original response
      const preservedHeaders = new Headers();
      original.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (lower === 'retry-after' || lower.startsWith('x-ratelimit-') || lower.startsWith('x-proxy-')) {
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

  // Sieve Layer 3.5: Identity resolution (fingerprint/versions; never
  // acquires or leases - only reads). Runs after discord-context so
  // c.var.discordToken has a static-token fallback in place; runs before
  // snowflake-validator so an invalid path never costs a DO round trip.
  app.use('*', identityMiddleware);

  // Sieve Layer 4: Snowflake Validation (Discord ID format checks)
  app.use('*', snowflakeValidatorMiddleware);

  // Sieve Layer 4.5: Subrequest Logger (wraps proxyFetch for streaming visibility)
  // Sits below auth/snowflake so unauthenticated traffic doesn't generate noise.
  app.use('*', subrequestLoggerMiddleware);

  // Sieve Layer 5: Custom Business Logic Routes (mounted under /custom)
  app.route('/custom', customRoutes);

  // Sieve Layer 6: Catch-All Proxy Forwarder (everything else → Discord API)
  app.route('/', proxyRoute);

  /** Global error handler - logs full error internally, returns generic message to client. */
  app.onError((err, c) => {
    console.error('HONO ERROR:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}

/** Worker entry: fetch handler + daily scheduled scraper for the Discord client build number and Chrome stable major. */
const app = createApp();
export default {
  fetch: app.fetch.bind(app),
  scheduled: async (_event: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> => {
    await scheduledClientVersionsHandler(env);
  },
};
