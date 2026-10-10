import './styles/hero.css';
import { config } from './config';
import { HeroScene } from './hero/HeroScene';
import { PointerInput } from './input/PointerInput';
import { OrientationInput } from './input/OrientationInput';
import { CENTER_POSE, type HeadPose, type InputSource } from './input/types';
import { HeroOverlay } from './ui/HeroOverlay';
import type { HeadTracker } from './tracking/HeadTracker';
import type { SplatFileType } from '@sparkjsdev/spark';

const overlay = new HeroOverlay();
const canvas = document.querySelector<HTMLCanvasElement>('#hero-canvas');
if (!canvas) throw new Error('Missing #hero-canvas');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const cameraApiAvailable =
  window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function';
const cameraAllowed = cameraApiAvailable && cameraAllowedByPolicy();
const trackerSupported = cameraAllowed;
const TRACKING_NOTE = cameraApiAvailable
  ? 'Head tracking needs the camera, which this embedded view cannot use. Open the standalone page to try it.'
  : 'Head tracking needs a camera over HTTPS. Mouse mode only here.';

if (!HeroScene.isSupported()) {
  overlay.setState('unsupported');
  overlay.setTrackingSupported(false);
  overlay.setLoaderMessage('WebGL2 is not available. Enjoy the poster instead.');
} else if (!wasmAllowed()) {
  overlay.setState('unsupported');
  overlay.setTrackingSupported(false);
  overlay.setLoaderMessage('This host blocks WebAssembly, which the splat renderer needs. Open the standalone page.');
} else {
  boot(canvas).catch((err: unknown) => {
    console.error('[hero] boot failed', err);
    overlay.setState('unsupported');
    const msg = err instanceof Error ? err.message : String(err);
    overlay.setLoaderMessage(`The window would not open (${msg.slice(0, 120)}). Refresh to try again.`);
  });
}

async function boot(canvas: HTMLCanvasElement): Promise<void> {
  overlay.setState('loading');
  overlay.setTrackingSupported(trackerSupported, trackerSupported ? undefined : TRACKING_NOTE);

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
    scene.viewer.setTarget(latest[source.name] ?? CENTER_POSE);
  };
  const fallbackSource = () => (orientation && latest[orientation.name] ? orientation : pointer);

  pointer.onPose(feed(pointer));
  orientation?.onPose(feed(orientation));
  await pointer.start();

  // Android fires deviceorientation without permission; iOS needs a gesture (handled in the toggle).
  orientation?.start().then(() => switchTo(orientation)).catch(() => {});

  /** MediaPipe (≈2 MB of JS + WASM + model) is only fetched after the user opts in. */
  const getTracker = async (): Promise<HeadTracker> => {
    if (tracker) return tracker;
    const { HeadTracker } = await import('./tracking/HeadTracker');
    tracker = new HeadTracker();
    tracker.onPose(feed(tracker));
    tracker.onStatus((status, detail) => {
      overlay.setTrackerStatus(status, detail);
      if (status === 'tracking' || status === 'lost') {
        if (splatReady) overlay.setState('tracking');
        switchTo(tracker!);
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
      // On iOS the same gesture can unlock device orientation as a secondary fallback.
      orientation?.start().catch(() => {});
      const t = await getTracker();
      await t.start();
      safeStore(true);
    } catch {
      /* the status listener already reflected the failure */
      if (!tracker) overlay.setTrackerStatus('error');
    }
  };

  if (trackerSupported) {
    overlay.setTrackerStatus('idle');
    overlay.onToggle(() => {
      const s = tracker?.getStatus() ?? 'idle';
      if (s === 'idle' || s === 'denied' || s === 'error') {
        void startTracking();
      } else {
        tracker?.stop();
        safeStore(false);
      }
    });
  }

  // Debug handle (used by the headless smoke test and handy in DevTools).
  (window as unknown as { __hero: unknown }).__hero = { scene, pointer, switchTo, config, getTracker };

  // --- Splat ---
  // Hosts may override the asset location via data attributes on the canvas (see scripts/build-artifact.mjs).
  const splatUrl = canvas.dataset.splat ?? config.splat.url;
  const splatType = canvas.dataset.splatType as SplatFileType | undefined;
  try {
    await scene.load(splatUrl, splatType);
  } catch {
    overlay.setLoaderMessage('Could not load the scene. Run `npm run assets` and refresh.');
    return;
  }
  splatReady = true;
  const s = (tracker as HeadTracker | null)?.getStatus(); // assigned inside closures; TS narrows to null here
  overlay.setState(s === 'tracking' || s === 'lost' ? 'tracking' : 'ready');

  // Returning visitors who opted in before: resume on their first interaction (still a gesture, never an auto prompt).
  if (trackerSupported && safeRead() === true) {
    const resume = () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      void startTracking();
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  // --- Power management: pause inference + rendering when hidden or scrolled away ---
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
    // Smallest valid module: magic + version.
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
