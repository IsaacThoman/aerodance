import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { DECK, FLOOR_Y, HUB, LOOKOUT, WALK_GAP, WALK_ON, WALK_TO_HUB, WALK_WIDTH, deckRadius } from './layout.ts';
import { LIGHT, fx, limb, merge } from './shading.ts';

// The canopy deck: pale lacquered timber on a glossy white steel rim, glass balustrades with a
// white handrail, carried on branching white columns from the forest floor. A suspended walkway
// leaves its far end under white hoops and curves away to a ring deck round a giant tree.

type Profile = readonly (readonly [offset: number, y: number])[];

/**
 * Sweeps a cross-section along a path: each profile point is [offset to the path's right
 * (up × tangent), height above the path point]. uv: x = metres along, y = 0..1 across.
 */
export function sweep(points: readonly THREE.Vector3[], profile: Profile, closed = false): THREE.BufferGeometry {
  const n = profile.length;
  const count = points.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const across = [0];
  for (let j = 1; j < n; j++) across.push(across[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const total = across[n - 1] || 1;
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let along = 0;
  for (let i = 0; i < count; i++) {
    const prev = points[closed ? (i - 1 + count) % count : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % count : Math.min(count - 1, i + 1)];
    tangent.subVectors(next, prev).setY(0).normalize();
    side.crossVectors(up, tangent);
    if (i > 0) along += points[i].distanceTo(points[i - 1]);
    for (let j = 0; j < n; j++) {
      const [o, y] = profile[j];
      positions.push(points[i].x + side.x * o, points[i].y + y, points[i].z + side.z * o);
      uvs.push(along, across[j] / total);
    }
  }
  const segments = closed ? count : count - 1;
  for (let i = 0; i < segments; i++) {
    const i1 = (i + 1) % count;
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = i1 * n + j;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** The deck's outline at `inset` metres in from its edge, from angle t0 to t1. */
function outline(inset: number, t0 = 0, t1 = Math.PI * 2, segments = 200): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
  const steps = full ? segments : Math.ceil((segments * (t1 - t0)) / (Math.PI * 2));
  for (let i = 0; i < (full ? steps : steps + 1); i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const r = deckRadius(t) - inset;
    points.push(new THREE.Vector3(r * Math.sin(t), 0, r * Math.cos(t)));
  }
  return points;
}

/** Points every `spacing` metres along a polyline, ends included. */
function spaced(points: readonly THREE.Vector3[], spacing: number): THREE.Vector3[] {
  const out = [points[0].clone()];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = a.distanceTo(b);
    let t = spacing - carry;
    while (t <= len) {
      out.push(a.clone().lerp(b, t / len));
      t += spacing;
    }
    carry = len - (t - spacing);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1].distanceTo(last) > spacing * 0.4) out.push(last.clone());
  return out;
}

/** The path offset sideways by `offset` (to its right). */
function offsetPath(points: readonly THREE.Vector3[], offset: number): THREE.Vector3[] {
  const up = new THREE.Vector3(0, 1, 0);
  return points.map((p, i) => {
    const t = points[Math.min(points.length - 1, i + 1)].clone().sub(points[Math.max(0, i - 1)]).setY(0).normalize();
    return p.clone().addScaledVector(new THREE.Vector3().crossVectors(up, t), offset);
  });
}

const curvePoints = (points: readonly THREE.Vector3[], step = 0.4) => {
  const curve = new THREE.CatmullRomCurve3([...points]);
  return curve.getSpacedPoints(Math.ceil(curve.getLength() / step));
};

/** Pale timber planks along v, drawn once: 8 m square, tiling. */
function plankTexture(): THREE.CanvasTexture {
  const size = 1024;
  const ppm = size / 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  const rand = makeRandom(23);
  const columns = 48;
  const w = size / columns;
  g.fillStyle = '#8d7658';
  g.fillRect(0, 0, size, size);
  for (let c = 0; c < columns; c++) {
    let y = -rand.range(0, 3) * ppm;
    while (y < size) {
      const len = rand.range(1.6, 3.4) * ppm;
      const l = rand.range(57, 65);
      const h = rand.range(30, 36);
      for (const shift of [0, size]) {
        const top = y - shift;
        g.fillStyle = `hsl(${h}, ${rand.range(34, 44).toFixed(0)}%, ${l.toFixed(1)}%)`;
        g.fillRect(c * w + 1, top + 1, w - 2, len - 2);
        // Grain: faint streaks along the plank.
        for (let k = 0; k < 7; k++) {
          const gx = c * w + 2 + rand.next() * (w - 4);
          g.fillStyle = rand.chance(0.5) ? 'rgba(120,90,50,0.10)' : 'rgba(255,245,225,0.12)';
          g.fillRect(gx, top + rand.next() * len * 0.3, 1, len * rand.range(0.4, 0.9));
        }
        const sheen = g.createLinearGradient(c * w, 0, c * w + w, 0);
        sheen.addColorStop(0, 'rgba(255,255,255,0.0)');
        sheen.addColorStop(0.5, 'rgba(255,250,240,0.08)');
        sheen.addColorStop(1, 'rgba(90,60,30,0.06)');
        g.fillStyle = sheen;
        g.fillRect(c * w + 1, top + 1, w - 2, len - 2);
      }
      y += len;
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Rope netting for the walkway's sides: diamonds of pale cord, alpha cut. */
function netTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#f4fbf6';
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(128, 128);
  g.moveTo(128, 0); g.lineTo(0, 128);
  g.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// The fascia round the deck's edge: a glossy rounded band, [outward, y] from the edge.
const FASCIA: Profile = [
  [-0.5, -DECK.thickness - 0.14], [0.0, -DECK.thickness - 0.14], [0.1, -DECK.thickness - 0.1], [0.15, -0.26],
  [0.15, -0.06], [0.11, 0.0], [0.04, 0.025], [-0.06, 0.025],
];
const LED: Profile = [[0.158, -0.21], [0.158, -0.15]];
const RAIL_Y = 1.02;

// Glass: a faint aqua film with a bright polished top edge, reflections and sun glints.
const glassFragment = /* glsl */ `
${LIGHT}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float ndv = max(dot(n, v), 0.0);
  float fres = pow(1.0 - ndv, 4.0);
  float edge = smoothstep(0.9, 0.985, vUv.y) + smoothstep(0.08, 0.0, vUv.y) * 0.5;
  vec3 r = reflect(-v, n);
  vec3 refl = mix(vec3(0.35, 0.6, 0.42), vec3(0.85, 0.96, 1.0), smoothstep(-0.2, 0.6, r.y));
  vec3 col = mix(vec3(0.7, 0.95, 0.92), refl, 0.6);
  float a = 0.06 + fres * 0.32 + edge * 0.35;
  float glint = pow(max(dot(reflect(-uSunDir, n), v), 0.0), 60.0);
  // A slow sweep of light along the panels.
  float sweep = smoothstep(0.92, 1.0, sin(vUv.x * 0.35 - uTime * 0.4 + vUv.y * 1.5));
  vec3 add = vec3(1.0, 0.97, 0.9) * glint * 2.0 + vec3(0.8, 1.0, 0.95) * sweep * 0.08;
  col = haze(col, vWorld);
  gl_FragColor = vec4(col * a + add, a);
}
`;

const glassVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

function deckTop(): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline(0, 0, Math.PI * 2, 160).map((p) => new THREE.Vector2(p.x, -p.z)));
  const g = new THREE.ShapeGeometry(shape, 1).rotateX(-Math.PI / 2);
  // Planks run along z, 8 m to a tile of the texture.
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 8 + 0.03, p.getZ(i) / 8);
  return g;
}

function hubTop(): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(HUB.trunk + 0.12, HUB.r, 64, 2).rotateX(-Math.PI / 2).translate(HUB.x, 0, HUB.z);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 8, p.getZ(i) / 8);
  return g;
}

function circle(cx: number, cz: number, r: number, t0: number, t1: number, segments: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = t0 + ((t1 - t0) * i) / segments;
    pts.push(new THREE.Vector3(cx + r * Math.sin(t), 0, cz + r * Math.cos(t)));
  }
  return pts;
}

/** Angles round the hub where the walkways meet it. */
const hubGaps = (): [number, number] => {
  const a = Math.atan2(WALK_TO_HUB[WALK_TO_HUB.length - 1].x - HUB.x, WALK_TO_HUB[WALK_TO_HUB.length - 1].z - HUB.z);
  const b = Math.atan2(WALK_ON[0].x - HUB.x, WALK_ON[0].z - HUB.z);
  return [a, b];
};

function buildPlatform() {
  const steel: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const timber: THREE.BufferGeometry[] = [deckTop(), hubTop()];
  const led: THREE.BufferGeometry[] = [];
  const net: THREE.BufferGeometry[] = [];

  // --- The deck's rim, railing and soffit.
  const rim = outline(0);
  // The outline runs clockwise seen from above, so the profile's right is inward: flip it.
  const flip = (profile: Profile): Profile => profile.map(([o, y]) => [-o, y] as const);
  steel.push(sweep(rim, flip(FASCIA), true));
  led.push(sweep(rim, flip(LED), true));
  const soffit = new THREE.Shape(outline(0.5, 0, Math.PI * 2, 120).map((p) => new THREE.Vector2(p.x, -p.z)));
  steel.push(new THREE.ShapeGeometry(soffit, 1).rotateX(Math.PI / 2).translate(0, -DECK.thickness - 0.14, 0));
  const railLine = outline(0.12, WALK_GAP, Math.PI * 2 - WALK_GAP, 220);
  steel.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railLine), 260, 0.045, 8));
  glass.push(sweep(outline(0.13, WALK_GAP + 0.004, Math.PI * 2 - WALK_GAP - 0.004, 220), [[0, 0.07], [0, RAIL_Y - 0.06]]));
  for (const p of spaced(railLine, 1.35)) {
    steel.push(new THREE.CylinderGeometry(0.03, 0.035, RAIL_Y, 10, 1, true).translate(p.x, RAIL_Y / 2, p.z));
    steel.push(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 14).translate(p.x, 0.015, p.z));
  }

  // --- Branching white columns from the forest floor, spreading under the deck.
  for (const [x, z] of [[0, -3.6], [0, 3.6]] as const) {
    const fork = new THREE.Vector3(x, -7.5, z);
    steel.push(limb(new THREE.Vector3(x, FLOOR_Y - 1, z), fork, 0.62, 0.42, 16, false));
    steel.push(new THREE.SphereGeometry(0.46, 16, 10).translate(fork.x, fork.y, fork.z));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.3;
      const tip = new THREE.Vector3(x + Math.sin(a) * 3.3, -DECK.thickness - 0.1, z + Math.cos(a) * 2.6);
      const elbow = fork.clone().lerp(tip, 0.55).add(new THREE.Vector3(Math.sin(a) * 0.5, -0.6, Math.cos(a) * 0.4));
      steel.push(limb(fork, elbow, 0.3, 0.22, 10, false), limb(elbow, tip, 0.22, 0.14, 10, false));
      steel.push(new THREE.SphereGeometry(0.22, 10, 8).translate(elbow.x, elbow.y, elbow.z));
    }
  }

  // --- The walkway: planks between white edge beams, posts, handrails and rope netting, and
  // white hoops arching over it.
  const w = WALK_WIDTH / 2;
  for (const stretch of [WALK_TO_HUB, WALK_ON]) {
    const path = curvePoints(stretch, 0.35);
    // A hair below the decks they run onto, so the planks don't fight where they overlap.
    timber.push(sweep(path, [[-w, -0.003], [w, -0.003]]));
    for (const s of [-1, 1]) {
      const beam: Profile = [[s * (w - 0.02), 0.04], [s * (w + 0.1), 0.04], [s * (w + 0.12), -0.2], [s * (w + 0.06), -0.34], [s * (w - 0.3), -0.34]];
      steel.push(sweep(path, s > 0 ? beam : [...beam].reverse()));
      const side = offsetPath(path, s * (w + 0.02));
      steel.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(side.map((p) => p.clone().setY(RAIL_Y))), Math.ceil(side.length * 0.8), 0.04, 7));
      net.push(sweep(side, [[0, 0.06], [0, RAIL_Y - 0.04]]));
      for (const p of spaced(side, 1.6)) steel.push(new THREE.CylinderGeometry(0.03, 0.035, RAIL_Y, 8, 1, true).translate(p.x, RAIL_Y / 2, p.z));
    }
    // The underside, so the planks aren't paper thin from below.
    steel.push(sweep(path, [[w, -0.3], [-w, -0.3]]));
    const curve = new THREE.CatmullRomCurve3([...stretch]);
    const hoops = Math.floor(curve.getLength() / 6.5);
    for (let i = 1; i <= hoops; i++) {
      const t = (i - 0.5) / hoops;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).setY(0).normalize();
      const right = new THREE.Vector3(tan.z, 0, -tan.x).negate();
      const arc: THREE.Vector3[] = [];
      for (let k = 0; k <= 16; k++) {
        const a = (k / 16) * Math.PI;
        arc.push(p.clone().addScaledVector(right, Math.cos(a) * (w + 0.12)).setY(-0.3 + Math.sin(a) * 3.1));
      }
      steel.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arc), 24, 0.055, 7));
      // A slim pylon down to the forest floor every other hoop.
      if (i % 2 === 0) steel.push(limb(p.clone().setY(FLOOR_Y - 1), p.clone().setY(-0.34), 0.2, 0.12, 10, false));
    }
  }

  // --- The hub round the giant tree: a ring deck, fascia and railing, open to both walkways.
  const [ga, gb] = hubGaps();
  const hubRim = circle(HUB.x, HUB.z, HUB.r, 0, Math.PI * 2, 96);
  hubRim.pop();
  steel.push(sweep(hubRim, flip(FASCIA), true));
  led.push(sweep(hubRim, flip(LED), true));
  steel.push(new THREE.RingGeometry(HUB.trunk, HUB.r - 0.4, 48, 1).rotateX(Math.PI / 2).translate(HUB.x, -DECK.thickness - 0.14, HUB.z));
  const gapHalf = (WALK_WIDTH / 2 + 0.2) / HUB.r;
  const arcs: [number, number][] = [];
  const lo = Math.min(ga, gb);
  const hi = Math.max(ga, gb);
  arcs.push([lo + gapHalf, hi - gapHalf], [hi + gapHalf, lo + Math.PI * 2 - gapHalf]);
  for (const [t0, t1] of arcs) {
    const line = circle(HUB.x, HUB.z, HUB.r - 0.12, t0, t1, Math.ceil((t1 - t0) * 24));
    steel.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(line.map((p) => p.clone().setY(RAIL_Y))), line.length * 2, 0.045, 8));
    glass.push(sweep(line, [[0, 0.07], [0, RAIL_Y - 0.06]]));
    for (const p of spaced(line, 1.3)) steel.push(new THREE.CylinderGeometry(0.03, 0.035, RAIL_Y, 10, 1, true).translate(p.x, RAIL_Y / 2, p.z));
  }
  // A low white collar round the trunk.
  steel.push(new THREE.CylinderGeometry(HUB.trunk + 0.16, HUB.trunk + 0.2, 0.35, 32, 1, true).translate(HUB.x, 0.17, HUB.z));
  steel.push(new THREE.RingGeometry(HUB.trunk + 0.02, HUB.trunk + 0.17, 32).rotateX(-Math.PI / 2).translate(HUB.x, 0.345, HUB.z));

  // --- The lookout at the walkway's end: a round deck, railed but for its way in, on a pylon.
  {
    const { x, z, r } = LOOKOUT;
    const last = WALK_ON[WALK_ON.length - 1];
    const entry = Math.atan2(last.x - x, last.z - z);
    const top = new THREE.CircleGeometry(r, 48).rotateX(-Math.PI / 2).translate(x, 0, z);
    const uv = top.attributes.uv;
    const tp = top.attributes.position;
    for (let i = 0; i < tp.count; i++) uv.setXY(i, tp.getX(i) / 8, tp.getZ(i) / 8);
    timber.push(top);
    const rim = circle(x, z, r, 0, Math.PI * 2, 64);
    rim.pop();
    steel.push(sweep(rim, flip(FASCIA), true));
    led.push(sweep(rim, flip(LED), true));
    steel.push(new THREE.CircleGeometry(r - 0.4, 40).rotateX(Math.PI / 2).translate(x, -DECK.thickness - 0.14, z));
    const half = (WALK_WIDTH / 2 + 0.2) / r;
    const line = circle(x, z, r - 0.12, entry + half, entry + Math.PI * 2 - half, 60);
    steel.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(line.map((p) => p.clone().setY(RAIL_Y))), 90, 0.045, 8));
    glass.push(sweep(line, [[0, 0.07], [0, RAIL_Y - 0.06]]));
    for (const p of spaced(line, 1.3)) steel.push(new THREE.CylinderGeometry(0.03, 0.035, RAIL_Y, 10, 1, true).translate(p.x, RAIL_Y / 2, p.z));
    steel.push(limb(new THREE.Vector3(x, FLOOR_Y - 1, z), new THREE.Vector3(x, -0.4, z), 0.32, 0.22, 14, false));
    // A coin-op viewer looking out over the forest, Aero white and chrome.
    const out = entry + Math.PI;
    const vx = x + Math.sin(out) * (r - 0.7);
    const vz = z + Math.cos(out) * (r - 0.7);
    steel.push(new THREE.CylinderGeometry(0.06, 0.09, 1.1, 14).translate(vx, 0.55, vz));
    steel.push(new THREE.CapsuleGeometry(0.13, 0.32, 6, 14).rotateX(Math.PI / 2).rotateY(out).translate(vx, 1.22, vz));
  }

  // --- The court's inlaid line on the deck.
  const court = new THREE.Shape();
  roundedRect(court, 3.05, 5.4, 0.7);
  const hole = new THREE.Path();
  roundedRect(hole, 3.0, 5.35, 0.65);
  court.holes.push(hole);
  const line = new THREE.ShapeGeometry(court, 6).rotateX(-Math.PI / 2).translate(0, 0.002, 0);

  return {
    steel: merge(steel),
    glass: merge(glass),
    timber: merge(timber),
    led: merge(led),
    net: merge(net),
    line,
  };
}

function roundedRect(path: THREE.Path, hx: number, hz: number, r: number) {
  path.moveTo(-hx + r, -hz);
  path.lineTo(hx - r, -hz);
  path.quadraticCurveTo(hx, -hz, hx, -hz + r);
  path.lineTo(hx, hz - r);
  path.quadraticCurveTo(hx, hz, hx - r, hz);
  path.lineTo(-hx + r, hz);
  path.quadraticCurveTo(-hx, hz, -hx, hz - r);
  path.lineTo(-hx, -hz + r);
  path.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
}

export function Platform() {
  const parts = useDisposable(buildPlatform);
  const materials = useDisposable(() => {
    const planks = plankTexture();
    const net = netTexture();
    net.repeat.set(1 / 0.24, 1 / 0.24);
    return {
      planks,
      netMap: net,
      timber: new THREE.MeshPhysicalMaterial({ map: planks, roughness: 0.6, clearcoat: 0.3, clearcoatRoughness: 0.25, envMapIntensity: 0.35 }),
      steel: new THREE.MeshPhysicalMaterial({ color: '#f6faf9', roughness: 0.2, metalness: 0.08, clearcoat: 0.7, clearcoatRoughness: 0.08, side: THREE.DoubleSide }),
      glass: shaderMaterial({ uniforms: { ...fx }, vertexShader: glassVertex, fragmentShader: glassFragment, transparent: true, premultipliedAlpha: true, side: THREE.DoubleSide }),
      led: new THREE.MeshBasicMaterial({ color: new THREE.Color('#7ff8e4').multiplyScalar(1.7) }),
      net: new THREE.MeshStandardMaterial({ map: net, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7, color: '#e9f6ee' }),
      line: new THREE.MeshStandardMaterial({ color: '#e4ffc0', roughness: 0.35, emissive: '#9cff6a', emissiveIntensity: 0.12, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    };
  });
  // Net uvs are in metres along and 0..1 up: tile ~24 cm diamonds.
  return (
    <>
      <mesh geometry={parts.timber} material={materials.timber} receiveShadow />
      <mesh geometry={parts.steel} material={materials.steel} castShadow receiveShadow />
      <mesh geometry={parts.led} material={materials.led} />
      <mesh geometry={parts.net} material={materials.net} castShadow />
      <mesh geometry={parts.line} material={materials.line} receiveShadow />
      <mesh geometry={parts.glass} material={materials.glass} renderOrder={50} />
    </>
  );
}
