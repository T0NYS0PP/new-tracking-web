// Turns the Vite build in dist/ into the shape the claude.ai Artifact tool expects:
//  - dist-artifact/index.html : a page *fragment* (title + inline style + markup + module script)
//  - dist-artifact/files.json : published path -> source file map for the supporting files
// The artifact viewer cannot use the camera, so the MediaPipe bundle is left out; the lighter
// SH-degree-1 splat keeps the file under the 15 MB per-file limit. The artifact store only serves
// known extensions, so the .spz bytes are published under a .wasm name and the page tells Spark
// the real file type through data attributes on the canvas.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES = {
  main: { html: 'index.html', title: 'Boring Window' },
  painting: { html: 'painting.html', title: 'Painting Walk' },
};
const pageArg = process.argv.indexOf('--page');
const pageName = pageArg >= 0 ? process.argv[pageArg + 1] : 'main';
const page = PAGES[pageName];
if (!page) throw new Error(`unknown page "${pageName}" (${Object.keys(PAGES).join(', ')})`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const out = resolve(root, 'dist-artifact', pageName);
mkdirSync(out, { recursive: true });

const html = readFileSync(resolve(dist, page.html), 'utf8');
const cssFiles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\.?\/?([^"]+)"[^>]*>/g)].map((m) => m[1]);
const css = cssFiles.map((f) => readFileSync(resolve(dist, f), 'utf8')).join('\n');

const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1];
if (!body) throw new Error('dist/index.html has no <body>');
// Vite hoists the entry <script type="module"> into <head>; carry every module script over.
const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*><\/script>/g)].map((m) => m[0]);
if (scripts.length === 0) throw new Error('dist/index.html has no module script');
// Drop leading "./" so paths are plain relative references next to the page.
const relativize = (str) => str.replace(/(src|href)="\.\/(assets\/)/g, '$1="$2');
const SPLAT_PATH = 'splats/hero.spz.wasm';
const canvasAttrs =
  pageName === 'main'
    ? `data-splat="${SPLAT_PATH}" data-splat-type="spz"`
    : `data-splat-suffix=".wasm" data-splat-type="spz"`;
const markup =
  relativize(body)
    .replace('<canvas id="hero-canvas"', `<canvas id="hero-canvas" ${canvasAttrs}`)
    // Site navigation links point at the standalone pages; keep them absolute to the Pages site.
    .replace(/href="\.\/(painting\.html)?"/g, (m, p1) => `href="https://t0nys0pp.github.io/new-tracking-web/${p1 ?? ''}"`)
    .trim() +
  '\n' +
  scripts.map(relativize).join('\n');
if (!markup.includes('data-splat')) throw new Error('could not inject the splat override into the canvas');

const fragment = [
  `<title>${page.title}</title>`,
  '<style>',
  css.trim(),
  '</style>',
  markup,
  '',
].join('\n');
writeFileSync(resolve(out, 'index.html'), fragment);

const files = {};
for (const name of readdirSync(resolve(dist, 'assets'))) {
  if (name.endsWith('.js')) files[`assets/${name}`] = `dist/assets/${name}`;
}
if (pageName === 'main') {
  const lite = resolve(root, 'public/splats/hero-lite.spz');
  if (!existsSync(lite)) throw new Error('public/splats/hero-lite.spz missing: run `npm run assets`');
  files[SPLAT_PATH] = { from: 'public/splats/hero-lite.spz', contentType: 'application/wasm' };
} else {
  for (const name of readdirSync(resolve(root, 'public/splats/paintings'))) {
    if (!name.endsWith('.spz')) continue;
    files[`splats/paintings/${name}.wasm`] = { from: `public/splats/paintings/${name}`, contentType: 'application/wasm' };
  }
  for (const name of readdirSync(resolve(root, 'public/paintings'))) {
    if (/\.(jpe?g|png|webp)$/i.test(name)) files[`paintings/${name}`] = `public/paintings/${name}`;
  }
}
writeFileSync(resolve(out, 'files.json'), JSON.stringify(files, null, 2));

console.log(`[artifact] wrote ${out}/index.html (${(fragment.length / 1024).toFixed(0)} KB) and files.json:`);
console.log(JSON.stringify(files, null, 2));
