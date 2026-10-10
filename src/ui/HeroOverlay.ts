import type { TrackerStatus } from '../tracking/HeadTracker';

export type HeroState = 'booting' | 'loading' | 'ready' | 'tracking' | 'unsupported';

const STATUS_TEXT: Record<TrackerStatus, string> = {
  idle: 'Mouse mode. Enable the camera to use your head instead.',
  loading: 'Waking up the camera…',
  tracking: 'Tracking your head. Lean left, right, closer.',
  lost: 'Looking for a face… step into the frame.',
  denied: 'Camera blocked. Mouse mode it is.',
  error: 'Head tracking failed to start. Mouse mode it is.',
};

/** Thin DOM controller for the hero overlay (state attributes, loader, toggle). */
export class HeroOverlay {
  private root = must<HTMLElement>('#hero');
  private toggle = must<HTMLButtonElement>('#track-toggle');
  private toggleLabel = must<HTMLElement>('#track-toggle .track-toggle__label');
  private status = must<HTMLElement>('#track-status');
  private loaderFill = must<HTMLElement>('#loader-fill');
  private loaderText = must<HTMLElement>('#loader-text');

  setState(state: HeroState): void {
    this.root.dataset.state = state;
  }

  /** @param note shown instead of the toggle when tracking cannot work in this context. */
  setTrackingSupported(supported: boolean, note?: string): void {
    this.root.dataset.trackingSupported = String(supported);
    if (!supported && note) {
      this.root.dataset.trackingNote = 'true';
      this.status.textContent = note;
    } else {
      delete this.root.dataset.trackingNote;
    }
  }

  setProgress(fraction: number): void {
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    this.loaderFill.style.width = `${pct}%`;
    this.loaderText.textContent = pct < 100 ? `Loading something boring… ${pct}%` : 'Almost there.';
  }

  setLoaderMessage(text: string): void {
    this.loaderText.textContent = text;
  }

  onToggle(handler: () => void): void {
    this.toggle.addEventListener('click', handler);
  }

  setTrackerStatus(status: TrackerStatus, detail?: string): void {
    const on = status === 'tracking' || status === 'lost' || status === 'loading';
    this.toggle.setAttribute('aria-pressed', String(on));
    this.toggle.dataset.status = status;
    this.toggle.disabled = status === 'loading';
    this.toggleLabel.textContent = on ? 'Stop looking' : 'Look through the window';
    this.status.textContent = STATUS_TEXT[status];
    if (detail) this.status.title = detail;
  }
}

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}
