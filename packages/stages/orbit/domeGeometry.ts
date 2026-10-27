import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../catalog.ts';
import { makeRandom } from '../shared/random.ts';
import type { Random } from '../shared/random.ts';
import { DECK_Y, DOME } from './layout.ts';
import { Parts, lathe, place } from './geometry.ts';

// The garden dome's geometry. Azimuths here are degrees about y from the front (+z, towards the
// camera): x = sin(az) * r, z = cos(az) * r. The front stays open: no rib or planter between the
// camera and the dancers, the tall trees stand at the sides, and the back keeps low so the
// planet's limb still shows over it.

const deg = THREE.MathUtils.degToRad;
const onGround = (az: number, r: number, y = DECK_Y): THREE.Vector3 => new THREE.Vector3(Math.sin(deg(az)) * r, y, Math.cos(deg(az)) * r);

/** A point on the dome's surface at azimuth az and latitude lat (degrees), pushed out by grow. */
export const onDome = (az: number, lat: number, grow = 0): THREE.Vector3 =>
  new THREE.Vector3(
    Math.sin(deg(az)) * Math.cos(deg(lat)) * (DOME.radius + grow),
    DECK_Y + Math.sin(deg(lat)) * (DOME.height + grow),
    Math.cos(deg(az)) * Math.cos(deg(lat)) * (DOME.radius + grow),
  );

/** Rib azimuths: ten round, less the two nearest the front, which would cross the dancers. */
export const RIBS: readonly number[] = Array.from({ length: 8 }, (_, i) => 54 + i * 36);
/** The ring round the dome's shoulder, and the crown. */
const SHOULDER_LAT = 52;
const CROWN_LAT = 80;

/** The planter ring: from az to az (going round the back), inner and outer radius, height. */
export const PLANTER = { from: 42, to: 318, inner: 5.95, outer: 7.15, height: 0.5 } as const;
const SOIL_Y = DECK_Y + PLANTER.height - 0.06;

/** The dome's glass shell (a scaled half sphere). */
export function makeDomeGlassGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(DOME.radius, 96, 32, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(1, DOME.height / DOME.radius, 1);
  g.translate(0, DECK_Y, 0);
  g.deleteAttribute('uv');
  return g;
}

/** White: the ribs, the shoulder ring, the crown cap, the dome's foot and the planters. */
export function makeDomeWhiteGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  const white = '#f4f8fc';
  for (const az of RIBS) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) pts.push(onDome(az, (i / 16) * CROWN_LAT, 0.04));
    parts.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.065, 8, false), white);
  }
  const ring = (lat: number, tube: number) => {
    const p = onDome(0, lat, 0.05);
    return place(new THREE.TorusGeometry(p.z, tube, 8, 128), [0, p.y, 0], [Math.PI / 2, 0, 0]);
  };
  parts.add(ring(SHOULDER_LAT, 0.08), white);
  parts.add(ring(CROWN_LAT, 0.13), white);
  // A glossy cap over the crown.
  const crown = onDome(0, CROWN_LAT);
  parts.add(place(new THREE.SphereGeometry(crown.z + 0.18, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2), [0, crown.y - 0.05, 0], [0, 0, 0], [1, 0.38, 1]), white);
  // The dome's foot: a rounded sill on the deck.
  parts.add(
    lathe(
      [
        [DOME.radius - 0.2, DECK_Y],
        [DOME.radius - 0.16, DECK_Y + 0.16],
        [DOME.radius + 0.02, DECK_Y + 0.24],
        [DOME.radius + 0.2, DECK_Y + 0.14],
        [DOME.radius + 0.26, DECK_Y],
      ],
      160,
    ),
    white,
  );
  // The planter: a curved trough with rounded ends.
  const { from, to, inner, outer, height } = PLANTER;
  const steps = 96;
  const section = (r0: number, r1: number) => {
    const shape = new THREE.Shape();
    shape.moveTo(r0, 0);
    shape.lineTo(r1, 0);
    shape.lineTo(r1 + 0.04, height - 0.08);
    shape.quadraticCurveTo(r1 + 0.04, height, r1 - 0.06, height);
    // Down to the soil inside the lip and back up.
    shape.lineTo(r1 - 0.1, height - 0.06);
    shape.lineTo(r0 + 0.1, height - 0.06);
    shape.lineTo(r0 + 0.06, height);
    shape.quadraticCurveTo(r0 - 0.04, height, r0 - 0.04, height - 0.08);
    shape.closePath();
    return shape;
  };
  // Lathe the trough's cross-section round its arc (LatheGeometry turns about y from +z towards +x).
  const prof = section(inner, outer).getPoints(6);
  const trough = new THREE.LatheGeometry(prof, steps, deg(from), deg(to - from));
  trough.translate(0, DECK_Y, 0);
  parts.add(trough, white);
  // Round ends: a bowl at each end of the trough.
  const w = (outer - inner) / 2;
  for (const az of [from, to]) {
    const at = onGround(az, (inner + outer) / 2);
    const bowl = lathe(
      [
        [0.01, height - 0.06],
        [w - 0.1, height - 0.06],
        [w - 0.06, height],
        [w + 0.04, height - 0.08],
        [w + 0.04, 0.02],
        [w, 0],
      ],
      40,
    );
    parts.add(place(bowl, [at.x, DECK_Y, at.z]), white);
  }
  return parts.build();
}

/** Glossy leaves, moss and bark (vertex coloured). */
export function makeGardenGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  const rand = makeRandom(41);
  const { from, to, inner, outer } = PLANTER;
  // Moss over the soil.
  const moss = new THREE.RingGeometry(inner + 0.02, outer - 0.02, 96, 1, 0, deg(to - from));
  // Laid flat, the ring runs from azimuth 90 upwards; turning about y adds to the azimuth.
  parts.add(place(moss, [0, SOIL_Y + 0.004, 0], [-Math.PI / 2, 0, 0]).rotateY(deg(from - 90)), '#3f9a36');
  for (const az of [from, to]) {
    const at = onGround(az, (inner + outer) / 2, SOIL_Y + 0.003);
    parts.add(place(new THREE.CircleGeometry((outer - inner) / 2 - 0.08, 24), at.toArray(), [-Math.PI / 2, 0, 0]), '#3f9a36');
  }
  const greens = ['#3fb83a', '#5ccf3c', '#2fa046', '#77d64a'];
  const shade = (base: THREE.ColorRepresentation) => {
    const c = new THREE.Color(base);
    // Darker underneath, bright where the leaves face up.
    return (_p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => {
      out.copy(c).multiplyScalar(0.5 + 0.7 * THREE.MathUtils.smoothstep(n.y, -0.7, 0.9));
    };
  };
  const mid = (inner + outer) / 2;
  // Round trees at the sides, behind where the camera drones hover (Craft.tsx).
  for (const az of [-116, -96, 96, 116]) {
    const at = onGround(az, mid, SOIL_Y);
    const h = rand.range(1.9, 2.6);
    parts.add(place(new THREE.CylinderGeometry(0.07, 0.12, h, 8), [at.x, at.y + h / 2, at.z]), '#8a6a4c');
    const g = rand.pick(greens);
    parts.add(blob(rand, 1.0, [1, 0.92, 1], [at.x, at.y + h + 0.5, at.z]), shade(g));
    parts.add(blob(rand, 0.62, [1, 0.9, 1], [at.x + rand.range(-0.5, 0.5), at.y + h + 0.05, at.z + rand.range(-0.4, 0.4)]), shade(rand.pick(greens)));
  }
  // Ferns and bushes along the rest, lower towards the back.
  for (let az = from + 6; az <= to - 6; az += 11) {
    // Leave the trees room.
    if (Math.abs((az > 180 ? 360 - az : az) - 106) < 20) continue;
    const back = 1 - THREE.MathUtils.smoothstep(Math.abs(az - 180), 30, 80);
    const at = onGround(az + rand.range(-3, 3), mid + rand.range(-0.25, 0.25), SOIL_Y);
    if (rand.chance(0.55)) fern(parts, rand, at, (0.85 - 0.35 * back) * rand.range(0.85, 1.15));
    else parts.add(blob(rand, 0.48 - 0.12 * back, [1.2, 0.75, 1.2], [at.x, at.y + 0.15, at.z], 2), shade(rand.pick(greens)));
  }
  return parts.build();
}

/** A lumpy, squashed ball of leaves. */
function blob(rand: Random, radius: number, squash: Vec3, at: Vec3, detail = 3): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(radius, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const seed = rand.range(0, 10);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.08 * Math.sin(v.x * 4 / radius + seed) * Math.sin(v.y * 4 / radius + seed * 2) * Math.sin(v.z * 4 / radius + seed * 3);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x * squash[0] + at[0], v.y * squash[1] + at[1], v.z * squash[2] + at[2]);
  }
  g.computeVertexNormals();
  return g;
}

/** A fern: arching, tapering fronds round a centre, `size` long. */
function fern(parts: Parts, rand: Random, at: THREE.Vector3, size: number) {
  const fronds = rand.int(6, 8);
  const base = new THREE.Color('#2f9a3a');
  const tip = new THREE.Color('#8ee05a');
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + rand.range(-0.2, 0.2);
    const lift = rand.range(0.7, 1.1);
    const seg = 7;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      // Out and up, then drooping at the tip.
      const out = t * size;
      const up = Math.sin(t * Math.PI * 0.85) * size * 0.55 * lift;
      const w = Math.sin(Math.min(1, t * 1.15) * Math.PI) * size * 0.16 + 0.01;
      const cx = Math.cos(yaw) * out;
      const cz = Math.sin(yaw) * out;
      const sx = -Math.sin(yaw) * w;
      const sz = Math.cos(yaw) * w;
      // A slight V along the midrib.
      pos.push(cx + sx, up - w * 0.25, cz + sz, cx, up, cz, cx - sx, up - w * 0.25, cz - sz);
      if (i < seg) {
        const a = i * 3;
        idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.translate(at.x, at.y, at.z);
    parts.add(g, (p, _n, out) => out.copy(base).lerp(tip, THREE.MathUtils.clamp(p.distanceTo(at) / size, 0, 1)));
  }
}

/** Flower heads for instancing: position and colour index. */
export function flowerSpots(): { at: THREE.Vector3; color: number }[] {
  const rand = makeRandom(17);
  const spots: { at: THREE.Vector3; color: number }[] = [];
  const { from, to, inner, outer } = PLANTER;
  for (let i = 0; i < 170; i++) {
    const az = rand.range(from + 3, to - 3);
    const r = rand.range(inner + 0.15, outer - 0.15);
    spots.push({ at: onGround(az, r, SOIL_Y + rand.range(0.06, 0.32)), color: rand.int(0, 4) });
  }
  return spots;
}

/** Grow-light and LED strips (emissive, vertex coloured): the planter's lip and the shoulder ring. */
export function makeDomeGlowGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  const { from, to, inner, height } = PLANTER;
  const arc = (r: number, y: number, tube: number, a0: number, a1: number) =>
    // Laid flat, a torus arc runs from azimuth 90 downwards; turning about y adds to the azimuth.
    place(new THREE.TorusGeometry(r, tube, 4, 128, deg(a1 - a0)), [0, y, 0], [Math.PI / 2, 0, 0]).rotateY(deg(a1 - 90));
  parts.add(arc(inner - 0.06, DECK_Y + height - 0.12, 0.03, from, to), '#d6ff8a');
  const s = onDome(0, SHOULDER_LAT, -0.06);
  parts.add(place(new THREE.TorusGeometry(s.z, 0.035, 4, 160), [0, s.y - 0.1, 0], [Math.PI / 2, 0, 0]), '#ffc8f0');
  parts.add(place(new THREE.TorusGeometry(DOME.radius - 0.24, 0.03, 4, 160), [0, DECK_Y + 0.03, 0], [Math.PI / 2, 0, 0]), '#4ff0ff');
  return parts.build();
}
