/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module routes/proxy
 * Catch-all reverse proxy that forwards unmatched requests to the Discord API.
 *
 * Rewrites the request URL from `/{path}` to `https://discord.com/api/v10/{path}`
 * for every token kind - bot and user alike, unchanged from the pre-existing
 * codebase; only the header realism, body fill, and pacing below are new.
 *
 * This is the ONLY module that ever pairs acquire/release (pool tokens) or
 * lease/settle (static tokens via the identity guard) - always within this
 * one function, immediately around the single outbound fetch each guards.
 * Every budget, lease, settle, release, and response-inspection call uses the
 * budget key (`deriveBudgetKey`), while route-type decisions (message-send
 * fill, typing, `X-Context-Properties`) use the normalized `deriveRouteKey`;
 * both are derived from `c.req.path`, the same decoded source the identity
 * middleware used, so a lease is always settled under the key it was
 * acquired with.
 * `identityMiddleware` upstream never acquires or leases anything; it only
 * resolves a read-only fallback `identity` (always present for non-bot
 * requests) and, on a pool-eligible route, a `poolPlan` describing how to
 * attempt the pool (`c.var.poolPlan`). See `middleware/identity.ts`'s module
 * doc for why: the old design's acquire-in-middleware leaked a lease on any
 * early return between acquiring and this handler running.
 *
 * Bot requests carry only the Discord-compliant `DiscordBot (...)` UA and
 * never touch the pool, the guard, or the fingerprint layer at all.
 *
 * User-token requests (`user-default` / `user-premium`, whether served by a
 * pool token or the static token): full browser-like fingerprint headers via
 * `composeRequestHeaders`, an inbound-header allowlist (`FORWARDED_REQUEST_HEADERS`
 * in `fingerprint/headers.ts` - `cf-*`, `x-forwarded-*`, and the caller's own
 * `user-agent`/`accept*` never reach Discord), `nonce`/`tts`/`flags` fill on a
 * JSON `POST /channels/:id/messages` body, and an opt-in typing indicator
 * (`X-Proxy-Typing: on`, default off) sequenced with an explicit wait before
 * the main dispatch so it clears the identity-wide dispatch-gap floor
 * (`MIN_DISPATCH_GAP_MS` in `rotator/budget.ts`).
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Bindings } from '../types';
import type { AuthVariables } from '../middleware/auth';
import type { DiscordContextVariables, DiscordTokenKind } from '../middleware/discord-context';
import { composeRequestHeaders } from '../fingerprint/headers';
import { contextPropertiesFor } from '../fingerprint/context-properties';
import { resolveProfileId } from '../fingerprint/profiles';
import { resolveClientVersions } from '../fingerprint/versions';
import { blockResponse } from '../rotator/static-guard';
import type { StaticGuard } from '../rotator/static-guard';
import { inspectResponse } from '../rotator/signals';
import { retryDelayMs } from '../rotator/budget';
import { deriveBudgetKey, deriveRouteKey, extractGuildId } from '../rotator/bucket';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import type { AcquireResult, PoolPlan, ReleaseInput, RequestIdentity, RouteKey, Slot, TokenPoolClient } from '../rotator/types';
import type { ClientVersions } from '../fingerprint/versions';

/** Catch-all proxy route - forwards any unmatched request to the Discord API. */
export const proxyRoute = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: DiscordContextVariables & AuthVariables & RotatorVariablesLocal;
}>();

/** Local alias: this file only reads `identity`/`clientVersions`/`poolPlan`/`tokenPoolClient`/`staticGuard`, never sets them. */
type RotatorVariablesLocal = {
  identity?: RequestIdentity;
  clientVersions?: ClientVersions;
  poolPlan?: PoolPlan;
  tokenPoolClient?: TokenPoolClient;
  staticGuard?: StaticGuard;
};

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MESSAGE_SEND_ROUTE: RouteKey = 'POST:/channels/:id/messages';
/** Above this the message body is streamed through unread rather than parsed for defaults - abuse-signal bodies and real message payloads are always small. */
const MAX_FILLABLE_BODY_BYTES = 65536;
/** Comfortably below `LEASE_TTL_MS` in `rotator/budget.ts` so a leased request is never pruned as abandoned out from under its own eventual settle. */
const OUTBOUND_TIMEOUT_MS = 60_000;
/** Discord's snowflake epoch (2015-01-01T00:00:00.000Z), used to synthesize a client-like `nonce`. */
const DISCORD_EPOCH_MS = 1420070400000n;

type SafeInit = RequestInit & { duplex?: 'half' };

const defaultWait = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

proxyRoute.all('/*', async (c) => {
  const url = new URL(c.req.url);
  const method = c.req.method;
  // Both keys come from Hono's decoded request path, the same source the
  // identity middleware built its pool plan from - deriving them from the raw
  // `url.pathname` instead would acquire a lease under one key and release it
  // under another (e.g. `/messages/%73earch`), which the DO drops as a
  // mismatch, leaking the lease. The outbound Discord URL still uses the raw
  // pathname + search so percent-encoding is forwarded untouched.
  const path = c.req.path;
  const discordUrl = `${DISCORD_API_BASE}${url.pathname}${url.search}`;
  const kind: DiscordTokenKind = c.var.discordTokenKind ?? 'bot';
  // `routeKey` drives route-TYPE decisions (message-send body fill, typing,
  // `X-Context-Properties`); `budgetKey` drives every budget/lease/settle
  // call. They differ only in the literal top-level resource id.
  const routeKey = deriveRouteKey(method, path);
  const budgetKey = deriveBudgetKey(method, path);
  const guildId = extractGuildId(path);
  const fetcher = c.var.proxyFetch ?? fetch;
  const wait = c.var.proxyWait ?? defaultWait;

  try {
    // ---- Read the body once (methods that carry one), filling message defaults when applicable. ----
    let bodyInit: ReadableStream<Uint8Array> | string | undefined;
    let messageContent: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const contentType = (c.req.header('content-type') ?? '').toLowerCase();
      const contentLengthHeader = c.req.header('content-length');
      // A declared length at or over the cap streams through unread. An absent
      // one (chunked upload) is read with the cap enforced on the actual bytes,
      // so an oversized chunked body is never buffered whole.
      const declaredTooLarge = contentLengthHeader !== undefined && Number(contentLengthHeader) >= MAX_FILLABLE_BODY_BYTES;
      const fillable = kind !== 'bot' && routeKey === MESSAGE_SEND_ROUTE && contentType.startsWith('application/json') && !declaredTooLarge;
      const rawBody = c.req.raw.body ?? undefined;
      if (fillable && rawBody) {
        const read = await readBodyUpTo(rawBody, MAX_FILLABLE_BODY_BYTES);
        if (read.kind === 'text') {
          const filled = fillMessageBody(read.text);
          bodyInit = filled.body;
          messageContent = filled.content;
        } else {
          bodyInit = read.stream;
        }
      } else {
        bodyInit = rawBody;
      }
    }

    // ---- Bot: no identity, no guard, no pool. ----
    if (kind === 'bot') {
      const headers = await composeRequestHeaders({ token: c.var.discordToken, tokenKind: 'bot', buildHash: BUILD_HASH, inbound: c.req.raw.headers });
      return await dispatch(fetcher, discordUrl, method, headers, bodyInit);
    }

    // ---- Resolve a client (best effort). identityMiddleware already resolved
    // one for most requests; a missing client here (binding failure on an
    // auto-selector pool request, or no binding at all) just means the
    // static path below runs unguarded - it stays first-class either way. ----
    const slot: Slot = c.var.authSlot === 'premium' ? 'premium' : 'default';
    let client = c.var.tokenPoolClient;
    if (!client) {
      try {
        client = createTokenPoolClient(getPoolStub(c.env, slot));
      } catch (err: unknown) {
        console.error('TOKEN_POOL binding unavailable in proxy:', err);
      }
    }

    const versions = c.var.clientVersions ?? resolveClientVersions(null, Date.now());
    const plan = c.var.poolPlan;

    // ---- Attempt the pool when the route is pool-eligible. ----
    let token = c.var.discordToken;
    let identity = c.var.identity;
    let poolLease: { label: string; requestId: string } | undefined;

    if (plan && client) {
      const attempt = await attemptPoolAcquire(client, plan);
      if (attempt.kind === 'blocked') return attempt.response(c);
      if (attempt.kind === 'acquired') {
        token = attempt.tokenSecret;
        poolLease = { label: attempt.label, requestId: attempt.requestId };
        identity = poolIdentity(attempt, versions);
      }
      // 'fallback': token/identity stay the static ones resolved by identityMiddleware.
    }

    const usingPool = poolLease !== undefined;
    const guard: StaticGuard | undefined = usingPool ? undefined : c.var.staticGuard;

    // ---- Typing (opt-in; only for a real, non-empty message send). ----
    let typingDispatched = false;
    if (routeKey === MESSAGE_SEND_ROUTE && messageContent && c.req.header('X-Proxy-Typing') === 'on') {
      typingDispatched = await dispatchTyping({ fetcher, path, identity, versions, guard, token, kind });
      if (typingDispatched) {
        await wait(typingWaitMs(messageContent.length));
      }
    }

    // ---- Main dispatch. Pool tokens already hold their lease from `attemptPoolAcquire`; static tokens lease here, immediately before this one fetch. ----
    let mainLease: { requestId: string } | undefined;
    if (guard) {
      const lease = await guard.lease(budgetKey);
      if (!lease.ok) return blockResponse(c, lease.block);
      mainLease = lease;
    }

    let mainSettled = false;
    let poolReleased = false;
    try {
      const headers = await composeRequestHeaders({ token, tokenKind: kind, identity, versions, inbound: c.req.raw.headers });
      if (typeof bodyInit === 'string') {
        // fillMessageBody rewrote the body (nonce/tts/flags fill) - the inbound
        // Content-Length forwarded above by composeRequestHeaders no longer
        // matches the actual byte length; recompute it.
        headers.set('Content-Length', String(new TextEncoder().encode(bodyInit).byteLength));
      }
      applyContextProperties(headers, routeKey);

      const response = await dispatch(fetcher, discordUrl, method, headers, bodyInit);
      const outcome = await inspectResponse(response, budgetKey, guildId);

      if (usingPool && client && poolLease) {
        // `budgetKey` equals `plan.routeKey` (the key the acquire above was
        // granted under - both derive from `c.req.path`), so the DO matches
        // this release to its outstanding lease instead of dropping it.
        await client.release(poolLease.label, poolLease.requestId, outcome);
        poolReleased = true;
        if (response.status === 429 && plan) {
          return await retryPool({
            c,
            client,
            plan,
            versions,
            kind,
            method,
            routeKey,
            headers: c.req.raw.headers,
            discordUrl,
            fetcher,
            wait,
            outcome,
            fallback: response,
          });
        }
      } else if (guard && mainLease) {
        await guard.settle(mainLease.requestId, outcome);
        mainSettled = true;
      }

      return response;
    } catch (err: unknown) {
      if (guard && mainLease && !mainSettled) {
        await guard.settle(mainLease.requestId, { status: 599, routeKey: budgetKey }).catch((cleanupErr: unknown) => {
          console.error('PROXY guard cleanup failed:', cleanupErr);
        });
      }
      if (plan && client && poolLease && !poolReleased) {
        // The pool release key must equal the acquire key, and `plan.routeKey`
        // is exactly that budget key - the plan that produced this lease.
        await client.release(poolLease.label, poolLease.requestId, { status: 599, routeKey: plan.routeKey }).catch(
          (cleanupErr: unknown) => {
            console.error('PROXY pool release cleanup failed:', cleanupErr);
          },
        );
      }
      throw err;
    }
  } catch (err: unknown) {
    console.error('PROXY ERR:', err);
    return c.json({ error: 'Proxy error' }, 500);
  }
});

/** Dispatch one outbound fetch with the standard timeout + streaming-body init. */
async function dispatch(
  fetcher: typeof fetch,
  discordUrl: string,
  method: string,
  headers: Headers,
  bodyInit: ReadableStream<Uint8Array> | string | undefined,
): Promise<Response> {
  const init: SafeInit = { method, headers, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) };
  if (bodyInit !== undefined) {
    init.body = bodyInit;
    if (typeof bodyInit !== 'string') init.duplex = 'half'; // Required for streaming request bodies in Workers.
  }
  return await fetcher(discordUrl, init as RequestInit);
}

/**
 * Fill `nonce`/`tts`/`flags` on a JSON message-send body. The body is never
 * re-serialized: a caller's numeric `nonce` above 2^53 (Discord accepts
 * 64-bit ids) would round through `JSON.parse` + `JSON.stringify`, so the
 * original text is forwarded byte-for-byte when nothing is missing, and
 * otherwise the missing `"key":value` pairs are spliced in textually before
 * the final closing brace, leaving every original lexeme untouched. Forwards
 * the original text unchanged on parse failure or a non-object body.
 */
function fillMessageBody(text: string): { body: string; content: string | undefined } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: text, content: undefined };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body: text, content: undefined };
  }
  const obj = parsed as Record<string, unknown>;
  const additions: string[] = [];
  if (obj.nonce === undefined) additions.push(`"nonce":${JSON.stringify(String((BigInt(Date.now()) - DISCORD_EPOCH_MS) << 22n))}`);
  if (obj.tts === undefined) additions.push('"tts":false');
  if (obj.flags === undefined) additions.push('"flags":0');
  const content = typeof obj.content === 'string' && obj.content.length > 0 ? obj.content : undefined;
  if (additions.length === 0) return { body: text, content };

  const close = text.lastIndexOf('}');
  const beforeClose = text.slice(0, close).trimEnd();
  // `{}` (or all-whitespace members) must not gain a leading comma.
  const separator = beforeClose.endsWith('{') ? '' : ',';
  return { body: `${beforeClose}${separator}${additions.join(',')}${text.slice(close)}`, content };
}

/**
 * Read a request body only while it stays under `cap` bytes. Returns the
 * decoded text when the whole body fits; otherwise a stream that replays the
 * bytes already read followed by the unread remainder, so an oversized body is
 * forwarded unchanged without ever being held in memory whole.
 */
async function readBodyUpTo(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ kind: 'text'; text: string } | { kind: 'stream'; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= cap) return { kind: 'stream', stream: replayThenRest(chunks, reader) };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'text', text: new TextDecoder().decode(bytes) };
}

/** A stream that first emits `buffered`, then pulls the rest from `reader`. */
function replayThenRest(buffered: readonly Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < buffered.length) {
        controller.enqueue(buffered[next++]);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Set the route's default `X-Context-Properties` (see `context-properties.ts`) unless the caller already sent one. */
function applyContextProperties(headers: Headers, routeKey: RouteKey): void {
  if (headers.has('X-Context-Properties')) return;
  const contextProperties = contextPropertiesFor(routeKey);
  if (contextProperties) headers.set('X-Context-Properties', contextProperties);
}

/** Pre-send typing delay: a rough humanized read of `600ms + 55ms/char`, clamped to 1-4s, plus up to 400ms of jitter. */
function typingWaitMs(contentLength: number): number {
  return Math.max(1000, Math.min(4000, 600 + 55 * contentLength) + Math.floor(Math.random() * 400));
}

type PoolAcquireOutcome =
  | { kind: 'acquired'; label: string; tokenSecret: string; requestId: string; fingerprintProfileId: string }
  | { kind: 'fallback' }
  | {
      kind: 'blocked';
      response: (c: { json: (body: unknown, status: 429 | 503, headers?: Record<string, string>) => Response }) => Response;
    };

/**
 * Attempt the pool for one request. Auto selection gracefully falls back to
 * the static identity on `empty-pool`/`no-eligible-token` (a genuinely busy
 * or unconfigured pool shouldn't fail the whole request when a static
 * fallback exists); a `cooldown` result, and every failure on a *pinned*
 * label (`X-Proxy-Token: <label>`), is a hard failure - pinning explicitly
 * asked for that one token, so silently substituting another would defeat
 * the pin.
 */
async function attemptPoolAcquire(client: TokenPoolClient, plan: PoolPlan): Promise<PoolAcquireOutcome> {
  try {
    let result: AcquireResult;
    if (plan.selector === 'auto') {
      result = await client.acquire(plan.slot, plan.routeKey, plan.guildId);
    } else {
      if (!client.acquireByLabel) {
        return { kind: 'blocked', response: (c) => c.json({ error: 'token pool unavailable' }, 503) };
      }
      result = await client.acquireByLabel(plan.selector.label, plan.slot, plan.routeKey, plan.guildId);
    }

    if (result.ok) {
      return {
        kind: 'acquired',
        label: result.label,
        tokenSecret: result.tokenSecret,
        requestId: result.requestId,
        fingerprintProfileId: result.fingerprintProfileId,
      };
    }

    if (plan.selector !== 'auto') {
      if (result.reason === 'cooldown') {
        return { kind: 'blocked', response: (c) => cooldownResponse(c, result.retryAfter) };
      }
      return { kind: 'blocked', response: (c) => c.json({ error: 'token pool unavailable', reason: result.reason }, 503) };
    }

    if (result.reason === 'cooldown') {
      return { kind: 'blocked', response: (c) => cooldownResponse(c, result.retryAfter) };
    }
    return { kind: 'fallback' };
  } catch (err: unknown) {
    console.error('TOKEN_POOL acquire failed:', err);
    return { kind: 'blocked', response: (c) => c.json({ error: 'token pool unavailable' }, 503) };
  }
}

function cooldownResponse(
  c: { json: (body: unknown, status: 429, headers?: Record<string, string>) => Response },
  retryAfterMs: number,
): Response {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return c.json({ error: 'Too Many Requests', retryAfter: seconds }, 429, { 'Retry-After': String(seconds) });
}

function poolIdentity(attempt: Extract<PoolAcquireOutcome, { kind: 'acquired' }>, versions: ClientVersions): RequestIdentity {
  return {
    key: `pool:${attempt.label}`,
    kind: 'pool',
    label: attempt.label,
    profile: resolveProfileId(attempt.fingerprintProfileId, versions.chromeMajor),
  };
}

/** Dispatch the opt-in `/typing` indicator, guarded if a `StaticGuard` is present, unguarded (never erroring) otherwise. Returns whether it was actually dispatched. */
async function dispatchTyping(args: {
  fetcher: typeof fetch;
  path: string;
  identity: RequestIdentity | undefined;
  versions: ClientVersions;
  guard: StaticGuard | undefined;
  token: string;
  kind: DiscordTokenKind;
}): Promise<boolean> {
  const channelId = args.path.match(/^\/channels\/(\d{17,20})\//)?.[1];
  if (!channelId) return false;
  const typingUrl = `${DISCORD_API_BASE}/channels/${channelId}/typing`;
  // Typing is its own Discord rate-limit bucket, and the budget key keeps
  // this channel's literal id so the lease is scoped to the same resource
  // the message send that follows it belongs to.
  const typingRouteKey = deriveBudgetKey('POST', `/channels/${channelId}/typing`);

  if (args.guard) {
    const lease = await args.guard.lease(typingRouteKey);
    if (!lease.ok) return false; // Blocked - skip typing entirely, fall through to the main dispatch with no wait.
    let settled = false;
    try {
      const headers = await composeRequestHeaders({
        token: args.token,
        tokenKind: args.kind,
        identity: args.identity,
        versions: args.versions,
      });
      const response = await dispatch(args.fetcher, typingUrl, 'POST', headers, undefined);
      const outcome = await inspectResponse(response, typingRouteKey);
      await args.guard.settle(lease.requestId, outcome);
      settled = true;
      await response.body?.cancel();
    } catch (err: unknown) {
      if (!settled) {
        await args.guard.settle(lease.requestId, { status: 599, routeKey: typingRouteKey }).catch((cleanupErr: unknown) => {
          console.error('PROXY typing guard cleanup failed:', cleanupErr);
        });
      }
      console.error('PROXY typing dispatch failed:', err);
    }
    return true;
  }

  // No guard (no DO binding) - dispatch unguarded; nothing to reserve or settle.
  try {
    const headers = await composeRequestHeaders({
      token: args.token,
      tokenKind: args.kind,
      identity: args.identity,
      versions: args.versions,
    });
    const response = await dispatch(args.fetcher, typingUrl, 'POST', headers, undefined);
    await response.body?.cancel();
  } catch (err: unknown) {
    console.error('PROXY typing dispatch failed:', err);
  }
  return true;
}

/**
 * Single retry attempt on a pool 429: wait the shared backoff, acquire a
 * fresh token (auto or the same pinned label - `attemptPoolAcquire` again
 * applies the same fallback/hard-failure rules), and re-dispatch. Every
 * rotatable route is GET (see `bucket.ts`'s `ROTATABLE_ALLOWLIST`), so there
 * is never a body to worry about reusing on the retry.
 */
async function retryPool(args: {
  c: { json: (body: unknown, status: 429 | 503, headers?: Record<string, string>) => Response };
  client: TokenPoolClient;
  plan: PoolPlan;
  versions: ClientVersions;
  kind: DiscordTokenKind;
  method: string;
  /** The normalized route-type key - drives `X-Context-Properties` only; every pool call uses `plan.routeKey`. */
  routeKey: RouteKey;
  headers: Headers;
  discordUrl: string;
  fetcher: typeof fetch;
  wait: (ms: number) => Promise<void>;
  outcome: ReleaseInput;
  fallback: Response;
}): Promise<Response> {
  await args.wait(retryDelayMs(args.outcome));
  const retry = await attemptPoolAcquire(args.client, args.plan);
  if (retry.kind !== 'acquired') {
    return args.fallback; // No alternative token; pass the original 429 through.
  }

  const retryIdentity = poolIdentity(retry, args.versions);
  try {
    const retryHeaders = await composeRequestHeaders({
      token: retry.tokenSecret,
      tokenKind: args.kind,
      identity: retryIdentity,
      versions: args.versions,
      inbound: args.headers,
    });
    applyContextProperties(retryHeaders, args.routeKey);

    const retryResponse = await dispatch(args.fetcher, args.discordUrl, args.method, retryHeaders, undefined);
    // Same budget key as the acquire above, so the retry lease settles.
    const retryOutcome = await inspectResponse(retryResponse, args.plan.routeKey, args.plan.guildId);
    await args.client.release(retry.label, retry.requestId, retryOutcome);
    return retryResponse;
  } catch (err: unknown) {
    await args.client.release(retry.label, retry.requestId, { status: 599, routeKey: args.plan.routeKey }).catch((cleanupErr: unknown) => {
      console.error('PROXY retryPool release cleanup failed:', cleanupErr);
    });
    throw err;
  }
}
