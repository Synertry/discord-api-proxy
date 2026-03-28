/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/formatter
 * Renders a {@link KindnessCascadeResult} into a Discord-formatted plain text message.
 *
 * The output uses Discord markdown syntax: `**bold**`, `__underline__`, `###` headings,
 * `-#` small text, and `<t:unix>` dynamic timestamps. Usernames are escaped to prevent
 * accidental markdown injection from user-controlled data.
 *
 * The formatted message shows the **top 3** entries per ranked category (regardless
 * of how many the API returned), and up to **5** entries per listing section with
 * `and N more...` truncation. When `showAll` is enabled, listing sections are not
 * truncated. Invalid submissions are intentionally excluded.
 */

import type { KindnessCascadeResult, Stats, SubmissionEntry, UserTally } from './types';

/** Maximum number of ranked entries shown in the formatted output. */
const TOP_RANKED = 3;

/** Default maximum number of listing entries shown before truncation. */
const MAX_LISTING_SHOWN = 5;

/**
 * Escapes characters that have special meaning in Discord markdown.
 * Applied to user-controlled strings (usernames) to prevent formatting corruption.
 */
function escapeDiscordMarkdown(s: string): string {
  return s.replace(/([*_`~\\|>])/g, '\\$1');
}

/**
 * Formats ranked submission entries as `{link}: {reactionCount}` lines.
 * @example
 * // "https://discord.com/channels/.../123: 14"
 */
function formatSubmissionRanked(entries: readonly SubmissionEntry[]): string {
  return entries.map((e) => `${e.messageLink}: ${e.reactionCount}`).join('\n');
}

/**
 * Formats ranked user tallies as `{username} ({userId}): {count}` lines.
 * Usernames are escaped to prevent Discord markdown injection.
 * @example
 * // "alice (702202396985655306): 56"
 */
function formatUserTallyRanked(entries: readonly UserTally[]): string {
  return entries.map((e) => `${escapeDiscordMarkdown(e.username)} (${e.userId}): ${e.count}`).join('\n');
}

/**
 * Formats a listing section with a heading, bullet-pointed message links,
 * and optional truncation indicator.
 *
 * @param title   - Section heading (e.g. "Reply Submissions").
 * @param entries - All entries in this listing category.
 * @param showAll - When true, all entries are shown without truncation.
 * @returns Formatted section string, or empty string if no entries exist.
 */
function formatListingSection(title: string, entries: readonly SubmissionEntry[], showAll: boolean = false): string {
  if (entries.length === 0) return '';

  const lines = [`### ${title}`];
  const shown = showAll ? entries : entries.slice(0, MAX_LISTING_SHOWN);
  for (const entry of shown) {
    lines.push(`- ${entry.messageLink}`);
  }
  if (!showAll && entries.length > MAX_LISTING_SHOWN) {
    lines.push(`and ${entries.length - MAX_LISTING_SHOWN} more...`);
  }

  return lines.join('\n');
}

/** Formats the aggregate stats section. */
function formatStats(stats: Stats): string {
  return [
    '### Stats',
    `Total valid messages: ${stats.totalValidMessages}`,
    `Unique senders: ${stats.totalSenders}`,
    `Unique receivers: ${stats.totalReceivers}`,
    `Unique participants: ${stats.totalParticipants}`,
    `Total reactions: ${stats.totalReactions}`,
  ].join('\n');
}

/**
 * Assembles the full Discord-formatted tally message.
 *
 * Sections are separated by triple newlines (`\n\n\n`) to create visual spacing
 * when rendered in Discord. The footer contains a dynamic Discord timestamp.
 *
 * @param result    - The complete tallying result to format.
 * @param timestamp - Unix timestamp (seconds) for the footer; defaults to current time.
 * @param options   - `showAll`: when true, listing sections are not truncated.
 * @returns Plain text string ready to post as a Discord message.
 */
export function formatDiscordMessage(
  result: KindnessCascadeResult,
  timestamp: number = Math.floor(Date.now() / 1000),
  options?: { readonly showAll?: boolean },
): string {
  const showAll = options?.showAll ?? false;
  const sections: string[] = [];

  sections.push('**__Kindness Cascade Tally__**');

  sections.push(formatStats(result.stats));

  // Ranked sections — always show top 3 regardless of how many the API returned.
  // Joined with double newlines (single blank line) to keep them visually grouped.
  const rankedSections = [
    `### Top Voted Kindness\n${formatSubmissionRanked(result.ranked.topVotedKindness.slice(0, TOP_RANKED))}`,
    `### Most Kindness Sent\n${formatUserTallyRanked(result.ranked.mostKindnessSent.slice(0, TOP_RANKED))}`,
    `### Most Kindness Received\n${formatUserTallyRanked(result.ranked.mostKindnessReceived.slice(0, TOP_RANKED))}`,
    `### Top Voted Submitter\n${formatUserTallyRanked(result.ranked.topVotedSubmitter.slice(0, TOP_RANKED))}`,
    `### Top Voted Receiver\n${formatUserTallyRanked(result.ranked.topVotedReceiver.slice(0, TOP_RANKED))}`,
  ].join('\n\n');
  sections.push(rankedSections);

  // Listing sections — skip empty categories, exclude invalidSubmissions
  const listingSections = [
    formatListingSection('Reply Submissions', result.listings.replySubmissions, showAll),
    formatListingSection('Multi Mention Submissions', result.listings.multiMentionSubmissions, showAll),
    formatListingSection('Different Format Submissions', result.listings.differentFormatSubmissions, showAll),
    formatListingSection('Missing Votes', result.listings.missingVotes, showAll),
  ].filter((s) => s.length > 0);

  if (listingSections.length > 0) {
    sections.push(listingSections.join('\n\n'));
  }

  sections.push(`-# Updated as of <t:${timestamp}>`);

  return sections.join('\n\n\n');
}
