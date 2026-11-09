import { RECORDED_MODEL_HASHES } from '../modelMetadata.ts';

export type PoseModelId = 'lite';
export interface PoseModel {
  id: PoseModelId; label: string; description: string;
  /** Size and SHA-256 of the .task file, checked before use. */
  bytes: number; sha256: string;
  file: string; url: string;
}
export const MEDIAPIPE_VERSION = '1.1.0';
export const ASSET_PATH = `pose-assets/mediapipe-${MEDIAPIPE_VERSION}`;
export const MODELS: readonly PoseModel[] = ([
  { id: 'lite', label: 'Lite', description: 'Local pose tracking', bytes: 5777746, sha256: RECORDED_MODEL_HASHES.lite },
] as const).map(model => ({ ...model, file: `pose_landmarker_${model.id}.task`, url: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${model.id}/float16/1/pose_landmarker_${model.id}.task` }));
/** A model file the browser loads beside the pose model, checked the same way. */
export interface ModelAsset { label: string; bytes: number; sha256: string; file: string; url: string; }
/** The Hand Landmarker, run on a player's wrists for the 'hands' detail (pose.worker.ts); loaded only once it's asked for. */
export const HAND_MODEL: ModelAsset = {
  label: 'Hand Landmarker', bytes: 7819105, sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
  file: 'hand_landmarker.task', url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
/** Every model the pose assets pipeline downloads, checks, serves and copies into builds (scripts/poseAssets.ts). */
export const MODEL_ASSETS: readonly ModelAsset[] = [...MODELS, HAND_MODEL];
export const isPoseModelId = (id: unknown): id is PoseModelId => MODELS.some(model => model.id === id);
/** The supported inference model; recorded model identities are separate. */
export function poseModel(id: unknown): PoseModel {
  const model = MODELS.find(model => model.id === id);
  if (!model) throw Error('Only the Lite pose model is supported');
  return model;
}
