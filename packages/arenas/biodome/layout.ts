import * as THREE from 'three';

// Where everything is, in metres. The table stands at the origin on the canopy deck (y = 0), its
// long axis along z; the forest floor is far below. The pool and the waterfall's cliff are off
// the deck's -x side, the walkway leaves its +z end and curves away east to a hub round a giant
// tree, and the geodesic dome arcs over all of it.

/** The forest floor. */
export const FLOOR_Y = -22;

/** The deck: a superellipse |x/rx|^p + |z/rz|^p = 1, its top at y = 0. */
export const DECK = { rx: 5.2, rz: 7.6, p: 4, thickness: 0.34 } as const;

/** The deck's edge distance from the origin at angle theta (x = r sin theta, z = r cos theta). */
export function deckRadius(theta: number): number {
  const s = Math.abs(Math.sin(theta)) / DECK.rx;
  const c = Math.abs(Math.cos(theta)) / DECK.rz;
  return Math.pow(Math.pow(s, DECK.p) + Math.pow(c, DECK.p), -1 / DECK.p);
}

/** Whether (x, z) is on the deck, `margin` metres in from its edge (negative: outside it). */
export function onDeck(x: number, z: number, margin = 0): boolean {
  const r = Math.hypot(x, z);
  return r < deckRadius(Math.atan2(x, z)) - margin;
}

/** The walkway's opening in the deck's railing, round +z: half its angle. */
export const WALK_GAP = 0.15;
export const WALK_WIDTH = 1.9;

/** The walkway's centre line, from the deck's +z end to the hub and on east into the jungle. */
export const WALK_TO_HUB = [
  new THREE.Vector3(0, 0, 7.56), new THREE.Vector3(0.2, 0, 10.5), new THREE.Vector3(2.4, 0, 14.6),
  new THREE.Vector3(6.8, 0, 18.4), new THREE.Vector3(12.6, 0, 20.9), new THREE.Vector3(19.6, 0, 22.4),
];
export const HUB = { x: 23.2, z: 23.4, r: 3.7, trunk: 1.25 } as const;
/** Where the walkway ends: a round lookout. */
export const LOOKOUT = { x: 38.95, z: -3.85, r: 2.4 } as const;
export const WALK_ON = [
  new THREE.Vector3(26.4, 0, 21.8), new THREE.Vector3(30.5, 0, 18.6), new THREE.Vector3(34.5, 0, 13.4),
  new THREE.Vector3(37.4, 0, 6.5), new THREE.Vector3(38.6, 0, -1.5),
];

/** Points along both walkway stretches, every ~0.5 m, for keeping trees off it. */
export const WALK_SAMPLES: readonly THREE.Vector3[] = [WALK_TO_HUB, WALK_ON].flatMap((points) => {
  const curve = new THREE.CatmullRomCurve3(points);
  return curve.getSpacedPoints(Math.ceil(curve.getLength() / 0.5));
});

export function distanceToWalk(x: number, z: number): number {
  let best = Infinity;
  for (const p of WALK_SAMPLES) best = Math.min(best, Math.hypot(p.x - x, p.z - z));
  return Math.min(best, Math.hypot(HUB.x - x, HUB.z - z) - HUB.r);
}

/** The pool on the rock shelf beside the deck: an ellipse. */
export const POOL = { x: -10.6, z: -2.4, rx: 5.0, rz: 5.9, y: -0.55 } as const;

/** The upper fall's lip, high on the cliff, pouring towards +x into the pool. */
export const FALL = { x: -18.0, y: 12.6, z: -3.4, width: 3.4, reach: 3.0 } as const;

/** The lower fall: the pool spilling over its north rim down to the forest floor. */
export const LOWER_FALL = { x: -9.2, y: POOL.y, z: -8.6, width: 2.6, reach: 2.6 } as const;

/** The rock shelf the pool sits in: the pool's ellipse scaled up, its rim at RIM of it. */
export const SHELF = { scale: 1.25, rim: 0.84 } as const;

/** The geodesic dome: a sphere cap over the forest floor. */
export const DOME = { center: new THREE.Vector3(4, -30.6, -4), radius: 60.6 } as const;

/** Towards the sun: warm morning light, ahead and to the right of the opening view, high enough to clear the dome's walls. */
export const SUN_DIR = new THREE.Vector3(0.45, 0.6, -0.66).normalize();

/** Where walk mode starts: the establishing shot over the table to the pool and the falls. */
export const SPAWN = { position: [1.4, 1.62, 4.4] as const, target: [-4.0, 1.85, -3.4] as const, fov: 50 };

/** Glossy white planters on the deck: [x, z, radius]. Their soil is PLANTER_TOP up. */
export const PLANTERS: readonly (readonly [number, number, number])[] = [
  [-3.95, -6.3, 0.72], [3.95, -6.3, 0.72], [-3.95, 6.3, 0.72], [3.95, 6.3, 0.72],
];
export const PLANTER_TOP = 0.52;

/**
 * The garden bed at the deck's far (-z) end, behind the court: a low crescent along the railing
 * between the corner planters.
 */
/** Its edges' insets from the deck's edge, its height, and how far it reaches either side of -z (radians). */
export const BED = { outer: 0.27, inner: 0.95, height: 0.4, reach: 0.395 } as const;

/** A point on the bed's centre line, `a` radians off -z (positive towards -x), `across` metres in from it. */
export function bedPoint(a: number, across = 0): THREE.Vector3 {
  const t = Math.PI + a;
  const r = deckRadius(t) - (BED.outer + BED.inner) / 2 - across;
  return new THREE.Vector3(r * Math.sin(t), 0, r * Math.cos(t));
}

/** The bed's footprint, a crescent with rounded ends, counter-clockwise seen from above: points in xz. */
export function bedOutline(steps = 72): THREE.Vector3[] {
  const half = (BED.inner - BED.outer) / 2;
  const out: THREE.Vector3[] = [];
  const arc = (across: number, a0: number, a1: number) => {
    for (let i = 0; i <= steps; i++) out.push(bedPoint(a0 + ((a1 - a0) * i) / steps, across));
  };
  const cap = (a: number, sign: 1 | -1) => {
    // A half circle about the centre line's end, bulging along the bed: from the edge the last
    // arc ended on round to the other (outer to inner at the +a end, back at the -a end).
    const c = bedPoint(a);
    const along = bedPoint(a + sign * 0.01).sub(c).normalize();
    const inward = c.clone().setY(0).normalize().negate();
    for (let i = 1; i < 12; i++) {
      const k = (i / 12) * Math.PI;
      out.push(c.clone().addScaledVector(inward, -sign * Math.cos(k) * half).addScaledVector(along, Math.sin(k) * half));
    }
  };
  arc(-half, -BED.reach, BED.reach);
  cap(BED.reach, 1);
  arc(half, BED.reach, -BED.reach);
  cap(-BED.reach, -1);
  // Counter-clockwise in (x, -z), i.e. as a THREE.Shape sees it after rotateX(-90°).
  let area = 0;
  out.forEach((p, i) => {
    const q = out[(i + 1) % out.length];
    area += p.x * -q.z - q.x * -p.z;
  });
  return area < 0 ? out.reverse() : out;
}
