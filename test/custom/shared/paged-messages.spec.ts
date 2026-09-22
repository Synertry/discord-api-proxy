/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module custom/shared/paged-messages.spec
 * Covers `fetchAllMessages` (basic pagination, ported from the former
 * per-event kindness-cascade/hear-me-out discord-client.spec.ts files, now
 * deleted) plus the pacing, guard, and retry behaviors unique to the shared
 * pager.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchAllMessages, DiscordApiError, IdentityBlockedError } from '../../../src/custom/shared/paged-messages';
import type { PagerOptions, PagedMessage } from '../../../src/custom/shared/paged-messages';

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
    expect(lease).toHaveBeenCalledWith('GET:/channels/:id/messages');
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
