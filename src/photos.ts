import './styles/hero.css';
import './styles/photos.css';
import * as THREE from 'three';
import type { SplatFileType, SplatMesh } from '@sparkjsdev/spark';
import { config, configure } from './config';
import { FX_PRESETS, PostFX } from './fx/PostFX';
import { Motes } from './fx/Motes';
import { HeroOverlay } from './ui/HeroOverlay';
import { bootHero, checkPlatform, reportBootFailure, type HeroApp } from './app/bootHero';
import { findPhoto, PHOTOS, SEQUENCE, type ArchivePhoto, type Shot } from './photoshots';

// Same placement as the painting page: the photo's own camera sits where the viewer rests. The head
// parallax is kept small so the authored camera moves read as the shot, not the viewer's wobble.
configure({
  splat: { position: [0, 0, 2.6], rotation: [0, 0, 0], scale: 1 },
  camera: {
    windowWidth: 2.2,
    baseDistance: 2.6,
    kx: 0.22,
    ky: 0.14,
    maxYaw: (2.5 * Math.PI) / 180,
    maxPitch: (1.5 * Math.PI) / 180,
    pivot: [0, 0, -1.0],
    depthGain: 0.3,
  },
  tracking: { lateralRangeCm: 26, verticalRangeCm: 18 },
});

const overlay = new HeroOverlay();
const canvas = must<HTMLCanvasElement>('#hero-canvas');
const frame = must<HTMLElement>('#frame');
const captionEl = must<HTMLElement>('#reel-caption');
const pipImg = must<HTMLImageElement>('#pip-image');
const pipCaption = must<HTMLElement>('#pip-caption');
const pipLink = must<HTMLAnchorElement>('#pip-link');
const playToggle = must<HTMLButtonElement>('#play-toggle');
const prevBtn = must<HTMLButtonElement>('#prev-shot');
const nextBtn = must<HTMLButtonElement>('#next-shot');
const fxToggle = must<HTMLButtonElement>('#fx-toggle');
const shotCounter = must<HTMLElement>('#shot-counter');

// Hosts that cannot serve .spz publish the same bytes under another name (see scripts/build-artifact.mjs).
const splatSuffix = canvas.dataset.splatSuffix ?? '';
const splatType = canvas.dataset.splatType as SplatFileType | undefined;

const coarse = window.matchMedia('(pointer: coarse)').matches;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Depth (in front of the photo's camera) assumed for the `focus` point when it is re-centred. */
const FOCUS_DEPTH = 3.0;
/** Dip to black around a cut: hides the frame or two the new splats need to sort. */
const CUT_MS = 140;

let shotIndex = startIndex();
let shotStart = 0; // scene time at which the current shot began
let playing = !reducedMotion;
let cutting = false;
let fxOn = readFxPreference();
let current: ArchivePhoto = findPhoto(SEQUENCE[shotIndex].photo);
const broken = new Set<string>();

applyPhotoMeta(current);
applyCaption(SEQUENCE[shotIndex]);

if (checkPlatform(overlay)) run().catch((err: unknown) => reportBootFailure(overlay, err));

async function run(): Promise<void> {
  const app = await bootHero({ canvas, overlay, splatUrl: null });
  const cache = new MeshCache(app, coarse ? 2 : PHOTOS.length);

  // --- Light: archival grade (monochrome, blown-out windows, grain) + a little dust in the air ---
  const fx = new PostFX(app.scene.renderer, app.scene.scene, app.scene.viewer.camera, FX_PRESETS.archival);
  const motes = new Motes(coarse ? 120 : 260, '#ffffff', 1.1, 1.1);
  motes.setIntensity(0.45);
  app.scene.scene.add(motes.points);
  const applyLight = (p: ArchivePhoto) => {
    const preset = FX_PRESETS.archival;
    fx.apply({
      ...preset,
      sun: { ...preset.sun, glow: preset.sun.glow * p.light.rays, haze: preset.sun.haze * p.light.rays },
      rays: { ...preset.rays, exposure: preset.rays.exposure * p.light.rays },
      grade: { ...preset.grade, exposure: p.light.exposure ?? preset.grade.exposure },
    });
  };
  const applyFx = () => {
    app.scene.setPostFX(fxOn ? fx : null);
    motes.points.visible = fxOn && !reducedMotion;
    fxToggle.setAttribute('aria-pressed', String(fxOn));
    fxToggle.textContent = fxOn ? 'Light: archival' : 'Light: off';
    if (fxOn) applyLight(current);
  };
  applyFx();
  fxToggle.addEventListener('click', () => {
    fxOn = !fxOn;
    storeFxPreference(fxOn);
    applyFx();
  });

  // --- First photo: show the loader until it is in, then start the reel ---
  overlay.setState('loading');
  overlay.setProgressLabel('Developing the first photograph…');
  const firstMesh = await cache.get(SEQUENCE[shotIndex].photo, (f) => overlay.setProgress(f));
  app.scene.show(firstMesh);
  applyRig(app, SEQUENCE[shotIndex], 0);
  await wait(350);
  overlay.setState('ready');
  shotStart = app.scene.elapsedTime();
  cache.warm(SEQUENCE[next(shotIndex, 1)].photo);
  if (!coarse) cache.warm(SEQUENCE[next(shotIndex, 2)].photo);

  // --- Timeline: ease the rig through the shot, then cut ---
  app.scene.onFrame((_dt, time) => {
    const shot = SEQUENCE[shotIndex];
    const raw = (time - shotStart) / shot.duration;
    applyRig(app, shot, reducedMotion ? 0.5 : clamp(raw, 0, 1));
    if (playing && raw >= 1) void advance(1);

    motes.update(time, app.scene.renderer.getPixelRatio());
    const mesh = app.scene.currentSplat();
    if (!fxOn || !mesh) return;
    // Project the photo's light source (image coords at the far plane) into screen space.
    const aspect = photoAspect();
    const tanH = Math.tan((current.fovDeg * Math.PI) / 360);
    const zf = 6.5;
    sunLocal.set((current.light.x - 0.5) * 2 * tanH * zf, (-(current.light.y - 0.5) * 2 * tanH * zf) / aspect, -zf);
    mesh.localToWorld(sunWorld.copy(sunLocal));
    sunWorld.project(app.scene.viewer.camera);
    fx.setLight({ x: (sunWorld.x + 1) / 2, y: (sunWorld.y + 1) / 2 }, sunWorld.z > 1 ? 0 : 1);
  });

  /** Cut to the shot `dir` steps away (holds on the current one until its splat is ready). */
  async function advance(dir: 1 | -1): Promise<void> {
    if (cutting) return;
    cutting = true;
    let index = shotIndex;
    let mesh: SplatMesh | null = null;
    for (let tries = 0; tries < SEQUENCE.length && !mesh; tries++) {
      index = next(index, dir);
      const id = SEQUENCE[index].photo;
      if (broken.has(id)) continue;
      const slow = window.setTimeout(() => frame.classList.add('is-buffering'), 300);
      try {
        mesh = await cache.get(id);
      } catch (err) {
        console.warn(`[photos] ${id} failed to load, skipping`, err);
        broken.add(id);
      } finally {
        window.clearTimeout(slow);
      }
    }
    frame.classList.remove('is-buffering');
    if (!mesh) {
      overlay.setLoaderMessage('No photographs could be loaded. Run `npm run assets` and refresh.');
      overlay.setState('loading');
      playing = false;
      cutting = false;
      return;
    }
    const shot = SEQUENCE[index];
    frame.classList.add('is-cutting');
    await wait(CUT_MS);
    app.scene.show(mesh);
    shotIndex = index;
    current = findPhoto(shot.photo);
    applyPhotoMeta(current);
    applyCaption(shot);
    if (fxOn) applyLight(current);
    applyRig(app, shot, 0);
    shotStart = app.scene.elapsedTime();
    await wait(60);
    frame.classList.remove('is-cutting');
    cutting = false;
    cache.warm(SEQUENCE[next(index, dir)].photo);
  }

  // --- Controls ---
  const setPlaying = (on: boolean) => {
    if (on && !playing) {
      // Resume where the move paused instead of restarting the shot.
      shotStart = app.scene.elapsedTime() - pausedAt;
    } else if (!on && playing) {
      pausedAt = app.scene.elapsedTime() - shotStart;
    }
    playing = on;
    playToggle.textContent = on ? 'Pause' : 'Play';
    playToggle.setAttribute('aria-pressed', String(on));
  };
  let pausedAt = 0;
  setPlaying(playing);
  playToggle.addEventListener('click', () => setPlaying(!playing));
  nextBtn.addEventListener('click', () => void advance(1));
  prevBtn.addEventListener('click', () => void advance(-1));
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'ArrowRight') void advance(1);
    else if (e.key === 'ArrowLeft') void advance(-1);
  });
  // While paused, scrolling over the frame scrubs the shot's camera move.
  frame.addEventListener(
    'wheel',
    (e) => {
      if (playing) return;
      e.preventDefault();
      const shot = SEQUENCE[shotIndex];
      pausedAt = clamp(pausedAt + Math.sign(e.deltaY) * 0.04 * shot.duration, 0, shot.duration);
      shotStart = app.scene.elapsedTime() - pausedAt;
    },
    { passive: false },
  );
}

const sunLocal = new THREE.Vector3();
const sunWorld = new THREE.Vector3();

/** Loaded splat meshes keyed by photo id, with a small least-recently-used cache on phones. */
class MeshCache {
  private entries = new Map<string, { mesh: Promise<SplatMesh>; used: number }>();
  private tick = 0;

  constructor(
    private app: HeroApp,
    private limit: number,
  ) {}

  get(id: string, onProgress?: (fraction: number) => void): Promise<SplatMesh> {
    let entry = this.entries.get(id);
    if (!entry) {
      const photo = findPhoto(id);
      const mesh = this.app.scene.preload(photo.splat + splatSuffix, splatType, onProgress);
      entry = { mesh, used: 0 };
      this.entries.set(id, entry);
      mesh.catch(() => this.entries.delete(id));
      this.evict();
    }
    entry.used = ++this.tick;
    return entry.mesh;
  }

  warm(id: string): void {
    if (!broken.has(id)) this.get(id).catch(() => {});
  }

  private evict(): void {
    while (this.entries.size > this.limit) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [id, e] of this.entries) {
        if (id === current.id) continue;
        if (e.used < oldest) {
          oldest = e.used;
          victim = id;
        }
      }
      if (!victim) return;
      const e = this.entries.get(victim)!;
      this.entries.delete(victim);
      e.mesh.then((m) => this.app.scene.release(m)).catch(() => {});
    }
  }
}

function applyRig(app: HeroApp, shot: Shot, t: number): void {
  const e = ease(t, shot.ease ?? 'inOut');
  const a = shot.from;
  const b = shot.to;
  const fx = lerp(a.focus?.[0] ?? 0.5, b.focus?.[0] ?? 0.5, e);
  const fy = lerp(a.focus?.[1] ?? 0.5, b.focus?.[1] ?? 0.5, e);
  const tanH = Math.tan((current.fovDeg * Math.PI) / 360);
  const aspect = photoAspect();
  app.scene.viewer.setRig({
    pan: [(fx - 0.5) * 2 * tanH * FOCUS_DEPTH, (-(fy - 0.5) * 2 * tanH * FOCUS_DEPTH) / aspect],
    zoom: lerp(a.zoom ?? 0, b.zoom ?? 0, e),
    yaw: (lerp(a.yaw ?? 0, b.yaw ?? 0, e) * Math.PI) / 180,
    pitch: (lerp(a.pitch ?? 0, b.pitch ?? 0, e) * Math.PI) / 180,
  });
}

function ease(t: number, kind: NonNullable<Shot['ease']>): number {
  switch (kind) {
    case 'linear':
      return t;
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    default:
      return t * t * (3 - 2 * t);
  }
}

function photoAspect(): number {
  return pipImg.naturalWidth && pipImg.naturalHeight ? pipImg.naturalWidth / pipImg.naturalHeight : 1.5;
}

function applyPhotoMeta(p: ArchivePhoto): void {
  pipImg.src = p.image;
  pipImg.alt = `${p.title}, ${p.year}`;
  pipCaption.textContent = `${p.title}, ${p.year} · `;
  pipLink.textContent = p.credit;
  pipLink.href = p.source;
  pipCaption.append(pipLink);
  shotCounter.textContent = `${shotIndex + 1} / ${SEQUENCE.length}`;
  document.title = `${p.title}, ${p.year} — inside the photograph`;
  if (location.hash !== `#${p.id}`) history.replaceState(null, '', `#${p.id}`);
}

function applyCaption(shot: Shot): void {
  if (shot.caption === null) {
    captionEl.classList.add('is-hidden');
  } else {
    captionEl.textContent = shot.caption;
    captionEl.classList.remove('is-hidden');
  }
}

function startIndex(): number {
  const id = location.hash.replace(/^#/, '') || new URLSearchParams(location.search).get('photo');
  const i = SEQUENCE.findIndex((s) => s.photo === id);
  return i >= 0 ? i : 0;
}

function next(index: number, dir: number): number {
  return (index + dir + SEQUENCE.length) % SEQUENCE.length;
}

function readFxPreference(): boolean {
  try {
    return localStorage.getItem('photos.fx') !== 'off';
  } catch {
    return true;
  }
}

function storeFxPreference(on: boolean): void {
  try {
    localStorage.setItem('photos.fx', on ? 'archival' : 'off');
  } catch {
    /* storage unavailable */
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

// Keep the shared config import live for the debug panel (tree-shaking guard).
void config;
