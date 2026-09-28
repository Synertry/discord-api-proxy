/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/typing-delay
 * Humanized timing for the opt-in typing indicator (`X-Proxy-Typing: on`).
 * Pure: randomness is a `Math.random`-shaped parameter so tests are exact.
 *
 * - {@link typingWaitMs} models how long a person takes to compose the
 *   message: a reaction time plus a per-character typing rate, or a short
 *   hesitation for content that looks pasted.
 * - {@link typingSlicesMs} splits a wait longer than one typing-indicator
 *   window into randomized slices; the proxy re-sends `/typing` between
 *   slices so the indicator never lapses, and never on a fixed cadence.
 * - {@link parseTypingMaxMsHeader} reads the opt-in `X-Proxy-Typing-Max-Ms`
 *   ceiling.
 */

/** Typing and the send are two dispatches on one identity; `MIN_DISPATCH_GAP_MS` blocks the second any sooner. */
export const TYPING_WAIT_FLOOR_MS = 1000;
/** One typing-indicator window: Discord shows the indicator for about 10 s per `/typing` call. */
export const TYPING_WAIT_DEFAULT_MAX_MS = 8000;
/** Upper bound accepted from `X-Proxy-Typing-Max-Ms`. */
export const TYPING_WAIT_HARD_MAX_MS = 30_000;
export const TYPING_REACTION_MIN_MS = 400;
export const TYPING_REACTION_MAX_MS = 900;
export const TYPING_MS_PER_CHAR_MIN = 120;
export const TYPING_MS_PER_CHAR_MAX = 180;
export const TYPING_PASTE_MIN_CHARS = 300;
export const TYPING_PASTE_NEWLINES = 4;
export const TYPING_PASTE_WAIT_MIN_MS = 1500;
export const TYPING_PASTE_WAIT_MAX_MS = 3000;
export const TYPING_SLICE_MIN_MS = 5000;
export const TYPING_SLICE_MAX_MS = 8000;

const MAX_MS_HEADER_ERROR = `invalid X-Proxy-Typing-Max-Ms: expected an integer between ${TYPING_WAIT_FLOOR_MS} and ${TYPING_WAIT_HARD_MAX_MS}`;

/** A uniform draw in `[lo, hi)` from a `Math.random`-shaped source. */
function between(lo: number, hi: number, random: () => number): number {
  return lo + random() * (hi - lo);
}

/** Pasted content: a code fence, 4+ line breaks, or 300+ characters. A person pastes these, then hesitates briefly. */
export function isPastedContent(content: string): boolean {
  if (content.length >= TYPING_PASTE_MIN_CHARS || content.includes('```')) return true;
  let newlines = 0;
  for (const ch of content) {
    if (ch === '\n' && ++newlines >= TYPING_PASTE_NEWLINES) return true;
  }
  return false;
}

/** Humanized compose time for `content`, clamped to `[TYPING_WAIT_FLOOR_MS, maxMs]`. The per-character rate is drawn once per message, not per character. */
export function typingWaitMs(content: string, maxMs: number, random: () => number = Math.random): number {
  const raw = isPastedContent(content)
    ? between(TYPING_PASTE_WAIT_MIN_MS, TYPING_PASTE_WAIT_MAX_MS, random)
    : between(TYPING_REACTION_MIN_MS, TYPING_REACTION_MAX_MS, random) +
      content.length * between(TYPING_MS_PER_CHAR_MIN, TYPING_MS_PER_CHAR_MAX, random);
  return Math.round(Math.min(Math.max(raw, TYPING_WAIT_FLOOR_MS), maxMs));
}

/**
 * Splits `totalMs` into the waits between successive `/typing` dispatches.
 * Every slice but the last is a fresh draw in `[5000, 8000)`, so re-triggers
 * never land on a fixed cadence; the last is the remainder, in `[1000, 8000]`
 * (while more than 8000 ms remain, `remaining - 1000` exceeds 7000, so the
 * cap below only ever keeps the remainder at or above the dispatch gap). The
 * slices sum to exactly `totalMs`.
 */
export function typingSlicesMs(totalMs: number, random: () => number = Math.random): readonly number[] {
  const slices: number[] = [];
  let remaining = totalMs;
  while (remaining > TYPING_SLICE_MAX_MS) {
    const slice = Math.min(Math.floor(between(TYPING_SLICE_MIN_MS, TYPING_SLICE_MAX_MS, random)), remaining - TYPING_WAIT_FLOOR_MS);
    slices.push(slice);
    remaining -= slice;
  }
  slices.push(remaining);
  return slices;
}

/** Parses `X-Proxy-Typing-Max-Ms`. Absent or blank means one indicator window; otherwise a plain integer in `[1000, 30000]`. */
export function parseTypingMaxMsHeader(value: string | null | undefined): { ok: true; maxMs: number } | { ok: false; error: string } {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return { ok: true, maxMs: TYPING_WAIT_DEFAULT_MAX_MS };
  const maxMs = Number.parseInt(trimmed, 10);
  if (String(maxMs) !== trimmed || maxMs < TYPING_WAIT_FLOOR_MS || maxMs > TYPING_WAIT_HARD_MAX_MS) {
    return { ok: false, error: MAX_MS_HEADER_ERROR };
  }
  return { ok: true, maxMs };
}
