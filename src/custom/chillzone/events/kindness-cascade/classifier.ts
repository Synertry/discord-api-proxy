/*
 *             discord-api-proxy
 *     Copyright (c) discord-api-proxy 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module kindness-cascade/classifier
 * Classifies Discord messages into submission types for the Kindness Cascade event.
 *
 * Classification pipeline (evaluated in order):
 * 1. **Reply** (Discord type 19) → `reply`, or `invalid` if the referenced message was deleted
 * 2. **Leading mentions** → `standard` (1 mention) or `multi-mention` (2+)
 * 3. **Embedded mentions** (not at the start) → `different-format`
 * 4. **No mentions at all** → `invalid`
 *
 * At every stage, messages without reactions are diverted to `missing-votes`.
 * The chronologically oldest message (host intro) is always classified as `skipped`.
 */

import type { DiscordMessage, DiscordMessageAuthor, DiscordReaction, ClassifiedMessage, UserEntity } from './types';

/**
 * Sums reaction counts across all emoji types on a message.
 * @returns Total reaction count, or 0 if the message has no reactions.
 */
function getTotalReactionCount(reactions: readonly DiscordReaction[] | undefined): number {
  if (!reactions) return 0;
  return reactions.reduce((sum, r) => sum + r.count, 0);
}

/**
 * Extracts user IDs from `<@id>` or `<@!id>` mentions at the very start of the message content.
 *
 * Stops as soon as non-whitespace text is found between mentions, ensuring only
 * truly "leading" mentions are captured. Supports the legacy `<@!id>` nickname format.
 *
 * @example
 * extractLeadingMentionIds('<@123> <@456> you rock!') // ['123', '456']
 * extractLeadingMentionIds('hey <@123>')              // [] — mention is not leading
 */
function extractLeadingMentionIds(content: string): readonly string[] {
  const ids: string[] = [];
  const regex = /<@!?(\d{17,20})>/g;
  let expectedIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    // If there's non-whitespace between the last match and this one, stop
    const gap = content.slice(expectedIndex, match.index);
    if (gap.trim() !== '') break;
    ids.push(match[1]);
    expectedIndex = match.index + match[0].length;
  }

  return ids;
}

/**
 * Maps raw mention IDs to {@link UserEntity} objects using the message's mentions array.
 * Deduplicates by user ID to handle repeated mentions of the same user.
 *
 * @param mentionIds - Raw user IDs extracted from message content.
 * @param mentions   - Discord's resolved mention objects (provides usernames).
 */
function resolveRecipients(mentionIds: readonly string[], mentions: readonly DiscordMessageAuthor[]): readonly UserEntity[] {
  const seen = new Set<string>();
  const recipients: UserEntity[] = [];

  for (const id of mentionIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const mention = mentions.find((m) => m.id === id);
    recipients.push({
      userId: id,
      username: mention?.username ?? 'unknown',
    });
  }

  return recipients;
}

/**
 * Extracts the author of the referenced (parent) message in a reply chain.
 * @returns The parent message's author as a {@link UserEntity}, or `null` if the parent was deleted.
 */
function getReplyRecipient(message: DiscordMessage): UserEntity | null {
  const ref = message.referenced_message;
  if (!ref) return null;
  return { userId: ref.author.id, username: ref.author.username };
}

/**
 * Classifies a single Discord message into a {@link MessageClassification}.
 *
 * @param message   - The raw Discord message to classify.
 * @param guildId   - Server ID, used to construct the message link.
 * @param channelId - Channel ID, used to construct the message link.
 * @returns A {@link ClassifiedMessage} with sender, recipients, and classification.
 */
export function classifyMessage(message: DiscordMessage, guildId: string, channelId: string): ClassifiedMessage {
  const sender: UserEntity = { userId: message.author.id, username: message.author.username };
  const messageLink = `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;
  const reactionCount = getTotalReactionCount(message.reactions);
  const hasReactions = reactionCount > 0;

  // --- Reply path (Discord message type 19) ---
  if (message.type === 19 && message.message_reference) {
    const recipient = getReplyRecipient(message);
    if (!recipient) {
      return { messageId: message.id, classification: 'invalid', sender, recipients: [], reactionCount, messageLink };
    }
    if (!hasReactions) {
      return { messageId: message.id, classification: 'missing-votes', sender, recipients: [recipient], reactionCount, messageLink };
    }
    return { messageId: message.id, classification: 'reply', sender, recipients: [recipient], reactionCount, messageLink };
  }

  // --- Leading mention path ---
  const mentionIds = extractLeadingMentionIds(message.content);
  if (mentionIds.length > 0) {
    const recipients = resolveRecipients(mentionIds, message.mentions);
    if (!hasReactions) {
      return { messageId: message.id, classification: 'missing-votes', sender, recipients, reactionCount, messageLink };
    }
    if (recipients.length >= 2) {
      return { messageId: message.id, classification: 'multi-mention', sender, recipients, reactionCount, messageLink };
    }
    return { messageId: message.id, classification: 'standard', sender, recipients, reactionCount, messageLink };
  }

  // --- Embedded mention path (mention exists but not at the start) ---
  if (message.mentions.length > 0) {
    const recipients = resolveRecipients(
      message.mentions.map((m) => m.id),
      message.mentions,
    );
    if (!hasReactions) {
      return { messageId: message.id, classification: 'missing-votes', sender, recipients, reactionCount, messageLink };
    }
    return { messageId: message.id, classification: 'different-format', sender, recipients, reactionCount, messageLink };
  }

  // --- Fallback: no mentions, not a reply ---
  return { messageId: message.id, classification: 'invalid', sender, recipients: [], reactionCount, messageLink };
}

/**
 * Classifies all messages in a channel, skipping the chronologically oldest
 * message (the host's event introduction).
 *
 * @param messages  - Raw Discord messages (typically in newest-first order from the API).
 * @param guildId   - Server ID for constructing message links.
 * @param channelId - Channel ID for constructing message links.
 * @returns Classified messages in the same order as the input array.
 */
export function classifyMessages(messages: readonly DiscordMessage[], guildId: string, channelId: string): readonly ClassifiedMessage[] {
  if (messages.length === 0) return [];

  // Find oldest message by smallest snowflake ID (robust regardless of array order)
  const oldestId = messages.reduce((min, m) => (m.id < min ? m.id : min), messages[0].id);

  return messages.map((message) => {
    if (message.id === oldestId) {
      const sender: UserEntity = { userId: message.author.id, username: message.author.username };
      const messageLink = `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;
      return { messageId: message.id, classification: 'skipped' as const, sender, recipients: [], reactionCount: 0, messageLink };
    }
    return classifyMessage(message, guildId, channelId);
  });
}
