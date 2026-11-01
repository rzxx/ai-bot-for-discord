# AI agent harness for Discord

Bring an agent into a voice channel. It listens, follows the conversation, uses tools, and speaks back.

This project connects speech recognition, model inference, tools, and speech synthesis into one conversation loop. It handles the parts between them: who is speaking, when to answer, how to stream a reply, and when to stop.

**[Get started](docs/setup.md)** · **[How it works](docs/architecture.md)** · **[Build an adapter](docs/adapters.md)**

## Built for conversation

- **Keep up with the room.** Audio is processed per participant. The agent prepares replies during pauses and replaces answers that are no longer relevant.
- **Speak without waiting for the whole response.** Text streams into synthesis while the model finishes its turn. One playback queue keeps speech in order.
- **Give people control.** New speech, corrections, pause, and stop can cancel work throughout the pipeline.
- **Keep tool permissions in the host.** The model proposes actions. The harness checks the speaker, channel access, limits, and cancellation before executing them.

The included tools handle messages, reminders, member lookups, public search, and proactive tasks such as recurring reminders or reactions to music. Optional chat and presence context help the agent follow what's happening around it.

## Get it running

Install [Bun](https://bun.sh/) and [uv](https://docs.astral.sh/uv/), then run from the checkout:

```sh
bun install --frozen-lockfile
bun run configure
bun run setup:speech
bun run login
bun start
```

The setup form connects your Discord bot and configures the experience. Join a voice channel and use `/join`. Use `/stop` to interrupt a reply, `/pause` to step out of the conversation, and `/leave` to disconnect.

Inference uses **Sign in with ChatGPT**, with the models and allowance available to your account. Speech runs locally. You can choose a model, select a language, or connect another backend through an adapter.

The [setup guide](docs/setup.md) covers Discord permissions, speech installation, proxies, and first-run checks. For language-specific speech choices and tuning, see [localization](docs/localization.md).

## Make it yours

The room controller works with interfaces for inference, recognition, synthesis, and playback. Replace a backend without rebuilding the conversation loop, or change the tools and behavior for your own server.

Start with the [architecture](docs/architecture.md) for the design and [adapter guide](docs/adapters.md) for the contracts. To work on the source:

```sh
bun run typecheck
bun test tests
```

Settings, credentials, downloaded models, and runtime output stay in local files outside Git. The [data flow](docs/architecture.md#data-and-lifetime) explains what reaches providers and what survives a session.

[MIT](LICENSE). Speech models and dependencies retain their upstream licenses.
