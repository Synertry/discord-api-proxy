/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { deriveFingerprintSession, LAUNCH_SIGNATURE_MASK, LAUNCH_PERIOD_MS, HEARTBEAT_PERIOD_MS } from '../../src/fingerprint/session';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW = 1_700_000_000_000;

describe('deriveFingerprintSession', () => {
  it('is deterministic for the same key and instant', async () => {
    const a = await deriveFingerprintSession('static:user-default', NOW);
    const b = await deriveFingerprintSession('static:user-default', NOW);
    expect(a).toEqual(b);
  });

  it('differs across identity keys at the same instant', async () => {
    const a = await deriveFingerprintSession('static:user-default', NOW);
    const b = await deriveFingerprintSession('static:user-premium', NOW);
    expect(a).not.toEqual(b);
  });

  it('rotates only the heartbeat id within a 30-minute window change', async () => {
    const a = await deriveFingerprintSession('pool:label-1', NOW);
    const b = await deriveFingerprintSession('pool:label-1', NOW + HEARTBEAT_PERIOD_MS + 1);
    expect(b.clientHeartbeatSessionId).not.toBe(a.clientHeartbeatSessionId);
    expect(b.clientLaunchId).toBe(a.clientLaunchId);
    expect(b.launchSignature).toBe(a.launchSignature);
  });

  it('rotates launch id and signature after a 24h+ gap', async () => {
    const a = await deriveFingerprintSession('pool:label-1', NOW);
    const b = await deriveFingerprintSession('pool:label-1', NOW + LAUNCH_PERIOD_MS + 1);
    expect(b.clientLaunchId).not.toBe(a.clientLaunchId);
    expect(b.launchSignature).not.toBe(a.launchSignature);
  });

  it('produces valid v4 UUIDs for all three fields', async () => {
    const s = await deriveFingerprintSession('static:user-default', NOW);
    expect(s.clientLaunchId).toMatch(UUID_V4_RE);
    expect(s.clientHeartbeatSessionId).toMatch(UUID_V4_RE);
    expect(s.launchSignature).toMatch(UUID_V4_RE);
  });

  it('always reports a clean client: launch signature has every mod-detection bit cleared', async () => {
    const s = await deriveFingerprintSession('static:user-premium', NOW);
    const asBigInt = BigInt(`0x${s.launchSignature.replaceAll('-', '')}`);
    expect(asBigInt & LAUNCH_SIGNATURE_MASK).toBe(0n);
  });
});
