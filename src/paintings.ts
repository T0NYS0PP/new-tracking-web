import { assetUrl } from './config';

export interface Painting {
  id: string;
  title: string;
  artist: string;
  year: string;
  splat: string;
  image: string;
  /** How far the scene slides toward the viewer during the walk (world units). */
  walkDepth: number;
  /** Horizontal FOV the splat was converted with (scripts/download-assets.mjs). */
  fovDeg: number;
  /** Light source in image coordinates (0..1 from the top-left) and how the frame is graded. */
  light: { x: number; y: number; rays: number; color: string; warmth: number; haze: [number, number, number]; exposure?: number };
}

/** Public-domain paintings converted with scripts/painting-to-splat.mjs (see scripts/download-assets.mjs). */
export const PAINTINGS: Painting[] = [
  {
    id: 'starry-night',
    title: 'The Starry Night',
    artist: 'Vincent van Gogh',
    year: '1889',
    splat: assetUrl('splats/paintings/starry-night.spz'),
    image: assetUrl('paintings/starry-night.jpg'),
    walkDepth: 1.8,
    fovDeg: 66,
    light: { x: 0.9, y: 0.1, rays: 1.0, color: '#ffe9a8', warmth: -0.1, haze: [0.55, 0.65, 0.9] },
  },
  {
    id: 'shipwreck',
    title: 'The Shipwreck',
    artist: 'J. M. W. Turner',
    year: '1805',
    splat: assetUrl('splats/paintings/shipwreck.spz'),
    image: assetUrl('paintings/shipwreck.jpg'),
    walkDepth: 2.2,
    fovDeg: 66,
    light: { x: 0.48, y: 0.18, rays: 1.25, color: '#ffcf8a', warmth: 0.35, haze: [0.8, 0.72, 0.55] },
  },
  {
    id: 'great-wave',
    title: 'The Great Wave off Kanagawa',
    artist: 'Katsushika Hokusai',
    year: 'c. 1831',
    splat: assetUrl('splats/paintings/great-wave.spz'),
    image: assetUrl('paintings/great-wave.jpg'),
    walkDepth: 2.2,
    fovDeg: 66,
    light: { x: 0.55, y: 0.12, rays: 0.6, color: '#fff2d6', warmth: 0.1, haze: [0.82, 0.8, 0.72], exposure: 1.04 },
  },
  {
    id: 'the-scream',
    title: 'The Scream',
    artist: 'Edvard Munch',
    year: '1893',
    splat: assetUrl('splats/paintings/the-scream.spz'),
    image: assetUrl('paintings/the-scream.jpg'),
    walkDepth: 1.8,
    fovDeg: 66,
    light: { x: 0.5, y: 0.08, rays: 1.1, color: '#ffb87a', warmth: 0.45, haze: [0.85, 0.6, 0.4], exposure: 1.14 },
  },
];

export function findPainting(id: string | null | undefined): Painting {
  return PAINTINGS.find((p) => p.id === id) ?? PAINTINGS[0];
}
