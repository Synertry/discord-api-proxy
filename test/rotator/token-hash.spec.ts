/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { hashToken } from '../../src/rotator/token-hash';

describe('hashToken', () => {
  it('produces a 64-character lowercase hex digest', async () => {
    const hash = await hashToken('some-discord-token-value');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await hashToken('token-a');
    const b = await hashToken('token-a');
    expect(a).toBe(b);
  });

  it('differs for different inputs', async () => {
    const a = await hashToken('token-a');
    const b = await hashToken('token-b');
    expect(a).not.toBe(b);
  });

  it('proves the same physical token used under two kinds hashes to the same key (the reason kind alone is unsafe)', async () => {
    const sharedToken = 'shared-secret-used-for-both-slots';
    const a = await hashToken(sharedToken);
    const b = await hashToken(sharedToken);
    expect(a).toBe(b);
  });
});
