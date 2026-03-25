/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/handler.spec
 * Integration tests for the Kindness Cascade HTTP handler.
 *
 * Tests the full request→response cycle using Hono's `.request()` test helper
 * with mocked Discord API responses. Covers JSON and formatted-text response modes,
 * input validation (missing/invalid snowflakes), Discord API error forwarding,
 * top-10 truncation, and empty channel handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { kindnessCascadeRoutes } from '../../../../../src/custom/chillzone/events/kindness-cascade/handler';
import type { Bindings } from '../../../../../src/types';
import type { DiscordContextVariables } from '../../../../../src/middleware/discord-context';
import { MOCK_GUILD_ID, MOCK_CHANNEL_ID, FULL_CHANNEL_MESSAGES } from './fixtures';

describe('kindness-cascade handler', () => {
  /** Minimal environment bindings for handler tests. */
  const MOCK_ENV: Bindings = {
    AUTH_KEY: 'secret-key',
    DISCORD_TOKEN_BOT: 'bot-token',
    DISCORD_TOKEN_USER: 'user-token',
  };

  /** Creates a mock fetch that always returns the given messages as a JSON response. */
  function createMockFetch(messages: readonly unknown[]) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify(messages), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
  }

  /** Wraps the handler routes with a middleware that injects proxyFetch via c.var. */
  function createTestApp(mockFetch: typeof fetch) {
    const app = new OpenAPIHono<{ Bindings: Bindings; Variables: DiscordContextVariables }>();
    app.use('*', async (c, next) => {
      c.set('proxyFetch', mockFetch);
      await next();
    });
    app.route('/', kindnessCascadeRoutes);
    return app;
  }

  /** Builds a request URL with optional query parameters for the tallying endpoint. */
  function buildUrl(params?: { guildId?: string; channelId?: string; all?: string; formattedMessage?: string }): string {
    const query = new URLSearchParams();
    if (params?.guildId) query.set('guildId', params.guildId);
    if (params?.channelId) query.set('channelId', params.channelId);
    if (params?.all) query.set('all', params.all);
    if (params?.formattedMessage) query.set('formattedMessage', params.formattedMessage);
    return `http://localhost/kindness-cascade?${query.toString()}`;
  }

  it('should return tallying results for valid request', async () => {
    const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);

    const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ranked).toBeDefined();
    expect(body.ranked.mostKindnessSent).toBeInstanceOf(Array);
    expect(body.ranked.mostKindnessReceived).toBeInstanceOf(Array);
    expect(body.ranked.topVotedKindness).toBeInstanceOf(Array);
    expect(body.ranked.topVotedSubmitter).toBeInstanceOf(Array);
    expect(body.ranked.topVotedReceiver).toBeInstanceOf(Array);
    expect(body.listings).toBeDefined();
    expect(body.listings.replySubmissions).toBeInstanceOf(Array);
    expect(body.listings.multiMentionSubmissions).toBeInstanceOf(Array);
    expect(body.listings.differentFormatSubmissions).toBeInstanceOf(Array);
    expect(body.listings.missingVotes).toBeInstanceOf(Array);
    expect(body.listings.invalidSubmissions).toBeInstanceOf(Array);
    expect(body.listings.counts).toBeDefined();
    expect(typeof body.listings.counts).toBe('object');
  });

  it('should return top 10 by default', async () => {
    const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);

    const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ranked.mostKindnessSent.length).toBeLessThanOrEqual(10);
  });

  it('should return all entries when all=true', async () => {
    const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);

    const res = await createTestApp(mockFetch).request(
      buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID, all: 'true' }),
      {},
      MOCK_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ranked.mostKindnessSent.length).toBeGreaterThan(0);
  });

  it('should return 400 for missing guildId', async () => {
    const res = await kindnessCascadeRoutes.request(buildUrl({ channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(400);
  });

  it('should return 400 for missing channelId', async () => {
    const res = await kindnessCascadeRoutes.request(buildUrl({ guildId: MOCK_GUILD_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(400);
  });

  it('should return 400 for invalid snowflake format', async () => {
    const res = await kindnessCascadeRoutes.request(buildUrl({ guildId: 'not-a-snowflake', channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(400);
  });

  it('should return 502 for Discord API errors', async () => {
    const mockFetch = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;

    const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('should handle empty channel', async () => {
    const mockFetch = createMockFetch([]);

    const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ranked.mostKindnessSent).toEqual([]);
  });

  it('should return text/plain when formattedMessage=true', async () => {
    const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);

    const res = await createTestApp(mockFetch).request(
      buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID, formattedMessage: 'true' }),
      {},
      MOCK_ENV,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('**__Kindness Cascade Tally__**');
    expect(body).toContain('### Top Voted Kindness');
    expect(body).toContain('### Most Kindness Sent');
    expect(body).toContain('### Most Kindness Received');
    expect(body).toContain('### Top Voted Submitter');
    expect(body).toContain('### Top Voted Receiver');
    expect(body).toContain('-# Updated as of <t:');
  });

  it('should return JSON when formattedMessage is absent', async () => {
    const mockFetch = createMockFetch(FULL_CHANNEL_MESSAGES);

    const res = await createTestApp(mockFetch).request(buildUrl({ guildId: MOCK_GUILD_ID, channelId: MOCK_CHANNEL_ID }), {}, MOCK_ENV);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
