import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { config } from '../config';
import { CENTER_POSE, type HeadPose, type InputSource, type PoseListener } from '../input/types';
import { OneEuroFilter } from './OneEuroFilter';

export type TrackerStatus = 'idle' | 'loading' | 'calibrating' | 'tracking' | 'lost' | 'denied' | 'error';
export type StatusListener = (status: TrackerStatus, detail?: string) => void;
export type EstimationMethod = 'matrix' | 'landmarks';

/** Metric estimate of the head position in camera space: x image-right, y up, z distance (all cm). */
export interface HeadSample {
  x: number;
  y: number;
  z: number;
  t: number;
  method: EstimationMethod;
}

export interface TrackerStats {
  status: TrackerStatus;
  fps: number;
  inferenceMs: number;
  raw: HeadSample | null;
  neutral: { x: number; y: number; z: number } | null;
  pose: HeadPose;
  video: { width: number; height: number } | null;
}

// Face mesh indices (478-point topology with iris refinement).
const EYE_CORNERS = [33, 133, 362, 263] as const;
const LEFT_IRIS = { h: [469, 471], v: [470, 472] } as const;
const RIGHT_IRIS = { h: [474, 476], v: [475, 477] } as const;
const MIN_LANDMARKS = 478;

/**
 * Webcam head tracker built on MediaPipe Face Landmarker.
 *
 * Position is estimated in centimetres (facial transformation matrix by default, pinhole + iris
 * size as a fallback), made relative to an automatically captured neutral pose, normalised to the
 * configured travel range and smoothed with a One Euro filter. Everything runs on-device.
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
  private status: TrackerStatus = 'idle';

  private lastInferenceTs = 0;
  private lastSeenTs = 0;
  private lostEmitted = false;
  private lostSince = 0;

  private calibration: HeadSample[] = [];
  private neutral: { x: number; y: number; z: number } | null = null;
  private lastSample: HeadSample | null = null;
  private lastPose: HeadPose = { ...CENTER_POSE };
  private fpsEma = 0;
  private inferEma = 0;

  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private fz: OneEuroFilter;

  constructor() {
    const { minCutoff, beta, dCutoff } = config.tracking.oneEuro;
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
    // Depth is noisier than lateral position: smooth it a little harder.
    this.fz = new OneEuroFilter(minCutoff * 0.6, beta * 0.5, dCutoff);
  }

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

  getStats(): TrackerStats {
    return {
      status: this.status,
      fps: this.fpsEma,
      inferenceMs: this.inferEma,
      raw: this.lastSample,
      neutral: this.neutral,
      pose: this.lastPose,
      video: this.video ? { width: this.video.videoWidth, height: this.video.videoHeight } : null,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.setStatus('loading');
    const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    const wanted = coarse ? config.tracking.mobileVideo : config.tracking.video;
    try {
      // Request the camera first: the permission prompt is the slow, user-facing step.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: wanted.width },
          height: { ideal: wanted.height },
          frameRate: { ideal: wanted.frameRate },
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
      this.recalibrate(false);
      this.lastSeenTs = performance.now();
      this.lostEmitted = false;
      this.lostSince = 0;
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

  /** Forget the neutral pose; the next frames define a new "looking straight at the screen". */
  recalibrate(announce = true): void {
    this.calibration = [];
    this.neutral = null;
    this.lastSample = null;
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
    this.emit(CENTER_POSE);
    if (announce && this.running) this.setStatus('calibrating');
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
    if (now - this.lastInferenceTs >= minInterval - 1 && this.video.readyState >= 2) {
      if (this.lastInferenceTs) {
        const inst = 1000 / (now - this.lastInferenceTs);
        this.fpsEma = this.fpsEma ? this.fpsEma * 0.9 + inst * 0.1 : inst;
      }
      this.lastInferenceTs = now;
      let result: FaceLandmarkerResult | null = null;
      try {
        result = this.landmarker.detectForVideo(this.video, now);
      } catch (err) {
        console.warn('[HeadTracker] inference failed', err);
      }
      const cost = performance.now() - now;
      this.inferEma = this.inferEma ? this.inferEma * 0.9 + cost * 0.1 : cost;
      this.handleResult(result, now);
    }
    this.scheduleNext();
  }

  private handleResult(result: FaceLandmarkerResult | null, now: number): void {
    const sample = result ? this.estimate(result, now) : null;

    if (!sample) {
      if (!this.lostEmitted && now - this.lastSeenTs > config.tracking.lostAfterMs) {
        this.lostEmitted = true;
        this.lostSince = now;
        this.fx.reset();
        this.fy.reset();
        this.fz.reset();
        this.lastSample = null;
        this.emit(CENTER_POSE);
        this.setStatus('lost');
      }
      return;
    }

    // Glitch rejection: a face cannot teleport between consecutive frames.
    if (this.lastSample && now - this.lastSample.t < 200) {
      const jump = Math.hypot(sample.x - this.lastSample.x, sample.y - this.lastSample.y, sample.z - this.lastSample.z);
      if (jump > config.tracking.maxJumpCm) return;
    }

    if (this.lostEmitted) {
      this.lostEmitted = false;
      // Away for long enough that the viewer probably sat down somewhere else: re-centre.
      if (this.neutral && now - this.lostSince > config.tracking.recalibrateAfterLostMs) this.recalibrate(false);
    }
    this.lastSeenTs = now;
    this.lastSample = sample;

    if (!this.neutral) {
      this.calibration.push(sample);
      if (this.status !== 'calibrating') this.setStatus('calibrating');
      if (this.calibration.length < config.tracking.calibrationFrames) return;
      this.neutral = {
        x: median(this.calibration.map((s) => s.x)),
        y: median(this.calibration.map((s) => s.y)),
        z: median(this.calibration.map((s) => s.z)),
      };
      this.calibration = [];
    }
    if (this.status !== 'tracking') this.setStatus('tracking');

    const t = config.tracking;
    let nx = (sample.x - this.neutral.x) / t.lateralRangeCm;
    if (t.mirror) nx = -nx;
    let ny = (sample.y - this.neutral.y) / t.verticalRangeCm;
    const nz = sample.z / Math.max(1, this.neutral.z);

    nx = deadZone(nx, t.deadZone);
    ny = deadZone(ny, t.deadZone);

    const ts = now / 1000;
    this.lastPose = {
      x: clamp(this.fx.filter(nx, ts), -1, 1),
      y: clamp(this.fy.filter(ny, ts), -1, 1),
      z: clamp(this.fz.filter(nz, ts), t.zMin, t.zMax),
      confidence: 1,
    };
    this.emit(this.lastPose);
  }

  /** Metric head position from the landmarker output. */
  private estimate(result: FaceLandmarkerResult, now: number): HeadSample | null {
    const face = result.faceLandmarks?.[0];
    if (!face || face.length < MIN_LANDMARKS || !this.video) return null;

    if (config.tracking.method === 'matrix') {
      // Column-major 4x4 pose of the canonical face model in camera space; translation in cm.
      const m = result.facialTransformationMatrixes?.[0]?.data;
      if (m && m.length === 16) {
        const x = m[12];
        const y = m[13];
        const z = Math.abs(m[14]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && z > 5 && z < 400) {
          return { x, y, z, t: now, method: 'matrix' };
        }
      }
    }

    // Fallback: pinhole camera with an assumed field of view, scaled by the near-constant human iris.
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    if (!W || !H) return null;
    const f = W / 2 / Math.tan((config.tracking.assumedHfovDeg * Math.PI) / 360);
    const px = (i: number) => ({ x: face[i].x * W, y: face[i].y * H });
    const dist = (a: number, b: number) => {
      const p = px(a);
      const q = px(b);
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    const dl = (dist(LEFT_IRIS.h[0], LEFT_IRIS.h[1]) + dist(LEFT_IRIS.v[0], LEFT_IRIS.v[1])) / 2;
    const dr = (dist(RIGHT_IRIS.h[0], RIGHT_IRIS.h[1]) + dist(RIGHT_IRIS.v[0], RIGHT_IRIS.v[1])) / 2;
    const diam = Math.max(dl, dr); // the eye facing the camera more squarely reads larger
    if (diam < 2) return null;
    const z = (f * config.tracking.irisDiameterCm) / diam;

    let mx = 0;
    let my = 0;
    for (const i of EYE_CORNERS) {
      const p = px(i);
      mx += p.x / EYE_CORNERS.length;
      my += p.y / EYE_CORNERS.length;
    }
    return {
      x: ((mx - W / 2) * z) / f,
      y: (-(my - H / 2) * z) / f,
      z,
      t: now,
      method: 'landmarks',
    };
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
    this.lastPose = pose;
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
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function deadZone(v: number, dz: number): number {
  if (Math.abs(v) < dz) return 0;
  return v - Math.sign(v) * dz;
}
