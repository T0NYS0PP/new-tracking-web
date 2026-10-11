import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export interface PostFXSettings {
  /** Screen-space light rays from the light position. */
  rays: { density: number; decay: number; weight: number; exposure: number; threshold: number; samples: number };
  bloom: { strength: number; radius: number; threshold: number };
  grade: { exposure: number; contrast: number; warmth: number; vignette: number; grain: number; haze: [number, number, number]; hazeAmount: number };
}

export const DEFAULT_FX: PostFXSettings = {
  rays: { density: 0.9, decay: 0.965, weight: 0.04, exposure: 0.4, threshold: 0.72, samples: 56 },
  bloom: { strength: 0.22, radius: 0.4, threshold: 0.82 },
  grade: { exposure: 0.98, contrast: 1.08, warmth: 0.12, vignette: 0.3, grain: 0.015, haze: [0.86, 0.78, 0.62], hazeAmount: 0.03 },
};

const RaysShader = {
  uniforms: {
    tDiffuse: { value: null },
    lightPos: { value: new THREE.Vector2(0.5, 0.5) },
    lightStrength: { value: 1 },
    density: { value: 0.9 },
    decay: { value: 0.965 },
    weight: { value: 0.045 },
    exposure: { value: 0.55 },
    threshold: { value: 0.55 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 lightPos;
    uniform float lightStrength, density, decay, weight, exposure, threshold, time;
    varying vec2 vUv;
    const int SAMPLES = 56;
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 toLight = vUv - lightPos;
      vec2 delta = toLight / float(SAMPLES) * density;
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        vec3 c = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        float l = luma(c);
        c *= smoothstep(threshold - 0.15, threshold + 0.25, l);
        acc += c * illum * weight;
        illum *= decay;
      }
      // Rays fade with distance from the light and shimmer very slightly.
      float dist = length(toLight * vec2(1.0, 0.6));
      float falloff = smoothstep(1.4, 0.0, dist);
      float shimmer = 0.92 + 0.08 * sin(time * 0.7 + vUv.x * 6.0) * sin(time * 0.45 + vUv.y * 5.0);
      gl_FragColor = vec4(base.rgb + acc * exposure * falloff * lightStrength * shimmer, base.a);
    }
  `,
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    exposure: { value: 1.0 },
    contrast: { value: 1.0 },
    warmth: { value: 0.0 },
    vignette: { value: 0.3 },
    grain: { value: 0.02 },
    haze: { value: new THREE.Vector3(0.86, 0.78, 0.62) },
    hazeAmount: { value: 0.05 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float exposure, contrast, warmth, vignette, grain, hazeAmount, time;
    uniform vec3 haze;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * exposure;
      // Lift the shadows toward the haze colour (aerial perspective, film fog).
      c = mix(c, haze, hazeAmount * (1.0 - smoothstep(0.0, 0.6, dot(c, vec3(0.333)))));
      // Warm / cool tint.
      c *= vec3(1.0 + 0.06 * warmth, 1.0 + 0.015 * warmth, 1.0 - 0.07 * warmth);
      // Gentle S-curve contrast around mid grey.
      c = (c - 0.5) * contrast + 0.5;
      // Vignette.
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.85);
      c *= 1.0 - vignette * smoothstep(0.35, 1.05, length(d) * 1.6);
      // Fine grain.
      c += (hash(vUv * 1024.0 + fract(time)) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Light rays + bloom + grade on top of the splat render. Built on three's EffectComposer, so
 * the splats are rendered once into a render target and the passes work in screen space.
 */
export class PostFX {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private rays: ShaderPass;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private settings: PostFXSettings;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    settings: PostFXSettings = DEFAULT_FX,
  ) {
    this.settings = settings;
    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.rays = new ShaderPass(RaysShader);
    this.bloom = new UnrealBloomPass(size, settings.bloom.strength, settings.bloom.radius, settings.bloom.threshold);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.rays);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.apply(settings);
  }

  apply(settings: Partial<PostFXSettings>): void {
    this.settings = { ...this.settings, ...settings };
    const { rays, bloom, grade } = this.settings;
    const ru = this.rays.uniforms;
    ru.density.value = rays.density;
    ru.decay.value = rays.decay;
    ru.weight.value = rays.weight;
    ru.exposure.value = rays.exposure;
    ru.threshold.value = rays.threshold;
    this.bloom.strength = bloom.strength;
    this.bloom.radius = bloom.radius;
    this.bloom.threshold = bloom.threshold;
    const gu = this.grade.uniforms;
    gu.exposure.value = grade.exposure;
    gu.contrast.value = grade.contrast;
    gu.warmth.value = grade.warmth;
    gu.vignette.value = grade.vignette;
    gu.grain.value = grade.grain;
    gu.haze.value.set(grade.haze[0], grade.haze[1], grade.haze[2]);
    gu.hazeAmount.value = grade.hazeAmount;
  }

  /** Light position in screen UV (0..1) and a strength multiplier (0 hides the rays). */
  setLight(uv: THREE.Vector2Like, strength = 1): void {
    this.rays.uniforms.lightPos.value.set(uv.x, uv.y);
    this.rays.uniforms.lightStrength.value = strength;
  }

  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
  }

  render(time: number): void {
    this.rays.uniforms.time.value = time;
    this.grade.uniforms.time.value = time;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    void this.renderer;
  }
}
