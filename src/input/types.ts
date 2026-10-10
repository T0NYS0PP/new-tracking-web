/**
 * Normalised viewer head position shared by every input source.
 *  x, y ∈ [-1, 1]  : lateral / vertical offset from the screen centre (x > 0 = viewer's right)
 *  z   ∈ ~[0.6,1.6]: relative distance (1 = calibrated baseline, < 1 = closer)
 *  confidence      : 0 when the source has no signal (face lost, pointer idle)
 */
export interface HeadPose {
  x: number;
  y: number;
  z: number;
  confidence: number;
}

export const CENTER_POSE: Readonly<HeadPose> = Object.freeze({ x: 0, y: 0, z: 1, confidence: 0 });

export type PoseListener = (pose: HeadPose) => void;

export interface InputSource {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  onPose(listener: PoseListener): () => void;
}
