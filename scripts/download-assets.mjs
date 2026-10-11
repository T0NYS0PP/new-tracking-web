// Downloads development assets that are not committed to the repository:
//  - MediaPipe Face Landmarker model (float16)
//  - A sample Gaussian splat (.spz) from the Niantic spz repository
//  - Depth Anything V2 (small) ONNX model + public-domain paintings, converted to splats
//  - Public-domain archive photographs (Wikimedia Commons), converted to splats
// Usage: node scripts/download-assets.mjs
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
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

// Archive photographs for photos.html (Marie Curie's laboratory). Wikimedia Commons serves a resized
// copy through Special:FilePath; a descriptive User-Agent is required by their policy. Keep ids in
// sync with src/photoshots.ts. A photo that cannot be fetched is skipped with a warning (the page
// skips shots whose splat is missing) so one dead link never breaks the build.
const commons = (file, width = 2000) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
const PHOTO_ARGS = ['--fov', '60', '--near', '1.8', '--far', '7', '--gamma', '0.8', '--haze', '0.08', '--max-splats', '600000'];
const PHOTOS = [
  { id: 'curie-1912', url: commons('Marie Curie in her Paris Laboratory, 1912.jpg') },
  { id: 'curie-lab', url: commons('Marie Curie in her laboratory.jpg') },
  { id: 'curie-chair', url: commons('Marie Curie on a chair in her laboratory.jpg') },
  { id: 'curie-laboratory', url: commons('Marie Curie-Laboratory.jpg') },
  { id: 'curies-wellcome', url: commons('Marie and Pierre Curie (centre) in their laboratory, Paris Wellcome V0030700.jpg') },
];
for (const p of PHOTOS) ASSETS.push({ url: p.url, dest: `public/photos/${p.id}.jpg`, optional: true });

const HEADERS = { 'User-Agent': 'new-tracking-web/0.1 (asset download; https://github.com/t0nys0pp/new-tracking-web)' };

for (const { url, dest, optional } of ASSETS) {
  const out = resolve(root, dest);
  if (existsSync(out) && statSync(out).size > 0) {
    console.log(`[assets] exists   ${dest}`);
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  console.log(`[assets] download ${url}`);
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
    console.log(`[assets] saved    ${dest} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    if (existsSync(out)) rmSync(out);
    if (!optional) throw new Error(`Failed ${url}: ${err.message}`);
    console.warn(`[assets] skipped  ${dest}: ${err.message}`);
  }
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

// Photographs -> splats. Black-and-white prints get a neutral haze and a slightly flatter depth curve.
mkdirSync(resolve(root, 'public/splats/photos'), { recursive: true });
for (const p of PHOTOS) {
  const src = resolve(root, `public/photos/${p.id}.jpg`);
  const out = resolve(root, `public/splats/photos/${p.id}.spz`);
  if (!existsSync(src)) {
    console.warn(`[assets] no image for ${p.id}, skipping its splat`);
    continue;
  }
  if (existsSync(out) && statSync(out).size > 0) {
    console.log(`[assets] exists   public/splats/photos/${p.id}.spz`);
    continue;
  }
  execFileSync(process.execPath, [resolve(root, 'scripts/painting-to-splat.mjs'), src, out, '--model', model, ...PHOTO_ARGS], {
    stdio: 'inherit',
  });
}
