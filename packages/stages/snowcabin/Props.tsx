import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { makeRandom } from '../shared/random.ts';
import { CABIN_MATRIX, LANTERN_POSTS, SLED, SNOWMAN, WOODPILE } from './layout.ts';
import { landHeight } from './terrain.ts';
import { LANTERNS, LANTERN_HEIGHT } from './palette.ts';
import { patchScenery } from './materials.ts';
import { blob, box, finalize, lathe, merge, place, rod } from './geometry.ts';

// The things round the clearing: a snowman in a bobble hat and scarf, a wooden sled leaning on a
// lantern post, the woodpile by the cabin and the lanterns. Glossy painted wood and iron in one
// mesh, their snow in another.

const COAL = '#15161c';
const RED = '#d8283a';
const TEAL = '#14b8b0';
const HONEY = '#c98a4e';
const IRON = '#23262e';

/** A frame placed on the snow at (x, z), turned by heading. */
function onGround(x: number, z: number, heading: number, sink = 0, scale = 1) {
  return (g: THREE.BufferGeometry) => place(place(g, { rotation: [0, heading, 0], scale }), { position: [x, landHeight(x, z) - sink, z] });
}

function snowman(): { timber: THREE.BufferGeometry[]; snow: THREE.BufferGeometry[] } {
  const at = onGround(SNOWMAN.x, SNOWMAN.z, SNOWMAN.heading, 0.15, SNOWMAN.scale);
  const lump = (seed: number) => (d: THREE.Vector3) => 0.03 * Math.sin(d.x * 7 + seed) * Math.sin(d.y * 5 + d.z * 6);
  const snow = [
    blob(0.66, [1, 0.9, 1], lump(1)).translate(0, 0.55, 0),
    blob(0.48, [1, 0.94, 1], lump(2)).translate(0, 1.36, 0),
    blob(0.34, [1, 1, 1], lump(3), 2).translate(0, 1.98, 0),
  ].map((g) => at(finalize(g, '#e9f0ff')));
  const timber: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, paint: THREE.ColorRepresentation | ((p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void)) => timber.push(at(finalize(g, paint)));
  // Coal eyes, smile and buttons; a carrot nose.
  for (const x of [-0.12, 0.12]) add(new THREE.SphereGeometry(0.05, 8, 6).translate(x, 2.06, 0.3), COAL);
  for (let i = 0; i < 5; i++) {
    const a = (i / 4 - 0.5) * 1.2;
    add(new THREE.SphereGeometry(0.03, 6, 4).translate(Math.sin(a) * 0.15, 1.88 - Math.cos(a) * 0.05 + 0.05, 0.31), COAL);
  }
  for (let i = 0; i < 3; i++) add(new THREE.SphereGeometry(0.055, 8, 6).translate(0, 1.2 + i * 0.2, 0.46 - i * 0.02), COAL);
  add(rod([0, 1.98, 0.3], [0.02, 1.95, 0.72], 0.065, 0.005, 8), '#ff7a1a');
  // A striped scarf with a tail, and a bobble hat.
  const stripes = (a: THREE.ColorRepresentation, b: THREE.ColorRepresentation, k: number) => {
    const ca = new THREE.Color(a);
    const cb = new THREE.Color(b);
    return (p: THREE.Vector3, _n: THREE.Vector3, out: THREE.Color) => out.copy(Math.sin(Math.atan2(p.z, p.x) * k + p.y * 20) > 0 ? ca : cb);
  };
  add(new THREE.TorusGeometry(0.34, 0.085, 8, 18).rotateX(Math.PI / 2).translate(0, 1.7, 0), stripes(TEAL, '#e8fff8', 6));
  add(place(box([-0.09, -0.5, -0.03], [0.09, 0, 0.03]), { position: [0.2, 1.7, 0.33], rotation: [0.25, 0, 0.15] }), (p, _n, out) => out.set(Math.sin(p.y * 40) > 0 ? TEAL : '#e8fff8'));
  add(lathe([[0.33, 0], [0.34, 0.08], [0.3, 0.2], [0.18, 0.32], [0.0, 0.37]], 16).translate(0, 2.12, 0), (p, _n, out) => out.set(p.y < 2.2 ? '#f4f4f4' : Math.sin(p.y * 45) > 0 ? RED : '#f4f4f4'));
  add(new THREE.IcosahedronGeometry(0.1, 1).translate(0, 2.52, 0), '#f4f4f4');
  // Twig arms, waving.
  for (const s of [-1, 1]) {
    add(rod([s * 0.38, 1.42, 0], [s * 1.05, 1.82 + (s > 0 ? 0.25 : 0), 0.08], 0.03, 0.015, 5), '#4a2e1e');
    add(rod([s * 0.82, 1.7 + (s > 0 ? 0.18 : 0), 0.06], [s * 1.0, 1.98 + (s > 0 ? 0.2 : 0), 0.02], 0.016, 0.01, 4), '#4a2e1e');
  }
  return { timber, snow };
}

function sled(): { timber: THREE.BufferGeometry[]; snow: THREE.BufferGeometry[] } {
  // Stood up on its tail, its slats to the camera, leaning back against the post.
  const at = (g: THREE.BufferGeometry) => onGround(SLED.x, SLED.z, SLED.heading, 0.02)(g.translate(0, 0, 0.78).rotateX(-1.25).rotateY(Math.PI).scale(1.2, 1.2, 1.2));
  const timber: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      [s * 0.27, 0.04, -0.75], [s * 0.27, 0.03, 0.4], [s * 0.27, 0.12, 0.7], [s * 0.27, 0.36, 0.76], [s * 0.27, 0.36, 0.56],
    ].map((p) => new THREE.Vector3(...p)));
    timber.push(at(finalize(new THREE.TubeGeometry(curve, 24, 0.035, 6), RED)));
    for (const z of [-0.55, -0.05, 0.4]) timber.push(at(finalize(box([s * 0.27 - 0.03, 0.03, z - 0.03], [s * 0.27 + 0.03, 0.27, z + 0.03]), RED)));
  }
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 0.12;
    timber.push(at(finalize(box([x - 0.05, 0.26, -0.72], [x + 0.05, 0.3, 0.5]), (p, _n, out) => out.set(HONEY).multiplyScalar(0.92 + 0.08 * Math.sin(i * 3.1)))));
  }
  timber.push(at(finalize(rod([0, 0.34, 0.74], [0.35, 0.3, 0.95], 0.012, 0.012, 4), '#7a1a22')));
  return { timber, snow: [] };
}

function woodpile(): { timber: THREE.BufferGeometry[]; snow: THREE.BufferGeometry[] } {
  const rand = makeRandom(13);
  const timber: THREE.BufferGeometry[] = [];
  const bark = new THREE.Color('#4a2e1e');
  const end = new THREE.Color('#d9a066');
  const log = (paint: THREE.Vector3) => (_p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => out.copy(Math.abs(n.x) > 0.8 ? end : bark).multiplyScalar(0.85 + paint.x * 0.3);
  // Logs stacked along the cabin's side, their cut ends facing out.
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 6 - row; i++) {
      const r = 0.17 + rand.next() * 0.03;
      const g = new THREE.CylinderGeometry(r, r, 0.9, 9).rotateZ(Math.PI / 2);
      timber.push(finalize(g.translate(WOODPILE.x, 0.2 + row * 0.3, WOODPILE.z + (i - (5 - row) / 2) * 0.36), log(new THREE.Vector3(rand.next(), 0, 0))));
    }
  }
  const snow = [finalize(blob(1, [0.55, 0.16, 1.05], (d) => 0.1 * Math.sin(d.z * 7 + d.x * 3), 2).translate(WOODPILE.x, 1.28, WOODPILE.z), '#e9f0ff', true)];
  return { timber: timber.map((g) => g.applyMatrix4(CABIN_MATRIX)), snow: snow.map((g) => g.applyMatrix4(CABIN_MATRIX)) };
}

/** A little iron lantern round a flame at (x, y, z) (Lights draws the flame), with snow on its roof. */
function lantern(x: number, y: number, z: number): { timber: THREE.BufferGeometry[]; snow: THREE.BufferGeometry[] } {
  const timber = [
    finalize(box([x - 0.17, y - 0.32, z - 0.17], [x + 0.17, y - 0.27, z + 0.17]), IRON),
    finalize(place(new THREE.ConeGeometry(0.27, 0.24, 4).rotateY(Math.PI / 4), { position: [x, y + 0.33, z] }), IRON),
    finalize(new THREE.TorusGeometry(0.06, 0.012, 4, 10).translate(x, y + 0.5, z), IRON),
  ];
  for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) timber.push(finalize(rod([x + dx * 0.14, y - 0.27, z + dz * 0.14], [x + dx * 0.14, y + 0.22, z + dz * 0.14], 0.014, 0.014, 4), IRON));
  const snow = [finalize(blob(0.2, [1, 0.45, 1], (d) => 0.1 * Math.sin(d.x * 8 + d.z * 5), 2).translate(x, y + 0.4, z), '#e9f0ff', true)];
  return { timber, snow };
}

/** A wooden post with a lantern on top. */
function lanternPost(x: number, z: number): { timber: THREE.BufferGeometry[]; snow: THREE.BufferGeometry[] } {
  const y = landHeight(x, z);
  const top = y + LANTERN_HEIGHT;
  const head = lantern(x, top, z);
  head.timber.push(finalize(box([x - 0.07, y - 0.3, z - 0.07], [x + 0.07, top - 0.3, z + 0.07]), (p, _n, out) => out.set(HONEY).multiplyScalar(0.7 + 0.08 * Math.sin(p.y * 7))));
  return head;
}

/** The props: painted wood and iron in one mesh, their snow in another. */
export function Props() {
  const geometries = useDisposable(() => {
    const all = [snowman(), sled(), woodpile(), ...LANTERN_POSTS.map(([x, z]) => lanternPost(x, z)), ...LANTERNS.slice(LANTERN_POSTS.length).map(([x, y, z]) => lantern(x, y, z))];
    return { timber: merge(all.flatMap((p) => p.timber)), snow: merge(all.flatMap((p) => p.snow)) };
  });
  const materials = useDisposable(() => ({
    timber: patchScenery(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.12 }), { key: 'props', ibl: 0.4 }),
    snow: patchScenery(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), { key: 'props-snow', ibl: 0.55, sparkle: 0.25 }),
  }));
  return (
    <>
      <mesh geometry={geometries.timber} material={materials.timber} castShadow />
      <mesh geometry={geometries.snow} material={materials.snow} castShadow />
    </>
  );
}

