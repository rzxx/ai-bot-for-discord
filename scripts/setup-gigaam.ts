import { resolve } from 'node:path';
import { MODELS, ROOT } from '../src/config';
import { download } from './download';
import { run } from '../src/platform';

const source = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-giga-am-v3-russian-2025-12-16/resolve/main/';
export async function setupGigaAM() {
  const files: [string, string | undefined][] = [
    ['encoder.int8.onnx', '0ec54e5f130a91c0f228d21795ede10b31c992a1f73e45dcd827e843a71a9b50'],
    ['decoder.onnx', '5d1cfef155d8e07f213bd2f3229b5f6c5c29355c7fa5c1b9eb62cb1925725254'],
    ['joiner.onnx', 'fd1d02f45c2ad3d6b67cc149811ad794ab4b020ed49a0a9e2790a8619d1cddd8'],
    ['tokens.txt', undefined], ['LICENSE', undefined],
  ];
  await Promise.all(files.map(([file, hash]) => download(`${source}${file}?download=true`, resolve(MODELS, 'gigaam-v3', file), hash)));
}
if (import.meta.main) {
  await setupGigaAM();
  await run(['uv', 'sync', '--project', resolve(ROOT, 'services'), '--python', '3.11']);
}
