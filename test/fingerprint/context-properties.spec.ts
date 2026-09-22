/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { contextPropertiesFor } from '../../src/fingerprint/context-properties';

describe('contextPropertiesFor', () => {
  it('returns the chat_input value for a message send', () => {
    const value = contextPropertiesFor('POST:/channels/:id/messages');
    expect(value).toBe('eyJsb2NhdGlvbiI6ImNoYXRfaW5wdXQifQ==');
    expect(JSON.parse(atob(value as string))).toEqual({ location: 'chat_input' });
  });

  it('returns the empty-object value for opening a DM channel', () => {
    const value = contextPropertiesFor('POST:/users/@me/channels');
    expect(value).toBe('e30=');
    expect(JSON.parse(atob(value as string))).toEqual({});
  });

  it('returns undefined for a route with no default', () => {
    expect(contextPropertiesFor('GET:/users/@me')).toBeUndefined();
  });
});
