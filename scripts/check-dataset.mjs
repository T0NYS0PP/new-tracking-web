// Sanity-check a Nerfstudio-style dataset before training:
//   node scripts/check-dataset.mjs <dataset dir>
// Verifies transforms.json, that every referenced image exists, and prints coverage stats.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/check-dataset.mjs <dataset dir>');
  process.exit(1);
}
const jsonPath = resolve(dir, 'transforms.json');
const imagesDir = resolve(dir, 'images');
const images = existsSync(imagesDir) ? readdirSync(imagesDir).filter((f) => /\.(png|jpe?g)$/i.test(f)) : [];
console.log(`images/: ${images.length} files`);

if (!existsSync(jsonPath)) {
  console.log('transforms.json: missing (fine for PostShot, required for Nerfstudio without COLMAP)');
  process.exit(images.length ? 0 : 1);
}
const t = JSON.parse(readFileSync(jsonPath, 'utf8'));
const hfov = (2 * Math.atan(t.w / 2 / t.fl_x) * 180) / Math.PI;
console.log(`transforms.json: ${t.frames.length} frames, ${t.w}x${t.h}, hfov ${hfov.toFixed(1)}°`);

let missing = 0;
const positions = [];
for (const f of t.frames) {
  const p = resolve(dir, f.file_path);
  if (!existsSync(p) || statSync(p).size === 0) missing++;
  const m = f.transform_matrix;
  positions.push([m[0][3], m[1][3], m[2][3]]);
  // Rotation part should be orthonormal.
  const r = [m[0].slice(0, 3), m[1].slice(0, 3), m[2].slice(0, 3)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const col = (i) => [r[0][i], r[1][i], r[2][i]];
  const err = Math.abs(dot(col(0), col(1))) + Math.abs(dot(col(1), col(2))) + Math.abs(1 - dot(col(0), col(0)));
  if (err > 1e-3) console.warn(`frame ${f.file_path}: rotation not orthonormal (err ${err.toExponential(1)})`);
}
if (missing) console.warn(`${missing} referenced images are missing or empty`);
const axis = (i) => positions.map((p) => p[i]);
const span = (a) => (Math.max(...a) - Math.min(...a)).toFixed(2);
console.log(`camera spread (m): x ${span(axis(0))}  y ${span(axis(1))}  z ${span(axis(2))}`);
process.exit(missing ? 1 : 0);
