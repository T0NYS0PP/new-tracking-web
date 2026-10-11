import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export interface PostFXSettings {
  /** Screen-space light rays from the light position (crepuscular rays). */
  rays: { density: number; decay: number; weight: number; exposure: number; threshold: number; flicker: number };
  /** Big soft glow around the light and light-lit haze in front of the scene. */
  sun: { glow: number; radius: number; haze: number; color: [number, number, number] };
  /** Highlight bloom. */
  bloom: { strength: number; radius: number; threshold: number };
  /** Low-threshold bloom used as soft-focus diffusion over the whole frame. */
  diffusion: { strength: number; radius: number; threshold: number };
  grade: {
    exposure: number;
    contrast: number;
    warmth: number;
    vignette: number;
    grain: number;
    haze: [number, number, number];
    hazeAmount: number;
    /** Split toning: highlights toward the sun colour, shadows toward this colour. */
    shadowTint: [number, number, number];
    splitTone: number;
    saturation: number;
  };
}

export type FXPresetName = 'cinematic' | 'soft' | 'archival';

const SUN: [number, number, number] = [1.0, 0.86, 0.6];
const DAYLIGHT: [number, number, number] = [1.0, 1.0, 1.0];

export const FX_PRESETS: Record<FXPresetName, PostFXSettings> = {
  // Ray energy is bounded: weight * (1 - decay^64) / (1 - decay) * exposure ≈ 0.56 when every
  // sample along the march is fully bright, so bright skies glow instead of clipping to white.
  cinematic: {
    rays: { density: 1.0, decay: 0.975, weight: 0.025, exposure: 0.6, threshold: 0.62, flicker: 0.12 },
    sun: { glow: 0.22, radius: 0.32, haze: 0.08, color: SUN },
    bloom: { strength: 0.28, radius: 0.5, threshold: 0.78 },
    diffusion: { strength: 0.1, radius: 0.9, threshold: 0.4 },
    grade: {
      exposure: 1.0,
      contrast: 1.14,
      warmth: 0.2,
      vignette: 0.4,
      grain: 0.02,
      haze: [0.86, 0.78, 0.62],
      hazeAmount: 0.02,
      shadowTint: [0.35, 0.45, 0.65],
      splitTone: 0.14,
      saturation: 1.05,
    },
  },
  soft: {
    rays: { density: 0.9, decay: 0.965, weight: 0.02, exposure: 0.4, threshold: 0.72, flicker: 0.06 },
    sun: { glow: 0.12, radius: 0.35, haze: 0.06, color: SUN },
    bloom: { strength: 0.22, radius: 0.4, threshold: 0.82 },
    diffusion: { strength: 0.0, radius: 0.8, threshold: 0.3 },
    grade: {
      exposure: 0.98,
      contrast: 1.08,
      warmth: 0.12,
      vignette: 0.3,
      grain: 0.015,
      haze: [0.86, 0.78, 0.62],
      hazeAmount: 0.03,
      shadowTint: [0.35, 0.45, 0.65],
      splitTone: 0.08,
      saturation: 1.0,
    },
  },
  // Black-and-white archive photographs: no colour work at all, the windows blow out into a soft
  // white glow (bloom + a little diffusion), heavier vignette and visible grain like a scanned print.
  archival: {
    rays: { density: 0.8, decay: 0.96, weight: 0.018, exposure: 0.3, threshold: 0.8, flicker: 0.04 },
    sun: { glow: 0.1, radius: 0.3, haze: 0.05, color: DAYLIGHT },
    bloom: { strength: 0.5, radius: 0.6, threshold: 0.72 },
    diffusion: { strength: 0.14, radius: 1.0, threshold: 0.45 },
    grade: {
      exposure: 1.0,
      contrast: 1.12,
      warmth: 0,
      vignette: 0.5,
      grain: 0.045,
      haze: [0.6, 0.6, 0.6],
      hazeAmount: 0.03,
      shadowTint: [1, 1, 1],
      splitTone: 0,
      saturation: 0,
    },
  },
};

export const DEFAULT_FX: PostFXSettings = FX_PRESETS.cinematic;

const LightShader = {
  uniforms: {
    tDiffuse: { value: null },
    lightPos: { value: new THREE.Vector2(0.5, 0.5) },
    lightStrength: { value: 1 },
    aspect: { value: 1.6 },
    density: { value: 1.0 },
    decay: { value: 0.972 },
    weight: { value: 0.06 },
    exposure: { value: 0.85 },
    threshold: { value: 0.58 },
    flicker: { value: 0.14 },
    sunColor: { value: new THREE.Vector3(1.0, 0.86, 0.6) },
    glow: { value: 0.55 },
    glowRadius: { value: 0.42 },
    sunHaze: { value: 0.28 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 lightPos;
    uniform float lightStrength, aspect, density, decay, weight, exposure, threshold, flicker, glow, glowRadius, sunHaze, time;
    uniform vec3 sunColor;
    varying vec2 vUv;
    const int SAMPLES = 64;
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = base.rgb;

      // Slow "wind through the leaves" modulation shared by rays and glow.
      float breathe = 1.0
        + flicker * sin(time * 0.9) * sin(time * 0.37 + 1.7)
        + flicker * 0.6 * sin(time * 2.3 + 0.5) * sin(time * 0.61);

      // --- Crepuscular rays: march from this pixel toward the light, accumulating bright pixels.
      vec2 toLight = vUv - lightPos;
      vec2 delta = toLight / float(SAMPLES) * density;
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < SAMPLES; i++) {
        uv -= delta;
        vec3 c = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        float l = luma(c);
        c *= smoothstep(threshold - 0.18, threshold + 0.22, l);
        acc += c * illum * weight;
        illum *= decay;
      }
      float dist = length(toLight * vec2(aspect, 1.0)) / aspect;
      float falloff = smoothstep(1.6, 0.0, dist);
      float shimmer = 0.9 + 0.1 * sin(time * 0.7 + vUv.x * 6.0) * sin(time * 0.45 + vUv.y * 5.0);
      col += acc * mix(vec3(1.0), sunColor, 0.6) * exposure * falloff * lightStrength * shimmer * breathe;

      // --- Sun glow: a wide, warm, additive halo around the light (blown-out backlight).
      float g = exp(-(dist * dist) / (glowRadius * glowRadius));
      col += sunColor * glow * g * lightStrength * breathe;

      // --- Lit haze: light scattering in the air lifts everything near the sun toward its colour,
      // strongest in darker pixels so it reads as fog rather than extra brightness.
      float h = exp(-(dist * dist) / (0.55 * 0.55)) * sunHaze * lightStrength;
      col = mix(col, max(col, sunColor * 0.85), h * (1.0 - smoothstep(0.0, 0.8, luma(col))));

      gl_FragColor = vec4(col, base.a);
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
    hazeAmount: { value: 0.04 },
    highlightTint: { value: new THREE.Vector3(1.0, 0.86, 0.6) },
    shadowTint: { value: new THREE.Vector3(0.35, 0.45, 0.65) },
    splitTone: { value: 0.2 },
    saturation: { value: 1.0 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float exposure, contrast, warmth, vignette, grain, hazeAmount, splitTone, saturation, time;
    uniform vec3 haze, highlightTint, shadowTint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * exposure;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      // Shadow lift toward the haze colour (film fog / aerial perspective).
      c = mix(c, haze, hazeAmount * (1.0 - smoothstep(0.0, 0.6, l)));
      // Split toning: warm highlights, cool shadows.
      c = mix(c, c * shadowTint * 1.6, splitTone * (1.0 - smoothstep(0.1, 0.55, l)));
      c = mix(c, c * highlightTint * 1.1, splitTone * smoothstep(0.45, 0.95, l));
      // Global warm / cool tint.
      c *= vec3(1.0 + 0.06 * warmth, 1.0 + 0.015 * warmth, 1.0 - 0.07 * warmth);
      // Saturation.
      float l2 = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l2), c, saturation);
      // Gentle S-curve contrast around mid grey.
      c = (c - 0.5) * contrast + 0.5;
      // Filmic shoulder: everything above the knee rolls off toward white instead of clipping.
      const float knee = 0.62;
      vec3 over = max(c - knee, 0.0);
      c = min(c, knee) + (1.0 - knee) * (1.0 - exp(-over / (1.0 - knee)));
      // Vignette.
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.85);
      c *= 1.0 - vignette * smoothstep(0.3, 1.05, length(d) * 1.6);
      // Fine grain.
      c += (hash(vUv * 1024.0 + fract(time)) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Cinematic light on top of the splat render: crepuscular rays, sun glow and lit haze, highlight
 * bloom, soft-focus diffusion and a grade. Built on three's EffectComposer: the splats render once
 * into a render target and every pass works in screen space.
 */
export class PostFX {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private light: ShaderPass;
  private bloom: UnrealBloomPass;
  private diffusion: UnrealBloomPass;
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
    this.light = new ShaderPass(LightShader);
    this.bloom = new UnrealBloomPass(size, settings.bloom.strength, settings.bloom.radius, settings.bloom.threshold);
    this.diffusion = new UnrealBloomPass(size, settings.diffusion.strength, settings.diffusion.radius, settings.diffusion.threshold);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.light);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.diffusion);
    this.composer.addPass(this.grade);
    this.light.uniforms.aspect.value = size.x / Math.max(1, size.y);
    this.apply(settings);
  }

  apply(settings: Partial<PostFXSettings>): void {
    this.settings = { ...this.settings, ...settings };
    const { rays, sun, bloom, diffusion, grade } = this.settings;
    const lu = this.light.uniforms;
    lu.density.value = rays.density;
    lu.decay.value = rays.decay;
    lu.weight.value = rays.weight;
    lu.exposure.value = rays.exposure;
    lu.threshold.value = rays.threshold;
    lu.flicker.value = rays.flicker;
    lu.sunColor.value.set(sun.color[0], sun.color[1], sun.color[2]);
    lu.glow.value = sun.glow;
    lu.glowRadius.value = sun.radius;
    lu.sunHaze.value = sun.haze;
    this.bloom.strength = bloom.strength;
    this.bloom.radius = bloom.radius;
    this.bloom.threshold = bloom.threshold;
    this.diffusion.strength = diffusion.strength;
    this.diffusion.radius = diffusion.radius;
    this.diffusion.threshold = diffusion.threshold;
    this.diffusion.enabled = diffusion.strength > 0;
    const gu = this.grade.uniforms;
    gu.exposure.value = grade.exposure;
    gu.contrast.value = grade.contrast;
    gu.warmth.value = grade.warmth;
    gu.vignette.value = grade.vignette;
    gu.grain.value = grade.grain;
    gu.haze.value.set(grade.haze[0], grade.haze[1], grade.haze[2]);
    gu.hazeAmount.value = grade.hazeAmount;
    gu.highlightTint.value.set(sun.color[0], sun.color[1], sun.color[2]);
    gu.shadowTint.value.set(grade.shadowTint[0], grade.shadowTint[1], grade.shadowTint[2]);
    gu.splitTone.value = grade.splitTone;
    gu.saturation.value = grade.saturation;
  }

  /** Light position in screen UV (0..1) and a strength multiplier (0 hides rays, glow and haze). */
  setLight(uv: THREE.Vector2Like, strength = 1): void {
    this.light.uniforms.lightPos.value.set(uv.x, uv.y);
    this.light.uniforms.lightStrength.value = strength;
  }

  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
    this.diffusion.setSize(width, height);
    this.light.uniforms.aspect.value = width / Math.max(1, height);
  }

  render(time: number): void {
    this.light.uniforms.time.value = time;
    this.grade.uniforms.time.value = time;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    this.diffusion.dispose();
    void this.renderer;
  }
}
