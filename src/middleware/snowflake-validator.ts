/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/snowflake-validator
 * Validates Discord snowflake IDs in URL path segments before forwarding.
 *
 * Scans the request path for known Discord resource types (e.g. `guilds`, `channels`)
 * and validates that the following path segment is a valid snowflake (17–20 digit
 * numeric string). Returns a Discord-API-compatible error response on failure.
 *
 * Special cases: `@me` is allowed for `users` and `applications` endpoints.
 */

import { createMiddleware } from 'hono/factory';

/** Discord API resource types whose IDs must be valid snowflakes. */
const SNOWFLAKE_RESOURCES = new Set([
  'guilds',
  'channels',
  'users',
  'roles',
  'messages',
  'webhooks',
  'applications',
  'interactions',
  'entitlements',
  'skus',
]);

/** Discord snowflakes are 64-bit integers: 17–20 decimal digit strings. */
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

/**
 * Validates snowflake IDs in the request URL path.
 *
 * For each known resource type in the path, checks that the next segment is a
 * valid snowflake. Returns a 400 response with Discord's error format (`code: 50035`,
 * `NUMBER_TYPE_COERCE`) if validation fails, preventing invalid IDs from reaching
 * the Discord API.
 */
export const snowflakeValidatorMiddleware = createMiddleware(async (c, next) => {
  const segments = c.req.path.split('/').filter(Boolean);

  for (let i = 0; i < segments.length - 1; i++) {
    const resource = segments[i].toLowerCase();
    if (SNOWFLAKE_RESOURCES.has(resource)) {
      const id = segments[i + 1];

      // Allow virtual IDs: @me for user/application self-references,
      // @original for interaction response message references
      if ((resource === 'users' || resource === 'applications') && id === '@me') {
        continue;
      }
      if (resource === 'messages' && id === '@original') {
        continue;
      }

      if (!SNOWFLAKE_REGEX.test(id)) {
        // Derive field name from resource (e.g. "guilds" → "guild_id")
        const errorField = resource.endsWith('s') ? `${resource.slice(0, -1)}_id` : `${resource}_id`;

        return c.json(
          {
            message: 'Invalid Form Body',
            code: 50035,
            errors: {
              [errorField]: {
                _errors: [
                  {
                    code: 'NUMBER_TYPE_COERCE',
                    message: `Value "${id}" is not snowflake.`,
                  },
                ],
              },
            },
          },
          400,
        );
      }
    }
  }

  await next();
});
