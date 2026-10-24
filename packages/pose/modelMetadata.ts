/** Recorded identities include retired models so existing pose files keep their provenance.
 * Inference models and downloadable assets are defined separately in browser/models.ts.
 */
export const RECORDED_MODEL_HASHES = {
  lite: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
  full: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
  heavy: '64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b',
} as const;
export type RecordedPoseModelId = keyof typeof RECORDED_MODEL_HASHES;
export const isRecordedPoseModelId = (id: unknown): id is RecordedPoseModelId =>
  typeof id === 'string' && Object.hasOwn(RECORDED_MODEL_HASHES, id);
