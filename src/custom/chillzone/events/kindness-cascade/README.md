# Kindness Cascade

Server-side tallying module for the ChillZone Discord server's **Kindness Cascade** event. Fetches all messages from a designated channel, classifies each submission, and produces ranked leaderboards and categorized listings.

## Endpoint

```
GET /custom/chillzone/events/kindness-cascade
```

### Query Parameters

| Parameter          | Required | Default   | Description                                                    |
|--------------------|----------|-----------|----------------------------------------------------------------|
| `guildId`          | Yes      | -         | Discord server (guild) snowflake ID                            |
| `channelId`        | Yes      | -         | Discord channel snowflake ID                                   |
| `all`              | No       | `'false'` | `'true'` returns all entries; `'false'` returns top 10         |
| `formattedMessage` | No       | `'false'` | `'true'` returns Discord-formatted `text/plain` instead of JSON |

### Response Modes

**JSON** (default) - Returns `application/json` with the full `KindnessCascadeResult`:

```jsonc
{
  "ranked": {
    "topVotedKindness":    [{ "messageLink": "...", "reactionCount": 14, ... }],
    "mostKindnessSent":    [{ "userId": "...", "username": "...", "count": 56 }],
    "mostKindnessReceived": [{ "userId": "...", "username": "...", "count": 22 }],
    "topVotedSubmitter":   [{ "userId": "...", "username": "...", "count": 307 }],
    "topVotedReceiver":    [{ "userId": "...", "username": "...", "count": 107 }]
  },
  "listings": {
    "replySubmissions":          [...],
    "multiMentionSubmissions":   [...],
    "differentFormatSubmissions": [...],
    "missingVotes":              [...],
    "invalidSubmissions":        [...],
    "counts": { "replySubmissions": 21, ... }
  }
}
```

**Formatted text** (`?formattedMessage=true`) - Returns `text/plain` with Discord markdown, ready to post as a message. Shows top 3 ranked entries, up to 5 listing entries with truncation, and a dynamic Discord timestamp footer.

## Pipeline

```
fetchAllMessages  →  classifyMessages  →  tally  →  JSON or formatDiscordMessage
```

### 1. Fetch (`discord-client.ts`)

Paginates through the Discord Messages API (100 per page, up to 5000 total) using cursor-based `before` pagination.

### 2. Classify (`classifier.ts`)

Each message is classified into one of:

| Classification     | Criteria                                                      |
|--------------------|---------------------------------------------------------------|
| `standard`         | Single leading `<@id>` mention with reactions                 |
| `reply`            | Discord reply (type 19) with reactions                        |
| `multi-mention`    | Two or more leading mentions with reactions                   |
| `different-format` | Mention present but not at the start of the message           |
| `missing-votes`    | Valid structure but zero reactions                             |
| `invalid`          | No mentions and not a reply, or deleted reference             |
| `skipped`          | The chronologically oldest message (host intro)               |

### 3. Tally (`tallier.ts`)

Aggregates classified messages into two sections:

**Ranked categories** (sorted descending, top 10 by default):
- **topVotedKindness** - Submissions ranked by individual reaction count
- **mostKindnessSent** - Users ranked by number of messages sent
- **mostKindnessReceived** - Users ranked by number of messages received
- **topVotedSubmitter** - Users ranked by total reactions across sent messages
- **topVotedReceiver** - Users ranked by total reactions across received messages

**Listing categories** (all entries, with sparse counts):
- Reply submissions, multi-mention submissions, different-format submissions
- Missing votes, invalid submissions

### 4. Format (`formatter.ts`)

Renders the result as a Discord message with markdown headings, bold/underline title, and `<t:unix>` timestamp. Escapes usernames to prevent markdown injection.

## File Structure

```
kindness-cascade/
  index.ts           Barrel file (public API re-exports)
  types.ts           Domain types and Discord API type subset
  schemas.ts         Zod schemas for validation and OpenAPI spec
  discord-client.ts  Paginated Discord message fetcher
  classifier.ts      Message classification logic
  tallier.ts         Aggregation and ranking logic
  formatter.ts       Discord markdown formatter
  handler.ts         Hono route handlers (JSON + text)
```

## Testing

```bash
bun run test
```

Tests are in `test/custom/chillzone/events/kindness-cascade/`:

| Test File              | Coverage                                              |
|------------------------|-------------------------------------------------------|
| `fixtures.ts`          | Shared mock messages covering all classification paths |
| `classifier.spec.ts`   | All classification paths, edge cases, deduplication    |
| `tallier.spec.ts`      | All ranked/listing categories, truncation, ties        |
| `formatter.spec.ts`    | Output structure, top-3 limit, listing truncation      |
| `handler.spec.ts`      | HTTP integration: JSON, text, validation, errors       |
