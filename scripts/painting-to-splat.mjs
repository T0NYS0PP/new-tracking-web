// Turn a single painting (or photo) into a Gaussian splat scene (.spz) using monocular depth.
//
//   node scripts/painting-to-splat.mjs <image> <out.spz> [options]
//
// Options
//   --model <path>      ONNX depth model (Depth Anything V2 dynamic, or MiDaS small)   [required]
//   --max-width <px>    upper bound on the working width (one splat per pixel)              [1024]
//   --max-splats <n>    pixel budget for the image layer; the width is reduced to fit it   [700000]
//   --infer <px>        long side fed to the depth network (multiple of 14)              [518]
//   --fov <deg>         horizontal field of view assumed for the painting's "camera"     [55]
//   --near <u> --far <u>  depth range the scene is mapped to (world units, +z toward you) [1.2 / 7]
//   --gamma <g>         depth curve: >1 pushes more of the image toward the far plane     [1.0]
//   --splat-scale <k>   splat radius relative to the pixel footprint                      [1.5]
//   --edge <g>          drop pixels whose depth gradient exceeds this (normalised/px);
//                       removes the smeared ramp at silhouettes                            [0.025]
//   --bg-extend <r>     backdrop extends this far beyond the painting (mirrored), 1 = none  [1.4]
//   --thin <t>          splat thickness along the view axis relative to its radius        [0.35]
//   --opacity <a>       splat opacity 0-1                                                 [0.97]
//   --bg <0|1>          add a blurred backdrop layer behind the scene to hide holes       [1]
//   --preview <png>     write image + depth side-by-side for inspection
//
// Output is SPZ v2 (gzip, SH degree 0) in the right/up/back coordinate system Spark expects:
// the painting sits in front of the origin at negative z, as seen by a camera on +z.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import ort from 'onnxruntime-node';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const [input, output] = positional;
if (!input || !output || !opt('model')) {
  console.error('usage: node scripts/painting-to-splat.mjs <image> <out.spz> --model <depth.onnx> [options]');
  process.exit(1);
}
const cfg = {
  model: opt('model'),
  maxWidth: Number(opt('max-width', 1024)),
  maxSplats: Number(opt('max-splats', 700000)),
  infer: Number(opt('infer', 518)),
  fovDeg: Number(opt('fov', 55)),
  near: Number(opt('near', 1.2)),
  far: Number(opt('far', 7)),
  gamma: Number(opt('gamma', 1.0)),
  splatScale: Number(opt('splat-scale', 1.5)),
  edge: Number(opt('edge', 0.025)),
  bgExtend: Number(opt('bg-extend', 1.4)),
  thin: Number(opt('thin', 0.35)),
  opacity: Number(opt('opacity', 0.97)),
  bg: Number(opt('bg', 1)) !== 0,
  preview: opt('preview', null),
};

// ---------------------------------------------------------------- 1. image
const src = sharp(input).rotate();
const meta = await src.metadata();
const srcAspect = meta.width / meta.height;
const budgetWidth = Math.floor(Math.sqrt(cfg.maxSplats * srcAspect));
const W = Math.min(cfg.maxWidth, meta.width, budgetWidth);
const H = Math.round(W / srcAspect);
const rgb = await src.clone().resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
console.log(`[image] ${meta.width}x${meta.height} -> ${W}x${H}`);

// ---------------------------------------------------------------- 2. depth inference
const session = await ort.InferenceSession.create(cfg.model, { executionProviders: ['cpu'] });
const inName = session.inputNames[0];
const outName = session.outputNames[0];
const aspect = W / H;
let iw = cfg.infer;
let ih = cfg.infer;
if (aspect >= 1) ih = Math.round(cfg.infer / aspect);
else iw = Math.round(cfg.infer * aspect);
const r14 = (v) => Math.max(14, Math.round(v / 14) * 14);
iw = r14(iw);
ih = r14(ih);
const small = await src.clone().resize(iw, ih, { fit: 'fill' }).removeAlpha().raw().toBuffer();
const mean = [0.485, 0.456, 0.406];
const std = [0.229, 0.224, 0.225];
const chw = new Float32Array(3 * iw * ih);
for (let i = 0; i < iw * ih; i++) {
  for (let c = 0; c < 3; c++) chw[c * iw * ih + i] = (small[i * 3 + c] / 255 - mean[c]) / std[c];
}
console.log(`[depth] model ${cfg.model.split('/').pop()}  input "${inName}" ${ih}x${iw}  output "${outName}"`);
const t0 = Date.now();
const result = await session.run({ [inName]: new ort.Tensor('float32', chw, [1, 3, ih, iw]) });
const out = result[outName];
const dims = out.dims;
const oh = dims[dims.length - 2];
const ow = dims[dims.length - 1];
const disp = out.data; // relative inverse depth: larger = closer
console.log(`[depth] ${Date.now() - t0} ms, output ${oh}x${ow}`);

// Robust normalisation to [0,1] (1st..99th percentile).
const sorted = Float32Array.from(disp).sort();
const lo = sorted[Math.floor(sorted.length * 0.01)];
const hi = sorted[Math.floor(sorted.length * 0.99)];
const dispN = new Float32Array(oh * ow);
for (let i = 0; i < disp.length; i++) dispN[i] = Math.min(1, Math.max(0, (disp[i] - lo) / Math.max(1e-6, hi - lo)));

// Bilinear upsample to W x H.
const depthN = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  const fy = ((y + 0.5) * oh) / H - 0.5;
  const y0 = Math.max(0, Math.min(oh - 1, Math.floor(fy)));
  const y1 = Math.min(oh - 1, y0 + 1);
  const ty = Math.min(1, Math.max(0, fy - y0));
  for (let x = 0; x < W; x++) {
    const fx = ((x + 0.5) * ow) / W - 0.5;
    const x0 = Math.max(0, Math.min(ow - 1, Math.floor(fx)));
    const x1 = Math.min(ow - 1, x0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0));
    const a = dispN[y0 * ow + x0] * (1 - tx) + dispN[y0 * ow + x1] * tx;
    const b = dispN[y1 * ow + x0] * (1 - tx) + dispN[y1 * ow + x1] * tx;
    depthN[y * W + x] = a * (1 - ty) + b * ty;
  }
}

// ---------------------------------------------------------------- 3. unproject to splats
const f = W / 2 / Math.tan((cfg.fovDeg * Math.PI) / 360);
const cx = W / 2;
const cy = H / 2;
const invNear = 1 / cfg.near;
const invFar = 1 / cfg.far;
const toZ = (d) => 1 / ((invNear - invFar) * Math.pow(d, cfg.gamma) + invFar);

// Silhouette ramps: pixels where the (upsampled) depth jumps are neither foreground nor background.
// Seen from the side they become a spray of isolated dots, so drop them and let the backdrop show.
const edge = new Uint8Array(W * H);
for (let v = 0; v < H; v++) {
  for (let u = 0; u < W; u++) {
    const i = v * W + u;
    const gx = depthN[v * W + Math.min(W - 1, u + 1)] - depthN[v * W + Math.max(0, u - 1)];
    const gy = depthN[Math.min(H - 1, v + 1) * W + u] - depthN[Math.max(0, v - 1) * W + u];
    if (Math.hypot(gx, gy) * 0.5 > cfg.edge) edge[i] = 1;
  }
}
// One-pixel dilation so the halo around the ramp goes too.
const edgeD = new Uint8Array(edge);
for (let v = 1; v < H - 1; v++) {
  for (let u = 1; u < W - 1; u++) {
    const i = v * W + u;
    if (edge[i - 1] || edge[i + 1] || edge[i - W] || edge[i + W]) edgeD[i] = 1;
  }
}
let dropped = 0;

const splats = []; // {x,y,z,sx,sy,sz,r,g,b,a}
let zMin = Infinity;
let zMax = 0;
for (let v = 0; v < H; v++) {
  for (let u = 0; u < W; u++) {
    const i = v * W + u;
    if (edgeD[i]) {
      dropped++;
      continue;
    }
    const z = toZ(depthN[i]);
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
    const px = z / f; // world size of one pixel at this depth
    const s = px * cfg.splatScale;
    splats.push({
      x: ((u + 0.5 - cx) / f) * z,
      y: (-(v + 0.5 - cy) / f) * z,
      z: -z,
      sx: s,
      sy: s,
      sz: s * cfg.thin,
      r: rgb[i * 3],
      g: rgb[i * 3 + 1],
      b: rgb[i * 3 + 2],
      a: cfg.opacity,
    });
  }
}
const mainCount = splats.length;

// Backdrop: a blurred, coarse copy of the painting a little beyond the far plane, mirrored outward
// so the view never runs into a hard black edge when the head moves.
let bgCount = 0;
if (cfg.bg) {
  const step = 6;
  const padX = Math.round((W * (cfg.bgExtend - 1)) / 2);
  const padY = Math.round((H * (cfg.bgExtend - 1)) / 2);
  const EW = W + 2 * padX;
  const EH = H + 2 * padY;
  const bw = Math.max(8, Math.round(EW / step));
  const bh = Math.max(8, Math.round(EH / step));
  const blurred = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extend({ left: padX, right: padX, top: padY, bottom: padY, extendWith: 'mirror' })
    .blur(4)
    .resize(bw, bh, { fit: 'fill' })
    .raw()
    .toBuffer();
  const z = cfg.far * 1.12;
  const px = z / f;
  const s = px * step * 1.6;
  for (let v = 0; v < bh; v++) {
    for (let u = 0; u < bw; u++) {
      const i = v * bw + u;
      splats.push({
        x: (((u + 0.5) * step - padX - cx) / f) * z,
        y: (-((v + 0.5) * step - padY - cy) / f) * z,
        z: -z,
        sx: s,
        sy: s,
        sz: s * 0.2,
        r: blurred[i * 3],
        g: blurred[i * 3 + 1],
        b: blurred[i * 3 + 2],
        a: 1,
      });
      bgCount++;
    }
  }
}

// ---------------------------------------------------------------- 4. SPZ v2 encode
const n = splats.length;
const FRAC = 12;
const buf = Buffer.alloc(16 + n * (9 + 1 + 3 + 3 + 3));
buf.writeUInt32LE(0x5053474e, 0);
buf.writeUInt32LE(2, 4);
buf.writeUInt32LE(n, 8);
buf[12] = 0; // shDegree
buf[13] = FRAC;
buf[14] = 0; // flags
buf[15] = 0;
let o = 16;
const write24 = (val) => {
  const q = Math.max(-8388607, Math.min(8388607, Math.round(val * (1 << FRAC))));
  buf[o++] = q & 0xff;
  buf[o++] = (q >> 8) & 0xff;
  buf[o++] = (q >> 16) & 0xff;
};
for (const s of splats) {
  write24(s.x);
  write24(s.y);
  write24(s.z);
}
for (const s of splats) buf[o++] = Math.round(Math.min(1, Math.max(0, s.a)) * 255);
const SH_C0 = 0.28209479177387814;
const packColor = (c) => Math.max(0, Math.min(255, Math.round(((c / 255 - 0.5) / SH_C0) * (0.15 * 255) + 127.5)));
for (const s of splats) {
  buf[o++] = packColor(s.r);
  buf[o++] = packColor(s.g);
  buf[o++] = packColor(s.b);
}
const packScale = (v) => Math.max(0, Math.min(255, Math.round((Math.log(Math.max(1e-6, v)) + 10) * 16)));
for (const s of splats) {
  buf[o++] = packScale(s.sx);
  buf[o++] = packScale(s.sy);
  buf[o++] = packScale(s.sz);
}
for (let i = 0; i < n; i++) {
  buf[o++] = 128; // identity quaternion (0,0,0,1): xyz * 127.5 + 127.5
  buf[o++] = 128;
  buf[o++] = 128;
}
if (o !== buf.length) throw new Error(`encode size mismatch ${o} != ${buf.length}`);
const gz = gzipSync(buf, { level: 9 });
writeFileSync(output, gz);
console.log(
  `[spz] ${n} splats (${mainCount} image + ${bgCount} backdrop, ${dropped} edge pixels dropped), depth ${zMin.toFixed(2)}..${zMax.toFixed(2)}, ` +
    `${(gz.length / 1e6).toFixed(1)} MB -> ${output}`,
);

// ---------------------------------------------------------------- 5. preview
if (cfg.preview) {
  const gray = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const g = Math.round(depthN[i] * 255);
    gray[i * 3] = gray[i * 3 + 1] = gray[i * 3 + 2] = g;
  }
  await sharp({ create: { width: W * 2, height: H, channels: 3, background: '#000' } })
    .composite([
      { input: rgb, raw: { width: W, height: H, channels: 3 }, left: 0, top: 0 },
      { input: gray, raw: { width: W, height: H, channels: 3 }, left: W, top: 0 },
    ])
    .png()
    .toFile(cfg.preview);
  console.log(`[preview] ${cfg.preview}`);
}
