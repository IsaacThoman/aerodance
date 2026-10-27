import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { makeRandom } from '../shared/random.ts';
import { makeNoise2 } from '../polar/noise.ts';
import { PINES, VARIANTS } from './forest.ts';
import type { PineSpot } from './forest.ts';
import { landHeight } from './terrain.ts';
import { patchScenery } from './materials.ts';
import { finalize, lathe, merge, rod } from './geometry.ts';

// Snow-laden spruces round the clearing, in 3D: tiers of drooping boughs, each carrying a
// rounded cap of snow that leaves its dark-green edge showing. A few shapes, instanced.

const NEEDLES = new THREE.Color('#0c2a24');
const bumps = makeNoise2(19);

/** Snow: bright where it faces up, bluer where it rounds over a bough's edge. */
const snowPaint = (_p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => out.setRGB(0.6, 0.7, 0.92).lerp(new THREE.Color(0.8, 0.86, 0.98), THREE.MathUtils.smoothstep(n.y, 0.1, 0.7));

/** One spruce a unit tall, its trunk's foot at the origin. */
function spruce(seed: number): THREE.BufferGeometry {
  const rand = makeRandom(seed);
  const parts: THREE.BufferGeometry[] = [finalize(rod([0, -0.05, 0], [0, 0.9, 0], 0.035, 0.008, 6), '#2a1a12')];
  const tiers = 7 + (seed % 2);
  for (let k = 0; k < tiers; k++) {
    // Tiers at uneven heights and spreads, so the snow doesn't fall into stripes.
    const f = Math.min(1, Math.max(0, (k + rand.range(-0.3, 0.3)) / tiers));
    const base = 0.05 + f * 0.82;
    const tall = (0.2 - f * 0.06) * rand.range(0.85, 1.2);
    const r = (0.34 * (1 - f) ** 0.85 + 0.03) * rand.range(0.88, 1.1);
    const twist = rand.range(0, Math.PI * 2);
    // Boughs: a drooping skirt with a ragged hem; over it a thick cap of snow that rounds over
    // the hem, so the white shows even from below (profiles run bottom to top, so the lathe
    // faces outwards).
    const boughs = lathe([[0.02, base + tall * 0.1], [r * 0.82, base - tall * 0.16], [r, base], [r * 0.5, base + tall * 0.45], [0.02, base + tall]], 9);
    const cap = lathe([[r * 0.9, base - 0.014], [r * 1.0, base + 0.012], [r * 0.78, base + tall * 0.36 + 0.03], [r * 0.36, base + tall * 0.74 + 0.03], [0.0, base + tall + 0.035]], 9);
    for (const [g, isCap] of [[boughs, false], [cap, true]] as const) {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const a = Math.atan2(z, x) + twist;
        const out = Math.hypot(x, z) / r;
        // Bough tips poke out in five lobes; the snow lies thick, thinner here and there.
        let ragged = 1 + 0.18 * Math.sin(a * 5 + k) * out + 0.08 * bumps(a * 2 + k * 3, seed) * out;
        if (isCap) ragged *= 0.9 + 0.14 * bumps(a * 1.6 + k * 5.3, seed + 3) * out;
        pos.setXYZ(i, x * ragged, pos.getY(i) - 0.04 * out * out * (1 + Math.sin(a * 5 + k)), z * ragged);
      }
      g.computeVertexNormals();
    }
    parts.push(finalize(boughs, NEEDLES));
    parts.push(finalize(cap, snowPaint));
  }
  // A cap of snow on the leader.
  parts.push(finalize(lathe([[0.0, 0.88], [0.05, 0.9], [0.03, 0.95], [0.0, 0.99]], 7), snowPaint));
  return merge(parts);
}

/** The spruces: one instanced mesh per shape. */
export function Pines() {
  const geometries = useDisposable(() => Array.from({ length: VARIANTS }, (_, i) => spruce(11 + i * 7)));
  const material = useDisposable(() =>
    patchScenery(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), { key: 'pine', ibl: 0.5, sparkle: 0.18 }),
  );
  const groups = useMemo(() => Array.from({ length: VARIANTS }, (_, v) => PINES.filter((s) => s.variant === v)), []);
  return groups.map((group, v) => <PineGroup key={v} geometry={geometries[v]} material={material} spots={group} />);
}

function PineGroup({ geometry, material, spots }: { geometry: THREE.BufferGeometry; material: THREE.Material; spots: readonly PineSpot[] }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const dummy = new THREE.Object3D();
    spots.forEach((s, i) => {
      dummy.position.set(s.x, landHeight(s.x, s.z) - 0.3, s.z);
      dummy.rotation.set(0, s.turn, 0);
      dummy.scale.set(s.height * 0.95, s.height, s.height * 0.95);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [spots]);
  return <instancedMesh ref={mesh} args={[geometry, material, spots.length]} />;
}
