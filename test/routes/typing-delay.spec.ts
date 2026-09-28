/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/typing-delay.spec
 * Unit tests for the humanized typing delay: compose-time model, paste
 * detection, randomized re-trigger slicing, and the `X-Proxy-Typing-Max-Ms`
 * parser. Randomness is injected so every expectation is exact.
 */

import { describe, it, expect } from 'vitest';
import {
  isPastedContent,
  parseTypingMaxMsHeader,
  typingSlicesMs,
  typingWaitMs,
  TYPING_WAIT_DEFAULT_MAX_MS,
} from '../../src/routes/typing-delay';

const LOW = () => 0;
const MID = () => 0.5;
const HIGH = () => 0.999;
const HEADER_ERROR = 'invalid X-Proxy-Typing-Max-Ms: expected an integer between 1000 and 30000';

describe('typingWaitMs', () => {
  it('never waits less than the 1000ms identity dispatch gap, even for a two-character message', () => {
    expect(typingWaitMs('hi', 8000, LOW)).toBe(1000);
  });

  it('adds 400-900ms of reaction time to 120-180ms per character, drawn once per request', () => {
    const content = 'a'.repeat(20);
    expect(typingWaitMs(content, 8000, LOW)).toBe(2800);
    expect(typingWaitMs(content, 8000, MID)).toBe(3650);
    expect(typingWaitMs(content, 8000, HIGH)).toBe(4498);
  });

  it('grows with message length below the cap', () => {
    const waits = [10, 20, 40].map((n) => typingWaitMs('a'.repeat(n), 8000, MID));
    expect(waits).toEqual([2150, 3650, 6650]);
  });

  it('caps at maxMs, so a long mode max lets a long message wait longer', () => {
    const content = 'a'.repeat(100);
    expect(typingWaitMs(content, 8000, LOW)).toBe(8000);
    expect(typingWaitMs(content, 30_000, LOW)).toBe(12_400);
  });

  it('gives pasted-looking content a short 1.5-3s compose delay instead of a per-character one', () => {
    const pasted = 'a'.repeat(300);
    expect(typingWaitMs(pasted, 30_000, LOW)).toBe(1500);
    expect(typingWaitMs(pasted, 30_000, HIGH)).toBe(2999);
    // One character shorter is typed out, and hits the cap.
    expect(typingWaitMs('a'.repeat(299), 30_000, LOW)).toBe(30_000);
  });
});

describe('isPastedContent', () => {
  it.each([
    ['300 characters', 'a'.repeat(300), true],
    ['299 characters', 'a'.repeat(299), false],
    ['a code fence', 'look:\n```ts\nx\n', true],
    ['four line breaks', 'a\nb\nc\nd\ne', true],
    ['three line breaks', 'a\nb\nc\nd', false],
  ])('%s -> %s', (_label, content, expected) => {
    expect(isPastedContent(content)).toBe(expected);
  });
});

describe('typingSlicesMs', () => {
  it('keeps a wait that fits in one typing-indicator window as a single slice', () => {
    expect(typingSlicesMs(1000, LOW)).toEqual([1000]);
    expect(typingSlicesMs(8000, HIGH)).toEqual([8000]);
  });

  it('splits a longer wait into randomized 5-8s slices and a remainder of at least 1000ms', () => {
    expect(typingSlicesMs(9000, LOW)).toEqual([5000, 4000]);
    expect(typingSlicesMs(9000, HIGH)).toEqual([7997, 1003]);
    expect(typingSlicesMs(30_000, LOW)).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
  });

  it.each([0, 0.25, 0.5, 0.75, 0.999])('with random() = %s every slice stays in [1000, 8000] and the slices sum to the total', (r) => {
    for (const total of [8001, 12_345, 20_000, 30_000]) {
      const slices = typingSlicesMs(total, () => r);
      expect(slices.length).toBeGreaterThanOrEqual(2);
      expect(slices.reduce((sum, s) => sum + s, 0)).toBe(total);
      for (const slice of slices) {
        expect(slice).toBeGreaterThanOrEqual(1000);
        expect(slice).toBeLessThanOrEqual(8000);
      }
    }
  });

  it('does not re-trigger on a fixed cadence: different draws give different slice lengths', () => {
    const draws = [0.1, 0.9, 0.4];
    let i = 0;
    const slices = typingSlicesMs(20_000, () => draws[i++ % draws.length]);
    expect(new Set(slices.slice(0, -1)).size).toBe(slices.length - 1);
  });
});

describe('parseTypingMaxMsHeader', () => {
  it.each([undefined, null, '', '   '])('defaults to one indicator window for %j', (value) => {
    expect(parseTypingMaxMsHeader(value)).toEqual({ ok: true, maxMs: TYPING_WAIT_DEFAULT_MAX_MS });
  });

  it.each([
    [' 12000 ', 12_000],
    ['1000', 1000],
    ['30000', 30_000],
  ])('accepts %j', (value, maxMs) => {
    expect(parseTypingMaxMsHeader(value)).toEqual({ ok: true, maxMs });
  });

  it.each(['999', '30001', 'abc', '12e3', '1000.5', '+5000', '-1000'])('rejects %j', (value) => {
    expect(parseTypingMaxMsHeader(value)).toEqual({ ok: false, error: HEADER_ERROR });
  });
});
