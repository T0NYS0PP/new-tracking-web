import { config } from '../config';
import { CENTER_POSE, type HeadPose, type InputSource, type PoseListener } from './types';

type OrientationEventCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

/** Device-tilt fallback for phones. iOS requires a user-gesture permission request. */
export class OrientationInput implements InputSource {
  readonly name = 'orientation';
  private listeners = new Set<PoseListener>();
  private active = false;
  private baseline: { beta: number; gamma: number } | null = null;

  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  async start(): Promise<void> {
    if (this.active) return;
    const ctor = DeviceOrientationEvent as OrientationEventCtor;
    if (typeof ctor.requestPermission === 'function') {
      const result = await ctor.requestPermission();
      if (result !== 'granted') throw new Error('Device orientation permission denied');
    }
    this.active = true;
    this.baseline = null;
    window.addEventListener('deviceorientation', this.onOrientation, { passive: true });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.emit(CENTER_POSE);
  }

  onPose(listener: PoseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    // First reading becomes the neutral orientation so the user can hold the phone however they like.
    if (!this.baseline) this.baseline = { beta: e.beta, gamma: e.gamma };
    const range = config.orientation.rangeDeg;
    const x = clamp((e.gamma - this.baseline.gamma) / range);
    const y = clamp(-(e.beta - this.baseline.beta) / range);
    this.emit({ x, y, z: 1, confidence: 1 });
  };

  private emit(pose: HeadPose): void {
    for (const l of this.listeners) l(pose);
  }
}

function clamp(v: number, lo = -1, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}
