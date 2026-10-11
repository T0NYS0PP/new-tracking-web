import * as THREE from 'three';

/**
 * Slowly drifting, twinkling light particles in the air between the viewer and the scene.
 * Additive, unsorted and depth-free: cheap and always in front of the splats.
 */
export class Motes {
  readonly points: THREE.Points;
  private material: THREE.ShaderMaterial;

  constructor(count = 320, color = '#ffe3b0', sizeScale = 1, private spread = 1) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 3.2 * this.spread;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 2.0 * this.spread;
      positions[i * 3 + 2] = -0.4 - Math.random() * 3.2; // in front of the window plane, toward the scene
      seeds[i * 4] = Math.random() * Math.PI * 2;
      seeds[i * 4 + 1] = 0.3 + Math.random() * 0.9; // speed
      seeds[i * 4 + 2] = 0.5 + Math.random() * 1.0; // size
      seeds[i * 4 + 3] = Math.random(); // phase
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        color: { value: new THREE.Color(color) },
        pixelRatio: { value: 1 },
        intensity: { value: 1 },
        sizeScale: { value: sizeScale },
      },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform float time, pixelRatio, sizeScale;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          float t = time * seed.y * 0.25 + seed.x;
          p.x += sin(t) * 0.12 + sin(t * 0.37) * 0.08;
          p.y += cos(t * 0.8) * 0.08 + sin(time * 0.05 + seed.x) * 0.05 + sin(t * 0.21) * 0.05;
          p.z += sin(t * 0.5) * 0.06;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float twinkle = 0.55 + 0.45 * sin(time * (0.8 + seed.w * 1.6) + seed.x * 3.0);
          vAlpha = twinkle * smoothstep(-4.5, -0.6, mv.z) * smoothstep(0.1, -0.4, mv.z);
          gl_PointSize = seed.z * 9.0 * sizeScale * pixelRatio / max(0.3, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        uniform float intensity;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          a *= a;
          gl_FragColor = vec4(color * a * vAlpha * intensity, a * vAlpha * intensity);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  update(time: number, pixelRatio: number): void {
    this.material.uniforms.time.value = time;
    this.material.uniforms.pixelRatio.value = pixelRatio;
  }

  setIntensity(v: number): void {
    this.material.uniforms.intensity.value = v;
  }

  setColor(color: string): void {
    (this.material.uniforms.color.value as THREE.Color).set(color);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
