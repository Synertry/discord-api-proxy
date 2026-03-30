/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/proxy
 * Catch-all reverse proxy that forwards unmatched requests to the Discord API.
 *
 * Rewrites the request URL from `/{path}` to `https://discord.com/api/v10/{path}`,
 * injects the appropriate authorization token and user-agent from the Discord context
 * middleware, and streams the response back to the client. Supports all HTTP methods
 * including request body forwarding for POST/PUT/PATCH/DELETE.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Bindings } from '../types';
import type { DiscordContextVariables } from '../middleware/discord-context';

/** Catch-all proxy route — forwards any unmatched request to Discord API v10. */
export const proxyRoute = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();

/** Internal headers that must not be forwarded to the Discord API. */
const STRIPPED_HEADERS = new Set(['host', 'x-auth-key', 'x-proxy-context']);

type SafeInit = RequestInit & { duplex?: 'half' };

proxyRoute.all('/*', async (c) => {
  const url = new URL(c.req.url);
  const discordUrl = `https://discord.com/api/v10${url.pathname}${url.search}`;

  const discordToken = c.var.discordToken;
  const discordUserAgent = c.var.discordUserAgent;

  try {
    const method = c.req.method;

    // Clone incoming headers, stripping internal proxy headers and Host
    const cleanHeaders = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      if (!STRIPPED_HEADERS.has(k.toLowerCase())) cleanHeaders.set(k, v);
    });

    // Inject Discord auth and optional user-agent from context middleware
    cleanHeaders.set('Authorization', discordToken);
    if (discordUserAgent) cleanHeaders.set('User-Agent', discordUserAgent);

    // Build fetch init — include body + duplex for methods that carry a payload
    const safeInit: SafeInit = { method, headers: cleanHeaders };
    if (method !== 'GET' && method !== 'HEAD') {
      safeInit.body = c.req.raw.body;
      safeInit.duplex = 'half'; // Required for streaming request bodies in Workers
    }

    const fetcher = c.var.proxyFetch ?? fetch;
    const response = await fetcher(discordUrl, safeInit as RequestInit);
    return response;
  } catch (err: unknown) {
    console.error('PROXY ERR:', err);
    return c.json({ error: 'Proxy error' }, 500);
  }
});
