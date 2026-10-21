import type { BufferGeometry } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** Share identical position/normal/colour vertices without changing the canopy or its shading. */
export function mergeTreeGeometry(parts: BufferGeometry[]): BufferGeometry {
  const flat = parts.map((part) => part.index ? part.toNonIndexed() : part);
  const merged = mergeGeometries(flat);
  const indexed = mergeVertices(merged, 1e-6);
  merged.dispose();
  flat.forEach((part, i) => { if (part !== parts[i]) part.dispose(); });
  return indexed;
}
