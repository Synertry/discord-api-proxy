/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/custom
 * Router for `/custom/*`: server-side endpoints that process Discord data
 * (event tallies, analytics, aggregations) instead of forwarding one call.
 *
 * Ships as a skeleton with no feature mounted. To add one:
 *
 * 1. Create `src/custom/<scope>/<feature>/` with a `handler.ts` exporting an
 *    `OpenAPIHono` sub-app built from `createRoute` definitions.
 * 2. Read channel history through `custom/shared/paged-messages`
 *    (`fetchAllMessages`) rather than a hand-rolled fetch loop, and lease the
 *    static guard or acquire a pool token immediately before every other
 *    outbound fetch.
 * 3. Mount it below with `customRoutes.route('/<scope>/<feature>', featureRoutes)`,
 *    above the trailing catch-all.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Bindings } from '../types';
import type { DiscordContextVariables } from '../middleware/discord-context';

/** Parent router for all custom (non-proxy) endpoints. */
export const customRoutes = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();

/** Unmatched /custom/* paths stop here: they are never forwarded to Discord and never spend a guard lease. */
customRoutes.all('*', (c) => c.json({ error: 'Not Found' }, 404));
