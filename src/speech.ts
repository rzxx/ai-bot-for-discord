import { t, translate, withLocale } from './locale';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Config, LOCAL, MODELS, ROOT, log } from './config';
import { speechPreset } from './speech-presets';
import { TaskQueue } from './queue';
import { StdioVad, type VadProvider } from './live-vad';
import { withAbort } from './abort';
import { diagnosticsEnabled, latency, type DiagnosticFields } from './telemetry';

export interface Speaker { synthesize(text: string, signal: AbortSignal): Promise<Buffer> }
export interface Transcriber { transcribe(wav: Buffer, names: string[], signal: AbortSignal): Promise<string> }
export interface SpeechServices extends Speaker, Transcriber { vad?: VadProvider }
export interface SpeechAdapter { readonly client: SpeechServices; start(): Promise<void>; stop(): Promise<void> }

export class SpeechClient implements Speaker, Transcriber {
  private t = (message: string, ...values: unknown[]) => translate(this.config.locale, message, ...values);
  vad?: VadProvider;
  private ttsQueue = new TaskQueue(8);
  private ttsSequence = 0;
  constructor(readonly config: Config, readonly token: string) {}
  async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    const job = ++this.ttsSequence, began = performance.now();
    const trace = (stage: string, fields: DiagnosticFields = {}) => {
      if (diagnosticsEnabled()) latency({ session: 'speech', stage, job, elapsedMs: Math.round(performance.now() - began), ...fields });
    };
    trace('tts_job_queued', { chars: text.length });
    const task = this.ttsQueue.submit(async () => {
      let status: number | undefined, succeeded = false;
      try {
        signal.throwIfAborted(); // Canceled queued work must never reach the worker.
        trace('tts_job_started');
        // Python inference cannot be interrupted by closing its HTTP connection.
        // Keep this queue slot until the actual response/body completes, while
        // withAbort releases the canceled caller immediately and discards its WAV.
        const r = await fetch(`http://127.0.0.1:${this.config.speechPort}/tts`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Speech-Token': this.token },
          body: JSON.stringify({ text, voice: this.config.voice, pronunciations: this.config.pronunciations }),
          signal: AbortSignal.timeout(90000),
        });
        status = r.status;
        const body = await r.arrayBuffer();
        if (!r.ok) throw new Error(this.t("Speech synthesis: HTTP {0}", r.status));
        succeeded = true;
        trace('tts_job_audio', { wavBytes: body.byteLength });
        return Buffer.from(body);
      } finally { trace('tts_job_finished', { status, succeeded, callerAborted: signal.aborted }); }
    });
    try { return await withAbort(task, signal); }
    finally { if (signal.aborted) trace('tts_caller_canceled'); }
  }
  async transcribe(wav: Buffer, names: string[], signal: AbortSignal): Promise<string> {
    const speech = await fetch(`http://127.0.0.1:${this.config.speechPort}/${this.config.sttEngine === 'gigaam' ? 'stt' : 'vad'}`, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Speech-Token': this.token },
      body: new Uint8Array(wav), signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    });
    if (!speech.ok) throw new Error(this.t("Recognition/voice activity detector: HTTP {0}", speech.status));
    const validated = await speech.json() as { text?: string; speech: boolean };
    if (!validated.speech) return '';
    if (this.config.sttEngine === 'gigaam') return String(validated.text ?? '').trim();
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    form.set('language', this.config.speechLanguage); form.set('translate', 'false');
    form.set('response_format', 'verbose_json');
    form.set('temperature', '0.0'); form.set('temperature_inc', '0.0');
    // Hint only the vocabulary, never inject a plausible whole sentence for Whisper to hallucinate.
    form.set('prompt', names.slice(0, 20).join(', '));
    const r = await fetch(`http://127.0.0.1:${this.config.whisperPort}/inference`, {
      method: 'POST', body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    });
    if (!r.ok) throw new Error(this.t("Speech recognition: HTTP {0}", r.status));
    const result = await r.json() as { text?: string; segments?: { text: string; no_speech_prob?: number; avg_logprob?: number }[] };
    const segments = result.segments;
    const text = segments?.length ? segments.filter(s => (s.no_speech_prob ?? 0) < 0.75 && (s.avg_logprob ?? 0) > -1.5).map(s => s.text).join('') : result.text ?? '';
    return text.replace(/\[(?:BLANK_AUDIO|silence|тишина|музыка)\]/gi, '').replace(/\s+/g, ' ').trim();
  }
}

export class SpeechRuntime {
  private t = (message: string, ...values: unknown[]) => translate(this.config.locale, message, ...values);
  readonly token = crypto.randomUUID();
  readonly client: SpeechClient;
  private children: ChildProcess[] = [];
  private stopping = false;
  private vad?: StdioVad;
  constructor(readonly config: Config, readonly onFailure: (error: Error) => void = () => {}) { this.client = new SpeechClient(config, this.token); }
  async start() {
    const model = resolve(MODELS, `ggml-${this.config.sttModel}.bin`);
    const ttsModel = resolve(MODELS, speechPreset(this.config.speechLanguage).ttsModel);
    const python = resolve(ROOT, 'services', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    let whisper = process.env.WHISPER_SERVER_PATH;
    if (!whisper) { try { whisper = (await readFile(resolve(LOCAL, 'whisper-path.txt'), 'utf8')).trim(); } catch {} }
    if (!await Bun.file(ttsModel).exists() || !await Bun.file(python).exists() || !await Bun.file(resolve(MODELS, 'silero_vad.onnx')).exists()) throw new Error(this.t("Speech preset is not installed. Run bun run setup:speech."));
    if (this.config.sttEngine === 'whisper' && (!whisper || !await Bun.file(model).exists())) throw new Error(this.t("Whisper is not installed. Run bun run setup:speech --whisper."));
    if (this.config.sttEngine === 'gigaam' && !await Bun.file(resolve(MODELS, 'gigaam-v3/encoder.int8.onnx')).exists()) throw new Error(this.t("GigaAM is not installed. Run bun run setup:speech."));
    for (const port of this.config.sttEngine === 'whisper' ? [this.config.speechPort, this.config.whisperPort] : [this.config.speechPort]) {
      try { const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }); probe.stop(true); }
      catch { throw new Error(this.t("Port {0} is already in use. Stop the previous speech process.", port)); }
    }
    try {
      if (this.config.sttEngine === 'whisper') this.launch([whisper!, '-m', model, '--host', '127.0.0.1', '--port', String(this.config.whisperPort), '-l', this.config.speechLanguage, '-t', String(this.config.whisperThreads), '-bs', '5', '-sns', '-nlp'], 'Whisper');
      const speech = this.launch([python, resolve(ROOT, 'services/speech.py'), '--model', ttsModel, '--language', this.config.speechLanguage, '--port', String(this.config.speechPort), '--threads', String(this.config.ttsThreads), '--vad-model', resolve(MODELS, 'silero_vad.onnx'), '--asr-engine', this.config.sttEngine, '--gigaam-dir', resolve(MODELS, 'gigaam-v3'), '--asr-threads', String(this.config.gigaamThreads)], this.t('Speech worker'), true);
      if (this.config.liveVad) this.client.vad = this.vad = new StdioVad(speech.stdin!, speech.stdout!);
      await Promise.all([this.waitReady(this.config.speechPort, '/health'), ...(this.config.sttEngine === 'whisper' ? [this.waitReady(this.config.whisperPort, '/health')] : [])]);
      log(this.t('Speech recognition and synthesis ready.'));
    } catch (error) { await this.stop(); throw error; }
  }
  private launch(command: string[], name: string, pipeInput = false) {
    const child = spawn(command[0]!, command.slice(1), { windowsHide: true, cwd: ROOT,
      env: { ...process.env, SPEECH_SERVICE_TOKEN: this.token, PYTHONUTF8: '1' }, stdio: [pipeInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    this.children.push(child);
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', b => { tail = (tail + b.toString()).slice(-2000); });
    child.on('error', error => { if (!this.stopping) this.onFailure(new Error(`${name}: ${error.message}`)); });
    child.on('exit', code => { if (!this.stopping) this.onFailure(new Error(this.t("{0} exited: {1}. {2}", name, code, tail.slice(-900)))); });
    log(this.t("Started {0}.", name));
    child.stdin?.on('error', () => {});
    return child;
  }
  private async waitReady(port: number, path: string) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      if (this.children.some(c => c.exitCode !== null)) throw new Error(this.t("A speech process exited during startup."));
      try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
      await Bun.sleep(500);
    }
    throw new Error(this.t("Speech service on port {0} was not ready within 150 seconds.", port));
  }
  async stop() {
    this.stopping = true;
    this.vad?.close(); this.vad = undefined; this.client.vad = undefined;
    await Promise.all(this.children.map(child => new Promise<void>(resolveDone => {
      if (child.exitCode !== null || child.killed) return resolveDone();
      child.once('exit', () => resolveDone());
      child.kill();
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolveDone(); }, 2500).unref();
    })));
    this.children = [];
  }
}
