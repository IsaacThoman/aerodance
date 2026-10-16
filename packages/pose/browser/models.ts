export type PoseModelId = 'lite' | 'full' | 'heavy';
export interface PoseModel {
  id: PoseModelId; label: string; description: string;
  /** Size and SHA-256 of the .task file, checked before use. */
  bytes: number; sha256: string;
  file: string; url: string;
}
export const MEDIAPIPE_VERSION = '1.1.0';
export const ASSET_PATH = `pose-assets/mediapipe-${MEDIAPIPE_VERSION}`;
export const MODELS: readonly PoseModel[] = ([
  { id: 'lite', label: 'Lite', description: 'Fastest option · start here', bytes: 5777746, sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a' },
  { id: 'full', label: 'Full', description: 'Balanced quality and speed', bytes: 9398198, sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1' },
  { id: 'heavy', label: 'Heavy', description: 'More demanding · try on a capable computer', bytes: 30664242, sha256: '64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b' },
] as const).map(model => ({ ...model, file: `pose_landmarker_${model.id}.task`, url: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${model.id}/float16/1/pose_landmarker_${model.id}.task` }));
export const isPoseModelId = (id: unknown): id is PoseModelId => MODELS.some(model => model.id === id);
/** The model for an id from settings or a record; throws for anything else. */
export function poseModel(id: unknown): PoseModel {
  const model = MODELS.find(model => model.id === id);
  if (!model) throw Error('Choose Lite, Full, or Heavy');
  return model;
}
