/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module fingerprint/context-properties
 * Lookup table for the `X-Context-Properties` header the real client sends
 * on a handful of routes to describe where in the UI the action originated
 * (e.g. sending a message from the main chat input vs. a thread). Applied by
 * the proxy only when the caller did not already send its own value.
 */

import type { RouteKey } from '../rotator/types';

/** `{"location":"chat_input"}` base64-encoded. */
const CHAT_INPUT = 'eyJsb2NhdGlvbiI6ImNoYXRfaW5wdXQifQ==';
/** `{}` base64-encoded. */
const EMPTY = 'e30=';

const CONTEXT_PROPERTIES_BY_ROUTE: Readonly<Record<string, string>> = {
  'POST:/channels/:id/messages': CHAT_INPUT,
  'POST:/users/@me/channels': EMPTY,
};

/** The default `X-Context-Properties` value for a route, or undefined when the route has none. */
export function contextPropertiesFor(routeKey: RouteKey): string | undefined {
  return CONTEXT_PROPERTIES_BY_ROUTE[routeKey];
}
