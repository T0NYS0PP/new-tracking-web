// Turns the Vite build in dist/ into the shape the claude.ai Artifact tool expects:
//  - dist-artifact/index.html : a page *fragment* (title + inline style + markup + module script)
//  - dist-artifact/files.json : published path -> source file map for the supporting files
// The artifact viewer cannot use the camera, so the MediaPipe bundle is left out; the lighter
// SH-degree-1 splat keeps the file under the 15 MB per-file limit.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const out = resolve(root, 'dist-artifact');
mkdirSync(out, { recursive: true });

const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const cssFiles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\.?\/?([^"]+)"[^>]*>/g)].map((m) => m[1]);
const css = cssFiles.map((f) => readFileSync(resolve(dist, f), 'utf8')).join('\n');

const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1];
if (!body) throw new Error('dist/index.html has no <body>');
// Vite hoists the entry <script type="module"> into <head>; carry every module script over.
const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*><\/script>/g)].map((m) => m[0]);
if (scripts.length === 0) throw new Error('dist/index.html has no module script');
// Drop leading "./" so paths are plain relative references next to the page.
const relativize = (str) => str.replace(/(src|href)="\.\/(assets\/)/g, '$1="$2');
const markup = relativize(body).trim() + '\n' + scripts.map(relativize).join('\n');

const fragment = [
  '<title>Boring Window</title>',
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
const lite = resolve(root, 'public/splats/hero-lite.spz');
if (!existsSync(lite)) throw new Error('public/splats/hero-lite.spz missing: run `npm run assets`');
files['splats/hero.spz'] = { from: 'public/splats/hero-lite.spz', contentType: 'application/octet-stream' };
writeFileSync(resolve(out, 'files.json'), JSON.stringify(files, null, 2));

console.log(`[artifact] wrote ${out}/index.html (${(fragment.length / 1024).toFixed(0)} KB) and files.json:`);
console.log(JSON.stringify(files, null, 2));
