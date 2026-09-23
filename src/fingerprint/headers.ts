/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/headers
 * The single request-header composer every Discord caller (proxy.ts, the
 * in-worker custom clients, the admin identity-preview endpoint) uses.
 *
 * Replaces the old clone-everything-except-a-blocklist approach
 * (`STRIPPED_HEADERS` in the pre-rewrite `proxy.ts`) with an allowlist:
 * `cf-*`, `x-forwarded-*`, `x-real-ip`, `cdn-loop`, the caller's own
 * `user-agent`/`accept*`, and every `x-proxy-*` header are dropped
 * unconditionally, regardless of what a future inbound request happens to
 * carry, closing the leak that let the operator's real IP ride along to
 * Discord next to the Worker's fingerprint.
 */

import { composeFingerprint, composeBotUserAgent } from './compose';
import { resolveProfileId } from './profiles';
import { resolveClientVersions } from './versions';
import { deriveFingerprintSession } from './session';
import type { ResolvedProfile } from './profiles';
import type { ClientVersions, ClientVersionRecords } from './versions';
import type { StaticTokenKind } from '../rotator/types';

/** Inbound headers a caller is allowed to have forwarded verbatim; everything else is dropped. */
export const FORWARDED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'x-audit-log-reason',
  'x-context-properties',
  'x-captcha-key',
  'x-captcha-session-id',
  'x-captcha-rqtoken',
  'if-none-match',
  'if-modified-since',
  'range',
]);

export interface RequestIdentity {
  key: string;
  profile: ResolvedProfile;
  kind: 'static' | 'pool';
  staticKind?: StaticTokenKind;
  label?: string;
}

export interface ComposeRequestHeadersArgs {
  token: string;
  tokenKind: 'bot' | 'user-default' | 'user-premium';
  /** Required when `tokenKind === 'bot'`; the deploy build hash embedded in the bot User-Agent. Ignored for user-token kinds. */
  buildHash?: string;
  identity?: RequestIdentity;
  versions?: ClientVersions | ClientVersionRecords | null;
  inbound?: Headers;
  now?: number;
}

/**
 * Compose the full outbound header set for one Discord request: the
 * allowlisted subset of the inbound headers, `Authorization` (replacing, not
 * appending, any inbound value), and - for user-token kinds - the full
 * client-hint / super-properties fingerprint set.
 */
export async function composeRequestHeaders(args: ComposeRequestHeadersArgs): Promise<Headers> {
  const now = args.now ?? Date.now();
  const headers = new Headers();

  if (args.inbound) {
    for (const [name, value] of args.inbound.entries()) {
      if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) {
        headers.set(name, value);
      }
    }
  }

  if (args.tokenKind === 'bot') {
    headers.set('User-Agent', composeBotUserAgent(args.buildHash ?? 'dev'));
    headers.set('Authorization', args.token);
    return headers;
  }

  const versions = resolveVersions(args.versions, now);
  const profile = args.identity?.profile ?? resolveProfileId(undefined, versions.chromeMajor);
  const session = await deriveFingerprintSession(args.identity?.key ?? `static:${args.tokenKind}`, now);
  const fingerprintHeaders = composeFingerprint(profile, versions, session);
  for (const [name, value] of Object.entries(fingerprintHeaders)) {
    headers.set(name, value);
  }

  // Set last: guarantees the real token always wins even if a future bug
  // ever let an "authorization"/"cookie"-named key ride through inbound
  // allowlisting or a composed header set above.
  headers.set('Authorization', args.token);

  return headers;
}

function resolveVersions(input: ClientVersions | ClientVersionRecords | null | undefined, now: number): ClientVersions {
  if (!input) return resolveClientVersions(null, now);
  if ('buildNumber' in input && 'chromeMajor' in input) return input;
  return resolveClientVersions(input, now);
}
