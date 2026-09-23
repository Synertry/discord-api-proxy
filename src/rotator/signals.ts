/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/signals
 * Inspects a Discord response for abuse signals (a captcha challenge, or a
 * Cloudflare edge-level block) beyond the plain rate-limit headers
 * `extractReleaseInput` already parses. Supersedes the old, narrower
 * `extractReleaseInputWithBody` (which only looked for a 50001 code on 403).
 *
 * Discord's own error responses always carry a `via: 1.1 google` header
 * (Discord runs behind Google's infrastructure); a Cloudflare challenge page
 * for the *proxy's own* Worker domain does not, since it never reaches
 * Discord's origin. A non-JSON body with an HTML content-type and no `via`
 * header on 400/403/429/503 is treated as a Cloudflare block.
 */

import { extractReleaseInput } from './release-input';
import type { ReleaseInput, RouteKey } from './types';

/** Status codes worth inspecting the body for; everything else is passed through unchanged by `extractReleaseInput` alone. */
const INSPECTABLE_STATUSES: Readonly<Record<number, true>> = { 400: true, 403: true, 429: true, 503: true };

/** Skip body inspection above this size: abuse-signal bodies are always small JSON or a short HTML challenge page. */
const MAX_INSPECTABLE_BYTES = 65536;

/**
 * Read at most `cap` bytes from `body` as UTF-8 text, returning `null` the
 * moment the stream turns out to carry more than `cap` bytes: the caller must
 * then treat the body as uninspectable instead of buffering it. Reading stops
 * there and this branch is cancelled - callers pass a `Response.clone()`
 * branch, which is a tee, so the response the caller still holds is untouched
 * either way.
 */
async function readCappedText(body: ReadableStream<Uint8Array> | null, cap: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let readBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      if (!value) continue;
      readBytes += value.byteLength;
      if (readBytes > cap) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Build a `ReleaseInput` from a Discord `Response`, including an
 * `inspectResponse` walk of the body on abuse-relevant statuses. Clones the
 * response first so the original body remains readable by the caller. Never
 * logs the body (it may carry account-identifying detail).
 */
export async function inspectResponse(response: Response, routeKey: RouteKey, guildId?: string): Promise<ReleaseInput> {
  const base = extractReleaseInput(response, routeKey, guildId);
  if (!INSPECTABLE_STATUSES[response.status]) return base;

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_INSPECTABLE_BYTES) return base;

  let text: string | null;
  try {
    text = await readCappedText(response.clone().body, MAX_INSPECTABLE_BYTES);
  } catch (err: unknown) {
    console.error('inspectResponse body read failed, skipping signal inspection:', err);
    return base;
  }
  if (text === null || text.length === 0) return base;

  try {
    const body = JSON.parse(text) as { code?: number; captcha_key?: unknown; captcha_sitekey?: unknown };
    const next: ReleaseInput = { ...base };
    if (typeof body?.code === 'number') next.code = body.code;
    if (body?.captcha_key !== undefined || body?.captcha_sitekey !== undefined) next.signal = 'captcha';
    return next;
  } catch {
    // Not JSON. Discord's own responses (including error pages) are always
    // JSON; a non-JSON HTML body with no `via` header is a Cloudflare
    // challenge page for the proxy's own domain, which never reached Discord.
    const contentType = response.headers.get('content-type') ?? '';
    const hasVia = response.headers.get('via') !== null;
    if (contentType.includes('text/html') && !hasVia) {
      return { ...base, signal: 'cloudflare' };
    }
    return base;
  }
}
