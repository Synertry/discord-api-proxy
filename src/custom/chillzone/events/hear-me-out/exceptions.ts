/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/exceptions
 * Manual overrides for specific message IDs whose submitter the classifier
 * can't resolve programmatically (typically because the messenger referenced
 * the submitter by plain-text `@username` instead of a `<@id>` mention).
 *
 * Each override force-credits a submitter ID to the named message. Classification
 * is preserved (a formatting-error stays a formatting-error and still appears in
 * the host-review listing) so the host can see WHY an override was needed. The
 * deviation reason is rewritten to surface the override.
 *
 * For future events that need the same mechanism, follow the pattern: add a
 * sibling `exceptions.ts` in that event's module, or refactor this into a
 * shared helper if a third event needs it.
 */

import type { ClassifiedSubmission, UserEntity } from './types';

/** A manual override that resolves a specific message's submitter. */
interface SubmissionException {
	/** Authoritative submitter ID (host-verified). */
	readonly submitterId: string;
	/** Username to display alongside the ID. Defaults to `'unknown'` if absent and not in mentions array. */
	readonly submitterUsername?: string;
	/** Why this override exists. Surfaces in the listings so the host audit trail is preserved. */
	readonly reason: string;
}

/**
 * Hard-coded message-ID -> submitter map for the Hear Me Out 2026-05 event.
 *
 * Entries should be added only AFTER the host has reviewed the source message
 * and confirmed the intended submitter. Adding a wrong entry silently credits
 * someone with submissions they didn't make.
 *
 * Format: `messageId: { submitterId, submitterUsername?, reason }`.
 */
const EXCEPTIONS: Record<string, SubmissionException> = {
	// mcha.__ referenced doz by plain-text "@doz" instead of a <@id> mention.
	// "@doz" maps to xdozei (303596199171194880), a known event team messenger
	// (one of the 5 IDs listed in the event announcement).
	'1504877846781497434': {
		submitterId: '303596199171194880',
		submitterUsername: 'doz',
		reason: 'plain-text "@doz"',
	},
};

/**
 * Applies any registered exception overrides to a classified-submission list.
 *
 * Pure function; returns a new array. Messages without an exception are
 * passed through unchanged.
 *
 * @param classified - All classified messages from the channel.
 * @returns Classified messages with overrides applied.
 */
export function applyExceptions(classified: readonly ClassifiedSubmission[]): readonly ClassifiedSubmission[] {
	return classified.map((s) => {
		const override = EXCEPTIONS[s.messageId];
		if (!override) return s;

		const submitter: UserEntity = {
			userId: override.submitterId,
			username: override.submitterUsername ?? s.submitter?.username ?? 'unknown',
		};
		// Replace the deviation reason wholesale - the override IS the explanation,
		// and the prior reason ("submitter not auto-resolvable") becomes redundant
		// once a submitter is resolved.
		return {
			...s,
			submitter,
			deviationReason: override.reason,
		};
	});
}

/** Exported for testing. */
export const _EXCEPTIONS = EXCEPTIONS;
