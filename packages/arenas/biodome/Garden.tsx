import * as THREE from 'three';
import { BED, bedOutline } from './layout.ts';
import { sweep } from './Platform.tsx';

// The garden bed at the deck's far end, behind the court: a low glossy white crescent along the
// railing between the corner planters, planted (Flora.tsx) with ferns, elephant ears,
// bromeliads and orchids. Its parts merge into the props' meshes (Props.tsx).

/** The bed's wall (glossy white) and its soil. */
export function gardenParts(): { white: THREE.BufferGeometry[]; soil: THREE.BufferGeometry[] } {
  const h = BED.height;
  const outline = bedOutline();
  // sweep() offsets to the path's right; which way that is depends on the outline's winding.
  let area = 0;
  outline.forEach((p, i) => {
    const q = outline[(i + 1) % outline.length];
    area += p.x * q.z - q.x * p.z;
  });
  const out = area > 0 ? 1 : -1;
  // A wall flaring out to a rolled lip, then down inside to the soil, like the round planters.
  const wall: [number, number][] = [[-0.02, 0], [0.0, 0.0], [0.035, 0.05], [0.06, h * 0.7], [0.07, h], [0.05, h + 0.022], [0.0, h + 0.012], [-0.03, h - 0.05]];
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.z)));
  return {
    white: [sweep(outline, wall.map(([o, y]) => [o * out, y] as const), true)],
    soil: [new THREE.ShapeGeometry(shape, 2).rotateX(-Math.PI / 2).translate(0, h - 0.03, 0)],
  };
}
