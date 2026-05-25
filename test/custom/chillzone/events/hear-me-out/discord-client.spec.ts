/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchAllMessages, DiscordApiError } from '../../../../../src/custom/chillzone/events/hear-me-out/discord-client';
import type { DiscordMessage } from '../../../../../src/custom/chillzone/events/hear-me-out/types';
import { MOCK_CHANNEL_ID, createMockMessage } from './fixtures';

function createMockFetch(pages: DiscordMessage[][]): typeof fetch {
	let callIndex = 0;
	return vi.fn(async () => {
		const page = pages[callIndex] ?? [];
		callIndex++;
		return new Response(JSON.stringify(page), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as unknown as typeof fetch;
}

function generateMessages(count: number, startId: number = 1000): DiscordMessage[] {
	return Array.from({ length: count }, (_, i) => createMockMessage({ id: String(startId - i).padStart(19, '0') }));
}

describe('fetchAllMessages', () => {
	const TOKEN = 'Bot test-token';

	it('should fetch a single page of messages', async () => {
		const messages = generateMessages(50);
		const mockFetch = createMockFetch([messages]);

		const result = await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);
		expect(result).toHaveLength(50);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('should paginate when a page has exactly 100 messages', async () => {
		const page1 = generateMessages(100, 2000);
		const page2 = generateMessages(30, 1900);
		const mockFetch = createMockFetch([page1, page2]);

		const result = await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);
		expect(result).toHaveLength(130);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('should stop when an empty page is returned', async () => {
		const page1 = generateMessages(100, 2000);
		const mockFetch = createMockFetch([page1, []]);

		const result = await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);
		expect(result).toHaveLength(100);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('should handle an empty channel', async () => {
		const mockFetch = createMockFetch([[]]);

		const result = await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);
		expect(result).toHaveLength(0);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('should pass the before cursor for pagination', async () => {
		const page1 = generateMessages(100, 2000);
		const lastId = page1[page1.length - 1].id;
		const page2 = generateMessages(10, 1900);
		const mockFetch = createMockFetch([page1, page2]);

		await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);

		const secondCall = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[1];
		const url = secondCall[0] as string;
		expect(url).toContain(`before=${lastId}`);
	});

	it('should set the Authorization header', async () => {
		const mockFetch = createMockFetch([[]]);

		await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);

		const firstCall = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
		const init = firstCall[1] as RequestInit;
		const headers = init.headers as Headers;
		expect(headers.get('Authorization')).toBe(TOKEN);
	});

	it('should pass an AbortSignal on every request', async () => {
		const page1 = generateMessages(100, 2000);
		const page2 = generateMessages(5, 1900);
		const mockFetch = createMockFetch([page1, page2]);

		await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);

		for (const call of (mockFetch as ReturnType<typeof vi.fn>).mock.calls) {
			const init = call[1] as RequestInit;
			expect(init.signal).toBeInstanceOf(AbortSignal);
		}
	});

	it('should throw DiscordApiError on non-200 response', async () => {
		const mockFetch = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;

		await expect(fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch)).rejects.toBeInstanceOf(DiscordApiError);
		await expect(fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch)).rejects.toMatchObject({ status: 403 });
	});

	it('should throw DiscordApiError when response body is not an array', async () => {
		const mockFetch = vi.fn(
			async () => new Response(JSON.stringify({ error: 'oops' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
		) as unknown as typeof fetch;

		await expect(fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch)).rejects.toBeInstanceOf(DiscordApiError);
	});

	it('should throw the pagination guard when last element is missing id', async () => {
		const page1 = generateMessages(99, 2000);
		const malformedTail = [{ type: 0, content: '', author: { id: '1', username: 'x' }, mentions: [], timestamp: 't' } as unknown as DiscordMessage];
		const page1Full = [...page1, ...malformedTail];
		const mockFetch = createMockFetch([page1Full]);

		await expect(fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch)).rejects.toMatchObject({
			status: 0,
			message: expect.stringContaining('Discord API error: 0'),
		});
	});

	it('should respect the safety cap of 5000 messages', async () => {
		const pages = Array.from({ length: 51 }, (_, i) => generateMessages(100, 10000 - i * 100));
		const mockFetch = createMockFetch(pages);

		const result = await fetchAllMessages(MOCK_CHANNEL_ID, TOKEN, mockFetch);
		expect(result).toHaveLength(5000);
	});
});
