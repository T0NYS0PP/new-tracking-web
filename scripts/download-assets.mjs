// Downloads development assets that are not committed to the repository:
//  - MediaPipe Face Landmarker model (float16)
//  - A sample Gaussian splat (.spz) from the Niantic spz repository
//  - Depth Anything V2 (small) ONNX model + public-domain paintings, converted to splats
// Usage: node scripts/download-assets.mjs
import { execFileSync } from 'node:child_process';
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
  {
    url: 'https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits_dynamic.onnx',
    dest: 'tools/models/depth_anything_v2_vits_dynamic.onnx',
  },
];

// Public-domain paintings (reproductions hosted in jcjohnson's neural-style repositories) and the
// depth-to-splat parameters that suit each one. Keep ids in sync with src/paintings.ts.
const PAINTINGS = [
  {
    id: 'starry-night',
    url: 'https://raw.githubusercontent.com/jcjohnson/neural-style/master/examples/inputs/starry_night.jpg',
    args: ['--fov', '66', '--near', '1.8', '--far', '7', '--gamma', '0.7', '--haze', '0.12'],
  },
  {
    id: 'shipwreck',
    url: 'https://raw.githubusercontent.com/jcjohnson/neural-style/master/examples/inputs/shipwreck.jpg',
    args: ['--fov', '66', '--near', '1.8', '--far', '8', '--gamma', '0.8', '--haze', '0.22'],
  },
  {
    id: 'great-wave',
    url: 'https://raw.githubusercontent.com/jcjohnson/fast-neural-style/master/images/styles/wave_crop.jpg',
    args: ['--fov', '66', '--near', '1.8', '--far', '8', '--gamma', '0.8', '--haze', '0.16'],
  },
  {
    id: 'the-scream',
    url: 'https://raw.githubusercontent.com/jcjohnson/neural-style/master/examples/inputs/the_scream.jpg',
    args: ['--fov', '66', '--near', '1.8', '--far', '7', '--gamma', '0.75', '--haze', '0.14'],
  },
];
for (const p of PAINTINGS) ASSETS.push({ url: p.url, dest: `public/paintings/${p.id}.jpg` });

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

// Lighter variant (SH degree 1, ~13 MB) for hosts with per-file size limits such as the artifact viewer.
const lite = resolve(root, 'public/splats/hero-lite.spz');
if (!existsSync(lite)) {
  execFileSync(process.execPath, [resolve(root, 'scripts/spz-lite.mjs'), resolve(root, 'public/splats/hero.spz'), lite, '--sh', '1'], {
    stdio: 'inherit',
  });
}

// Paintings -> splats (monocular depth, see scripts/painting-to-splat.mjs).
const model = resolve(root, 'tools/models/depth_anything_v2_vits_dynamic.onnx');
mkdirSync(resolve(root, 'public/splats/paintings'), { recursive: true });
for (const p of PAINTINGS) {
  const out = resolve(root, `public/splats/paintings/${p.id}.spz`);
  if (existsSync(out) && statSync(out).size > 0) {
    console.log(`[assets] exists   public/splats/paintings/${p.id}.spz`);
    continue;
  }
  execFileSync(
    process.execPath,
    [resolve(root, 'scripts/painting-to-splat.mjs'), resolve(root, `public/paintings/${p.id}.jpg`), out, '--model', model, ...p.args],
    { stdio: 'inherit' },
  );
}
