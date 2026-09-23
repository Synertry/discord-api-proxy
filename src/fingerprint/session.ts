/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/session
 * Deterministic per-identity session UUIDs, so no storage and no extra RPC
 * round-trip is needed to keep `client_launch_id` / `client_heartbeat_session_id`
 * / `launch_signature` stable within a real client's rotation windows and
 * rotating across them, the same way the real client does.
 *
 * `launchSignature`'s client-mod-detection bits are always masked to zero
 * (clean client, no mods) here, for every identity including operator-
 * registered clone profiles: it is per-launch data in the real client too
 * (Userdoccers' client-properties spec), so freezing a single captured value
 * forever would itself be an anomaly a real client never exhibits, not an
 * authenticity win. Runtime-agnostic: uses only `crypto.subtle`, which Workers
 * and Node both expose as a global.
 */

import { fnv1a32 } from './hash';

export interface FingerprintSession {
  clientLaunchId: string;
  clientHeartbeatSessionId: string;
  launchSignature: string;
}

/** How often a "launch" (app relaunch) is simulated, per identity. */
export const LAUNCH_PERIOD_MS = 24 * 60 * 60 * 1000;

/** How often the heartbeat session id rotates, matching the real client's cadence (Userdoccers client-properties spec). */
export const HEARTBEAT_PERIOD_MS = 30 * 60 * 1000;

/**
 * Bitmask of client-mod-detection bits inside `launch_signature`, per the
 * Userdoccers client-properties spec (bit 84 = Vencord, bit 108 =
 * BetterDiscord, others reserved for further known mods). ANDing the
 * generated UUID with the complement of this mask always reports a clean
 * client, matching a real unmodified Discord install.
 */
export const LAUNCH_SIGNATURE_MASK =
  0b00000000100000000001000000010000000010000001000000001000000000000010000010000001000000000100000000000001000000000000100000000000n;

/** Derive the three session-scoped identity fields for a given identity key and instant. Same key + same rotation window always yields the same values; different windows yield different values, matching the real client's own launch/heartbeat rotation. */
export async function deriveFingerprintSession(identityKey: string, now: number): Promise<FingerprintSession> {
  // Per-identity offset so identities do not all "relaunch" at the same UTC instant.
  const offset = fnv1a32(identityKey) % LAUNCH_PERIOD_MS;
  const launchBucket = Math.floor((now + offset) / LAUNCH_PERIOD_MS);
  const heartbeatBucket = Math.floor(now / HEARTBEAT_PERIOD_MS);

  const [clientLaunchId, clientHeartbeatSessionId, launchSignatureRaw] = await Promise.all([
    deriveUuidV4(`launch:${identityKey}:${launchBucket}`),
    deriveUuidV4(`heartbeat:${identityKey}:${launchBucket}:${heartbeatBucket}`),
    deriveUuidV4(`signature:${identityKey}:${launchBucket}`),
  ]);

  return {
    clientLaunchId,
    clientHeartbeatSessionId,
    launchSignature: maskLaunchSignature(launchSignatureRaw),
  };
}

/** SHA-256 the seed, take the first 16 bytes, set RFC 4122 v4 version/variant bits, format as a UUID string. */
async function deriveUuidV4(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Clear the client-mod-detection bits inside a UUID's 128-bit value, re-encode as a UUID string. */
function maskLaunchSignature(uuid: string): string {
  const asBigInt = BigInt(`0x${uuid.replaceAll('-', '')}`);
  const cleaned = asBigInt & ~LAUNCH_SIGNATURE_MASK;
  const hex = cleaned.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
