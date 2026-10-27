import * as THREE from 'three';
import { DECK_RADIUS, DECK_RAIL, DECK_THICKNESS, DECK_WINDOWS, DECK_Y } from './layout.ts';
import { Parts, lathe, place, strut } from './geometry.ts';

// The deck's geometry, by material. The top is a rounded slab with a ring of curved glass
// windows cut through its outer part; under it a skirt rings the rim and a saucer hull narrows
// down to the spine, leaving the windows open to space and the planet below.

/** How far the slab's edges are rounded. */
const BEVEL = 0.07;
/** Angular size of one window, and the gap between two. */
const WINDOW_SPAN = (Math.PI * 2) / DECK_WINDOWS.count;
const WINDOW_GAP = THREE.MathUtils.degToRad(13);

/** The windows' centre angles (world, about y from +x): none straight ahead or behind. */
export const windowAngles = (): number[] => Array.from({ length: DECK_WINDOWS.count }, (_, i) => (i + 0.5) * WINDOW_SPAN);

/**
 * One window's outline: a curved capsule along the ring, as (x, -z) shape points (the slab is
 * built in the shape plane and turned flat, which mirrors z).
 */
function windowOutline(center: number): THREE.Vector2[] {
  const { inner, outer } = DECK_WINDOWS;
  const mid = (inner + outer) / 2;
  const cap = (outer - inner) / 2;
  const half = (WINDOW_SPAN - WINDOW_GAP) / 2 - cap / mid;
  const pts: THREE.Vector2[] = [];
  const at = (r: number, a: number) => pts.push(new THREE.Vector2(Math.cos(a) * r, -Math.sin(a) * r));
  const arc = 14;
  const capSteps = 10;
  for (let i = 0; i <= arc; i++) at(outer, center - half + (2 * half * i) / arc);
  // Round the end: a half circle about the window's midline.
  const end = (a: number, from: number) => {
    const c = new THREE.Vector2(Math.cos(a) * mid, Math.sin(a) * mid);
    for (let i = 1; i < capSteps; i++) {
      const t = from + (Math.PI * i) / capSteps;
      // In the ring's frame: radial out (cos) and along the ring (sin).
      const radial = Math.cos(t) * cap;
      const along = Math.sin(t) * cap;
      const x = c.x + Math.cos(a) * radial - Math.sin(a) * along;
      const z = c.y + Math.sin(a) * radial + Math.cos(a) * along;
      pts.push(new THREE.Vector2(x, -z));
    }
  };
  end(center + half, 0);
  for (let i = 0; i <= arc; i++) at(inner, center + half - (2 * half * i) / arc);
  end(center - half, Math.PI);
  return pts;
}

/** The deck slab: its top at DECK_Y, rounded edges, and the window holes when `windows`. */
export function makeSlabGeometry(windows: boolean): THREE.BufferGeometry {
  const rim: THREE.Vector2[] = [];
  const n = 160;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    rim.push(new THREE.Vector2(Math.cos(a) * (DECK_RADIUS - BEVEL), Math.sin(a) * (DECK_RADIUS - BEVEL)));
  }
  const shape = new THREE.Shape(rim);
  if (windows) for (const a of windowAngles()) shape.holes.push(new THREE.Path(windowOutline(a)));
  const depth = DECK_THICKNESS - BEVEL * 2;
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 3, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, DECK_Y - depth - BEVEL, 0);
  g.deleteAttribute('uv');
  g.clearGroups();
  return g;
}

/** The glass panes in the windows, just under the deck's top. */
export function makePaneGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  for (const a of windowAngles()) {
    const pane = new THREE.ShapeGeometry(new THREE.Shape(windowOutline(a)), 1);
    parts.add(place(pane, [0, DECK_Y - 0.035, 0], [-Math.PI / 2, 0, 0]));
  }
  return parts.build();
}

/** Glossy white: the skirt round the rim and the hull under the deck, down to the spine. */
export function makeHullGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  const top = DECK_Y - DECK_THICKNESS;
  const R = DECK_RADIUS;
  // The skirt hangs under the rim, outside the windows.
  parts.add(
    lathe(
      [
        [R - 0.02, top + 0.02],
        [R + 0.02, top - 0.12],
        [R - 0.12, top - 0.3],
        [R - 0.5, top - 0.38],
        [DECK_WINDOWS.outer + 0.18, top - 0.3],
        [DECK_WINDOWS.outer + 0.12, top + 0.01],
      ],
      128,
    ),
    '#f4f8fc',
  );
  // The saucer hull, rounding under to a point, with a soft aqua cast low down.
  parts.add(
    lathe(
      [
        [0.01, top - 3.6],
        [0.7, top - 3.5],
        [1.5, top - 3.15],
        [2.5, top - 2.55],
        [3.5, top - 1.85],
        [4.35, top - 1.1],
        [4.95, top - 0.45],
        [DECK_WINDOWS.inner - 0.16, top + 0.01],
      ],
      96,
    ),
    (p, _n, out) => out.set('#f2f7fc').lerp(new THREE.Color('#b8dcf0'), THREE.MathUtils.smoothstep(-p.y, 1.2, 4)),
  );
  return parts.build();
}

/** Chrome: the rail's top tube, its posts and its foot. */
export function makeChromeGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  const { radius, height } = DECK_RAIL;
  parts.add(place(new THREE.TorusGeometry(radius, 0.045, 8, 192), [0, DECK_Y + height + 0.02, 0], [Math.PI / 2, 0, 0]));
  parts.add(place(new THREE.TorusGeometry(radius, 0.05, 6, 192), [0, DECK_Y + 0.025, 0], [Math.PI / 2, 0, 0]));
  const posts = 36;
  for (let i = 0; i < posts; i++) {
    const a = ((i + 0.5) / posts) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    parts.add(strut(new THREE.Vector3(x, DECK_Y, z), new THREE.Vector3(x, DECK_Y + height, z), 0.028, 6));
  }
  return parts.build();
}

/** The rail's glass band. */
export function makeRailGlassGeometry(): THREE.BufferGeometry {
  const { radius, height } = DECK_RAIL;
  const g = new THREE.CylinderGeometry(radius, radius, height - 0.03, 160, 1, true);
  g.translate(0, DECK_Y + (height + 0.03) / 2, 0);
  g.deleteAttribute('uv');
  return g;
}

/** LED strips (emissive, vertex coloured): round the skirt and at the rail's foot. */
export function makeLedGeometry(rail: boolean): THREE.BufferGeometry {
  const parts = new Parts();
  const top = DECK_Y - DECK_THICKNESS;
  const aqua = '#4ff0ff';
  parts.add(place(new THREE.TorusGeometry(DECK_RADIUS + 0.035, 0.035, 5, 192), [0, top - 0.1, 0], [Math.PI / 2, 0, 0]), aqua);
  // A soft ring round the hull's belly.
  parts.add(place(new THREE.TorusGeometry(3.02, 0.05, 5, 96), [0, top - 2.2, 0], [Math.PI / 2, 0, 0]), aqua);
  if (rail) parts.add(place(new THREE.TorusGeometry(DECK_RAIL.radius - 0.06, 0.022, 4, 192), [0, DECK_Y + 0.02, 0], [Math.PI / 2, 0, 0]), aqua);
  return parts.build();
}
