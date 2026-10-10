import { config } from '../config';
import { CENTER_POSE, type HeadPose, type InputSource, type PoseListener } from './types';

/** Mouse / touch fallback: maps pointer position over the viewport to a head pose. */
export class PointerInput implements InputSource {
  readonly name = 'pointer';
  private listeners = new Set<PoseListener>();
  private idleTimer: number | undefined;
  private active = false;

  constructor(private target: HTMLElement = document.documentElement) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.target.addEventListener('pointermove', this.onMove, { passive: true });
    this.target.addEventListener('pointerleave', this.onLeave, { passive: true });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.target.removeEventListener('pointermove', this.onMove);
    this.target.removeEventListener('pointerleave', this.onLeave);
    window.clearTimeout(this.idleTimer);
    this.emit(CENTER_POSE);
  }

  onPose(listener: PoseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onMove = (e: PointerEvent): void => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = -((e.clientY / window.innerHeight) * 2 - 1);
    this.emit({
      x: clamp(nx * config.pointer.gain),
      y: clamp(ny * config.pointer.gain),
      z: 1,
      confidence: 1,
    });
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.emit(CENTER_POSE), config.pointer.idleAfterMs);
  };

  private onLeave = (): void => {
    window.clearTimeout(this.idleTimer);
    this.emit(CENTER_POSE);
  };

  private emit(pose: HeadPose): void {
    for (const l of this.listeners) l(pose);
  }
}

function clamp(v: number, lo = -1, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}
