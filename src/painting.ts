import './styles/hero.css';
import './styles/painting.css';
import * as THREE from 'three';
import type { SplatFileType } from '@sparkjsdev/spark';
import { config, configure } from './config';
import { DEFAULT_FX, PostFX } from './fx/PostFX';
import { Motes } from './fx/Motes';
import { HeroOverlay } from './ui/HeroOverlay';
import { bootHero, checkPlatform, reportBootFailure } from './app/bootHero';
import { PAINTINGS, findPainting, type Painting } from './paintings';

// The painting's own camera sits where the viewer rests, so the depth layers start just in front
// of the window and recede into the frame. A narrower window than the hero keeps the painting's
// edges out of view while the head moves.
configure({
  splat: { position: [0, 0, 2.6], rotation: [0, 0, 0], scale: 1 },
  camera: {
    windowWidth: 2.2,
    baseDistance: 2.6,
    kx: 0.3,
    ky: 0.2,
    maxYaw: (3 * Math.PI) / 180,
    maxPitch: (2 * Math.PI) / 180,
    pivot: [0, 0, -1.0],
    depthGain: 0.35,
  },
  tracking: { lateralRangeCm: 26, verticalRangeCm: 18 },
});

const overlay = new HeroOverlay();
const canvas = must<HTMLCanvasElement>('#hero-canvas');
const titleEl = must<HTMLElement>('#painting-title');
const metaEl = must<HTMLElement>('#painting-meta');
const pipImg = must<HTMLImageElement>('#pip-image');
const pipCaption = must<HTMLElement>('#pip-caption');
const chips = must<HTMLElement>('#painting-chips');
const walkToggle = must<HTMLButtonElement>('#walk-toggle');
const walkHint = must<HTMLElement>('#walk-hint');
const fxToggle = must<HTMLButtonElement>('#fx-toggle');

// Hosts that cannot serve .spz publish the same bytes under another name (see scripts/build-artifact.mjs).
const splatSuffix = canvas.dataset.splatSuffix ?? '';
const splatType = canvas.dataset.splatType as SplatFileType | undefined;
const splatUrlOf = (p: Painting) => p.splat + splatSuffix;

let current: Painting = findPainting(selectedId());
let fxEnabled = readFxPreference();
let walking = false;
let walkStartedAt = 0;
let manualOffset = 0;
let manualTouchedAt = -Infinity;
const WALK_PERIOD_S = 30;

renderChips();
applyPaintingMeta(current);

if (checkPlatform(overlay)) {
  bootHero({ canvas, overlay, splatUrl: splatUrlOf(current), splatType })
    .then((app) => {
      // --- Light: rays + bloom + grade in post, and motes drifting in the air in front of the scene ---
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const fx = new PostFX(app.scene.renderer, app.scene.scene, app.scene.viewer.camera, DEFAULT_FX);
      const motes = new Motes(coarse ? 160 : 320, current.light.color);
      app.scene.scene.add(motes.points);
      const applyFx = () => {
        app.scene.setPostFX(fxEnabled ? fx : null);
        motes.points.visible = fxEnabled && !reducedMotion;
        fxToggle.setAttribute('aria-pressed', String(fxEnabled));
        fxToggle.textContent = fxEnabled ? 'Light: on' : 'Light: off';
      };
      const applyLightForPainting = (p: Painting) => {
        fx.apply({
          grade: {
            ...DEFAULT_FX.grade,
            warmth: p.light.warmth,
            haze: p.light.haze,
            hazeAmount: 0.03,
            exposure: p.light.exposure ?? DEFAULT_FX.grade.exposure,
          },
          rays: { ...DEFAULT_FX.rays, exposure: DEFAULT_FX.rays.exposure * p.light.rays },
        });
        motes.setColor(p.light.color);
      };
      applyLightForPainting(current);
      applyFx();
      fxToggle.addEventListener('click', () => {
        fxEnabled = !fxEnabled;
        storeFxPreference(fxEnabled);
        applyFx();
      });
      onPaintingChange = applyLightForPainting;

      const sunLocal = new THREE.Vector3();
      const sunWorld = new THREE.Vector3();
      app.scene.onFrame((_dt, time) => {
        motes.update(time, app.scene.renderer.getPixelRatio());
        const mesh = app.scene.currentSplat();
        if (!fxEnabled || !mesh) return;
        // Project the painting's light source (image coords at the far plane) into screen space.
        const aspect = pipImg.naturalWidth && pipImg.naturalHeight ? pipImg.naturalWidth / pipImg.naturalHeight : 1.6;
        const tanH = Math.tan((current.fovDeg * Math.PI) / 360);
        const zf = 6.5;
        sunLocal.set((current.light.x - 0.5) * 2 * tanH * zf, (-(current.light.y - 0.5) * 2 * tanH * zf) / aspect, -zf);
        mesh.localToWorld(sunWorld.copy(sunLocal));
        sunWorld.project(app.scene.viewer.camera);
        const behind = sunWorld.z > 1;
        fx.setLight({ x: (sunWorld.x + 1) / 2, y: (sunWorld.y + 1) / 2 }, behind ? 0 : 1);
      });

      // --- Walk: ease the scene toward the viewer and back, with wheel / keys nudging the depth ---
      app.scene.onFrame((_dt, time) => {
        let auto = 0;
        if (walking) {
          const t = Math.max(0, time - walkStartedAt - 1.2);
          auto = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / WALK_PERIOD_S);
        }
        const sinceManual = time - manualTouchedAt;
        if (sinceManual > 6 && manualOffset !== 0) manualOffset *= 1 - Math.min(1, _dt * 0.6);
        const depth = clamp(auto + manualOffset, 0, 1);
        app.scene.viewer.setDolly(depth * current.walkDepth);
      });

      const nudge = (delta: number) => {
        manualOffset = clamp(manualOffset + delta, -1, 1);
        manualTouchedAt = performance.now() / 1000;
        if (!walking) setWalking(true, app);
      };
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        nudge(Math.sign(e.deltaY) * 0.06);
      }, { passive: false });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') nudge(0.08);
        if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') nudge(-0.08);
        if (e.key === ' ') {
          e.preventDefault();
          setWalking(!walking, app);
        }
      });
      walkToggle.addEventListener('click', () => setWalking(!walking, app));

      // Start walking once the first scene is in (a short still moment first, like the reel).
      setWalking(true, app);

      // --- Switch paintings ---
      chips.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
        if (!btn || btn.dataset.id === current.id) return;
        await switchPainting(findPainting(btn.dataset.id), app);
      });
      window.addEventListener('hashchange', () => {
        const next = findPainting(selectedId());
        if (next.id !== current.id) void switchPainting(next, app);
      });
    })
    .catch((err: unknown) => reportBootFailure(overlay, err));
}

let onPaintingChange: ((p: Painting) => void) | null = null;

async function switchPainting(next: Painting, app: Awaited<ReturnType<typeof bootHero>>): Promise<void> {
  current = next;
  applyPaintingMeta(next);
  onPaintingChange?.(next);
  renderChips();
  setWalking(false, app);
  manualOffset = 0;
  app.scene.viewer.setDolly(0);
  if (location.hash !== `#${next.id}`) history.replaceState(null, '', `#${next.id}`);
  try {
    await app.loadSplat(splatUrlOf(next), splatType);
    setWalking(true, app);
  } catch {
    /* loader shows the message */
  }
}

function setWalking(on: boolean, app: Awaited<ReturnType<typeof bootHero>>): void {
  walking = on;
  if (on) {
    walkStartedAt = app.scene.viewer.getDolly() > 0.01 ? -Infinity : performance.now() / 1000;
    // Resume from the current depth rather than jumping back to the start.
    if (walkStartedAt === -Infinity) {
      const depth = clamp(app.scene.viewer.getDolly() / current.walkDepth - manualOffset, 0, 1);
      const phase = Math.acos(1 - 2 * depth); // invert the cosine ease
      walkStartedAt = performance.now() / 1000 - 1.2 - (phase * WALK_PERIOD_S) / (2 * Math.PI);
    }
  }
  walkToggle.textContent = on ? 'Pause the walk' : 'Walk into the painting';
  walkToggle.setAttribute('aria-pressed', String(on));
  walkHint.textContent = on ? 'Scroll or press ↑ ↓ to go deeper or step back. Space pauses.' : 'Paused. Space or the button resumes.';
}

function applyPaintingMeta(p: Painting): void {
  titleEl.textContent = p.title;
  metaEl.textContent = `${p.artist} · ${p.year}`;
  pipImg.src = p.image;
  pipImg.alt = `${p.title} by ${p.artist}`;
  pipCaption.textContent = `${p.title}, ${p.year}`;
  document.title = `${p.title} — step inside the painting`;
}

function renderChips(): void {
  chips.innerHTML = PAINTINGS.map(
    (p) =>
      `<button type="button" data-id="${p.id}" class="chip${p.id === current.id ? ' is-active' : ''}" aria-pressed="${p.id === current.id}">${escapeHtml(p.title)}</button>`,
  ).join('');
}

function selectedId(): string | null {
  const hash = location.hash.replace(/^#/, '');
  if (hash && PAINTINGS.some((p) => p.id === hash)) return hash;
  return new URLSearchParams(location.search).get('painting');
}

function readFxPreference(): boolean {
  try {
    return localStorage.getItem('painting.fx') !== '0';
  } catch {
    return true;
  }
}

function storeFxPreference(on: boolean): void {
  try {
    localStorage.setItem('painting.fx', on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

// Keep the shared config import live for the debug panel (tree-shaking guard).
void config;
