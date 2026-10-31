import { t, setLocale } from '../src/locale';
import { configureNetwork } from '../src/network';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { download } from './download';
import { BIN, LOCAL, MODELS, ROOT, loadConfig, selectLocale, saveConfig, log } from '../src/config';
import { speechPreset } from '../src/speech-presets';
import { run } from '../src/platform';
import { acquireLock } from '../src/platform';
import { setupGigaAM } from './setup-gigaam';

async function find(root: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const result = await find(path, name); if (result) return result; }
  }
}

const config = await loadConfig();
const localeIndex = process.argv.indexOf('--locale');
if (localeIndex >= 0) {
  const locale = process.argv[localeIndex + 1];
  if (!locale || locale.startsWith('-')) throw new Error('Provide a locale after --locale.');
  Object.assign(config, selectLocale(config, locale));
}
setLocale(config.locale);
configureNetwork(config.networkMode);
const release = await acquireLock();
try {
if (localeIndex >= 0) await saveConfig(config);
await Promise.all([mkdir(BIN, { recursive: true }), mkdir(MODELS, { recursive: true })]);
const model = config.sttModel;
const preset = speechPreset(config.speechLanguage);
const hashes: Record<string, string> = { 'large-v3-turbo-q8_0': '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1' };
const archive = resolve(LOCAL, 'whisper-b5454.zip');
const whisperDir = resolve(BIN, 'whisper');
const installWhisper = config.sttEngine === 'whisper' || process.argv.includes('--whisper');
if (installWhisper && process.platform !== 'win32' && !process.env.WHISPER_SERVER_PATH) throw new Error(t("Set WHISPER_SERVER_PATH on this OS. Automatic binary installation targets Windows x64."));
if (installWhisper && !process.env.WHISPER_SERVER_PATH && !await Bun.file(resolve(LOCAL, 'whisper-path.txt')).exists()) {
  await download('https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip', archive, '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb');
  await mkdir(whisperDir, { recursive: true });
  // Paths are fixed descendants of this checkout, passed as process arguments.
  await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '& { param($a,$d) Expand-Archive -LiteralPath $a -DestinationPath $d -Force }', archive, whisperDir]);
  const exe = await find(whisperDir, 'whisper-server.exe');
  if (!exe) throw new Error(t("whisper-server.exe was not found in the archive."));
  await writeFile(resolve(LOCAL, 'whisper-path.txt'), exe, 'utf8');
}
await Promise.all([
  installWhisper ? download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin?download=true`, resolve(MODELS, `ggml-${model}.bin`), hashes[model], 12) : setupGigaAM(),
  download(preset.modelUrl, resolve(MODELS, preset.ttsModel), config.speechLanguage === 'ru' ? '50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437' : '02b71034d9f13bc4001195017bac9db1c6bb6115e03fea52983e8abcff13b665'),
  download('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', resolve(MODELS, 'silero_vad.onnx'), '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'),
]);
log(t("Installing an isolated Python environment (PyTorch CPU)…"));
await run(['uv', 'sync', '--locked', '--project', resolve(ROOT, 'services'), '--python', '3.11']);
await writeFile(resolve(LOCAL, 'speech-install.json'), JSON.stringify({ locale: config.locale, sttEngine: config.sttEngine, whisperBuild: installWhisper ? 'b5454' : undefined, whisperModel: installWhisper ? model : undefined, sileroModel: preset.modelId, installedAt: new Date().toISOString() }, null, 2));
log(t('Speech setup complete.'));
} finally { await release(); }
