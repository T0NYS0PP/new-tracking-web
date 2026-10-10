/**
 * One Euro Filter (Casiez et al. 2012): low latency at speed, low jitter at rest.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.0,
    private dCutoff = 1.0,
  ) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  /** @param t timestamp in seconds */
  filter(x: number, t: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(1e-4, t - this.tPrev);
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    const dxHat = OneEuroFilter.lowpass(dx, this.dxPrev, OneEuroFilter.alpha(dt, this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const xHat = OneEuroFilter.lowpass(x, this.xPrev, OneEuroFilter.alpha(dt, cutoff));

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }

  private static alpha(dt: number, cutoff: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  private static lowpass(x: number, prev: number, a: number): number {
    return a * x + (1 - a) * prev;
  }
}
