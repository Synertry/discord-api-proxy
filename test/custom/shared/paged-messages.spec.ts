/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module custom/shared/paged-messages.spec
 * Covers `fetchAllMessages`: basic pagination plus the pacing, guard, and
 * retry behaviors of the shared pager.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchAllMessages, DiscordApiError, IdentityBlockedError } from '../../../src/custom/shared/paged-messages';
import type { PagerOptions, PagedMessage } from '../../../src/custom/shared/paged-messages';
import type { IdentityBlock, ReleaseInput, TokenPoolClient } from '../../../src/rotator/types';

const CHANNEL_ID = '1234567890123456789';

interface TestMessage extends PagedMessage {
  id: string;
}

function generateMessages(count: number, startId = 1000): TestMessage[] {
  return Array.from({ length: count }, (_, i) => ({ id: String(startId - i).padStart(19, '0') }));
}

function jsonPage(page: TestMessage[]): Response {
  return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function createMockFetch(pages: TestMessage[][]): ReturnType<typeof vi.fn> {
  let callIndex = 0;
  return vi.fn(async () => {
    const page = pages[callIndex] ?? [];
    callIndex++;
    return jsonPage(page);
  });
}

function baseOpts(
  overrides: Partial<PagerOptions> = {},
): Omit<PagerOptions, 'maxMessages' | 'pageLimit'> & { maxMessages: number; pageLimit: number } {
  return {
    channelId: CHANNEL_ID,
    headers: new Headers({ Authorization: 'test-token' }),
    fetcher: vi.fn() as unknown as typeof fetch,
    maxMessages: 5000,
    pageLimit: 100,
    wait: vi.fn(async () => undefined),
    ...overrides,
  };
}

function botOpts(overrides: Partial<PagerOptions> = {}): PagerOptions {
  return baseOpts({ headers: new Headers({ Authorization: 'Bot test-token' }), ...overrides });
}

function createBotClient(overrides: Partial<Pick<TokenPoolClient, 'checkUpstreamCircuit' | 'reportUpstreamOutcome'>> = {}) {
  return {
    acquire: vi.fn(async () => ({ ok: false as const, reason: 'empty-pool' as const, retryAfter: 0 })),
    release: vi.fn(async () => undefined),
    checkUpstreamCircuit: vi.fn(async (): Promise<IdentityBlock | null> => null),
    reportUpstreamOutcome: vi.fn(async (_outcome: ReleaseInput) => undefined),
    leaseStatic: vi.fn(async () => ({ ok: true as const, requestId: 'unused-bot-lease' })),
    settleStatic: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('fetchAllMessages: basic pagination', () => {
  it('fetches a single page of messages', async () => {
    const mockFetch = createMockFetch([generateMessages(50)]);
    const result = await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch }));
    expect(result).toHaveLength(50);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('paginates when a page has exactly pageLimit messages', async () => {
    const page1 = generateMessages(100, 2000);
    const page2 = generateMessages(30, 1900);
    const mockFetch = createMockFetch([page1, page2]);
    const result = await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch }));
    expect(result).toHaveLength(130);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stops when an empty page is returned', async () => {
    const page1 = generateMessages(100, 2000);
    const mockFetch = createMockFetch([page1, []]);
    const result = await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch }));
    expect(result).toHaveLength(100);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles an empty channel', async () => {
    const mockFetch = createMockFetch([[]]);
    const result = await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch }));
    expect(result).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('passes the before cursor for pagination', async () => {
    const page1 = generateMessages(100, 2000);
    const lastId = page1[page1.length - 1].id;
    const page2 = generateMessages(10, 1900);
    const mockFetch = createMockFetch([page1, page2]);
    await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch }));
    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[0] as string).toContain(`before=${lastId}`);
  });

  it('forwards the given headers verbatim on every page', async () => {
    const headers = new Headers({ Authorization: 'Bot my-token', 'X-Super-Properties': 'abc' });
    const mockFetch = createMockFetch([[]]);
    await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, headers }));
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get('Authorization')).toBe('Bot my-token');
    expect((init.headers as Headers).get('X-Super-Properties')).toBe('abc');
  });

  it('throws DiscordApiError on a non-2xx response', async () => {
    const mockFetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    await expect(fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch }))).rejects.toThrow('403');
  });

  it('respects the maxMessages safety cap', async () => {
    const pages = Array.from({ length: 51 }, (_, i) => generateMessages(100, 10000 - i * 100));
    const mockFetch = createMockFetch(pages);
    const result = await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, maxMessages: 5000 }));
    expect(result).toHaveLength(5000);
  });

  it('trims the final batch instead of overshooting a non-multiple maxMessages cap', async () => {
    // pageLimit=100 divides maxMessages=150 unevenly: page 1 is a full 100-message
    // batch, page 2 would also be a full batch. Without trimming, both full
    // batches get pushed unconditionally and the result overshoots to 200.
    const pages = [generateMessages(100, 3000), generateMessages(100, 2900)];
    const mockFetch = createMockFetch(pages);
    const result = await fetchAllMessages<TestMessage>(
      baseOpts({ fetcher: mockFetch as unknown as typeof fetch, maxMessages: 150, pageLimit: 100 }),
    );
    expect(result).toHaveLength(150);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('every outbound fetch carries an AbortSignal', async () => {
    const mockFetch = createMockFetch([[]]);
    await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch }));
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchAllMessages: bot upstream circuit', () => {
  it('blocks an open bot circuit before fetching without waiting or leasing', async () => {
    const block: IdentityBlock = { reason: 'circuit', retryAfter: 1000, signal: 'cloudflare' };
    const client = createBotClient({ checkUpstreamCircuit: vi.fn(async () => block) });
    const mockFetch = createMockFetch([[]]);
    const wait = vi.fn(async () => undefined);
    const opts = botOpts({
      fetcher: mockFetch as unknown as typeof fetch,
      tokenPoolClient: client,
      guard: { lease: client.leaseStatic, settle: client.settleStatic },
      wait,
    });

    await expect(fetchAllMessages<TestMessage>(opts)).rejects.toMatchObject({ name: 'IdentityBlockedError', block });
    expect(client.checkUpstreamCircuit).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(client.leaseStatic).not.toHaveBeenCalled();
    expect(client.settleStatic).not.toHaveBeenCalled();
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
  });

  it('reports a bot Cloudflare response and blocks the next pager on the shared client circuit', async () => {
    let circuit: IdentityBlock | null = null;
    const body = '<html>Cloudflare challenge</html>';
    const client = createBotClient({
      checkUpstreamCircuit: vi.fn(async () => circuit),
      reportUpstreamOutcome: vi.fn(async (outcome: ReleaseInput) => {
        if (outcome.signal === 'cloudflare') circuit = { reason: 'circuit', retryAfter: 600_000, signal: 'cloudflare' };
      }),
    });
    const mockFetch = vi.fn(async () => new Response(body, { status: 403, headers: { 'Content-Type': 'text/html' } }));
    const opts = botOpts({ fetcher: mockFetch as unknown as typeof fetch, tokenPoolClient: client });

    await expect(fetchAllMessages<TestMessage>(opts)).rejects.toMatchObject({ name: 'DiscordApiError', status: 403, body });
    expect(client.reportUpstreamOutcome).toHaveBeenCalledTimes(1);
    expect(client.reportUpstreamOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403, signal: 'cloudflare', routeKey: `GET:/channels/${CHANNEL_ID}/messages` }),
    );
    await expect(fetchAllMessages<TestMessage>(opts)).rejects.toThrow(IdentityBlockedError);
    expect(client.checkUpstreamCircuit).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(client.leaseStatic).not.toHaveBeenCalled();
    expect(client.settleStatic).not.toHaveBeenCalled();
  });

  it.each(['Bot', 'bOt', 'BOT'])('checks a clean %s request once and bypasses supplied identity budgets', async (prefix) => {
    const client = createBotClient();
    const mockFetch = createMockFetch([generateMessages(1)]);
    const result = await fetchAllMessages<TestMessage>(
      botOpts({
        headers: new Headers({ authorization: `${prefix} test-token` }),
        fetcher: mockFetch as unknown as typeof fetch,
        tokenPoolClient: client,
        guard: { lease: client.leaseStatic, settle: client.settleStatic },
      }),
    );

    expect(result).toEqual(generateMessages(1));
    expect(client.checkUpstreamCircuit).toHaveBeenCalledTimes(1);
    expect(client.checkUpstreamCircuit).toHaveBeenCalledWith();
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
    expect(client.acquire).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
    expect(client.leaseStatic).not.toHaveBeenCalled();
    expect(client.settleStatic).not.toHaveBeenCalled();
  });

  it('checks immediately before every bot page while preserving page pacing', async () => {
    const events: string[] = [];
    const client = createBotClient({
      checkUpstreamCircuit: vi.fn(async () => {
        events.push('check');
        return null;
      }),
    });
    const pages = [generateMessages(100), []];
    const mockFetch = vi.fn(async () => {
      events.push('fetch');
      return jsonPage(pages.shift()!);
    });
    const wait = vi.fn(async () => {
      events.push('wait');
    });

    const result = await fetchAllMessages<TestMessage>(
      botOpts({ fetcher: mockFetch as unknown as typeof fetch, tokenPoolClient: client, wait }),
    );

    expect(result).toHaveLength(100);
    expect(events).toEqual(['check', 'fetch', 'wait', 'check', 'fetch']);
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
  });

  it('checks again before a bot 429 retry and preserves the shared backoff', async () => {
    const events: string[] = [];
    const client = createBotClient({
      checkUpstreamCircuit: vi.fn(async () => {
        events.push('check');
        return null;
      }),
    });
    const mockFetch = vi.fn(async () => {
      events.push('fetch');
      return events.length === 2 ? new Response('Rate limited', { status: 429, headers: { 'Retry-After': '2' } }) : jsonPage([]);
    });
    const wait = vi.fn(async (ms: number) => {
      events.push(`wait:${ms}`);
    });

    await expect(
      fetchAllMessages<TestMessage>(botOpts({ fetcher: mockFetch as unknown as typeof fetch, tokenPoolClient: client, wait })),
    ).resolves.toEqual([]);
    expect(events).toEqual(['check', 'fetch', 'wait:3000', 'check', 'fetch']);
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
  });

  it('dispatches bots without a client and bypasses any supplied static guard', async () => {
    const client = createBotClient();
    const mockFetch = createMockFetch([[]]);

    await expect(
      fetchAllMessages<TestMessage>(
        botOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: { lease: client.leaseStatic, settle: client.settleStatic } }),
      ),
    ).resolves.toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(client.leaseStatic).not.toHaveBeenCalled();
    expect(client.settleStatic).not.toHaveBeenCalled();
  });

  it.each(['both', 'check', 'report'])('dispatches with legacy clients missing %s upstream methods', async (missing) => {
    const client = createBotClient();
    const legacyClient: TokenPoolClient = {
      ...client,
      checkUpstreamCircuit: missing === 'both' || missing === 'check' ? undefined : client.checkUpstreamCircuit,
      reportUpstreamOutcome: missing === 'both' || missing === 'report' ? undefined : client.reportUpstreamOutcome,
    };
    const body = '<html>Cloudflare challenge</html>';
    const mockFetch = vi.fn(async () => new Response(body, { status: 503, headers: { 'Content-Type': 'text/html' } }));

    await expect(
      fetchAllMessages<TestMessage>(botOpts({ fetcher: mockFetch as unknown as typeof fetch, tokenPoolClient: legacyClient })),
    ).rejects.toMatchObject({ name: 'DiscordApiError', status: 503, body });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(client.checkUpstreamCircuit).not.toHaveBeenCalled();
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
  });

  it.each([200, 403])('preserves a bot upstream %i response when the check RPC fails', async (status) => {
    const client = createBotClient({
      checkUpstreamCircuit: vi.fn(async () => {
        throw new Error('check RPC failed');
      }),
    });
    const body = status === 200 ? '[]' : 'Forbidden';
    const mockFetch = vi.fn(async () => new Response(body, { status }));
    const request = fetchAllMessages<TestMessage>(botOpts({ fetcher: mockFetch as unknown as typeof fetch, tokenPoolClient: client }));

    if (status === 200) await expect(request).resolves.toEqual([]);
    else await expect(request).rejects.toMatchObject({ name: 'DiscordApiError', status, body });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
  });

  it('preserves the bot Cloudflare status and body when the report RPC fails', async () => {
    const client = createBotClient({
      reportUpstreamOutcome: vi.fn(async (_outcome: ReleaseInput) => {
        throw new Error('report RPC failed');
      }),
    });
    const body = '<html>Cloudflare challenge</html>';
    const mockFetch = vi.fn(async () => new Response(body, { status: 403, headers: { 'Content-Type': 'text/html' } }));

    await expect(
      fetchAllMessages<TestMessage>(botOpts({ fetcher: mockFetch as unknown as typeof fetch, tokenPoolClient: client })),
    ).rejects.toMatchObject({ name: 'DiscordApiError', status: 403, body });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(client.reportUpstreamOutcome).toHaveBeenCalledTimes(1);
  });

  it('does not report bot captcha responses or lease their identity', async () => {
    const client = createBotClient();
    const body = JSON.stringify({ captcha_key: ['captcha-required'], captcha_sitekey: 'test-sitekey' });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(jsonPage([]));
    const opts = botOpts({
      fetcher: mockFetch as unknown as typeof fetch,
      tokenPoolClient: client,
      guard: { lease: client.leaseStatic, settle: client.settleStatic },
    });

    await expect(fetchAllMessages<TestMessage>(opts)).rejects.toMatchObject({ name: 'DiscordApiError', status: 400, body });
    await expect(fetchAllMessages<TestMessage>(opts)).resolves.toEqual([]);
    expect(client.checkUpstreamCircuit).toHaveBeenCalledTimes(2);
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
    expect(client.leaseStatic).not.toHaveBeenCalled();
    expect(client.settleStatic).not.toHaveBeenCalled();
  });

  it('preserves bot network errors without reporting or settling an identity lease', async () => {
    const client = createBotClient();
    const mockFetch = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(
      fetchAllMessages<TestMessage>(
        botOpts({
          fetcher: mockFetch as unknown as typeof fetch,
          tokenPoolClient: client,
          guard: { lease: client.leaseStatic, settle: client.settleStatic },
        }),
      ),
    ).rejects.toMatchObject({ name: 'DiscordApiError', status: 0, body: 'Network error: network down' });
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
    expect(client.leaseStatic).not.toHaveBeenCalled();
    expect(client.settleStatic).not.toHaveBeenCalled();
  });

  it('keeps user-token paging on the static guard rather than the bot circuit RPCs', async () => {
    const client = createBotClient();
    const mockFetch = createMockFetch([[]]);

    await expect(
      fetchAllMessages<TestMessage>(
        baseOpts({
          fetcher: mockFetch as unknown as typeof fetch,
          tokenPoolClient: client,
          guard: { lease: client.leaseStatic, settle: client.settleStatic },
        }),
      ),
    ).resolves.toEqual([]);
    expect(client.checkUpstreamCircuit).not.toHaveBeenCalled();
    expect(client.reportUpstreamOutcome).not.toHaveBeenCalled();
    expect(client.leaseStatic).toHaveBeenCalledTimes(1);
    expect(client.settleStatic).toHaveBeenCalledTimes(1);
  });
});

describe('fetchAllMessages: pacing', () => {
  it('waits at least 1000ms between page 1 and page 2, and between page 2 and page 3', async () => {
    const pages = [generateMessages(100, 3000), generateMessages(100, 2900), generateMessages(10, 2800)];
    const mockFetch = createMockFetch(pages);
    const waitedMs: number[] = [];
    const wait = vi.fn(async (ms: number) => {
      waitedMs.push(ms);
    });
    await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, wait }));
    expect(waitedMs.length).toBeGreaterThanOrEqual(2);
    for (const ms of waitedMs) expect(ms).toBeGreaterThanOrEqual(1000 - 50); // tolerate a few ms of real elapsed time between calls
  });

  it('does not wait before the first page', async () => {
    const mockFetch = createMockFetch([[]]);
    const wait = vi.fn(async () => undefined);
    await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, wait }));
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('fetchAllMessages: guard lease/settle', () => {
  it('leases the guard before each page and settles with the response bucket header after', async () => {
    const lease = vi.fn(async () => ({ ok: true as const, requestId: 'lease-1' }));
    const settle = vi.fn(async () => undefined);
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Bucket': 'b1' } }),
    );
    await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: { lease, settle } }));
    // The budget key keeps the channel snowflake literal, so each channel's
    // dump leases its own per-channel budget rather than a shared :id bucket.
    expect(lease).toHaveBeenCalledWith(`GET:/channels/${CHANNEL_ID}/messages`);
    expect(settle).toHaveBeenCalledWith('lease-1', expect.objectContaining({ status: 200, discordBucketHash: 'b1' }));
  });

  it('settles with status 599 when the fetch itself throws', async () => {
    const lease = vi.fn(async () => ({ ok: true as const, requestId: 'lease-err' }));
    const settle = vi.fn(async () => undefined);
    const mockFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: { lease, settle } })),
    ).rejects.toThrow(DiscordApiError);
    expect(settle).toHaveBeenCalledWith('lease-err', expect.objectContaining({ status: 599 }));
  });

  it('attempts a terminal 599 settle and rethrows when settling a successful page fails', async () => {
    // Without the cleanup, a rejected settle strands the lease until its TTL
    // and the caller learns nothing; the 599 fallback releases it immediately.
    const lease = vi.fn(async () => ({ ok: true as const, requestId: 'lease-fail' }));
    const settle = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('settle RPC failed');
      })
      .mockImplementationOnce(async () => undefined);
    const mockFetch = createMockFetch([generateMessages(5)]);
    await expect(
      fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: { lease, settle } })),
    ).rejects.toThrow('settle RPC failed');
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenNthCalledWith(1, 'lease-fail', expect.objectContaining({ status: 200 }));
    expect(settle).toHaveBeenNthCalledWith(2, 'lease-fail', expect.objectContaining({ status: 599 }));
  });

  it('waits out one short block (<= 5000ms) and retries the lease once', async () => {
    let leaseCalls = 0;
    const lease = vi.fn(async () => {
      leaseCalls += 1;
      if (leaseCalls === 1) return { ok: false as const, block: { reason: 'cooldown' as const, retryAfter: 3000 } };
      return { ok: true as const, requestId: 'lease-2' };
    });
    const settle = vi.fn(async () => undefined);
    const mockFetch = createMockFetch([[]]);
    const waitedMs: number[] = [];
    const wait = vi.fn(async (ms: number) => {
      waitedMs.push(ms);
    });
    await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: { lease, settle }, wait }));
    expect(lease).toHaveBeenCalledTimes(2);
    expect(waitedMs).toContain(3000);
  });

  it('throws IdentityBlockedError for a block longer than the short-wait threshold', async () => {
    const lease = vi.fn(async () => ({
      ok: false as const,
      block: { reason: 'cooldown' as const, retryAfter: 1_800_000, signal: 'captcha' as const },
    }));
    const settle = vi.fn(async () => undefined);
    const mockFetch = createMockFetch([[]]);
    await expect(
      fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: { lease, settle } })),
    ).rejects.toThrow(IdentityBlockedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws IdentityBlockedError when the retried lease is also blocked', async () => {
    const lease = vi.fn(async () => ({ ok: false as const, block: { reason: 'cooldown' as const, retryAfter: 2000 } }));
    const settle = vi.fn(async () => undefined);
    const mockFetch = createMockFetch([[]]);
    await expect(
      fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: { lease, settle } })),
    ).rejects.toThrow(IdentityBlockedError);
    expect(lease).toHaveBeenCalledTimes(2);
  });

  it('with no guard at all, dispatches unguarded and never calls lease/settle', async () => {
    const mockFetch = createMockFetch([[]]);
    const result = await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, guard: undefined }));
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('fetchAllMessages: 429 retry', () => {
  it('retries a live 429 after the shared backoff and succeeds', async () => {
    let call = 0;
    const mockFetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '2' } });
      return jsonPage([]);
    });
    const waitedMs: number[] = [];
    const wait = vi.fn(async (ms: number) => {
      waitedMs.push(ms);
    });
    const result = await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, wait }));
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(waitedMs).toContain(3000); // retryDelayMs: 2000ms * 1.5 backoff factor
  });

  it('throws DiscordApiError after exhausting 429 retries', async () => {
    const mockFetch = vi.fn(async () => new Response('Rate limited', { status: 429, headers: { 'Retry-After': '1' } }));
    const wait = vi.fn(async () => undefined);
    await expect(fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, wait }))).rejects.toThrow(
      DiscordApiError,
    );
    // MAX_429_RETRIES=3 -> 4 total attempts (1 initial + 3 retries).
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('fails fast with a 429 and never waits when Retry-After exceeds the retry cap', async () => {
    // Retry-After 600s -> retryDelayMs ~900000ms, far past the 15000ms cap.
    // Waiting it out would stall the whole dump for minutes, so the pager must
    // surface the 429 instead of sleeping.
    const mockFetch = vi.fn(async () => new Response('Rate limited', { status: 429, headers: { 'Retry-After': '600' } }));
    const wait = vi.fn(async () => undefined);
    let caught: unknown;
    try {
      await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, wait }));
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiscordApiError);
    expect((caught as DiscordApiError).status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('paces the NEXT page off the retry dispatch time, not the pre-retry timestamp', async () => {
    vi.useFakeTimers();
    try {
      // Page 1's first attempt 429s; the internal retry (after a real
      // retryDelayMs wait) succeeds with a full page, so a page 2 is fetched.
      // Before the fix, the outer loop paced page 2 off the timestamp taken
      // BEFORE page 1's first attempt - since the internal retry wait alone
      // already exceeds minGapMs, that stale timestamp made the pacing
      // check see enough elapsed time and skip waiting before page 2
      // entirely. After the fix, pacing is measured from the retry's actual
      // dispatch, so a full 1000ms wait is still required before page 2.
      let call = 0;
      const mockFetch = vi.fn(async () => {
        call += 1;
        if (call === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '2' } });
        if (call === 2) return jsonPage(generateMessages(100, 3000)); // retry succeeds, full page
        return jsonPage([]); // page 2
      });
      const waitedMs: number[] = [];
      const wait = vi.fn(async (ms: number) => {
        waitedMs.push(ms);
        await vi.advanceTimersByTimeAsync(ms); // simulate the real elapsed time a genuine wait would consume
      });
      await fetchAllMessages<TestMessage>(baseOpts({ fetcher: mockFetch as unknown as typeof fetch, wait }));

      expect(mockFetch).toHaveBeenCalledTimes(3);
      // First wait: the internal 429 retry backoff (retryDelayMs: 2000ms * 1.5 = 3000ms).
      expect(waitedMs[0]).toBe(3000);
      // Second wait: pacing before page 2, measured from the retry's own
      // dispatch (not the original pre-429 timestamp) - still a near-full
      // 1000ms gap, not skipped.
      expect(waitedMs.length).toBeGreaterThanOrEqual(2);
      expect(waitedMs[1]).toBeGreaterThanOrEqual(1000 - 5);
    } finally {
      vi.useRealTimers();
    }
  });
});
