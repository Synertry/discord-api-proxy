/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/exceptions.spec
 * Tests for the manual override layer: confirms exception entries resolve a
 * null submitter, leave classification untouched, and surface the override
 * reason in the deviation string.
 */

import { describe, it, expect } from 'vitest';
import { applyExceptions, _EXCEPTIONS } from '../../../../../src/custom/chillzone/events/hear-me-out/exceptions';
import type { ClassifiedSubmission } from '../../../../../src/custom/chillzone/events/hear-me-out/types';

function makeClassified(overrides: Partial<ClassifiedSubmission> & { messageId: string }): ClassifiedSubmission {
	return {
		classification: 'formatting-error',
		messenger: { userId: '300000000000000001', username: 'messenger' },
		submitter: null,
		reactionCount: 1,
		hasVotes: true,
		messageLink: `https://discord.com/channels/g/c/${overrides.messageId}`,
		deviationReason: 'plain-text @username instead of "<@id>" mention; submitter not auto-resolvable',
		...overrides,
	};
}

describe('applyExceptions', () => {
	it('resolves the submitter for a registered exception', () => {
		const targetId = Object.keys(_EXCEPTIONS)[0];
		expect(targetId).toBeDefined();
		const exception = _EXCEPTIONS[targetId];

		const input = [makeClassified({ messageId: targetId })];
		const output = applyExceptions(input);

		expect(output[0].submitter).toEqual({
			userId: exception.submitterId,
			username: exception.submitterUsername ?? 'unknown',
		});
	});

	it('preserves classification when applying an override', () => {
		const targetId = Object.keys(_EXCEPTIONS)[0];
		const input = [makeClassified({ messageId: targetId, classification: 'formatting-error' })];
		const output = applyExceptions(input);
		expect(output[0].classification).toBe('formatting-error');
	});

	it('replaces the deviation reason with the override reason', () => {
		const targetId = Object.keys(_EXCEPTIONS)[0];
		const exception = _EXCEPTIONS[targetId];
		const input = [makeClassified({ messageId: targetId, deviationReason: 'original reason' })];
		const output = applyExceptions(input);
		expect(output[0].deviationReason).toBe(exception.reason);
	});

	it('handles overrides on messages with no prior deviation reason', () => {
		const targetId = Object.keys(_EXCEPTIONS)[0];
		const exception = _EXCEPTIONS[targetId];
		const input = [makeClassified({ messageId: targetId, deviationReason: null })];
		const output = applyExceptions(input);
		expect(output[0].deviationReason).toBe(exception.reason);
	});

	it('passes through messages with no registered exception unchanged', () => {
		const input = [makeClassified({ messageId: '9999999999999999999', deviationReason: 'unrelated' })];
		const output = applyExceptions(input);
		expect(output[0]).toEqual(input[0]);
	});

	it('returns a new array (does not mutate input)', () => {
		const input = [makeClassified({ messageId: '9999999999999999999' })];
		const output = applyExceptions(input);
		expect(output).not.toBe(input);
	});

	it('handles an empty input array', () => {
		expect(applyExceptions([])).toEqual([]);
	});
});
