/** Resolve a public/ asset against the page URL (works with Vite's relative base and in workers). */
export function assetUrl(path: string): string {
  return new URL(import.meta.env.BASE_URL + path, document.baseURI).href;
}

/** All tunables for the hero in one place. Numbers are world units unless stated. */
export const config = {
  splat: {
    /** Served from public/splats (downloaded by `npm run assets`). */
    url: assetUrl('splats/hero.spz'),
    /** Orientation / placement of the loaded splat inside the scene. */
    position: [0, -0.3, -0.6] as [number, number, number],
    /** Euler XYZ in radians. Many .ply captures are y-down and need a [Math.PI, 0, 0] flip; the sample .spz does not. */
    rotation: [0, 0, 0] as [number, number, number],
    scale: 1,
  },

  camera: {
    /** Virtual "window" size in world units at z = 0 (aspect is corrected at runtime). */
    windowWidth: 3.2,
    /** Baseline eye distance from the window plane. */
    baseDistance: 2.6,
    near: 0.05,
    far: 100,
    /** Lateral / vertical translation per unit of head offset (off-axis part). */
    kx: 0.6,
    ky: 0.4,
    /** Extra orbit around the pivot (exaggeration seen in the reference reel), in radians. */
    maxYaw: (20 * Math.PI) / 180,
    maxPitch: (10 * Math.PI) / 180,
    /** Point the orbit rotates around (world units, in front of the window plane). */
    pivot: [0, 0, -2.5] as [number, number, number],
    /** Depth response: how much z moves the eye toward / away from the window. */
    depthGain: 0.8,
    /** Smoothing toward the target pose (1 - e^(-dt * rate)) for pointer / tilt input. */
    smoothingRate: 10,
    /** The webcam pose is already filtered, so the camera follows it more tightly. */
    headSmoothingRate: 28,
    /** Pixel-ratio cap for performance. */
    maxPixelRatio: 1.5,
  },

  tracking: {
    wasmPath: assetUrl('mediapipe/wasm'),
    modelPath: assetUrl('mediapipe/face_landmarker.task'),
    /** Fallback if the model is not self-hosted. */
    modelFallbackUrl:
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    /** Higher input resolution gives the landmark crop more detail (desktop). */
    video: { width: 1280, height: 720, frameRate: 30 },
    mobileVideo: { width: 640, height: 480, frameRate: 30 },
    /** Upper bound for inference; decoupled from the render loop. */
    maxFps: 30,
    /**
     * How the metric head position is estimated:
     *  - 'matrix'    : MediaPipe's facial transformation matrix (whole-face fit, in cm). Default.
     *  - 'landmarks' : pinhole model from eye corners + iris size (needs assumedHfovDeg).
     */
    method: 'matrix' as 'matrix' | 'landmarks',
    /** Horizontal field of view assumed for the landmark fallback (typical laptop webcam 60-78°). */
    assumedHfovDeg: 65,
    /** Human iris diameter is remarkably constant; used for depth in the landmark fallback. */
    irisDiameterCm: 1.17,
    /** Head travel (relative to the neutral pose) that maps to the full ±1 range. */
    lateralRangeCm: 22,
    verticalRangeCm: 14,
    /** Mirror horizontal axis so moving right moves the view right. */
    mirror: true,
    /** Dead zone around centre (normalised units) to kill micro jitter. */
    deadZone: 0.01,
    /** One Euro filter parameters in normalised units per second. */
    oneEuro: { minCutoff: 1.0, beta: 0.4, dCutoff: 1.0 },
    /** Frames used to capture the neutral pose when tracking starts (median). */
    calibrationFrames: 20,
    /** Reject a frame whose estimate jumps more than this from the previous one (cm). */
    maxJumpCm: 40,
    /** Face lost for longer than this and found again → capture a fresh neutral pose. */
    recalibrateAfterLostMs: 5000,
    /** Extrapolate the filtered pose this far ahead to hide camera + inference latency. */
    predictMs: 70,
    /** Depth clamp. */
    zMin: 0.6,
    zMax: 1.6,
    /** Face lost → pose confidence 0 after this many ms. */
    lostAfterMs: 500,
    storageKey: 'hero.headTracking',
  },

  pointer: {
    gain: 1,
    /** Pointer idle → slowly return to centre after this many ms. */
    idleAfterMs: 2500,
  },

  orientation: {
    /** Degrees of device tilt mapped to ±1. */
    rangeDeg: 25,
  },
} as const;

export type Config = typeof config;
