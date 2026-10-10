// Produce a lighter .spz by truncating spherical-harmonics coefficients (and optionally
// decimating points). Pure byte surgery on the SPZ v2 layout: header(16) | positions(9n) |
// alphas(n) | colors(3n) | scales(3n) | rotations(3n) | sh(3*shDim*n), all gzip-compressed.
// Usage: node scripts/spz-lite.mjs <in.spz> <out.spz> [--sh 0|1|2|3] [--keep 0.0-1.0]
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const [, , input, output, ...rest] = process.argv;
if (!input || !output) {
  console.error('usage: node scripts/spz-lite.mjs <in.spz> <out.spz> [--sh N] [--keep F]');
  process.exit(1);
}
const opt = (name, def) => {
  const i = rest.indexOf(name);
  return i >= 0 ? Number(rest[i + 1]) : def;
};
const targetSh = opt('--sh', 1);
const keep = opt('--keep', 1);

const raw = gunzipSync(readFileSync(input));
const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
const magic = view.getUint32(0, true);
const version = view.getUint32(4, true);
const n = view.getUint32(8, true);
const shDegree = raw[12];
if (magic !== 0x5053474e) throw new Error('not an SPZ file');
if (version !== 2) throw new Error(`only SPZ v2 is supported (got v${version})`);
if (targetSh > shDegree) throw new Error(`file only has SH degree ${shDegree}`);

const dimForDegree = (d) => [0, 3, 8, 15][d];
const shDim = dimForDegree(shDegree);
const outDim = dimForDegree(targetSh);
const sections = [
  { name: 'positions', bytes: 9 },
  { name: 'alphas', bytes: 1 },
  { name: 'colors', bytes: 3 },
  { name: 'scales', bytes: 3 },
  { name: 'rotations', bytes: 3 },
  { name: 'sh', bytes: 3 * shDim },
];
const expected = 16 + sections.reduce((s, x) => s + x.bytes * n, 0);
if (raw.length !== expected) throw new Error(`unexpected size ${raw.length}, expected ${expected}`);

// Deterministic point selection so repeated runs give identical files.
const keepIdx = [];
let acc = 0;
for (let i = 0; i < n; i++) {
  acc += keep;
  if (acc >= 1) {
    acc -= 1;
    keepIdx.push(i);
  }
}
const m = keepIdx.length;

const outSections = sections.map((s) => ({ ...s, outBytes: s.name === 'sh' ? 3 * outDim : s.bytes }));
const outLen = 16 + outSections.reduce((s, x) => s + x.outBytes * m, 0);
const out = Buffer.alloc(outLen);
raw.copy(out, 0, 0, 16);
out[12] = targetSh;
out.writeUInt32LE(m, 8);

let inOff = 16;
let outOff = 16;
for (const s of outSections) {
  for (let j = 0; j < m; j++) {
    const src = inOff + keepIdx[j] * s.bytes;
    raw.copy(out, outOff + j * s.outBytes, src, src + s.outBytes);
  }
  inOff += s.bytes * n;
  outOff += s.outBytes * m;
}

const gz = gzipSync(out, { level: 9 });
writeFileSync(output, gz);
console.log(
  `${input} -> ${output}: points ${n} -> ${m}, SH ${shDegree} -> ${targetSh}, ` +
    `${(readFileSync(input).length / 1e6).toFixed(1)}MB -> ${(gz.length / 1e6).toFixed(1)}MB`,
);
