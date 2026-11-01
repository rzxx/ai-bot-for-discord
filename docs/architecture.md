# Architecture

The harness owns the conversation loop. Inference and speech adapters supply capabilities; Discord supplies the room, participants, audio, and permissions.

```text
participant audio → decode / detect speech → recognize → room controller
                                                       ↓
                              tools ← model decision → speech → playback
```

The design is organized around a few decisions: keep work bounded, keep one voice in the room, preserve the meaning of interruptions, and enforce actions outside the model.

## Prepare early, speak at the right time

Each participant has an independent decoder and voice activity state. Recognition runs through a bounded queue, so a busy room cannot build an unlimited backlog of stale audio.

The room controller prepares an answer during a pause, then waits for a speaking opportunity. A correction or new question can replace that answer before it plays. If an answer gets too old or no longer belongs to the current conversation, it is discarded.

The model returns a decision containing `speak`, `text`, and optional actions. Text can stream into synthesis before the trailing action arguments finish. Playback stays serialized: streamed chunks and optional thinking cues share one output path.

This keeps latency low without treating every short pause as permission to interrupt. Local hints help with common speech patterns; the model still interprets the conversation.

## Cancellation follows the whole turn

A turn has one lifetime across recognition, inference, tools, synthesis, and playback. Stop, pause, leave, and obsolete work invalidate that lifetime. Late results are ignored even if a provider cannot cancel its underlying request.

Synthesis needs an extra distinction: canceling the caller does not necessarily stop the worker's inference. The local adapter releases the caller promptly but keeps its queue slot until the worker finishes. Otherwise an interrupted cue could still occupy the worker when the actual answer arrives.

Playback records what was transmitted and whether it was interrupted. It does not assume a listener heard the full proposed answer. Discord provides no remote playback acknowledgement.

## Context grows with the session

The default inference adapter uses an append-only history. Instructions, locale, model settings, and participant aliases remain stable within the session. New requests append speech, sparse roster/presence changes, playback records, and tool receipts.

Short session aliases avoid repeating Discord IDs. Relative event times preserve overlapping speech. Playback can reference a proposed reply without copying its full text into context again.

The harness does not silently compact or summarize this history. Reaching `contextMaxTokens` pauses replies; `/leave` followed by `/join` starts fresh. Stable prefixes make cache reuse possible, while actual cache hits remain the provider's decision.

## The host authorizes tools

The model proposes actions; the host executes them after validating a completed response. An initial action must point to a current human speech request. Chat context, activity text, retrieved pages, and ordinary tool receipts cannot authorize writes.

Message sends check the requester's presence, both sides' channel permissions, individual recipients, cooldowns, and cancellation. The destination is the session's bound text channel. Ambiguous names return candidates instead of choosing someone. Discord writes use an abortable request and nonce to avoid duplicate sends on transport retries.

Reminders and proactive tasks belong to the current voice session. Time, activity changes, and held conditions create bounded work opportunities. Observers keep unchanged checks outside model history. The room batches compatible work into its existing conversation; later task steps append only new observations and receipts. Prepared reminders can use playback directly without inference.

Task research has its own lifetime and can continue while humans talk. Its results wait for admission through the same model writer and playback path. Host-issued grants bind tools to an occurrence and task revision; edits, cancellation, pause, and session teardown revoke them. Audience and conditions are checked again before delivery. Limits and expiry bound the backlog, and uncertain message sends are not retried. [Setup](setup.md#5-try-a-conversation) covers user controls; task types and limits live in `src/tasks.ts` and `src/config.ts`.

Search runs separately from speech. Discovery and a small number of public page reads return bounded excerpts. Retrieved text is evidence, never instructions. A single-use receipt token can authorize a refined search on the same question, within a short bounded chain; it cannot authorize a message or other write. New conversation invalidates that continuation.

## Data and lifetime

Conversation, live chat context, tool receipts, timers, tasks, observations, and research caches live in memory. Leaving releases all session state, including explicit reminders and recurring tasks. Only existing message cooldowns survive voice-session replacement. No task persistence or personal ChatGPT history is loaded.

The default inference adapter sends selected text to OpenAI using `store: false`; provider retention remains governed by the provider. Public search queries go to DuckDuckGo. The selected speech adapter receives audio and text; the included speech worker runs locally.

Optional chat, presence, and member context use Discord permissions and published data. Everyone receiving chat context in voice must have access to its source channel. Presence is a current observation, not evidence of availability or historical tracking.

Local reports are the persistence exception. `reportTools` and `backgroundReports` start enabled and have switches in setup. Selected summarized findings go to `.local/reports/`. They are unreviewed data, never instructions, and are not reloaded into conversation context. Background review permits bounded post-turn analysis through the inference provider and consumes allowance. It waits for idle time and yields to foreground work. Disable `backgroundReports` for capture without extra inference, or `reportTools` to disable reporting altogether.

Diagnostics capture timings, usage, and allowlisted status values rather than prompts, transcripts, queries, or audio. Detailed mode measures visible tokens in a bounded worker so accounting does not block playback. Missing usage stays unknown; repeated input traffic is reported separately from context growth.

Settings and generated files live outside Git: `config.json`, `.local/`, and `models/`. Review any export before sharing it.

## Where to change things

| Area | Files |
| --- | --- |
| Startup and adapter composition | `src/cli.ts`, `src/providers.ts` |
| Settings, setup, credentials, network | `src/config.ts`, `src/setup.ts`, `src/auth.ts`, `src/platform.ts`, `src/network.ts` |
| Discord sessions and commands | `src/discord.ts` |
| Capture, decoding, speech detection | `src/audio.ts`, `src/live-decoder.ts`, `src/live-vad.ts` |
| Turn scheduling and local hints | `src/room.ts`, `src/conversation.ts` |
| Proactive tasks and observation/research adapters | `src/tasks.ts`, `src/task-presence.ts`, `src/task-research.ts`, `src/task-instructions.ts` |
| Agent instructions | `src/prompts.ts` |
| Localization and speech defaults | `src/locale.ts`, `src/locales/`, `src/speech-presets.ts` |
| Inference and context | `src/llm.ts`, `src/context.ts`, `src/context-wire.ts`, `src/responses-transport.ts` |
| Tools and their boundaries | `src/room-tools.ts`, `src/member-directory.ts`, `src/reminders.ts`, `src/tool-safety.ts` |
| Retrieval | `src/web-search.ts`, `src/search-http.ts`, `src/search-text.ts`, `src/search-worker.ts` |
| Synthesis and playback | `src/speech.ts`, `services/speech.py`, `src/reply-stream.ts`, `src/voice-output.ts`, `src/playback.ts` |
| Observation and local findings | `src/telemetry.ts`, `src/diagnostics-report.ts`, `src/token-accounting*.ts`, `src/reports.ts`, `src/reporting.ts` |

For another backend, start with [adapters](adapters.md). For behavior and pronunciation tuning, start with [localization](localization.md). The synthetic scenarios under `tests/` exercise scheduling, cancellation, streaming, context, and tool boundaries without a production account.
