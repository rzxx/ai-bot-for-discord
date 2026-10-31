# Adapters

An adapter connects a backend to the harness. It owns authentication and network requests, or speech model processes. The room controller keeps responsibility for turn timing, cancellation, playback, and tool permissions.

The included inference adapter uses Sign in with ChatGPT. To use a different service or local model, implement the same contract in a local TypeScript or JavaScript module.

## Load an adapter

Set module paths in `config.json`, relative to the project root or absolute:

```json
{
  "inferenceAdapter": ".local/my-inference.ts",
  "speechAdapter": ".local/my-speech.ts"
}
```

An empty setting uses the included implementation. You can replace either side independently. Modules load at startup and run with the bot's permissions; paths come from host configuration, never from model output. Private modules and credentials can stay under the ignored `.local/` directory.

The factories and types are defined in [`src/providers.ts`](../src/providers.ts). Factories may return their adapter directly or resolve it asynchronously.

## Inference

Export `createInferenceProvider(config, credentialStore)` returning:

```ts
interface InferenceProvider {
  models(): Promise<InferenceModel[]>;
  createBrain(): Brain;
  login?(): Promise<void>;
  logout?(): Promise<void>;
}
```

`models()` lists the models available to the configured account/backend in preference order. Entries contain `slug`, `display_name`, and optional `context_window` and `supported_reasoning_levels`. The first entry is used when the user has not selected a model. Report those limits when available so startup can validate the user's settings.

`login` and `logout` integrate with the corresponding CLI commands. A backend using environment credentials can omit them.

`createBrain()` supplies the [`Brain`](../src/llm.ts) interface. Its required method is:

```ts
reply(snapshot, signal, hooks?): Promise<Reply>
```

It receives the room snapshot and returns `{speak, text, actions?, report?}`. Translate the provider's wire format inside the adapter. The shared room protocol is available in [`src/prompts.ts`](../src/prompts.ts); use the selected locale's instructions when constructing requests.

Honor the turn's abort signal. If streaming through `hooks.onSentence`, the emitted text must be a prefix of the final validated reply and stay within its character limit. The host checks consistency before completing playback.

Optional `Brain` methods support context metrics, warmup, maintenance, session release, local findings analysis, and user alias resolution. Implement `resolveUser` and `referenceUser` if your model input uses aliases. Release session state in `release`; background analysis runs only when `report` is supplied. Throw [`InferenceError`](../src/inference-error.ts) with `blocksInference` set when an authentication or quota failure should pause the room.

The included adapter owns OAuth, account model discovery, Responses streaming, provider item replay, and usage accounting. A different API shape belongs in a different adapter; the rest of the conversation loop does not need to change.

## Speech

Export `createSpeechAdapter(config, onFailure)` returning:

```ts
interface SpeechAdapter {
  client: {
    transcribe(wav: Buffer, names: string[], signal: AbortSignal): Promise<string>;
    synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
    vad?: VadProvider;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Recognition input is PCM16 WAV at 16 kHz mono. Synthesis returns PCM16 WAV: mono or stereo at 16, 24, or 48 kHz. The host converts it for Discord. `names` supplies recognition vocabulary hints.

`vad` is optional. Without it, capture uses the volume gate. See [`VadProvider`](../src/live-vad.ts) for the streaming detection contract.

Keep queues bounded. Canceling a caller should release it promptly, but a worker still processing that job must retain its slot until it can safely accept another. Otherwise an interrupted turn can collide with the next inference. Call `onFailure` if a service dies, and release its workers and connections in `stop()`.

Your adapter owns supported voice IDs, model installation, and language support. `/voice` and setup accept custom voice IDs when `speechAdapter` is configured. See [localization](localization.md) for the relationship between locale, recognition, pronunciation, and reply preferences.

## Test the boundary

Start with the synthetic tests in [`tests/adapters.test.ts`](../tests/adapters.test.ts), then test the real backend with:

- A short reply and streamed reply that resolve to the same text.
- Cancellation before a request, during generation, and during playback.
- A late result after cancellation.
- Authentication/quota failure and session cleanup.
- Tool actions tied to the original human speech event.

An adapter proposes tool calls through the normal reply contract. It does not bypass the host's permission and lifetime checks. Real voice testing should cover corrections, overlap, and noisy microphones as well as successful requests.
