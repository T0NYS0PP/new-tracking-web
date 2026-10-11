import { assetUrl } from './config';

/** A black-and-white archive photograph converted to a depth splat (scripts/download-assets.mjs). */
export interface ArchivePhoto {
  id: string;
  title: string;
  year: string;
  /** Shown under the picture-in-picture; keep the attribution a licence asks for here. */
  credit: string;
  /** Where the original lives. */
  source: string;
  splat: string;
  image: string;
  /** Horizontal FOV the splat was converted with. */
  fovDeg: number;
  /** Strongest light (usually a window) in image coordinates 0..1 from the top-left, and how much it glows. */
  light: { x: number; y: number; rays: number; exposure?: number };
}

/** One camera pose of a shot. Every field is optional; unset fields read as the original framing. */
export interface RigKey {
  /** Image point (0..1 from the top-left) kept at the centre of the frame. [0.5, 0.5] = original framing. */
  focus?: [number, number];
  /** How far the scene slides toward the viewer (world units; the photo is ~1.8..7 deep). */
  zoom?: number;
  /** Turn of the scene around the viewer, degrees (positive = the scene turns to the viewer's right). */
  yaw?: number;
  /** Degrees (positive = look down). */
  pitch?: number;
}

export interface Shot {
  photo: string;
  /** Seconds on screen before the cut. */
  duration: number;
  from: RigKey;
  to: RigKey;
  /** Caption above the frame for this shot; null hides it. */
  caption: string | null;
  ease?: 'inOut' | 'in' | 'out' | 'linear';
}

const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${file}`;

/**
 * Public-domain photographs of Marie Curie's laboratory, Paris, 1900s–1920s (Wikimedia Commons).
 * `npm run assets` downloads and converts them; ids must match scripts/download-assets.mjs.
 */
export const PHOTOS: ArchivePhoto[] = [
  {
    id: 'curie-1912',
    title: 'Marie Curie in her Paris laboratory',
    year: '1912',
    credit: 'Wikimedia Commons · public domain',
    source: commons('Marie_Curie_in_her_Paris_Laboratory,_1912.jpg'),
    splat: assetUrl('splats/photos/curie-1912.spz'),
    image: assetUrl('photos/curie-1912.jpg'),
    fovDeg: 60,
    light: { x: 0.82, y: 0.2, rays: 0.8 },
  },
  {
    id: 'curie-lab',
    title: 'Marie Curie in her laboratory',
    year: 'c. 1900',
    credit: 'Wikimedia Commons · public domain',
    source: commons('Marie_Curie_in_her_laboratory.jpg'),
    splat: assetUrl('splats/photos/curie-lab.spz'),
    image: assetUrl('photos/curie-lab.jpg'),
    fovDeg: 60,
    light: { x: 0.7, y: 0.22, rays: 0.7 },
  },
  {
    id: 'curie-chair',
    title: 'Marie Curie on a chair in her laboratory',
    year: 'c. 1910s',
    credit: 'Wikimedia Commons · public domain',
    source: commons('Marie_Curie_on_a_chair_in_her_laboratory.jpg'),
    splat: assetUrl('splats/photos/curie-chair.spz'),
    image: assetUrl('photos/curie-chair.jpg'),
    fovDeg: 60,
    light: { x: 0.5, y: 0.2, rays: 0.9 },
  },
  {
    id: 'curie-laboratory',
    title: 'Marie Curie at work',
    year: 'c. 1920',
    credit: 'Wikimedia Commons · public domain',
    source: commons('Marie_Curie-Laboratory.jpg'),
    splat: assetUrl('splats/photos/curie-laboratory.spz'),
    image: assetUrl('photos/curie-laboratory.jpg'),
    fovDeg: 60,
    light: { x: 0.3, y: 0.2, rays: 0.7 },
  },
  {
    id: 'curies-wellcome',
    title: 'Marie and Pierre Curie in their laboratory',
    year: 'before 1906',
    credit: 'Wellcome Collection · CC BY 4.0',
    source: commons('Marie_and_Pierre_Curie_(centre)_in_their_laboratory,_Paris_Wellcome_V0030700.jpg'),
    splat: assetUrl('splats/photos/curies-wellcome.spz'),
    image: assetUrl('photos/curies-wellcome.jpg'),
    fovDeg: 60,
    light: { x: 0.5, y: 0.15, rays: 0.6 },
  },
];

export const POV_CAPTION = 'POV:\nYou are inside\nphotos from 1912';

/**
 * The reel: hard cuts, one slow camera move per shot. Moves follow the reference
 * (push in and drift, a close-up that pulls back to reveal the room, a gentle orbit, a truck).
 * Focus points stay near the centre and zoom stays <= 1.6 so the moves hold up on any composition
 * without per-photo tuning; tighten them once you have looked at the real photographs.
 */
export const SEQUENCE: Shot[] = [
  // Push in toward the bench while drifting to the right, like the opening shot.
  { photo: 'curie-1912', duration: 4.0, caption: POV_CAPTION, from: { zoom: 0 }, to: { focus: [0.55, 0.51], zoom: 1.0, yaw: -2 } },
  // Slow approach with a slight turn: the room sweeps past while the centre stays put.
  { photo: 'curie-lab', duration: 3.6, caption: POV_CAPTION, from: { zoom: 0.1, yaw: 3 }, to: { focus: [0.49, 0.49], zoom: 0.9, yaw: -1.5 } },
  // Start close on the centre of the frame and pull back to reveal where we are.
  { photo: 'curie-chair', duration: 3.6, caption: null, from: { focus: [0.5, 0.52], zoom: 1.6, pitch: 1.5 }, to: { focus: [0.5, 0.5], zoom: 0.5 } },
  // Orbit: the background slides behind the foreground.
  { photo: 'curie-laboratory', duration: 3.6, caption: null, from: { focus: [0.47, 0.5], zoom: 0.2, yaw: -4 }, to: { focus: [0.52, 0.5], zoom: 0.9, yaw: 2.5 } },
  // Truck left to right, closing in a little.
  { photo: 'curies-wellcome', duration: 3.8, caption: 'Look around —\nmove your head\n(or your mouse)', from: { focus: [0.45, 0.5], zoom: 0.4, pitch: 1 }, to: { focus: [0.55, 0.5], zoom: 1.0 } },
];

export function findPhoto(id: string | null | undefined): ArchivePhoto {
  return PHOTOS.find((p) => p.id === id) ?? PHOTOS[0];
}
