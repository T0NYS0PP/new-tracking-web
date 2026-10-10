import * as THREE from 'three';
import { config } from '../config';
import { CENTER_POSE, type HeadPose } from '../input/types';

export interface ViewerResponse {
  /** Exponential approach rate toward the target (higher = snappier). */
  smoothingRate: number;
  /** How far ahead (ms) to extrapolate the target along its velocity to hide sensor latency. */
  predictMs: number;
}

/**
 * Turns a head pose into a head-coupled camera:
 *  1. off-axis (asymmetric frustum) projection so the screen behaves like a window
 *  2. an additional orbit of the world around a pivot, matching the exaggerated
 *     parallax of the reference reel.
 * Targets arrive at the input's rate (30 Hz for the webcam); frames render at 60+ Hz, so the
 * camera eases toward a velocity-extrapolated target to stay smooth without lagging.
 */
export class ViewerCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Rotate this group (which contains the scene content) to produce the orbit. */
  readonly orbit: THREE.Group;

  private target: HeadPose = { ...CENTER_POSE };
  private targetTime = 0;
  private velocity = { x: 0, y: 0, z: 0 };
  private current: HeadPose = { ...CENTER_POSE };
  private aspect = 1;
  private enabled = true;
  private response: ViewerResponse = { smoothingRate: config.camera.smoothingRate, predictMs: 0 };

  constructor() {
    const c = config.camera;
    this.camera = new THREE.PerspectiveCamera(60, 1, c.near, c.far);
    this.camera.position.set(0, 0, c.baseDistance);
    this.orbit = new THREE.Group();
    this.orbit.position.fromArray(c.pivot);
  }

  /** Children added here are centred on the pivot so the orbit rotates around it. */
  addContent(object: THREE.Object3D): void {
    const c = config.camera;
    object.position.sub(new THREE.Vector3().fromArray(c.pivot));
    this.orbit.add(object);
  }

  setTarget(pose: HeadPose, t: number = performance.now()): void {
    const dt = (t - this.targetTime) / 1000;
    if (pose.confidence > 0 && this.target.confidence > 0 && dt > 0.005 && dt < 0.25) {
      // Blend the instantaneous velocity so one noisy sample cannot fling the prediction.
      this.velocity.x = this.velocity.x * 0.5 + ((pose.x - this.target.x) / dt) * 0.5;
      this.velocity.y = this.velocity.y * 0.5 + ((pose.y - this.target.y) / dt) * 0.5;
      this.velocity.z = this.velocity.z * 0.5 + ((pose.z - this.target.z) / dt) * 0.5;
    } else {
      this.velocity.x = this.velocity.y = this.velocity.z = 0;
    }
    this.target = pose;
    this.targetTime = t;
  }

  /** Per-input responsiveness: a filtered, 30 Hz webcam wants prediction; a 120 Hz mouse does not. */
  setResponse(response: Partial<ViewerResponse>): void {
    this.response = { ...this.response, ...response };
  }

  /** When disabled (reduced motion) the view eases back to the centre and stays. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.setTarget({ ...CENTER_POSE });
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
  }

  update(dt: number, now: number = performance.now()): void {
    const c = config.camera;
    const k = 1 - Math.exp(-dt * this.response.smoothingRate);

    let goal: HeadPose = CENTER_POSE;
    if (this.enabled && this.target.confidence > 0) {
      const lead = Math.max(0, Math.min(this.response.predictMs, now - this.targetTime)) / 1000;
      goal = {
        x: clamp(this.target.x + this.velocity.x * lead, -1, 1),
        y: clamp(this.target.y + this.velocity.y * lead, -1, 1),
        z: clamp(this.target.z + this.velocity.z * lead, 0.5, 2),
        confidence: 1,
      };
    }

    this.current.x += (goal.x - this.current.x) * k;
    this.current.y += (goal.y - this.current.y) * k;
    this.current.z += (goal.z - this.current.z) * k;

    const { x, y, z } = this.current;

    // --- 1. Eye position relative to the window plane (z = 0) ---
    const eyeX = x * c.kx;
    const eyeY = y * c.ky;
    const eyeZ = c.baseDistance * (1 + (z - 1) * c.depthGain);
    this.camera.position.set(eyeX, eyeY, eyeZ);
    this.camera.quaternion.identity(); // always face the window squarely

    // --- 2. Asymmetric frustum through the window edges ---
    const halfW = c.windowWidth / 2;
    const halfH = halfW / this.aspect;
    const n = c.near;
    const left = ((-halfW - eyeX) * n) / eyeZ;
    const right = ((halfW - eyeX) * n) / eyeZ;
    const bottom = ((-halfH - eyeY) * n) / eyeZ;
    const top = ((halfH - eyeY) * n) / eyeZ;
    this.camera.projectionMatrix.makePerspective(left, right, top, bottom, n, c.far);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    // --- 3. Orbit of the world around the pivot (exaggeration) ---
    this.orbit.rotation.set(y * c.maxPitch, -x * c.maxYaw, 0, 'YXZ');
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
