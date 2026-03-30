/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module global
 * Global constants injected at build time via Wrangler's `define` configuration.
 * These are replaced with literal values during the build step and available
 * as bare globals in the worker runtime.
 */
declare global {
  /** Short git commit hash at build time (e.g. `"d50567f"`). */
  const BUILD_HASH: string;
  /** ISO 8601 timestamp of the build (e.g. `"2026-03-26T12:00:00Z"`). */
  const BUILD_TIMESTAMP: string;
}

export {};
