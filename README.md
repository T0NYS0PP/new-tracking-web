# new-tracking-web — head-tracked Gaussian splat hero

A hero section where the screen behaves like a window: a 3D Gaussian splat scene
rendered with [Spark](https://github.com/sparkjsdev/spark) on three.js, with the
viewpoint driven by webcam head tracking ([MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)).
Mouse (desktop) and device tilt (phones) are the fallbacks. All face processing
happens in the browser; no frames leave the device.

Phase 1 scope: the hero section only. See `docs/hero-tech-requirements.md` (Japanese).

## Quick start

```bash
npm install          # also copies the MediaPipe WASM bundle into public/mediapipe/wasm
npm run assets       # downloads the face model + a sample .spz into public/ (not committed)
npm run dev          # http://localhost:5173
```

Head tracking needs a secure context: `localhost` is fine, anything else must be HTTPS.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck + production build into `dist/` |
| `npm run preview` | Serve `dist/` locally |
| `npm run assets` | Download `public/mediapipe/face_landmarker.task` and `public/splats/hero.spz` |
| `npm run typecheck` | `tsc --noEmit` |

## Making the scene in Unreal Engine

`docs/unreal-pipeline.md` (Japanese) walks through exporting a training dataset from an Unreal level with
`tools/unreal/ue_export_splat_dataset.py`, checking it with `node scripts/check-dataset.mjs <dir>`, training
a splat (PostShot or Nerfstudio), cleaning it in SuperSplat and dropping the `.spz` into the hero.

## Swapping in your own splat

1. Export a `.spz` or `.sog` (PlayCanvas SuperSplat can clean, crop and convert `.ply`).
2. Drop it in `public/splats/` and point `config.splat.url` at it in `src/config.ts`.
3. Adjust `config.splat.position / rotation / scale` so the scene sits in front of the window
   plane (z = 0). Many `.ply` captures are y-down and need `rotation: [Math.PI, 0, 0]`.
4. Tune `config.camera` (`windowWidth`, `baseDistance`, `maxYaw`, `maxPitch`, `kx`, `ky`) to taste.

## Project layout

```
src/
  main.ts                 entry: state machine, input switching, power management
  config.ts               every tunable in one place
  hero/HeroScene.ts       three.js + SparkRenderer + SplatMesh, resize, render loop
  camera/ViewerCamera.ts  head pose -> off-axis projection + pivot orbit
  tracking/HeadTracker.ts webcam + MediaPipe Face Landmarker -> normalised head pose (lazy-loaded)
  tracking/OneEuroFilter.ts
  input/PointerInput.ts   mouse / touch fallback
  input/OrientationInput.ts device tilt fallback (iOS asks permission on the toggle gesture)
  ui/HeroOverlay.ts       DOM overlay: loader, toggle, status, state attributes
  styles/hero.css
scripts/
  copy-mediapipe.mjs      postinstall: self-host the MediaPipe WASM bundle
  download-assets.mjs     fetch dev assets
```

## Deploying

**GitHub Pages (full experience, camera works).** `.github/workflows/deploy-pages.yml` builds the site
and publishes `dist/` on every push to the default branch. One-time setup in the repository:
Settings → Pages → Build and deployment → Source: **GitHub Actions**. The site then lives at
`https://t0nys0pp.github.io/new-tracking-web/`.

**claude.ai Artifact (preview, mouse parallax only).** `npm run build:artifact` writes
`dist-artifact/index.html` (a page fragment) and `dist-artifact/files.json` (supporting files). The artifact
viewer has no camera permission, so the page shows a note instead of the tracking toggle there.

The build uses a relative `base`, so the same `dist/` works at a domain root, under a sub-path, or
in the artifact viewer.

## Tuning head-tracking accuracy

The tracker estimates the head position in centimetres (MediaPipe's facial transformation matrix by
default, or a pinhole + iris-size model with `method: 'landmarks'`), subtracts a neutral pose captured
over the first frames (median), normalises by `lateralRangeCm` / `verticalRangeCm`, smooths with a One
Euro filter and lets the camera extrapolate `predictMs` ahead to hide sensor latency. Everything lives in
`config.tracking` in `src/config.ts`:

| Symptom | Knob |
|---|---|
| Too little / too much movement | `lateralRangeCm`, `verticalRangeCm` (smaller = more sensitive) |
| View inverted left/right | `mirror` |
| Jitter at rest | lower `oneEuro.minCutoff` (0.6–1.0) or raise `deadZone` |
| Feels laggy on fast moves | raise `oneEuro.beta` (0.3–1.0) or `predictMs` (50–100) |
| Overshoots / wobbles | lower `predictMs`, lower `camera.headSmoothingRate` |
| Neutral position feels off | press **R** or the Recenter button; `calibrationFrames` sets how long it samples |
| Depth too strong / weak | `camera.depthGain` |

Open the page with `?debug` (or `#debug`) to see the raw estimate, neutral pose, filtered pose, tracker
and render frame rates live.

## Debugging

`window.__hero` exposes `scene`, `pointer`, `switchTo`, `config` and `getTracker()` in the console.
`scene.stop()` then `scene.renderOnce()` renders single frames on demand.
