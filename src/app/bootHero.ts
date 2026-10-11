import type { SplatFileType } from '@sparkjsdev/spark';
import { config } from '../config';
import { HeroScene } from '../hero/HeroScene';
import { PointerInput } from '../input/PointerInput';
import { OrientationInput } from '../input/OrientationInput';
import { CENTER_POSE, type HeadPose, type InputSource } from '../input/types';
import { HeroOverlay } from '../ui/HeroOverlay';
import type { HeadTracker } from '../tracking/HeadTracker';

export interface BootOptions {
  canvas: HTMLCanvasElement;
  overlay: HeroOverlay;
  /** Initial splat; omit to boot without loading (call app.loadSplat later). */
  splatUrl?: string | null;
  splatType?: SplatFileType;
}

export interface HeroApp {
  scene: HeroScene;
  overlay: HeroOverlay;
  /** Lazily creates the webcam tracker (MediaPipe is only fetched then). */
  getTracker(): Promise<HeadTracker>;
  tracker(): HeadTracker | null;
  activeInput(): string;
  switchTo(source: InputSource): void;
  startTracking(): Promise<void>;
  stopTracking(): void;
  loadSplat(url: string, fileType?: SplatFileType): Promise<void>;
  trackerSupported: boolean;
}

const TRACKING_NOTE_EMBEDDED =
  'Head tracking needs the camera, which this embedded view cannot use. Open the standalone page to try it.';
const TRACKING_NOTE_INSECURE = 'Head tracking needs a camera over HTTPS. Mouse mode only here.';

/** Shared bootstrap: renderer, inputs, webcam opt-in, power management and the debug overlay. */
export async function bootHero(opts: BootOptions): Promise<HeroApp> {
  const { canvas, overlay } = opts;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const cameraApiAvailable = window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const trackerSupported = cameraApiAvailable && cameraAllowedByPolicy();

  overlay.setState('loading');
  overlay.setTrackingSupported(
    trackerSupported,
    trackerSupported ? undefined : cameraApiAvailable ? TRACKING_NOTE_EMBEDDED : TRACKING_NOTE_INSECURE,
  );

  // --- Scene ---
  const scene = new HeroScene(canvas, {
    onProgress: (f) => overlay.setProgress(f),
    onError: (err) => console.error('[hero] splat failed to load', err),
  });
  scene.viewer.setEnabled(!reducedMotion.matches);
  reducedMotion.addEventListener('change', () => scene.viewer.setEnabled(!reducedMotion.matches));
  scene.start();

  // --- Inputs: pointer always, device tilt on phones, webcam head tracking on demand ---
  const pointer = new PointerInput();
  const orientation = coarsePointer && OrientationInput.isSupported() ? new OrientationInput() : null;
  let tracker: HeadTracker | null = null;
  let splatReady = false;

  let active: InputSource = pointer;
  const latest: Record<string, HeadPose> = {};
  const feed = (source: InputSource) => (pose: HeadPose) => {
    latest[source.name] = pose;
    if (source === active) scene.viewer.setTarget(pose);
  };
  const switchTo = (source: InputSource) => {
    active = source;
    scene.viewer.setResponse(
      source.name === 'head'
        ? { smoothingRate: config.camera.headSmoothingRate, predictMs: config.tracking.predictMs }
        : { smoothingRate: config.camera.smoothingRate, predictMs: 0 },
    );
    scene.viewer.setTarget(latest[source.name] ?? CENTER_POSE);
  };
  const fallbackSource = () => (orientation && latest[orientation.name] ? orientation : pointer);

  pointer.onPose(feed(pointer));
  orientation?.onPose(feed(orientation));
  await pointer.start();
  orientation?.start().then(() => switchTo(orientation)).catch(() => {});

  const getTracker = async (): Promise<HeadTracker> => {
    if (tracker) return tracker;
    const { HeadTracker } = await import('../tracking/HeadTracker');
    tracker = new HeadTracker();
    tracker.onPose(feed(tracker));
    tracker.onStatus((status, detail) => {
      overlay.setTrackerStatus(status, detail);
      if (status === 'tracking' || status === 'lost' || status === 'calibrating') {
        if (splatReady) overlay.setState('tracking');
        if (active !== tracker) switchTo(tracker!);
      } else if (status === 'idle' || status === 'denied' || status === 'error') {
        if (splatReady) overlay.setState('ready');
        switchTo(fallbackSource());
        if (status !== 'idle') safeStore(false);
      }
    });
    return tracker;
  };

  const startTracking = async (): Promise<void> => {
    overlay.setTrackerStatus('loading');
    try {
      orientation?.start().catch(() => {});
      const t = await getTracker();
      await t.start();
      safeStore(true);
    } catch {
      if (!tracker) overlay.setTrackerStatus('error');
    }
  };
  const stopTracking = (): void => {
    tracker?.stop();
    safeStore(false);
  };

  if (trackerSupported) {
    overlay.setTrackerStatus('idle');
    overlay.onRecenter(() => tracker?.recalibrate());
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey) tracker?.recalibrate();
    });
    overlay.onToggle(() => {
      const s = tracker?.getStatus() ?? 'idle';
      if (s === 'idle' || s === 'denied' || s === 'error') void startTracking();
      else stopTracking();
    });
  }

  const loadSplat = async (url: string, fileType?: SplatFileType): Promise<void> => {
    splatReady = false;
    overlay.setProgress(0);
    overlay.setState('loading');
    try {
      await scene.load(url, fileType);
    } catch {
      overlay.setLoaderMessage('Could not load the scene. Run `npm run assets` and refresh.');
      throw new Error(`failed to load ${url}`);
    }
    splatReady = true;
    const s = tracker?.getStatus();
    overlay.setState(s === 'tracking' || s === 'lost' || s === 'calibrating' ? 'tracking' : 'ready');
  };

  const app: HeroApp = {
    scene,
    overlay,
    getTracker,
    tracker: () => tracker,
    activeInput: () => active.name,
    switchTo,
    startTracking,
    stopTracking,
    loadSplat,
    trackerSupported,
  };
  (window as unknown as { __hero: unknown }).__hero = { ...app, pointer, config };

  if (opts.splatUrl) await loadSplat(opts.splatUrl, opts.splatType);

  // Returning visitors who opted in before: resume on their first interaction (a gesture, never an auto prompt).
  if (trackerSupported && safeRead() === true) {
    const resume = () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      void startTracking();
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  // --- Power management ---
  document.addEventListener('visibilitychange', () => {
    tracker?.setPaused(document.hidden);
    if (document.hidden) scene.stop();
    else scene.start();
  });
  new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;
      tracker?.setPaused(!entry.isIntersecting);
      if (entry.isIntersecting) scene.start();
      else scene.stop();
    },
    { threshold: 0.05 },
  ).observe(canvas);

  if (/\bdebug\b/.test(location.search) || /\bdebug\b/.test(location.hash)) installDebugPanel(app);
  return app;
}

/** Shows WebGL2 / WebAssembly problems up front; returns false when the page cannot run. */
export function checkPlatform(overlay: HeroOverlay): boolean {
  if (!HeroScene.isSupported()) {
    overlay.setState('unsupported');
    overlay.setTrackingSupported(false);
    overlay.setLoaderMessage('WebGL2 is not available. Enjoy the poster instead.');
    return false;
  }
  if (!wasmAllowed()) {
    overlay.setState('unsupported');
    overlay.setTrackingSupported(false);
    overlay.setLoaderMessage('This host blocks WebAssembly, which the splat renderer needs. Open the standalone page.');
    return false;
  }
  return true;
}

export function reportBootFailure(overlay: HeroOverlay, err: unknown): void {
  console.error('[hero] boot failed', err);
  overlay.setState('unsupported');
  const msg = err instanceof Error ? err.message : String(err);
  overlay.setLoaderMessage(`The window would not open (${msg.slice(0, 120)}). Refresh to try again.`);
}

function installDebugPanel(app: HeroApp): void {
  app.overlay.setDebugVisible(true);
  let frames = 0;
  let lastFpsAt = performance.now();
  let renderFps = 0;
  const countFrame = () => {
    frames++;
    const now = performance.now();
    if (now - lastFpsAt >= 1000) {
      renderFps = (frames * 1000) / (now - lastFpsAt);
      frames = 0;
      lastFpsAt = now;
    }
    requestAnimationFrame(countFrame);
  };
  requestAnimationFrame(countFrame);
  window.setInterval(() => {
    const st = app.tracker()?.getStats();
    const f = (v: number, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
    const lines = [
      `input   ${app.activeInput()}   render ${renderFps.toFixed(0)} fps   dolly ${app.scene.viewer.getDolly().toFixed(2)}`,
      st
        ? `tracker ${st.status}   ${st.fps.toFixed(1)} fps   infer ${st.inferenceMs.toFixed(1)} ms   cam ${st.video?.width ?? '?'}x${st.video?.height ?? '?'}`
        : 'tracker not started',
      st?.raw ? `raw     ${st.raw.method}  x ${f(st.raw.x)}  y ${f(st.raw.y)}  z ${st.raw.z.toFixed(1)} cm` : 'raw     -',
      st?.neutral ? `neutral x ${f(st.neutral.x)}  y ${f(st.neutral.y)}  z ${st.neutral.z.toFixed(1)} cm` : 'neutral -',
      st ? `pose    x ${f(st.pose.x, 2)}  y ${f(st.pose.y, 2)}  z ${st.pose.z.toFixed(2)}` : '',
      `tuning  range ${config.tracking.lateralRangeCm}/${config.tracking.verticalRangeCm} cm  predict ${config.tracking.predictMs} ms  euro ${config.tracking.oneEuro.minCutoff}/${config.tracking.oneEuro.beta}`,
    ];
    app.overlay.setDebugText(lines.join('\n'));
  }, 200);
}

/** Inside a frame without `allow="camera"` getUserMedia is refused without a prompt; detect that up front. */
function cameraAllowedByPolicy(): boolean {
  type Policy = { allowsFeature(feature: string): boolean };
  const doc = document as Document & { featurePolicy?: Policy; permissionsPolicy?: Policy };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== 'function') return true;
  try {
    return policy.allowsFeature('camera');
  } catch {
    return true;
  }
}

/** A CSP without 'wasm-unsafe-eval' makes WebAssembly compilation throw synchronously. */
function wasmAllowed(): boolean {
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return true;
  } catch {
    return false;
  }
}

function safeStore(value: boolean): void {
  try {
    localStorage.setItem(config.tracking.storageKey, value ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function safeRead(): boolean | null {
  try {
    const v = localStorage.getItem(config.tracking.storageKey);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}
