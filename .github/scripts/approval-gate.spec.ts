/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

import { describe, it, expect } from 'vitest';
import { isApproveCommand, isPrNumber, isSha, isBranch, isRouting } from './approval-gate';

describe('isApproveCommand', () => {
	it('accepts an exact /approve command', () => {
		expect(isApproveCommand('/approve')).toBe(true);
	});

	it('accepts /approve with a trailing CRLF', () => {
		expect(isApproveCommand('/approve\r\n')).toBe(true);
	});

	it('accepts /approve with trailing spaces', () => {
		expect(isApproveCommand('/approve   ')).toBe(true);
	});

	it('accepts /approve after leading blank lines', () => {
		expect(isApproveCommand('\n\n/approve')).toBe(true);
	});

	it('rejects trailing text after the command', () => {
		expect(isApproveCommand('/approve now')).toBe(false);
	});

	it('rejects a shell-injection attempt riding along with the command', () => {
		expect(isApproveCommand('/approve; echo pwned')).toBe(false);
	});

	it('rejects a longer command sharing the prefix', () => {
		expect(isApproveCommand('/approved')).toBe(false);
	});

	it('rejects uppercase', () => {
		expect(isApproveCommand('/APPROVE')).toBe(false);
	});

	it('rejects a leading space on the command line itself', () => {
		expect(isApproveCommand(' /approve')).toBe(false);
	});

	it('rejects a command substitution payload', () => {
		expect(isApproveCommand('$(id)')).toBe(false);
	});

	it('rejects an empty body', () => {
		expect(isApproveCommand('')).toBe(false);
	});

	it('rejects a body of only blank lines', () => {
		expect(isApproveCommand('\n\n   \n')).toBe(false);
	});
});

describe('isPrNumber', () => {
	it.each(['42', '1', '9999999'])('accepts %s', (value) => {
		expect(isPrNumber(value)).toBe(true);
	});

	it.each(['0', '042', '42; rm -rf /', '$(id)', '12345678', '', '-1', '4.2'])('rejects %s', (value) => {
		expect(isPrNumber(value)).toBe(false);
	});
});

describe('isSha', () => {
	it('accepts a 40-char lowercase hex SHA', () => {
		expect(isSha('a'.repeat(40))).toBe(true);
	});

	it('rejects uppercase hex', () => {
		expect(isSha('A'.repeat(40))).toBe(false);
	});

	it('rejects a 39-char SHA', () => {
		expect(isSha('a'.repeat(39))).toBe(false);
	});

	it('rejects a SHA with an embedded newline', () => {
		expect(isSha(`${'a'.repeat(39)}\n`)).toBe(false);
	});

	it('rejects a non-hex character', () => {
		expect(isSha(`${'a'.repeat(39)}g`)).toBe(false);
	});
});

describe('isBranch', () => {
	it.each(['main', 'production', 'feat/client-identity', 'chore.deps-bump'])('accepts %s', (value) => {
		expect(isBranch(value)).toBe(true);
	});

	it('rejects a path-traversal-shaped ref', () => {
		expect(isBranch('main/../production')).toBe(false);
	});

	it('rejects a ref containing a shell metacharacter', () => {
		expect(isBranch('main; rm -rf /')).toBe(false);
	});

	it('rejects an empty ref', () => {
		expect(isBranch('')).toBe(false);
	});

	it('rejects a ref over 120 characters', () => {
		expect(isBranch('a'.repeat(121))).toBe(false);
	});
});

describe('isRouting', () => {
	it('accepts main -> production', () => {
		expect(isRouting('production', 'main')).toBe(true);
	});

	it('rejects any other base', () => {
		expect(isRouting('staging', 'main')).toBe(false);
	});

	it('rejects any other head', () => {
		expect(isRouting('production', 'feature')).toBe(false);
	});
});
