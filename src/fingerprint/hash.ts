/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/hash
 * Shared FNV-1a hash. Runtime-agnostic (no imports), used by both the
 * fingerprint layer (`session.ts`, for a deterministic per-identity launch
 * offset) and the rotator DO (`pickProfileId`, for a stable profile
 * assignment from a token label) - a single implementation so the two never
 * drift apart.
 */

/** 32-bit FNV-1a hash of a UTF-8 string. Not cryptographic; used only for deterministic, non-adversarial bucketing. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
