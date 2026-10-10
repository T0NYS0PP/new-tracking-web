import * as THREE from 'three';
import { config } from '../config';
import { CENTER_POSE, type HeadPose } from '../input/types';

/**
 * Turns a head pose into a head-coupled camera:
 *  1. off-axis (asymmetric frustum) projection so the screen behaves like a window
 *  2. an additional orbit of the world around a pivot, matching the exaggerated
 *     parallax of the reference reel.
 */
export class ViewerCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Rotate this group (which contains the scene content) to produce the orbit. */
  readonly orbit: THREE.Group;

  private target: HeadPose = { ...CENTER_POSE };
  private current: HeadPose = { ...CENTER_POSE };
  private aspect = 1;
  private enabled = true;

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

  setTarget(pose: HeadPose): void {
    this.target = pose;
  }

  /** When disabled (reduced motion) the view eases back to the centre and stays. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.target = { ...CENTER_POSE };
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
  }

  update(dt: number): void {
    const c = config.camera;
    const k = 1 - Math.exp(-dt * c.smoothingRate);
    const goal = this.enabled && this.target.confidence > 0 ? this.target : CENTER_POSE;

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
