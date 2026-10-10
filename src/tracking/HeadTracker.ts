import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { config } from '../config';
import { CENTER_POSE, type HeadPose, type InputSource, type PoseListener } from '../input/types';
import { OneEuroFilter } from './OneEuroFilter';

export type TrackerStatus = 'idle' | 'loading' | 'tracking' | 'lost' | 'denied' | 'error';
export type StatusListener = (status: TrackerStatus, detail?: string) => void;

const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;

/**
 * Webcam head tracker built on MediaPipe Face Landmarker.
 * Everything runs on-device; frames never leave the browser.
 */
export class HeadTracker implements InputSource {
  readonly name = 'head';
  private listeners = new Set<PoseListener>();
  private statusListeners = new Set<StatusListener>();
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private running = false;
  private rafHandle = 0;
  private vfcHandle = 0;
  private lastInferenceTs = 0;
  private lastSeenTs = 0;
  private lostEmitted = false;
  private status: TrackerStatus = 'idle';

  private fx = new OneEuroFilter(
    config.tracking.oneEuro.minCutoff,
    config.tracking.oneEuro.beta,
    config.tracking.oneEuro.dCutoff,
  );
  private fy = new OneEuroFilter(
    config.tracking.oneEuro.minCutoff,
    config.tracking.oneEuro.beta,
    config.tracking.oneEuro.dCutoff,
  );
  private fz = new OneEuroFilter(
    config.tracking.oneEuro.minCutoff * 0.6,
    config.tracking.oneEuro.beta,
    config.tracking.oneEuro.dCutoff,
  );

  private calibSamples: number[] = [];
  private baselineEyeDist: number | null = null;

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    );
  }

  onPose(listener: PoseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): TrackerStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.setStatus('loading');
    try {
      // Request the camera first: the permission prompt is the slow, user-facing step.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: config.tracking.video.width },
          height: { ideal: config.tracking.video.height },
          frameRate: { ideal: config.tracking.video.frameRate },
        },
      });
    } catch (err) {
      this.setStatus('denied', err instanceof Error ? err.message : String(err));
      throw err;
    }

    try {
      this.video = createHiddenVideo();
      this.video.srcObject = this.stream;
      await this.video.play();

      this.landmarker ??= await loadLandmarker();

      this.running = true;
      this.resetFilters();
      this.lastSeenTs = performance.now();
      this.lostEmitted = false;
      this.setStatus('lost');
      this.scheduleNext();
    } catch (err) {
      this.releaseCamera();
      this.setStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  stop(): void {
    if (!this.running && !this.stream) return;
    this.running = false;
    if (this.vfcHandle && this.video && 'cancelVideoFrameCallback' in this.video) {
      (this.video as HTMLVideoElement & { cancelVideoFrameCallback(h: number): void }).cancelVideoFrameCallback(
        this.vfcHandle,
      );
    }
    cancelAnimationFrame(this.rafHandle);
    this.releaseCamera();
    this.emit(CENTER_POSE);
    this.setStatus('idle');
  }

  /** Pause inference without releasing the camera (tab hidden etc.). */
  setPaused(paused: boolean): void {
    if (!this.stream) return;
    if (paused) {
      this.running = false;
      cancelAnimationFrame(this.rafHandle);
    } else if (!this.running) {
      this.running = true;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (!this.running || !this.video) return;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.vfcHandle = v.requestVideoFrameCallback(() => this.tick());
    } else {
      this.rafHandle = requestAnimationFrame(() => this.tick());
    }
  }

  private tick(): void {
    if (!this.running || !this.video || !this.landmarker) return;
    const now = performance.now();
    const minInterval = 1000 / config.tracking.maxFps;
    if (now - this.lastInferenceTs >= minInterval && this.video.readyState >= 2) {
      this.lastInferenceTs = now;
      let result: FaceLandmarkerResult | null = null;
      try {
        result = this.landmarker.detectForVideo(this.video, now);
      } catch (err) {
        console.warn('[HeadTracker] inference failed', err);
      }
      this.handleResult(result, now);
    }
    this.scheduleNext();
  }

  private handleResult(result: FaceLandmarkerResult | null, now: number): void {
    const face = result?.faceLandmarks?.[0];
    if (!face || face.length <= RIGHT_IRIS) {
      if (!this.lostEmitted && now - this.lastSeenTs > config.tracking.lostAfterMs) {
        this.lostEmitted = true;
        this.resetFilters();
        this.emit(CENTER_POSE);
        this.setStatus('lost');
      }
      return;
    }

    this.lastSeenTs = now;
    if (this.lostEmitted || this.status !== 'tracking') {
      this.lostEmitted = false;
      this.setStatus('tracking');
    }

    const l = face[LEFT_IRIS];
    const r = face[RIGHT_IRIS];
    const aspect = this.video ? this.video.videoWidth / Math.max(1, this.video.videoHeight) : 4 / 3;

    // Mid-point between the irises, normalised to [-1, 1] about the frame centre.
    const mx = (l.x + r.x) / 2;
    const my = (l.y + r.y) / 2;
    let nx = (mx - 0.5) * 2 * config.tracking.gainX;
    let ny = -(my - 0.5) * 2 * config.tracking.gainY;
    if (config.tracking.mirror) nx = -nx;

    // Depth from the apparent inter-ocular distance (aspect-corrected).
    const dx = (l.x - r.x) * aspect;
    const dy = l.y - r.y;
    const eyeDist = Math.hypot(dx, dy);
    let nz = 1;
    if (this.baselineEyeDist === null) {
      this.calibSamples.push(eyeDist);
      if (this.calibSamples.length >= config.tracking.calibrationFrames) {
        const sorted = [...this.calibSamples].sort((a, b) => a - b);
        this.baselineEyeDist = sorted[Math.floor(sorted.length / 2)];
      }
    } else if (eyeDist > 1e-4) {
      nz = this.baselineEyeDist / eyeDist;
    }

    nx = deadZone(nx, config.tracking.deadZone);
    ny = deadZone(ny, config.tracking.deadZone);

    const t = now / 1000;
    this.emit({
      x: clamp(this.fx.filter(nx, t), -1, 1),
      y: clamp(this.fy.filter(ny, t), -1, 1),
      z: clamp(this.fz.filter(nz, t), config.tracking.zMin, config.tracking.zMax),
      confidence: 1,
    });
  }

  private resetFilters(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
    this.calibSamples = [];
    this.baselineEyeDist = null;
  }

  private releaseCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
  }

  private emit(pose: HeadPose): void {
    for (const l of this.listeners) l(pose);
  }

  private setStatus(status: TrackerStatus, detail?: string): void {
    this.status = status;
    for (const l of this.statusListeners) l(status, detail);
  }
}

async function loadLandmarker(): Promise<FaceLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(config.tracking.wasmPath);
  const modelAssetPath = (await exists(config.tracking.modelPath))
    ? config.tracking.modelPath
    : config.tracking.modelFallbackUrl;

  const options = {
    baseOptions: { modelAssetPath, delegate: 'GPU' as const },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  };
  try {
    return await FaceLandmarker.createFromOptions(vision, options);
  } catch (err) {
    console.warn('[HeadTracker] GPU delegate failed, retrying on CPU', err);
    return FaceLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
  }
}

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

function createHiddenVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('aria-hidden', 'true');
  // Keep it in the DOM (some browsers throttle detached video) but out of sight.
  Object.assign(video.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    left: '-10px',
    top: '-10px',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(video);
  return video;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function deadZone(v: number, dz: number): number {
  if (Math.abs(v) < dz) return 0;
  return v - Math.sign(v) * dz;
}
