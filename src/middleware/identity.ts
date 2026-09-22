/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module middleware/identity
 * Sieve layer 3.5: resolves the request's Discord identity. Renamed from
 * `token-rotator.ts`.
 *
 * Runs after `discordContextMiddleware` (so `c.var.discordToken` already holds
 * a static-token fallback) and before `snowflakeValidatorMiddleware`.
 *
 * Never acquires or leases anything - only reads. This closes the
 * cross-boundary lease-leak the pre-rewrite middleware had for pool tokens:
 * it used to call `acquire()` here and rely on `proxy.ts`, several
 * middleware layers downstream, to call `release()`; any early return in
 * between (a snowflake-validator 400, a thrown error) leaked the lease
 * (`inFlightCount` only ever decrements on `release`, so a leaked count
 * persists and skews LRU selection indefinitely - not self-correcting).
 *
 * Instead this middleware only resolves:
 * - `identity` (+ `clientVersions`): a read-only static-identity peek via
 *   `prepareStatic`, always set for non-bot requests as the fallback.
 * - `poolPlan`: recorded, never acted on, when the route is pool-eligible
 *   (rotatable and not pinned to `static`).
 *
 * `proxy.ts` is the only place that ever calls `acquire`/`acquireByLabel`/
 * `release` or `leaseStatic`/`settleStatic` - always paired within the same
 * function, immediately around the one outbound fetch each guards.
 *
 * Selection is controlled by the optional `X-Proxy-Token` header:
 * - `static`             -> no pool plan; static identity is final
 * - `<label>`            -> pool plan pins to that label
 * - absent / `auto`      -> pool plan uses LRU selection
 */

import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../types';
import type { AuthVariables } from './auth';
import type { DiscordContextVariables } from './discord-context';
import { parseProxyTokenHeader } from './proxy-token-header';
import { deriveRouteKey, extractGuildId, isRotatableRoute } from '../rotator/bucket';
import { createTokenPoolClient, getPoolStub } from '../rotator/client';
import { resolveClientVersions } from '../fingerprint/versions';
import { resolveProfileId, resolveCustom } from '../fingerprint/profiles';
import type { RotatorVariables, Slot, StaticPrepareResult, StaticTokenKind, TokenPoolClient } from '../rotator/types';

export const identityMiddleware = createMiddleware<{
  Bindings: Bindings;
  Variables: AuthVariables & DiscordContextVariables & RotatorVariables;
}>(async (c, next) => {
  if (c.var.discordTokenKind === 'bot') {
    // Bot requests carry only the Discord-compliant DiscordBot UA (see
    // composeRequestHeaders); they have no fingerprint identity to resolve.
    await next();
    return;
  }

  const selector = parseProxyTokenHeader(c.req.header('X-Proxy-Token'));
  const slot: Slot = c.var.authSlot === 'premium' ? 'premium' : 'default';
  const rotatable = selector !== 'static' && isRotatableRoute(c.req.method, c.req.path);

  // Best-effort client resolution: absent here means the static path falls
  // back to the fallback profile/versions (never blocks - see
  // resolveStaticIdentity); the pool path only needs the client to exist
  // when proxy.ts actually attempts an acquire later, which it re-resolves
  // itself from `poolPlan` + the binding, not from a client stashed here.
  let client = c.var.tokenPoolClient;
  if (!client) {
    try {
      const stub = getPoolStub(c.env, slot);
      client = createTokenPoolClient(stub);
      c.set('tokenPoolClient', client);
    } catch (err: unknown) {
      console.error('TOKEN_POOL binding unavailable:', err);
      // Only fatal for the pool path; the static path below tolerates a missing client entirely.
      if (rotatable && selector !== 'auto') {
        return c.json({ error: 'token pool unavailable' }, 503);
      }
    }
  }

  await resolveStaticIdentity(c, client);

  if (rotatable) {
    c.set('poolPlan', {
      slot,
      selector: selector === 'auto' ? 'auto' : { label: selector.label },
      routeKey: deriveRouteKey(c.req.method, c.req.path),
      guildId: extractGuildId(c.req.path),
    });
  }

  await next();
});

/** Resolve the read-only fallback identity (fingerprint + live versions) onto context. Never blocks - a client-less or failing DO call just falls back to the fallback profile/versions. */
async function resolveStaticIdentity(
  c: { var: DiscordContextVariables; set: (key: 'clientVersions' | 'identity', value: unknown) => void },
  client: TokenPoolClient | undefined,
): Promise<void> {
  const kind = c.var.discordTokenKind as StaticTokenKind;
  const prepared = client?.prepareStatic ? await safePrepareStatic(client.prepareStatic, kind) : null;

  const versions = resolveClientVersions(prepared?.versions ?? null, Date.now());
  c.set('clientVersions', versions);

  const fingerprint = prepared?.fingerprint;
  const profile =
    fingerprint?.profileId === 'custom' && fingerprint.custom
      ? resolveCustom(fingerprint.custom)
      : resolveProfileId(fingerprint?.profileId, versions.chromeMajor);

  c.set('identity', {
    key: `static:${kind}`,
    kind: 'static',
    staticKind: kind,
    profile,
  });
}

/** Best-effort: a DO RPC failure here must never block the static path (it has no eligibility check to fail anyway) - fall back to the fallback profile/versions. */
async function safePrepareStatic(
  prepareStatic: NonNullable<TokenPoolClient['prepareStatic']>,
  kind: StaticTokenKind,
): Promise<StaticPrepareResult> {
  try {
    return await prepareStatic(kind);
  } catch (err: unknown) {
    console.error('prepareStatic failed:', err);
    return { fingerprint: null, versions: { build: null, chrome: null } };
  }
}
