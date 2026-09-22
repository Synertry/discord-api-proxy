/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/profiles
 * Generated Chromium client identity templates plus operator-captured
 * "clone" profiles for a real account.
 *
 * PORTABILITY: this file is deliberately runtime-agnostic. No imports from
 * `@hono/*`, `cloudflare:*`, or any binding type.
 *
 * Templates are resolved against the live Chrome stable major (see
 * `versions.ts`) so the emitted `User-Agent` / `Sec-CH-UA` / super-properties
 * always describe a real, currently-shipping Chrome build instead of a
 * pinned, aging one. The static field order inside `superProperties` matches
 * a live 2026-09-21 browser capture's key order exactly (`os`, `browser`,
 * `device`, `system_locale`, `has_client_mods`, `browser_user_agent`,
 * `browser_version`, `os_version`, the four `referr*` fields, then
 * `release_channel`); `compose.ts` appends the per-request dynamic fields
 * (`client_build_number`, `client_event_source`, the three session ids,
 * `client_app_state`) after that, in the same trailing order the capture
 * showed.
 *
 * Profiles are operator-chosen, non-secret IDs; treat them as public values.
 */

import { formatChromiumUserAgent, clientHints as chromiumClientHints, type Platform } from './chromium';

export type { Platform } from './chromium';

export interface ProfileTemplate {
  id: string;
  platform: Platform;
  locale: 'de' | 'en-US';
  timezone: string;
}

/** Generated Chromium templates. Each pairs a platform with a locale/timezone; UA and client hints are derived at resolve time from the live Chrome major. */
export const PROFILES: readonly ProfileTemplate[] = [
  { id: 'chrome-win-de', platform: 'Windows', locale: 'de', timezone: 'Europe/Berlin' },
  { id: 'chrome-win-en', platform: 'Windows', locale: 'en-US', timezone: 'America/New_York' },
  { id: 'chrome-mac-de', platform: 'macOS', locale: 'de', timezone: 'Europe/Berlin' },
  { id: 'chrome-mac-en', platform: 'macOS', locale: 'en-US', timezone: 'America/New_York' },
];

/** Operator-chosen default profile id used when a token has no assignment yet, or an old registry id no longer resolves. */
export const FALLBACK_PROFILE_ID = 'chrome-win-de';

export interface ClientHints {
  'Sec-CH-UA': string;
  'Sec-CH-UA-Mobile': string;
  'Sec-CH-UA-Platform': string;
}

/**
 * Static super-properties fields, in the exact order a live capture showed.
 * Deliberately excludes the four request-time-dynamic fields
 * (`client_build_number`, `client_event_source`, the two session ids, and
 * `launch_signature`) and `client_app_state`; `compose.ts` appends those
 * last so the final object's key order matches the real client's wire shape.
 */
export interface StaticSuperProperties {
  os: string;
  browser: string;
  device: string;
  system_locale: string;
  has_client_mods: boolean;
  browser_user_agent: string;
  browser_version: string;
  os_version: string;
  referrer: string;
  referring_domain: string;
  referrer_current: string;
  referring_domain_current: string;
  release_channel: string;
}

/**
 * An operator-registered clone of a real client's fingerprint, captured from
 * DevTools. `superProperties` is restricted to `StaticSuperProperties`: every
 * dynamic/session field a real capture also contains (`client_build_number`,
 * `client_event_source`, `client_launch_id`, `launch_signature`,
 * `client_heartbeat_session_id`, `client_app_state`) is intentionally absent
 * from this type. Those rotate per launch/session in the real client too, so
 * `session.ts` generates fresh ones for every identity - custom profiles
 * included - rather than freezing a single captured snapshot forever.
 */
export interface CustomProfile {
  userAgent: string;
  superProperties: StaticSuperProperties;
  locale: string;
  timezone: string;
  clientHints: ClientHints;
}

export interface ResolvedProfile {
  id: string;
  userAgent: string;
  locale: string;
  timezone: string;
  clientHints: ClientHints;
  superProperties: StaticSuperProperties;
}

const BY_ID: ReadonlyMap<string, ProfileTemplate> = new Map(PROFILES.map((p) => [p.id, p]));

/** Look up a profile template by id. Returns undefined for unknown ids (including retired registry ids from before the template rewrite, and any non-registry string such as an inherited Object.prototype name). */
export function lookupProfile(id: string): ProfileTemplate | undefined {
  return BY_ID.get(id);
}

/** Return all template ids in their declared order. Non-secret operator metadata. */
export function listProfileIds(): readonly string[] {
  return PROFILES.map((p) => p.id);
}

const OS_NAME: Record<Platform, string> = { Windows: 'Windows', macOS: 'Mac OS X' };
const OS_VERSION: Record<Platform, string> = { Windows: '10', macOS: '10.15.7' };

/** Resolve a template against the live Chrome major into a full profile ready for `compose.ts`. */
export function resolveTemplate(template: ProfileTemplate, chromeMajor: number): ResolvedProfile {
  const userAgent = formatChromiumUserAgent(template.platform, chromeMajor);
  const superProperties: StaticSuperProperties = {
    os: OS_NAME[template.platform],
    browser: 'Chrome',
    device: '',
    system_locale: template.locale,
    has_client_mods: false,
    browser_user_agent: userAgent,
    browser_version: `${chromeMajor}.0.0.0`,
    os_version: OS_VERSION[template.platform],
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
  };
  return {
    id: template.id,
    userAgent,
    locale: template.locale,
    timezone: template.timezone,
    clientHints: chromiumClientHints(template.platform, chromeMajor),
    superProperties,
  };
}

/** Resolve a template id (falling back to `FALLBACK_PROFILE_ID` for unknown/undefined ids, so old registry ids and unregistered tokens never throw) against the live Chrome major. */
export function resolveProfileId(id: string | undefined, chromeMajor: number): ResolvedProfile {
  const template = (id ? lookupProfile(id) : undefined) ?? lookupProfile(FALLBACK_PROFILE_ID);
  // FALLBACK_PROFILE_ID is always a valid registry entry (enforced by the profiles.spec.ts invariant test), so this is never undefined.
  return resolveTemplate(template as ProfileTemplate, chromeMajor);
}

/** Resolve an operator-captured clone profile. `custom.superProperties` is already the static-only shape (enforced by `validateCustomProfile`); `compose.ts` appends the dynamic fields from `session.ts` and the live build number, same as a generated template. */
export function resolveCustom(custom: CustomProfile): ResolvedProfile {
  return {
    id: 'custom',
    userAgent: custom.userAgent,
    locale: custom.locale,
    timezone: custom.timezone,
    clientHints: custom.clientHints,
    superProperties: custom.superProperties,
  };
}

export type ValidateCustomProfileResult = { ok: true; profile: CustomProfile } | { ok: false; reason: string };

/**
 * Header-value safety check for a direct (non-base64-encoded) header field:
 * printable ASCII only, rejecting CR/LF/control characters (which would make
 * `Headers.set` throw downstream, or in a less strict host, enable header
 * splitting) and non-ByteString/Unicode characters, plus a practical length
 * ceiling. Real User-Agent strings, BCP-47 locale tags, IANA timezone names,
 * and Sec-CH-UA-family client hints are always printable ASCII, so this is
 * not a functional restriction on legitimate captures.
 */
function isHeaderSafeValue(value: string, maxLen: number): boolean {
  if (value.length === 0 || value.length > maxLen) return false;
  return /^[\x20-\x7E]+$/.test(value);
}

/**
 * Validate an admin-submitted custom profile. `superProperties` may be a
 * plain object or a base64 string (the same shape the real `X-Super-Properties`
 * header carries), since operators typically paste the header value verbatim.
 *
 * Only the known static fields are copied out via an explicit allowlist;
 * every dynamic/session field in the input (`client_build_number`,
 * `client_event_source`, `client_launch_id`, `launch_signature`,
 * `client_heartbeat_session_id`, `client_app_state`, or anything else not on
 * the allowlist) is dropped, never stored, and never echoed back.
 *
 * `userAgent`, `locale`, `timezone`, and the three client hints become raw
 * (non-base64) outbound header values via `compose.ts`, so each is checked
 * with `isHeaderSafeValue` - not just type/non-emptiness - to stop a
 * malformed admin registration from persisting a value that makes every
 * later request (and the identity preview) for that static kind throw on an
 * invalid `Headers.set` call. `superProperties`' other fields are always
 * base64-encoded before they ever reach a header, so they only need the
 * type checks already below.
 */
export function validateCustomProfile(input: unknown): ValidateCustomProfileResult {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'input-not-object' };
  const candidate = input as Record<string, unknown>;

  if (typeof candidate.userAgent !== 'string' || !isHeaderSafeValue(candidate.userAgent, 512) || candidate.userAgent.length < 20) {
    return { ok: false, reason: 'userAgent-invalid' };
  }

  let rawSuperProperties: Record<string, unknown>;
  if (typeof candidate.superProperties === 'string') {
    let decoded: unknown;
    try {
      decoded = JSON.parse(atob(candidate.superProperties));
    } catch {
      return { ok: false, reason: 'superProperties-not-object' };
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return { ok: false, reason: 'superProperties-not-object' };
    }
    rawSuperProperties = decoded as Record<string, unknown>;
  } else if (
    typeof candidate.superProperties === 'object' &&
    candidate.superProperties !== null &&
    !Array.isArray(candidate.superProperties)
  ) {
    rawSuperProperties = candidate.superProperties as Record<string, unknown>;
  } else {
    return { ok: false, reason: 'superProperties-not-object' };
  }
  if (typeof rawSuperProperties.os !== 'string' || typeof rawSuperProperties.browser !== 'string') {
    return { ok: false, reason: 'superProperties-not-object' };
  }
  if (rawSuperProperties.browser_user_agent !== candidate.userAgent) {
    return { ok: false, reason: 'browser_user_agent-mismatch' };
  }

  if (typeof candidate.clientHints !== 'object' || candidate.clientHints === null) {
    return { ok: false, reason: 'clientHints-missing' };
  }
  const hints = candidate.clientHints as Record<string, unknown>;
  if (
    typeof hints['Sec-CH-UA'] !== 'string' ||
    !isHeaderSafeValue(hints['Sec-CH-UA'], 256) ||
    typeof hints['Sec-CH-UA-Mobile'] !== 'string' ||
    !isHeaderSafeValue(hints['Sec-CH-UA-Mobile'], 16) ||
    typeof hints['Sec-CH-UA-Platform'] !== 'string' ||
    !isHeaderSafeValue(hints['Sec-CH-UA-Platform'], 64)
  ) {
    return { ok: false, reason: 'clientHints-missing' };
  }

  const rawLocale = typeof candidate.locale === 'string' && candidate.locale ? candidate.locale : undefined;
  const rawSystemLocale = typeof rawSuperProperties.system_locale === 'string' ? rawSuperProperties.system_locale : undefined;
  const locale = rawLocale ?? rawSystemLocale ?? 'en-US';
  if (!isHeaderSafeValue(locale, 64)) {
    return { ok: false, reason: 'locale-invalid' };
  }
  const timezone = typeof candidate.timezone === 'string' && candidate.timezone ? candidate.timezone : 'Europe/Berlin';
  if (!isHeaderSafeValue(timezone, 64)) {
    return { ok: false, reason: 'timezone-invalid' };
  }
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  const superProperties: StaticSuperProperties = {
    os: rawSuperProperties.os,
    browser: rawSuperProperties.browser,
    device: str(rawSuperProperties.device, ''),
    system_locale: str(rawSuperProperties.system_locale, locale),
    has_client_mods: false,
    browser_user_agent: candidate.userAgent,
    browser_version: str(rawSuperProperties.browser_version, ''),
    os_version: str(rawSuperProperties.os_version, ''),
    referrer: str(rawSuperProperties.referrer, ''),
    referring_domain: str(rawSuperProperties.referring_domain, ''),
    referrer_current: str(rawSuperProperties.referrer_current, ''),
    referring_domain_current: str(rawSuperProperties.referring_domain_current, ''),
    release_channel: str(rawSuperProperties.release_channel, 'stable'),
  };

  const cleanHints: ClientHints = {
    'Sec-CH-UA': hints['Sec-CH-UA'],
    'Sec-CH-UA-Mobile': hints['Sec-CH-UA-Mobile'],
    'Sec-CH-UA-Platform': hints['Sec-CH-UA-Platform'],
  };

  return {
    ok: true,
    profile: {
      userAgent: candidate.userAgent,
      superProperties,
      locale,
      timezone,
      clientHints: cleanHints,
    },
  };
}
