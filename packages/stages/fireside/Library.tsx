// The library on the left of the room: a low oak bookcase under the slope, behind the fire,
// filled with books and topped with candles and a trailing plant, and glossy-leaved fiddle-leaf
// figs in white pots in the window's corners.
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { makeRandom } from '../shared/random.ts';
import type { Random } from '../shared/random.ts';
import { CANDLES, FLOOR, PLANTS, SHELF } from './layout.ts';
import { lathe, merge, paint, place, rod } from './geometry.ts';
import { patchRoom } from './room.ts';

const OAK = '#a8693a';
const SPINES = ['#efe4d0', '#b5482a', '#2f6b6e', '#24375e', '#d69a35', '#3f5e34', '#7a2a2e', '#e8c9a0', '#5b4a7a'];

/** The bookcase, its books and what stands on top, all glossy, in one draw. */
function Bookcase() {
  const material = useDisposable(() =>
    patchRoom(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.15 }), {
      key: 'bookcase',
      emissive: 'totalEmissiveRadiance += diffuseColor.rgb * fireGlow(vRoomWorld, normalize(vRoomNormal)) * 0.9;',
      ibl: 0.4,
    }),
  );
  const geometry = useDisposable(() => {
    const rand = makeRandom(71);
    const { x, z0, z1, height, depth } = SHELF;
    const back = x - depth / 2;
    const front = x + depth / 2;
    const length = z1 - z0;
    const box = (w: number, h: number, d: number, px: number, py: number, pz: number, color: string) =>
      paint(new THREE.BoxGeometry(w, h, d).translate(px, FLOOR + py, pz), color);
    const parts: THREE.BufferGeometry[] = [
      box(depth, 0.08, length, x, 0.04, (z0 + z1) / 2, OAK),
      box(depth + 0.06, 0.06, length + 0.06, x + 0.02, height - 0.03, (z0 + z1) / 2, OAK),
      box(0.04, height, length, back + 0.02, height / 2, (z0 + z1) / 2, '#7a4a28'),
    ];
    const bays = 3;
    const levels = [0.08, 0.64, 1.19];
    const shelfTop = (level: number) => (level < levels.length - 1 ? levels[level + 1] - 0.04 : height - 0.06);
    for (let i = 0; i <= bays; i++) parts.push(box(depth, height, 0.05, x, height / 2, z0 + (length * i) / bays, OAK));
    for (const y of levels.slice(1)) parts.push(box(depth, 0.04, length, x, y - 0.02, (z0 + z1) / 2, OAK));
    levels.forEach((floor, level) => {
      for (let bay = 0; bay < bays; bay++) {
        const start = z0 + (length * bay) / bays + 0.04;
        const end = z0 + (length * (bay + 1)) / bays - 0.04;
        books(rand, parts, front, floor, shelfTop(level) - floor, start, end);
      }
    });
    // On top: a stack of books, a trailing plant and the candles.
    let y = height;
    for (let i = 0; i < 3; i++) {
      const t = rand.range(0.06, 0.09);
      parts.push(paint(place(new THREE.BoxGeometry(rand.range(0.42, 0.5), t, rand.range(0.6, 0.7)), { position: [x + 0.05, FLOOR + y + t / 2, -1.3], rotation: [0, rand.range(-0.2, 0.2), 0] }), rand.pick(SPINES)));
      y += t;
    }
    for (const [cx, cy, cz] of CANDLES) {
      if (cx > 0) continue;
      const tall = cy - FLOOR - height - 0.06;
      parts.push(paint(new THREE.CylinderGeometry(0.075, 0.075, tall, 16).translate(cx, FLOOR + height + tall / 2, cz), '#f4e8d6'));
    }
    parts.push(...trailingPlant(rand, x + 0.1, FLOOR + height, -2.6));
    return merge(parts);
  });
  return <mesh geometry={geometry} material={material} />;
}

/** Fills a shelf bay with books: upright runs, the odd one leaning, a stack lying flat. */
function books(rand: Random, parts: THREE.BufferGeometry[], front: number, floor: number, room: number, start: number, end: number) {
  let z = start + rand.range(0, 0.15);
  while (z < end - 0.1) {
    if (rand.chance(0.12) && end - z > 0.6) {
      // A stack lying flat.
      let y = floor;
      const d = rand.range(0.45, 0.55);
      for (let i = rand.int(2, 4); i > 0; i--) {
        const t = rand.range(0.06, 0.1);
        parts.push(paint(place(new THREE.BoxGeometry(d, t, rand.range(0.3, 0.38)), { position: [front - d / 2 - 0.04, FLOOR + y + t / 2, z + 0.2], rotation: [0, rand.range(-0.15, 0.15), 0] }), rand.pick(SPINES)));
        y += t;
      }
      z += 0.5;
      continue;
    }
    const w = rand.range(0.09, 0.16);
    const h = Math.min(room - 0.03, rand.range(0.34, 0.5));
    const d = rand.range(0.42, 0.56);
    const lean = rand.chance(0.08) ? rand.range(0.15, 0.3) : 0;
    const book = new THREE.BoxGeometry(d, h, w).translate(0, h / 2, 0);
    parts.push(paint(place(book, { position: [front - d / 2 - 0.03, FLOOR + floor, z + w / 2 + lean * h * 0.5], rotation: [-lean, 0, 0] }), rand.pick(SPINES)));
    z += w + (lean ? h * Math.sin(lean) : 0.004) + (rand.chance(0.1) ? rand.range(0.1, 0.3) : 0);
  }
}

/** One leaf: an oval, folded along its midrib and curving down to the tip, along +z from its stalk. */
function leaf(length: number, width: number): THREE.BufferGeometry {
  const along = 6;
  const positions: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= along; i++) {
    const t = i / along;
    const w = width * Math.sin(Math.PI * Math.min(1, t ** 0.75)) * 0.5;
    const z = t * length;
    const y = -t * t * length * 0.25;
    for (const side of [-1, 0, 1]) positions.push(side * w, y + Math.abs(side) * w * 0.35, z);
  }
  for (let i = 0; i < along; i++) {
    const a = i * 3;
    index.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const leafGreen = (rand: Random) => new THREE.Color().setHSL(rand.range(0.27, 0.33), rand.range(0.45, 0.6), rand.range(0.2, 0.3));

/** A fiddle-leaf fig in a glossy white pot: big leaves spiralling up a slim trunk. */
function fig(rand: Random, x: number, z: number, size: number): { leaves: THREE.BufferGeometry[]; pot: THREE.BufferGeometry[] } {
  const at = (g: THREE.BufferGeometry) => place(g, { position: [x, FLOOR, z], scale: size });
  const pot = [
    paint(lathe([[0.001, 0], [0.3, 0], [0.36, 0.05], [0.42, 0.52], [0.44, 0.58], [0.4, 0.6], [0.37, 0.52]], 32), '#f4f1ec'),
    paint(new THREE.CircleGeometry(0.38, 24).rotateX(-Math.PI / 2).translate(0, 0.5, 0), '#2a1a10'),
    paint(rod([0, 0.5, 0], [0.06, 1.9, 0.04], 0.04, 8, 0.02), '#5a3a22'),
  ].map(at);
  const leaves: THREE.BufferGeometry[] = [];
  const count = 26;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const y = 0.95 + t * 1.15 + rand.range(-0.05, 0.05);
    const yaw = i * 2.4 + rand.range(-0.3, 0.3);
    const length = (0.5 - t * 0.14) * rand.range(0.85, 1.1);
    const g = leaf(length, length * 0.62);
    place(g, { position: [0.06 * t, y, 0.04 * t], rotation: [rand.range(-0.55, -0.05), yaw, rand.range(-0.2, 0.2)] });
    leaves.push(paint(at(g), leafGreen(rand)));
  }
  return { leaves, pot };
}

/** A small pot of trailing pothos on the bookcase, its vines spilling down the front. */
function trailingPlant(rand: Random, x: number, y: number, z: number): THREE.BufferGeometry[] {
  return [
    paint(lathe([[0.001, 0], [0.16, 0], [0.2, 0.24], [0.21, 0.27], [0.18, 0.27]], 20).translate(x, y, z), '#c4562a'),
    paint(new THREE.CircleGeometry(0.18, 16).rotateX(-Math.PI / 2).translate(x, y + 0.25, z), '#2a1a10'),
    ...Array.from({ length: 16 }, (_, i) => {
      const trail = i / 15;
      const g = leaf(0.16, 0.12);
      place(g, { position: [x + 0.12 + trail * 0.35, y + 0.28 - trail * trail * 1.0, z + Math.sin(i * 2.1) * 0.22], rotation: [rand.range(-0.6, 0.6), rand.range(0, Math.PI * 2), rand.range(-0.4, 0.4)] });
      return paint(g, leafGreen(rand));
    }),
  ];
}

/** The figs in the window's corners: glossy leaves, and their pots and trunks. */
function Plants() {
  const leaves = useDisposable(() =>
    patchRoom(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, side: THREE.DoubleSide }), {
      key: 'leaves',
      emissive: /* glsl */ `
        vec3 n = normalize(vRoomNormal);
        totalEmissiveRadiance += diffuseColor.rgb * (fireGlow(vRoomWorld, n) * 1.2 + BULB * 0.35);
      `,
      ibl: 0.6,
    }),
  );
  const pots = useDisposable(() =>
    patchRoom(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 }), { key: 'pots', ibl: 0.6 }),
  );
  const geometry = useDisposable(() => {
    const rand = makeRandom(5);
    const plants = PLANTS.map(([x, z, size]) => fig(rand, x, z, size));
    return { leaves: merge(plants.flatMap((p) => p.leaves)), pots: merge(plants.flatMap((p) => p.pot)) };
  });
  return (
    <>
      <mesh geometry={geometry.leaves} material={leaves} />
      <mesh geometry={geometry.pots} material={pots} />
    </>
  );
}

export function Library() {
  return (
    <>
      <Bookcase />
      <Plants />
    </>
  );
}
