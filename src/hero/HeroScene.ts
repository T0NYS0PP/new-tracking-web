import * as THREE from 'three';
import { SparkRenderer, SplatMesh, type SplatFileType } from '@sparkjsdev/spark';
import { config } from '../config';
import { ViewerCamera } from '../camera/ViewerCamera';
import type { PostFX } from '../fx/PostFX';

export interface HeroSceneEvents {
  onProgress?: (fraction: number) => void;
  onReady?: () => void;
  onError?: (err: unknown) => void;
}

export class HeroScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly viewer = new ViewerCamera();
  private spark: SparkRenderer;
  private splat: SplatMesh | null = null;
  private timer = new THREE.Timer();
  private running = false;
  private resizeObserver: ResizeObserver;
  private frameListeners = new Set<(dt: number, time: number) => void>();
  private elapsed = 0;
  private postFX: PostFX | null = null;

  static isSupported(): boolean {
    try {
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('webgl2');
    } catch {
      return false;
    }
  }

  constructor(
    private canvas: HTMLCanvasElement,
    private events: HeroSceneEvents = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x050505, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, config.camera.maxPixelRatio));

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    this.scene.add(this.viewer.orbit);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? document.body);
    this.resize();
  }

  /**
   * @param fileType forced when the host serves the splat under a foreign extension
   *                 (the artifact viewer only serves .wasm-style binaries, for instance).
   */
  async load(url = config.splat.url, fileType?: SplatFileType): Promise<void> {
    const s = config.splat;
    const mesh = new SplatMesh({
      url: new URL(url, document.baseURI).href,
      fileType,
      onProgress: (e) => {
        if (e.lengthComputable && e.total > 0) this.events.onProgress?.(e.loaded / e.total);
      },
    });
    mesh.position.fromArray(s.position);
    mesh.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
    mesh.scale.setScalar(s.scale);

    try {
      await mesh.initialized;
    } catch (err) {
      this.events.onError?.(err);
      throw err;
    }
    this.unload();
    this.splat = mesh;
    this.viewer.addContent(mesh);
    this.events.onProgress?.(1);
    this.events.onReady?.();
  }

  /** The splat currently in the scene, if any. */
  currentSplat(): SplatMesh | null {
    return this.splat;
  }

  /** Route rendering through a post-processing chain (null = plain render). */
  setPostFX(fx: PostFX | null): void {
    this.postFX = fx;
    if (fx) {
      const parent = this.canvas.parentElement ?? document.body;
      fx.setSize(Math.max(1, parent.clientWidth), Math.max(1, parent.clientHeight));
    }
  }

  getPostFX(): PostFX | null {
    return this.postFX;
  }

  elapsedTime(): number {
    return this.elapsed;
  }

  /** Remove and dispose the current splat (used when switching scenes). */
  unload(): void {
    if (!this.splat) return;
    this.viewer.orbit.remove(this.splat);
    this.splat.dispose();
    this.splat = null;
  }

  /** Called every rendered frame before the camera update. */
  onFrame(listener: (dt: number, time: number) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop(() => this.frame());
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.splat?.dispose();
    this.renderer.dispose();
  }

  /** Render a single frame on demand (used when the loop is stopped). */
  renderOnce(dt = 0): void {
    this.viewer.update(dt);
    this.draw();
  }

  private draw(): void {
    if (this.postFX) this.postFX.render(this.elapsed);
    else this.renderer.render(this.scene, this.viewer.camera);
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    this.elapsed += dt;
    for (const l of this.frameListeners) l(dt, this.elapsed);
    this.viewer.update(dt);
    this.draw();
  }

  private resize(): void {
    const parent = this.canvas.parentElement ?? document.body;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.viewer.resize(w, h);
    this.postFX?.setSize(w, h);
  }
}
