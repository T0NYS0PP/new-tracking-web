import './styles/hero.css';
import type { SplatFileType } from '@sparkjsdev/spark';
import { config } from './config';
import { HeroOverlay } from './ui/HeroOverlay';
import { bootHero, checkPlatform, reportBootFailure } from './app/bootHero';

const overlay = new HeroOverlay();
const canvas = document.querySelector<HTMLCanvasElement>('#hero-canvas');
if (!canvas) throw new Error('Missing #hero-canvas');

if (checkPlatform(overlay)) {
  // Hosts may override the asset location via data attributes on the canvas (see scripts/build-artifact.mjs).
  bootHero({
    canvas,
    overlay,
    splatUrl: canvas.dataset.splat ?? config.splat.url,
    splatType: canvas.dataset.splatType as SplatFileType | undefined,
  }).catch((err: unknown) => reportBootFailure(overlay, err));
}
