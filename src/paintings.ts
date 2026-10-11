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
  },
  {
    id: 'shipwreck',
    title: 'The Shipwreck',
    artist: 'J. M. W. Turner',
    year: '1805',
    splat: assetUrl('splats/paintings/shipwreck.spz'),
    image: assetUrl('paintings/shipwreck.jpg'),
    walkDepth: 2.2,
  },
  {
    id: 'great-wave',
    title: 'The Great Wave off Kanagawa',
    artist: 'Katsushika Hokusai',
    year: 'c. 1831',
    splat: assetUrl('splats/paintings/great-wave.spz'),
    image: assetUrl('paintings/great-wave.jpg'),
    walkDepth: 2.2,
  },
  {
    id: 'the-scream',
    title: 'The Scream',
    artist: 'Edvard Munch',
    year: '1893',
    splat: assetUrl('splats/paintings/the-scream.spz'),
    image: assetUrl('paintings/the-scream.jpg'),
    walkDepth: 1.8,
  },
];

export function findPainting(id: string | null | undefined): Painting {
  return PAINTINGS.find((p) => p.id === id) ?? PAINTINGS[0];
}
