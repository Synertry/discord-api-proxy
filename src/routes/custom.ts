/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/custom
 * Custom business logic routes that are not direct Discord API proxies.
 *
 * Mounts server-specific event endpoints under `/custom/chillzone/events/`.
 * These routes implement tallying, analytics, and other features that process
 * Discord data server-side rather than simply forwarding API calls.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Bindings } from '../types';
import type { DiscordContextVariables } from '../middleware/discord-context';
import { kindnessCascadeRoutes } from '../custom/chillzone/events/kindness-cascade';
import { bingoRoutes } from '../custom/chillzone/events/bingo';

/** Parent router for all custom (non-proxy) endpoints. */
export const customRoutes = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();

/** Placeholder route for the Cupid's Inbox event (not yet implemented). */
const cupidsInboxRoute = createRoute({
  method: 'get',
  path: '/chillzone/events/cupids-inbox',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            tally: z.number(),
          }),
        },
      },
      description: "Retrieve Cupid's Inbox tally placeholder",
    },
  },
});

customRoutes.openapi(cupidsInboxRoute, (c) => {
  return c.json({ tally: 0 }, 200);
});

// Mount Kindness Cascade routes under /chillzone/events/
customRoutes.route('/chillzone/events', kindnessCascadeRoutes);

// Mount Bingo autotally routes under /chillzone/events/bingo/
customRoutes.route('/chillzone/events/bingo', bingoRoutes);
