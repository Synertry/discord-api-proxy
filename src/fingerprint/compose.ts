/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/compose
 * Pure functions that compose the per-request fingerprint header set.
 *
 * Runtime-agnostic. No imports from `@hono/*` or `cloudflare:*`. Only
 * standard `TextEncoder`, `btoa`, etc.
 *
 * `composeSuperProperties` appends the dynamic fields (`client_build_number`,
 * `client_event_source`, the three session ids, `client_app_state`) after
 * the profile's static fields, in the exact trailing order a live 2026-09-21
 * capture showed - see `profiles.ts` for the full provenance note.
 */

import type { ResolvedProfile } from './profiles';
import type { ClientVersions } from './versions';
import type { FingerprintSession } from './session';

/** Compose the full set of user-token-side request headers for a resolved profile, the live client versions, and the current session. */
export function composeFingerprint(
  profile: ResolvedProfile,
  versions: ClientVersions,
  session: FingerprintSession,
): Record<string, string> {
  const superPropsB64 = encodeBase64Utf8(JSON.stringify(composeSuperProperties(profile, versions, session)));

  return {
    'Sec-CH-UA': profile.clientHints['Sec-CH-UA'],
    'Sec-CH-UA-Mobile': profile.clientHints['Sec-CH-UA-Mobile'],
    'Sec-CH-UA-Platform': profile.clientHints['Sec-CH-UA-Platform'],
    Priority: 'u=0, i',
    Accept: '*/*',
    'Accept-Language': buildAcceptLanguage(profile.locale),
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    Origin: 'https://discord.com',
    Referer: 'https://discord.com/channels/@me',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': profile.userAgent,
    'X-Debug-Options': 'bugReporterEnabled',
    'X-Discord-Locale': profile.locale,
    'X-Discord-Timezone': profile.timezone,
    'X-Super-Properties': superPropsB64,
  };
}

/** Build the decoded `X-Super-Properties` object: the profile's static fields followed by the dynamic ones, in real-capture order. */
export function composeSuperProperties(
  profile: ResolvedProfile,
  versions: ClientVersions,
  session: FingerprintSession,
): Record<string, unknown> {
  return {
    ...profile.superProperties,
    client_build_number: versions.buildNumber,
    client_event_source: null,
    client_launch_id: session.clientLaunchId,
    launch_signature: session.launchSignature,
    client_heartbeat_session_id: session.clientHeartbeatSessionId,
    client_app_state: 'focused',
  };
}

/** Same shape as `composeSuperProperties`, plus the two fields the gateway IDENTIFY payload's `properties` carries that the HTTP header does not. */
export function composeGatewayProperties(
  profile: ResolvedProfile,
  versions: ClientVersions,
  session: FingerprintSession,
): Record<string, unknown> {
  return {
    ...composeSuperProperties(profile, versions, session),
    is_fast_connect: false,
    gateway_connect_reasons: 'AppSkeleton',
  };
}

/**
 * Compose the bot User-Agent string. Discord's API documentation requires bot
 * requests to identify themselves with a URL and version; the build hash is
 * injected at deploy time via the `BUILD_HASH` define so each rollout is
 * distinct in upstream logs.
 */
export function composeBotUserAgent(buildHash: string): string {
  return `DiscordBot (https://github.com/Synertry/discord-api-proxy, ${buildHash})`;
}

/**
 * Build the `Accept-Language` header from a Discord locale. Real browsers
 * advertise the primary locale plus a fallback chain with q-weights; we mimic
 * the typical `de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7` shape.
 */
function buildAcceptLanguage(locale: string): string {
  const primary = locale.toLowerCase();
  if (primary === 'en-us' || primary === 'en') {
    return 'en-US,en;q=0.9';
  }
  if (primary === 'de') {
    return 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';
  }
  if (primary.includes('-')) {
    const base = primary.split('-')[0];
    return `${primary},${base};q=0.9,en-US;q=0.8,en;q=0.7`;
  }
  return `${primary},en-US;q=0.9,en;q=0.8`;
}

/**
 * Base64-encode a UTF-8 string. The Workers runtime exposes `btoa` but it only
 * handles Latin-1 input; the explicit encode-then-binary-string conversion is
 * what makes non-ASCII profile fields round-trip correctly.
 */
function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Re-export profile lookup helpers so callers can `import` everything from one place. */
export { lookupProfile, listProfileIds, resolveProfileId, resolveCustom, resolveTemplate, FALLBACK_PROFILE_ID } from './profiles';
export type { ResolvedProfile, ProfileTemplate, CustomProfile, StaticSuperProperties } from './profiles';
