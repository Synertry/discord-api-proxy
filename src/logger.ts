/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module logger
 * The single place production code writes log lines. Every module creates one
 * scoped logger, so each line reads `[scope] message` and Workers Logs or
 * `wrangler dev` output can be filtered by module.
 *
 * `info` writes through `console.log` (not `console.info`) so existing log
 * consumers and test spies on `console.log` keep seeing the same lines.
 */

export interface Logger {
  readonly info: (message: string, ...details: unknown[]) => void;
  readonly warn: (message: string, ...details: unknown[]) => void;
  readonly error: (message: string, ...details: unknown[]) => void;
}

/** Creates a logger whose every line is prefixed with `[scope]`. */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    info: (message, ...details) => console.log(`${prefix} ${message}`, ...details),
    warn: (message, ...details) => console.warn(`${prefix} ${message}`, ...details),
    error: (message, ...details) => console.error(`${prefix} ${message}`, ...details),
  };
}
