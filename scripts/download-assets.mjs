// Downloads development assets that are not committed to the repository:
//  - MediaPipe Face Landmarker model (float16)
//  - A sample Gaussian splat (.spz) from the Niantic spz repository
// Usage: node scripts/download-assets.mjs
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  {
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    dest: 'public/mediapipe/face_landmarker.task',
  },
  {
    url: 'https://raw.githubusercontent.com/nianticlabs/spz/main/samples/hornedlizard.spz',
    dest: 'public/splats/hero.spz',
  },
];

for (const { url, dest } of ASSETS) {
  const out = resolve(root, dest);
  if (existsSync(out) && statSync(out).size > 0) {
    console.log(`[assets] exists   ${dest}`);
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  console.log(`[assets] download ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed ${url}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
  console.log(`[assets] saved    ${dest} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}
