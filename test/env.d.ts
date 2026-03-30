/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module test/env
 * Type augmentation for the `cloudflare:test` module used by `@cloudflare/vitest-pool-workers`.
 * Maps the test environment interface to the worker's {@link Env} bindings so that
 * `env` is correctly typed within Vitest test files.
 */
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
