/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module rotator/client
 * Worker-side wrapper around the TokenPoolDO RPC interface.
 *
 * The factory `createTokenPoolClient` produces a `TokenPoolClient` that other
 * modules (middleware, bingo discord-client, admin routes) consume through a
 * stable interface. Tests inject a `vi.fn()`-backed client via
 * `createApp(_, mockTokenPool)` instead of constructing one from a real DO.
 *
 * The factory `getPoolStub` resolves the canonical DO instance. v1 always
 * returns the `'token-pool-v1'` instance; the call-site abstraction lets us
 * shift to per-slot or per-route sharding later as a one-file change.
 */

import type { ClientVersionRecords } from '../fingerprint/versions';
import type { Bindings } from '../types';
import type {
  AcquireResult,
  LeaseStaticResult,
  ReleaseInput,
  RouteKey,
  Slot,
  StaticPrepareResult,
  StaticTokenKind,
  TokenPoolClient,
} from './types';

/** Default DO instance name. Sharding refactor swaps this constant. */
export const POOL_INSTANCE_NAME = 'token-pool-v1';

/**
 * Resolve the DO stub for the pool. `slot` is reserved for future per-slot
 * sharding (idFromName(`token-pool-${slot}`)); v1 ignores it and always returns
 * the single canonical instance.
 */
export function getPoolStub(env: Bindings, _slot?: Slot): DurableObjectStub {
  const id = env.TOKEN_POOL.idFromName(POOL_INSTANCE_NAME);
  return env.TOKEN_POOL.get(id);
}

/**
 * Build a TokenPoolClient backed by the given DO stub. Each method forwards
 * to the underlying DO RPC. The DO is responsible for ordering and
 * atomicity (input/output gates around every storage operation); this
 * wrapper is intentionally thin.
 *
 * The static-identity guard methods (`prepareStatic`, `leaseStatic`,
 * `settleStatic`, `getClientVersions`) are present on the real client; the
 * {@link TokenPoolClient} interface declares them optional so mock clients in
 * tests can omit them.
 */
export function createTokenPoolClient(stub: DurableObjectStub): TokenPoolClient {
  const rpc = stub as unknown as RpcShape;

  return {
    acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
      return rpc.acquire(slot, routeKey, guildId);
    },
    acquireByLabel(label: string, slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult> {
      return rpc.acquireByLabel(label, slot, routeKey, guildId);
    },
    release(label: string, requestId: string, response: ReleaseInput): Promise<void> {
      return rpc.release(label, requestId, response);
    },
    prepareStatic(kind: StaticTokenKind): Promise<StaticPrepareResult> {
      return rpc.prepareStatic(kind);
    },
    leaseStatic(kind: StaticTokenKind, tokenHash: string, routeKey: RouteKey): Promise<LeaseStaticResult> {
      return rpc.leaseStatic(kind, tokenHash, routeKey);
    },
    settleStatic(kind: StaticTokenKind, tokenHash: string, requestId: string, outcome: ReleaseInput): Promise<void> {
      return rpc.settleStatic(kind, tokenHash, requestId, outcome);
    },
    getClientVersions(): Promise<ClientVersionRecords> {
      return rpc.getClientVersions();
    },
  };
}

/**
 * Internal contract: the DO stub's runtime shape. The DurableObjectStub type
 * doesn't expose RPC method types (those come from the class). We assert the
 * shape here so the rest of the codebase doesn't need to know about the cast.
 */
interface RpcShape {
  acquire(slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult>;
  acquireByLabel(label: string, slot: Slot, routeKey: RouteKey, guildId?: string): Promise<AcquireResult>;
  release(label: string, requestId: string, response: ReleaseInput): Promise<void>;
  prepareStatic(kind: StaticTokenKind): Promise<StaticPrepareResult>;
  leaseStatic(kind: StaticTokenKind, tokenHash: string, routeKey: RouteKey): Promise<LeaseStaticResult>;
  settleStatic(kind: StaticTokenKind, tokenHash: string, requestId: string, outcome: ReleaseInput): Promise<void>;
  getClientVersions(): Promise<ClientVersionRecords>;
}
