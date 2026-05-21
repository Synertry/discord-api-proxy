/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { parseProxyTokenHeader } from '../../src/middleware/proxy-token-header';

describe('parseProxyTokenHeader', () => {
	it('returns auto for null', () => {
		expect(parseProxyTokenHeader(null)).toBe('auto');
	});

	it('returns auto for undefined', () => {
		expect(parseProxyTokenHeader(undefined)).toBe('auto');
	});

	it('returns auto for empty string', () => {
		expect(parseProxyTokenHeader('')).toBe('auto');
	});

	it('returns auto for whitespace-only string', () => {
		expect(parseProxyTokenHeader('   ')).toBe('auto');
	});

	it('returns auto for literal "auto"', () => {
		expect(parseProxyTokenHeader('auto')).toBe('auto');
	});

	it('trims whitespace around "auto"', () => {
		expect(parseProxyTokenHeader('  auto  ')).toBe('auto');
	});

	it('returns static for literal "static"', () => {
		expect(parseProxyTokenHeader('static')).toBe('static');
	});

	it('trims whitespace around "static"', () => {
		expect(parseProxyTokenHeader('\tstatic\n')).toBe('static');
	});

	it('returns { label } for an arbitrary label', () => {
		expect(parseProxyTokenHeader('tok-3')).toEqual({ label: 'tok-3' });
	});

	it('trims whitespace around a label', () => {
		expect(parseProxyTokenHeader('  pinned-label  ')).toEqual({ label: 'pinned-label' });
	});

	it('is case-sensitive: "Static" is a label, not the static selector', () => {
		expect(parseProxyTokenHeader('Static')).toEqual({ label: 'Static' });
	});

	it('is case-sensitive: "AUTO" is a label, not the auto selector', () => {
		expect(parseProxyTokenHeader('AUTO')).toEqual({ label: 'AUTO' });
	});

	it('preserves internal punctuation in labels', () => {
		expect(parseProxyTokenHeader('tok_local-1.2')).toEqual({ label: 'tok_local-1.2' });
	});
});
