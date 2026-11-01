# On-demand Discord chat retrieval

Status: proposed for discussion. This document does not enable retrieval or change runtime behavior.

## Intended experience

The agent should be able to answer requests such as:

- “What were the last few messages in chat?”
- “What did Alex last send?”
- “Find what Alex said about the Minecraft server yesterday.”
- “Find the message with the download link in #general.”
- “Read this message and what people said around it.”

Recommend one read-only `chat` tool with history, search, and individual-message operations. Fetch from Discord when asked, including messages from before `/join`. Default to the session's bound text channel; accept another explicitly named channel in the same server. Use Discord's search index for finding messages. Keep retrieval separate from passive live chat, public web search, and permission to post messages.

## What exists today

Confirmed from the current source:

- `chatContext` defaults to false in [config.ts](../src/config.ts). When enabled, the client requests Guild Messages and Message Content intents.
- [discord.ts](../src/discord.ts) handles new `MessageCreate` events only from the session's bound channel, after the session started. Bot and webhook authors are excluded. The bound channel is `chatChannelId`, or the channel where `/join` was invoked. Only ordinary server text and announcement channels are supported.
- Every tracked human voice participant must be able to view that channel. Adding someone without access pauses replies.
- [room.ts](../src/room.ts), `chat()`, rejects messages longer than 2,000 JavaScript string units, keeps at most one accepted message per author per second, and rejects new chat when 20 chat events await submission to the model. Accepted text passes through `safeText(..., 320)`, which also removes links, code blocks, and formatting.
- Chat is background context: it does not itself open a normal human speech request for tool execution. Accepted chat is included in later inference requests and retained in the append-only session context; the 20-event cap is a pending-input cap, not the total remembered history.
- Discord's message cache is explicitly disabled. There is no history backfill, individual-message fetch, or Discord message-search tool. Existing `search` is public web search; `message` sends text.

Consequently, the current feed is useful context but cannot establish that the agent saw every message, recover a link removed by sanitization, or reliably answer “what did someone last send?”

## Discord support

The official API supports history pages of 1–100 messages, individual-message reads, and guild message search with content, author, channel, date-boundary, and attachment/link filters. Search returns up to 25 matches per page. History and individual reads require View Channel and Read Message History. Search also requires Read Message History and is restricted by Message Content access. Search can return an indexing response instead of results; totals can be approximate, and short pages do not prove exhaustion. [Discord message API](https://docs.discord.com/developers/resources/message#search-guild-messages)

Message Content restrictions apply to HTTP data independently of the Gateway intents requested at connection time. [Discord Gateway documentation](https://docs.discord.com/developers/events/gateway#http-restrictions)

The installed dependencies already expose `Routes.guildMessagesSearch` and the search request/result types. Use the existing authenticated `client.rest` transport; no new service, user token, dependency upgrade, or local search database is needed.

## First-version scope

Include:

- Read recent messages in chronological order for a coherent summary.
- Search by text, author, time range, and optionally `has: "link" | "file" | "image"`.
- Find someone's latest messages using author-filtered search sorted newest first.
- Read a known message, or a small window around it.
- Resolve people through the existing member directory and session aliases. Return ambiguity instead of guessing.
- Accept the bound channel, an exact channel name, or a previously returned channel alias. Resolve names within the current server; duplicate names require clarification.
- Accept a pasted Discord message link for individual-message reads, subject to the same scope and access checks.
- Include user and bot messages in retrieval, with author kind clearly labeled. Skip system messages; distinguish webhook authors from server members.
- Report message times, edits, truncation, search limitations, and source references.

Defer server-wide discovery, DMs, threads, forum posts, voice-channel text, age-restricted channels, deleted-message recovery, attachment downloading/OCR/transcription, semantic indexing, and automatic archive ingestion. The initial channel restrictions match the current binding model; additional channel types need their own access and membership handling.

Explicitly naming another supported channel is enough to read it when permissions permit. Do not silently broaden a failed search to other channels. If no channel is named, use the bound channel. If none is bound, ask for a channel.

## Model-facing contract

Advertise capability `chat` only when the feature is enabled and the host provides it. The existing `message` tool remains the write capability. Proposed action shapes:

```ts
type ChatAction =
  | { tool: 'chat'; event: number; op: 'history'; channel?: string;
      limit?: number; before?: string; after?: string; around?: string }
  | { tool: 'chat'; event: number; op: 'search'; channel?: string;
      query?: string; author?: string; after?: string; before?: string;
      has?: 'link' | 'file' | 'image'; sort?: 'newest' | 'relevance'; limit?: number }
  | { tool: 'chat'; event: number; op: 'get'; message: string }
  | { tool: 'chat'; event: number; op: 'continue'; token: string;
      next: 'more' | 'get' | 'around'; message?: string };
```

Rules:

- `channel` is an exact name or session-local `c1` reference; omission means the bound channel. No arbitrary guild ID or URL fetch operation.
- History `before`/`after`/`around` are mutually exclusive session-local message references. `around` includes the anchor when available. Return a recoverable status if the anchor was deleted.
- Search `after`/`before` are ISO 8601 timestamps with explicit offsets, defining `[after, before)`. Validate ordering and normalize on the host; translate to snowflake bounds and check result timestamps locally.
- Search needs at least one nonempty selector: query, author, date bound, or `has`. `query` is plain search text, limited to 180 characters; filters are structured fields, not a Discord search-language string or a regular expression.
- Author accepts an existing `u1` reference or exact person name. Author-only search implements “what did Alex last send?” without scanning history locally. Unknown/departed authors may be read from returned message metadata; never imply a departed author is a current server or voice member.
- Default sort is newest; relevance is available when text is supplied. History and context windows are displayed oldest first, even though fetched newest first.
- `message` is a host-issued `m1` reference or a standard Discord message URL. Parse URL IDs locally; require the current guild and an eligible channel. Do not navigate to the URL or resolve arbitrary hosts.
- Default result count is 5; maximum is 10. Reject unknown fields, invalid operation combinations, malformed dates/links, and out-of-range limits.

Example initial actions:

```json
{"tool":"chat","event":42,"op":"history","limit":5}
{"tool":"chat","event":42,"op":"search","author":"u2","limit":3}
{"tool":"chat","event":42,"op":"search","channel":"general","query":"Minecraft server","author":"u2"}
{"tool":"chat","event":42,"op":"search","channel":"general","has":"link","limit":5}
```

For “yesterday,” use a proposed `chatTimezone` IANA setting, defaulting explicitly to `UTC`, exposed in stable session metadata. Convert calendar boundaries in that timezone, including daylight-saving transitions. State the timezone when it could change the answer; clarify an ambiguous date rather than guessing the user's location. English and Russian instructions must describe the same behavior.

## Receipts and evidence

Return a bounded projection, not Discord SDK objects:

```json
{
  "tool": "chat",
  "event": 42,
  "status": "ready",
  "op": "search",
  "source": "discord_search",
  "channel": {"ref": "c1", "name": "general"},
  "fetchedAt": "2026-11-01T12:00:00Z",
  "messages": [{
    "ref": "m1",
    "author": {"ref": "u2", "name": "Alex", "kind": "human"},
    "sentAt": "2026-10-31T18:24:00Z",
    "editedAt": null,
    "text": "The server address is …",
    "truncated": false
  }],
  "coverage": "index_results",
  "more": "available",
  "next": "host-issued-opaque-token"
}
```

`more` is `available`, `exhausted`, or `unknown`. Search receipts describe indexed results, never a proven complete archive. Use `unknown` when indexing, changing results, or budget limits prevent a reliable determination. Do not infer exhaustion from a short search page or expose a purported exact total. History receipts describe a returned window, not all channel history. Empty results mean “no matches returned in this scope,” not “they never said it.”

Allocate `m1`/`c1` references in a session-owned map; reuse the existing user alias mechanism. Keep source IDs and generated jump links in the host map. Each record includes its guild, channel, and fetch time. A reference is an identifier, never authorization. Bound the map, for example to 500 message references per session; expired references return `expired_reference` and can be recovered through a supplied source link.

History/search return excerpts up to 500 Unicode characters per message. `get` can return up to 2,000 characters. Cap the entire UTF-8 receipt at 8 KiB, including names, metadata, tokens, and JSON overhead; trim or omit records before delivery and mark truncation explicitly. Attachment-only messages retain up to three bounded filename/type summaries and the total attachment count. Reply metadata can contain a reference to the parent; never expand a reply chain automatically.

Use a dedicated retrieved-text normalizer. Existing `safeText` would destroy the links and code people may be looking for. Preserve useful text, line breaks, code, and URLs as quoted data; remove hidden controls, neutralize mentions, and redact supported credential patterns. Mark redaction/transformation so the agent does not claim a verbatim quote. Never auto-fetch URLs, embeds, attachment bodies, forwarded content, or cross-channel reply targets.

The initial answer should briefly acknowledge a lookup. A ready receipt can wake a concise follow-up with who, when, and the relevant passage. Do not read source URLs aloud or speak every returned message unless requested. Distinguish a found quote from an interpretation of it.

Suggested statuses: `ready`, `empty`, `disabled`, `content_unavailable`, `channel_unavailable`, `unsupported_channel`, `ambiguous_channel`, `ambiguous_person`, `unknown_person`, `not_found`, `expired_reference`, `indexing`, `cooldown`, `limit`, and `unavailable`. Avoid revealing whether an inaccessible channel or message exists.

### Sharing a jump link

Keep generated message links in the host. If the user asks to post a found source, extend the existing message action with `citations?: ["m1"]` (maximum two), rather than permitting arbitrary outbound URLs. This is a separate write authorized by the human request; a read receipt cannot authorize it.

The sender resolves references, rechecks source access for the requester and destination audience, and appends canonical Discord links after sanitizing the ordinary message body. This needs a deliberate change to the send renderer: passing links through today's `safeText` path would erase them. A request to “find and post the link” may need a small write-intent mechanism tied to the original speech; defer that compound action in v1 and request a fresh “post that” instruction. Do not let a read-continuation token authorize the write.

## Access and session memory

For each source channel, require the bot, requester, and every tracked human voice participant to have View Channel and Read Message History. The requester must still be present. Resolve current member roles and channel overwrites; fail closed if access cannot be established. Recheck after asynchronous I/O and before delivering results. Cancel pending work when the audience changes, then reevaluate access. These checks also apply to supplied links and known message references.

Track every channel whose retrieved content is admitted into conversation context, regardless of whether live `chatContext` is enabled. Add the source to this set atomically with receipt admission, before another participant can trigger inference. Extend `canUseContext()` to check the whole set, not just the bound channel.

This is necessary because `SessionContext` retains an immutable submitted prefix. When a new participant cannot access a previously used source, or a participant loses access, pause and cancel inference/playback. Resume only when everyone has access, or start a new session. Recheck before each inference and before audio playback, including after `/resume`. Later participants can hear knowledge from earlier results even if no further retrieval occurs. Do not promise to remove already-submitted content or retract speech already heard.

Retrieved messages remain untrusted evidence. Instructions inside a message, author name, attachment filename, or URL cannot authorize tools. Keep origin checks deterministic. This design does not make text messages into commands addressed to the bot.

## Execution, limits, and continuation

Integrate with the current room tool lifecycle:

1. An initial action references a current human speech event. Validate feature, session, input, actor, scope, and audience before I/O.
2. Issue abortable REST requests with a shared deadline. `/stop`, `/pause`, `/leave`, audience changes, and newer meaningful speech invalidate work and its continuation tokens. Late providers must not deliver a stale receipt.
3. Admit a bounded receipt as a tool event, register its source, and let the existing relevant-result wake-up run the answer turn.
4. A host-issued single-use token allows only the same request's next page, a returned message's full text, or its surrounding context. It cannot change the channel or filters, introduce a new target, invoke another tool, or authorize a write.

Tokens bind owner, session, original speech event, operation/filter snapshot, eligible message references, pagination state, expiry, and remaining budgets. Require the matching receipt in current tool origins. Consume before I/O. `next: "get" | "around"` accepts only a reference returned by that chain. At most three total rounds within 20 seconds; no implicit query refinement in v1. A fresh human request can change the search.

Proposed initial budgets: one active chat job per room; at most three content REST calls across the chain, including indexing retries; eight-second overall I/O budget; at least three seconds between new requests per requester and room. Continuations use the original budget rather than resetting cooldowns. Shared limits survive session replacement. Bounded permission/member resolution has its own short deadline and must not trigger full-server enumeration. All numeric budgets here are application choices, not claimed Discord rate limits.

Use `client.rest` for authenticated requests and Discord's dynamic rate-limit handling. Respect retry delays within the remaining deadline; do not hardcode Discord request quotas. [Discord rate-limit guidance](https://docs.discord.com/developers/topics/rate-limits)

On search-index-not-ready, allow one retry if the requested delay fits the remaining call/time budget; otherwise return `indexing` with a bounded retry hint. Auth/access/content failures are not empty search results. If search is unavailable, report it and leave direct history usable; do not silently scan the entire channel. No local archive or background indexing fallback in v1.

Deduplicate initial actions using normalized operation and arguments, not just `event:chat`. Reserve concurrency/cooldown/call budgets before awaits so simultaneous actions cannot bypass them. Follow-up rounds deduplicate messages and do not repeatedly append the same excerpt.

## Configuration and data lifetime

Add `chatTools: false` as a separate opt-in from `chatContext`:

- `chatContext`: passively receive new messages from the bound channel.
- `chatTools`: retrieve messages on a current spoken request.
- `chatChannelId`: retain existing default-channel behavior.
- `chatTimezone`: timezone for calendar-date requests.

Both read features require Message Content access in the Developer Portal. Request Message Content in the Gateway configuration when either read feature is enabled; Guild Messages is needed for passive context. Update the intent error to explain that multiple feature settings may require the same intent. Tools-only mode must work with passive context disabled. Keep the existing message-send setting independent.

Explain in setup that retrieval can include messages from before `/join` and that selected results are sent to the inference provider. Receipts remain in append-only session memory until `/leave`; references and pending jobs are cleared with the room. No raw Discord objects, queried text, message bodies, or links in diagnostics.

The current reporting pipeline can persist summarized tool evidence. For this feature, exclude chat retrieval payloads from automatic report evidence and report review inputs; do not claim all chat-derived knowledge stays out of reports if the agent or a later speaker repeats it. Document the existing report switches and residual behavior. Provider retention remains governed by that provider.

## Implementation sequence

1. Add `src/chat-retrieval.ts`: strict query validation, scoped channel/message resolution, bounded normalization, source references, Discord REST adapter, typed outcomes. Inject time and transport for deterministic tests.
2. Extend [room-tools.ts](../src/room-tools.ts): action union/parser, optional host contract, capability, budgets, deduplication, abort handling, and narrowly scoped read continuations. Do not generalize the existing public-search exception into arbitrary receipt-authorized actions.
3. Wire the adapter in [discord.ts](../src/discord.ts): current guild, live requester/audience, existing identity directory, permissions, and session ownership. Retain disabled message caching.
4. Extend [room.ts](../src/room.ts): source-aware context gate, audience-change invalidation, tool-trigger attribution, and retrieval acknowledgement/follow-up behavior. Verify that source checks cover retained results with passive chat disabled.
5. Update configuration, setup, `/status`, English/Russian prompts, tool status allowlists, and reporting evidence handling. Explain that Discord history is retrievable but voice conversation memory still starts at `/join`. Add the bounded `message.citations` renderer if jump-link posting is included.
6. Update setup/architecture/adapter documentation and run focused tests plus typechecking. Use a controlled test server for an explicit live smoke test before rollout; mocked tests cannot establish actual app intent approval or search availability.

## Verification before rollout

- History ordering/paging, individual fetch, author-only latest search, text/date/link filters, and around-message windows.
- Query validation, exact/ambiguous names, departed authors, bot/webhook labels, duplicate results, expired aliases, and source-link guild validation.
- Missing bot/requester/listener permissions; role or overwrite changes during I/O; audience changes before receipt admission or playback; retained-source access when `chatContext` is false.
- Stop, pause, leave, timeout, and newer speech cancel queued requests and suppress stale receipts/wake-ups. Single-use tokens cannot be replayed, switched between users/sessions, or used for a different target/write.
- UTF-8 receipt bounds with emoji, long names and URLs; redaction/truncation flags; attachment-only messages; code/link preservation; no automatic external fetches.
- Indexing responses, rate limiting, unavailable content, deleted messages, short search pages, approximate totals, and exhausted budgets produce accurate statuses.
- On-demand-only, passive-only, both enabled, and both disabled intent/config behavior; updated 4014 diagnostics.
- Room integration exercises a human request, acknowledgement, receipt, concise answer, and read-only continuation. Retrieved injection attempts cannot authorize actions. Automatic reports and diagnostics exclude the raw retrieval payload.

## Decisions to discuss

Recommended defaults are explicit-channel retrieval, small excerpts, human and bot authors, and no persistent archive. The biggest product choice is whether the first release may read explicitly named shared channels or should be restricted to the bound channel. Broader server-wide search can follow once discovery scope and retained-source access behavior are agreed.

Also decide whether host-rendered jump-link posting belongs in the first release, and choose the deployment timezone. The retrieval tool itself does not require automatic posting or persistent storage.
