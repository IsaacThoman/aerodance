import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural models for the things that fly, built once. Every part carries `aColor` (linear
// rgb + gloss, or a negative glow; see materials.ts), so a whole model is one draw call.

type Paint = readonly [color: THREE.ColorRepresentation, gloss: number];
type Painter = (position: THREE.Vector3, normal: THREE.Vector3) => Paint;

const WHITE: Paint = ['#f4f6fb', 0.9];
const AQUA: Paint = ['#22c2e6', 0.9];
const AQUA_GLOW: Paint = ['#5fe8ff', -2.6];
const WINDOW: Paint = ['#1d3c6e', 1];
const GRASS: Paint = ['#6ee04a', 0.3];
const LEAVES: Paint = ['#44c050', 0.4];
const LEAVES_LIGHT: Paint = ['#8ae060', 0.4];
const BARK: Paint = ['#f2ece2', 0.5];

/** Non-indexed copy of `geometry` (disposed) with only position, normal and `aColor`. */
function paint(geometry: THREE.BufferGeometry, painter: Paint | Painter): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geometry.dispose();
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  const position = g.attributes.position;
  const normal = g.attributes.normal;
  const data = new Float32Array(position.count * 4);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    n.fromBufferAttribute(normal, i);
    const [color, gloss] = typeof painter === 'function' ? painter(p, n) : painter;
    c.set(color);
    data.set([c.r, c.g, c.b, gloss], i * 4);
  }
  g.setAttribute('aColor', new THREE.BufferAttribute(data, 4));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  if (!merged) throw new Error('cloudsea: model parts did not merge');
  return merged;
}

/**
 * A sleek airship one unit long, nose along +x: a glossy white envelope with an aqua pinstripe,
 * four swept fins with aqua tips, a gondola with a band of dark windows and two engine pods
 * whose exhausts glow.
 */
export function airshipGeometry(): THREE.BufferGeometry {
  const R = 0.165;
  // Fullest a little ahead of the middle, tapering to a long tail.
  const radius = (s: number) => {
    const u = 2 * Math.pow(s, 1.36) - 1;
    return R * Math.pow(Math.max(0, 1 - u * u), 0.52);
  };
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 48; i++) profile.push(new THREE.Vector2(Math.max(radius(i / 48), 1e-4), i / 48 - 0.5));
  const envelope = new THREE.LatheGeometry(profile, 48);
  envelope.rotateZ(-Math.PI / 2);
  const body = paint(envelope, (p) => {
    const s = p.x + 0.5;
    const r = Math.hypot(p.y, p.z);
    // A pinstripe along each flank.
    return s > 0.16 && s < 0.84 && r > 1e-3 && Math.abs(p.y / r + 0.08) < 0.07 ? AQUA : WHITE;
  });

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0.2, 0);
  shape.lineTo(0.075, 0.13);
  shape.lineTo(-0.02, 0.135);
  shape.closePath();
  const fins: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 1 });
    fin.translate(0, 0, -0.005);
    const painted = paint(fin, (p) => (p.y > 0.1 ? AQUA : WHITE));
    painted.translate(-0.47, 0.035, 0);
    painted.rotateX((k * Math.PI) / 2);
    fins.push(painted);
  }

  const capsule = new THREE.CapsuleGeometry(0.034, 0.17, 6, 18);
  capsule.rotateZ(Math.PI / 2);
  const gondola = paint(capsule, (p, n) => (Math.abs(p.x) < 0.1 && n.y > -0.15 && n.y < 0.55 ? WINDOW : WHITE));
  gondola.translate(0.07, -R - 0.006, 0);

  const pods: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const pod = paint(new THREE.SphereGeometry(1, 16, 10), WHITE);
    pod.scale(0.06, 0.022, 0.022);
    pod.translate(-0.06, -R * 0.62, side * R * 0.95);
    // The exhaust glows; a separate part, as a glow sharing triangles with enamel blends through dark.
    const exhaust = paint(new THREE.SphereGeometry(0.015, 10, 6), AQUA_GLOW);
    exhaust.translate(-0.115, -R * 0.62, side * R * 0.95);
    pods.push(pod, exhaust);
  }
  return merge([body, ...fins, gondola, ...pods]);
}

/**
 * A floating garden pod, one unit in radius: a glossy white saucer with a glowing aqua rim,
 * a lawn and two lollipop trees. Its glass dome is `podDomeGeometry`, drawn after it.
 */
export function podGeometry(): THREE.BufferGeometry {
  const hull = new THREE.LatheGeometry(
    [
      [0.001, -0.6], [0.16, -0.55], [0.42, -0.42], [0.72, -0.28], [0.92, -0.17], [1.02, -0.11],
      [1.04, -0.06], [1.0, -0.01], [0.96, 0.0], [0.001, 0.0],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
    40,
  );
  const saucer = paint(hull, WHITE);
  // The glowing rim is its own ring: a glow sharing triangles with enamel would blend through dark.
  const ring = paint(new THREE.TorusGeometry(1.03, 0.028, 8, 56), AQUA_GLOW);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, -0.095, 0);

  const lawn = paint(
    new THREE.LatheGeometry([[0.95, 0.018], [0.9, 0.03], [0.65, 0.08], [0.35, 0.122], [0.001, 0.135]].map(([x, y]) => new THREE.Vector2(x, y)), 40),
    GRASS,
  );

  const parts = [saucer, ring, lawn];
  const trees: [x: number, z: number, height: number, crown: number, leaves: Paint][] = [
    [0.22, -0.18, 0.42, 0.26, LEAVES],
    [-0.42, 0.12, 0.3, 0.18, LEAVES_LIGHT],
    [0.05, 0.45, 0.2, 0.13, LEAVES],
  ];
  for (const [x, z, height, crown, leaves] of trees) {
    const trunk = paint(new THREE.CylinderGeometry(0.022, 0.032, height, 8), BARK);
    trunk.translate(x, 0.1 + height / 2, z);
    const top = paint(new THREE.IcosahedronGeometry(crown, 2), leaves);
    top.translate(x, 0.1 + height + crown * 0.6, z);
    parts.push(trunk, top);
  }
  return merge(parts);
}

/** The pods' glass dome, over the lawn. */
export function podDomeGeometry(): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(0.98, 36, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.92, 1);
  return paint(dome, ['#9fe6ff', 0]);
}
