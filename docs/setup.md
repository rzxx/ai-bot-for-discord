# Setup

This guide takes a checkout to a working voice session. If you're helping someone set it up, follow the same path and verify each connection before tuning behavior.

## 1. Install dependencies

Install [Bun](https://bun.sh/), [Git](https://git-scm.com/), and [uv](https://docs.astral.sh/uv/), then run:

```sh
bun install --frozen-lockfile
```

Use the committed lockfile: it also applies the Discord transport patches the app needs.

## 2. Connect Discord

Create an application in [Discord Developer Portal](https://discord.com/developers/applications), add a bot, and copy its token. Then open local setup:

```sh
bun run configure
```

Enter the token and server ID, choose the bot's name and language, and save. The form opens the bot installation page. Grant **View Channel**, **Connect**, **Speak**, and **Send Messages**.

To copy server and user IDs, enable Developer Mode in Discord settings. A controller user ID is optional; when configured, joining, leaving, and changing the voice require that user or **Manage Server** permission.

Basic voice use needs no privileged intents. Enable these only for the features you want, in both Developer Portal → Bot and the app settings:

| Feature | Setting | Discord intent |
| --- | --- | --- |
| New text messages as context | `chatContext` | Message Content |
| On-demand chat history and search | `chatTools` | Message Content |
| Published status and activities | `presenceContext` | Presence |
| Full directory of a small server | `memberContext` | Server Members |

The shared text channel defaults to where `/join` is invoked. Set `chatChannelId` if you want a fixed destination. Every voice participant must be able to see a channel used for conversation context. History retrieval also requires **Read Message History** for the bot and every voice participant.

## 3. Install speech

```sh
bun run setup:speech
```

The installer creates the speech environment and downloads the models for your selected language. [Localization](localization.md) covers speech choices and pronunciation tuning.

The automatic installer is maintained for Windows. On another platform, provide `WHISPER_SERVER_PATH` when using Whisper and install the native audio dependencies needed by your system. FFmpeg is required by some optional audio tools, not by the normal voice loop.

## 4. Sign in and choose a model

```sh
bun run login
bun run models
```

The browser asks permission to use your ChatGPT plan in the app. The model list comes from that account. To select one:

```sh
bun run models <slug>
```

If no model is selected, startup uses the first available model in provider order. `contextMaxTokens` and `reasoningEffort` must fit the chosen model. Model access and allowance depend on your account; see the provider's [plan usage documentation](https://developers.openai.com/siwc/token-sharing-open-source).

The app uses the public Responses endpoint and pauses on account or quota errors. It does not switch to paid API billing. To disconnect the account, run `bun src/cli.ts logout`.

## 5. Try a conversation

```sh
bun run doctor
bun start
```

Join an ordinary server voice channel and use `/join`. Address the bot by name, ask a short question, then try `/stop` during its answer. Command responses are private. Stage channels are not supported.

| Command | Use |
| --- | --- |
| `/join`, `/leave` | Connect or disconnect |
| `/stop` | Interrupt speech and pending work |
| `/pause`, `/resume` | Suspend or resume participation |
| `/status` | Inspect room state and queues |
| `/tasks` | List, pause, resume, or cancel session tasks |
| `/name` | Set your preferred name and pronunciation |
| `/voice` | Choose a voice |

Ask in voice for ongoing work, such as “remind me to stretch every five minutes” or “roast each new Spotify track”. You can change or cancel tasks in conversation, or use `/tasks` to find their IDs and `/tasks action:cancel id:t1` to cancel one immediately. Everyone in the voice room may manage tasks.

Tasks share the current conversation and disappear on `/leave` or shutdown. `/stop` interrupts current work while keeping recurring definitions; `/pause` suspends them until `/resume`. Generated contributions consume model allowance. The **Proactive session tasks** setup switch controls whether the model can create and manage them.

Spotify reactions require published activity context and Presence Intent. The bot can react only to activity Discord publishes; it cannot recover tracks missed while that activity is unavailable.

Keep the host running while the bot is in use. Ctrl+C shuts down the bot and speech services. Restart after changing account, model, language, adapter, or network settings.

## If something gets stuck

**Discord rejects the connection with 4014.** A requested privileged intent is disabled or unapproved. Enable the corresponding intent in Developer Portal, or turn off that context feature in the app.

**The bot connects but doesn't speak.** Start with `/status`, then check `bun run doctor`. Confirm that speech models are installed, the bot can speak in the channel, and the selected account/model is available. Use a short direct question before adjusting timing thresholds.

**A provider limit pauses replies.** Resolve the account or allowance issue, then use `/resume`.

**The session reaches its context limit.** Start a fresh session with `/leave` then `/join`. The harness preserves the current history instead of silently rewriting it.

For a closer look:

```sh
bun run start:diagnostic
```

In another terminal, `bun run diagnostics --session=latest` reads the local log without calling the model. Inspect the failing stage—recognition, inference, synthesis, or playback—before changing settings. See [architecture](architecture.md) for how those stages fit together.

## Proxies

Choose `networkMode` in setup or `config.json`:

- `environment` uses locally configured `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` values when present.
- `direct` removes proxy variables for the bot process and its subprocesses.

The app does not read or change OS proxy settings. Loopback traffic stays local. Discord voice uses UDP, and the public page reader uses direct HTTPS; an HTTP proxy does not tunnel those connections. Package managers and custom adapters may have their own proxy settings.

## Local files and sharing

`config.json` stores preferences; `.local/` stores credentials, diagnostics, and reports; `models/` stores weights. These paths are ignored by Git. Credentials are protected for the current OS user, so run the bot as the same user who configured it.

Local findings and background review start enabled. In setup's conversation settings, turn off **Review findings in the background** to avoid extra model calls, or **Save local findings** to disable reporting altogether. The matching config fields are `backgroundReports` and `reportTools`.

Tell voice participants which services process their conversation. The [data flow](architecture.md#data-and-lifetime) covers provider requests and local reporting. Review exported logs, reports, or audio before sharing them.

For assisted setup, share error messages and content-free diagnostic counters. Enter tokens in the local form or credential store, and keep personal configuration and runtime exports out of commits.
