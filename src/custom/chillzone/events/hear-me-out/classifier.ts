/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out/classifier
 * Classifies Discord messages in the Hear Me Out voting channel into submission
 * categories based on their attribution line format.
 *
 * Canonical form (the "default"):
 *
 *     <hear me out text>
 *     -# Submitted by <@id>
 *
 * Classification cascade (first match wins):
 *
 * 1. **Loose regex** with lenient verb (any `sub<letters>` followed by `by` and
 *    a `<@id>` mention).
 *    - Multiple matches  -> `formatting-error` (ambiguous submitter)
 *    - Exact canonical   -> `canonical`
 *    - Extra `@`         -> `formatting-error`
 *    - Verb typo / other -> `non-default`
 * 2. **`-#` subtext + lone mention** (`-# <@id>` with no verb) -> `non-default`
 * 3. **`submitted by` + plain-text `@word`** (no `<@id>`)      -> `formatting-error`, submitter null
 * 4. **Single inline `<@id>` anywhere, no attribution line**   -> `non-default`
 * 5. **Anything else** -> `missing-attribution`
 *
 * Cases 2-5 are post-loose fallbacks; they only fire when stage 1 found no
 * attribution match. The exception override layer (see `exceptions.ts`)
 * applies on top of all of this, resolving submitters that this classifier
 * can't recover programmatically.
 */

import type { DiscordMessage, DiscordMessageAuthor, DiscordReaction, ClassifiedSubmission, UserEntity } from './types';

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Strict canonical: per-line, exactly `-# Submitted by <@id>` with optional
 * trailing whitespace. Case-sensitive (the title-cased verb is required).
 */
const CANONICAL_RE = /^-# Submitted by <@!?(\d{17,20})>\s*$/m;

/**
 * Loose attribution: catches every variant where there's a `sub*` verb + `by`
 * + an `<@id>` mention. Lenient on the verb so simple typos like `Submitte`
 * (missing 'd') still parse. The `[a-z]{2,}` after `sub` requires at least two
 * letters to keep false-positives down (a bare `sub by <@id>` won't match).
 *
 * Named groups:
 * - `prefix`:     leading chars before the verb (e.g. `-# `; absence -> missingSubtext)
 * - `verb`:       captured verb text (used for case/typo deviation detection)
 * - `colon`:      `:` after `by` (presence -> trailingColon)
 * - `extraWord`:  optional word between `by` and `<@id>` (e.g. "host")
 * - `extraAt`:    literal `@` immediately before `<@id>` (PROMOTES to formatting-error)
 * - `id`:         submitter snowflake
 */
const LOOSE_RE_GLOBAL =
	/^(?<prefix>[-#*>\s]*)(?<verb>[Ss]ub[a-z]{2,})\s+by(?<colon>:)?\s*(?:(?<extraWord>[A-Za-z]+)\s+)?(?<extraAt>@)?\s*<@!?(?<id>\d{17,20})>/gim;

/** Detects `-# <@id>` (subtext-style attribution missing the verb entirely). */
const SUBTEXT_MENTION_ONLY_RE = /^-#\s*<@!?(\d{17,20})>\s*$/m;

/**
 * Detects a `sub<letters>` + `by` line where the submitter is referenced by
 * plain-text `@username` instead of a `<@id>` mention. Doesn't capture the
 * submitter (it's unresolvable here); just flags the pattern.
 */
const PLAIN_TEXT_ATTRIBUTION_RE = /^[-#*>\s]*[Ss]ub[a-z]{2,}\s+by\s+@[A-Za-z][A-Za-z0-9_.]*/im;

/** Counts ALL `<@id>` mentions in the content (for the case-4 single-mention fallback). */
const ALL_MENTIONS_RE = /<@!?(\d{17,20})>/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sums reaction counts across all emoji types. */
function getTotalReactionCount(reactions: readonly DiscordReaction[] | undefined): number {
	if (!reactions) return 0;
	return reactions.reduce((sum, r) => sum + r.count, 0);
}

/**
 * Looks up a submitter's username from the message's `mentions` array.
 * Falls back to `'unknown'` if the ID didn't resolve at post time.
 */
function resolveSubmitter(submitterId: string, mentions: readonly DiscordMessageAuthor[]): UserEntity {
	const found = mentions.find((m) => m.id === submitterId);
	return { userId: submitterId, username: found?.username ?? 'unknown' };
}

/** Known canonical-acceptable verb forms (no typo deviation). */
const KNOWN_VERBS = new Set(['Submitted', 'submitted', 'Submission', 'submission']);

/**
 * Builds a human-readable deviation reason from the loose-regex named groups.
 * Returns `null` only when no deviation is detected (shouldn't happen when
 * called - the canonical check is supposed to short-circuit those).
 */
function describeDeviations(groups: Record<string, string | undefined>): string | null {
	const reasons: string[] = [];

	const prefix = groups.prefix ?? '';
	if (!prefix.includes('-#')) reasons.push('missing "-#" subtext');

	const verb = groups.verb ?? '';
	if (verb && !KNOWN_VERBS.has(verb)) {
		// Unrecognized verb (typo). The lenient regex still matched it, so we
		// surface the exact text to the host.
		reasons.push(`verb typo "${verb}" instead of "Submitted"`);
	} else {
		if (verb && verb[0] !== 'S') reasons.push('lowercase verb');
		if (verb.toLowerCase().includes('mission')) reasons.push('"submission" instead of "submitted"');
	}

	if (groups.colon) reasons.push('trailing colon after "by"');

	if (groups.extraWord) reasons.push(`extra word "${groups.extraWord}" before mention`);

	return reasons.length > 0 ? reasons.join(', ') : null;
}

/**
 * Common builder for ClassifiedSubmission with the per-message constants
 * (messenger, link, reactions) prefilled. Keeps the classifier's branching
 * code readable.
 */
function buildClassified(params: {
	messageId: string;
	messenger: UserEntity;
	messageLink: string;
	reactionCount: number;
	hasVotes: boolean;
	classification: ClassifiedSubmission['classification'];
	submitter: UserEntity | null;
	deviationReason: string | null;
}): ClassifiedSubmission {
	return params;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies a single Discord message into a {@link ClassifiedSubmission}.
 *
 * @param message   - Raw Discord message to classify.
 * @param guildId   - Server ID, used to construct the message link.
 * @param channelId - Channel ID, used to construct the message link.
 */
export function classifyMessage(message: DiscordMessage, guildId: string, channelId: string): ClassifiedSubmission {
	const messenger: UserEntity = { userId: message.author.id, username: message.author.username };
	const messageLink = `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;
	const reactionCount = getTotalReactionCount(message.reactions);
	const hasVotes = reactionCount > 0;
	const base = { messageId: message.id, messenger, messageLink, reactionCount, hasVotes };

	// Re-instantiate the global regex each call to reset lastIndex - defensive against
	// future refactors that might inadvertently share state across invocations.
	const looseRe = new RegExp(LOOSE_RE_GLOBAL.source, LOOSE_RE_GLOBAL.flags);
	const looseMatches = [...message.content.matchAll(looseRe)];

	// --- Stage 1: loose attribution found ---

	if (looseMatches.length > 1) {
		const firstId = looseMatches[0].groups?.id;
		const submitter = firstId ? resolveSubmitter(firstId, message.mentions) : null;
		return buildClassified({
			...base,
			classification: 'formatting-error',
			submitter,
			deviationReason: `multiple attribution lines (${looseMatches.length})`,
		});
	}

	if (looseMatches.length === 1) {
		const match = looseMatches[0];
		const groups = match.groups ?? {};
		const submitterId = groups.id;
		if (submitterId) {
			const submitter = resolveSubmitter(submitterId, message.mentions);

			// Canonical check on the matched text only (not whole message).
			if (CANONICAL_RE.test(match[0])) {
				return buildClassified({ ...base, classification: 'canonical', submitter, deviationReason: null });
			}

			// Extra `@` before mention is a clear typo -> formatting error.
			if (groups.extraAt) {
				return buildClassified({
					...base,
					classification: 'formatting-error',
					submitter,
					deviationReason: 'extra "@" before mention',
				});
			}

			const reason = describeDeviations(groups) ?? 'non-canonical format';
			return buildClassified({ ...base, classification: 'non-default', submitter, deviationReason: reason });
		}
	}

	// --- Stage 2: no loose match. Try fallbacks. ---

	// Fallback A: `-# <@id>` subtext line (no verb).
	const subtextMatch = message.content.match(SUBTEXT_MENTION_ONLY_RE);
	if (subtextMatch) {
		const submitterId = subtextMatch[1];
		const submitter = resolveSubmitter(submitterId, message.mentions);
		return buildClassified({
			...base,
			classification: 'non-default',
			submitter,
			deviationReason: 'missing "Submitted by" verb; submitter inferred from "-#" subtext mention',
		});
	}

	// Fallback B: `submitted by @plain-word` (no `<@id>`).
	if (PLAIN_TEXT_ATTRIBUTION_RE.test(message.content)) {
		return buildClassified({
			...base,
			classification: 'formatting-error',
			submitter: null,
			deviationReason: 'plain-text @username instead of "<@id>" mention; submitter not auto-resolvable',
		});
	}

	// Fallback C: exactly one inline `<@id>` anywhere, no attribution line.
	const allMentions = [...message.content.matchAll(ALL_MENTIONS_RE)];
	if (allMentions.length === 1) {
		const submitterId = allMentions[0][1];
		const submitter = resolveSubmitter(submitterId, message.mentions);
		return buildClassified({
			...base,
			classification: 'non-default',
			submitter,
			deviationReason: 'no "Submitted by" attribution; submitter inferred from sole inline mention',
		});
	}

	// Stage 3: nothing usable -> missing attribution.
	return buildClassified({
		...base,
		classification: 'missing-attribution',
		submitter: null,
		deviationReason: null,
	});
}

/** Classifies all messages from a channel. */
export function classifyMessages(messages: readonly DiscordMessage[], guildId: string, channelId: string): readonly ClassifiedSubmission[] {
	return messages.map((m) => classifyMessage(m, guildId, channelId));
}
