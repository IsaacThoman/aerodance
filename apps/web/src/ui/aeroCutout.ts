// The aero dancer as a flat cutout for the 2D overlays: the shape only, in one colour, as the
// mirror shows the players (game/MirrorDancers.tsx), drawn from the model's own proportions so
// it reads as the same character at any size.

type Ctx = CanvasRenderingContext2D;

/** How far each hand is raised, in radians from hanging down (π/2 out to the side, π straight up). */
export interface CutoutPose { left: number; right: number; }

// The model seen from the front (packages/character/source/build-character.py), in its units
// with y up from the floor: a round head, a lathed body with a wide flat bottom, two hands
// floating at its sides and two feet. The hands swing about the arm bones at the shoulders.
const FLOOR = 0.025;
const TOP = 3.36;
const HEAD = { y: 2.715, r: 0.645 };
// The body's profile, bottom to top: [height, half-width].
const BODY: readonly (readonly [number, number])[] = [
  [0.55, 0], [0.565, 0.43], [0.595, 0.6], [0.65, 0.66], [0.75, 0.67], [0.93, 0.65], [1.17, 0.6],
  [1.42, 0.52], [1.65, 0.44], [1.85, 0.34], [1.96, 0.22], [2, 0],
];
const SHOULDER = { x: 0.7, y: 1.94 };
const HAND = { r: 0.33, reach: 0.898 };
const FOOT = { x: 0.36, y: 0.3, rx: 0.43, ry: 0.275 };
const EYE = { x: 0.185, y: 2.73, rx: 0.082, ry: 0.178 };

const REST_ANGLE = Math.atan2(0.26, 0.86);
/** Hands at its sides, as the model stands. */
export const REST: CutoutPose = { left: REST_ANGLE, right: REST_ANGLE };
/** Waving one hand (a picked dancer): its left, or right. */
export const WAVES: readonly [CutoutPose, CutoutPose] = [{ left: 2.2, right: REST_ANGLE }, { left: REST_ANGLE, right: 2.2 }];
/** A few dance moves, big enough to show only on large cutouts (small ones stand at REST). */
export const CUTOUT_POSES: readonly CutoutPose[] = [
  { left: REST_ANGLE, right: 2.3 },
  { left: 2.3, right: REST_ANGLE },
  { left: 1.2, right: 1.2 },
  { left: 2.2, right: 2.2 },
];
/** How wide a cutout `height` tall is with its hands down: for spacing a row of them. */
export const cutoutWidth = (height: number) => (2 * (SHOULDER.x + HAND.reach * Math.sin(REST_ANGLE) + HAND.r) * height) / (TOP - FLOOR);

export interface CutoutStyle {
  /** The silhouette's fill. */
  fill: Ctx['fillStyle'];
  /** The eyes' colour, or null for none. */
  eyes?: string | null;
  pose?: CutoutPose;
}

/** Traces the silhouette as one path (every part wound the same way, so it fills as a whole). */
function trace(g: Ctx, x: number, y: number, s: number, pose: CutoutPose) {
  const px = (u: number) => x + u * s;
  const py = (v: number) => y - (v - FLOOR) * s;
  g.beginPath();
  // The body, clockwise on screen: up its left side, then down its right, smoothed through
  // the midpoints of the profile.
  const outline = [...BODY.map(([v, r]) => [-r, v] as const), ...[...BODY].reverse().slice(1).map(([v, r]) => [r, v] as const)];
  g.moveTo(px(outline[0][0]), py(outline[0][1]));
  for (let i = 1; i < outline.length - 1; i++) {
    const [u, v] = outline[i], [nu, nv] = outline[i + 1];
    g.quadraticCurveTo(px(u), py(v), px((u + nu) / 2), py((v + nv) / 2));
  }
  g.closePath();
  const circle = (u: number, v: number, r: number) => { g.moveTo(px(u) + r * s, py(v)); g.arc(px(u), py(v), r * s, 0, Math.PI * 2); };
  const ellipse = (u: number, v: number, rx: number, ry: number) => { g.moveTo(px(u) + rx * s, py(v)); g.ellipse(px(u), py(v), rx * s, ry * s, 0, 0, Math.PI * 2); };
  circle(0, HEAD.y, HEAD.r);
  for (const side of [-1, 1]) {
    const raise = side < 0 ? pose.left : pose.right;
    circle(side * (SHOULDER.x + HAND.reach * Math.sin(raise)), SHOULDER.y - HAND.reach * Math.cos(raise), HAND.r);
    ellipse(side * FOOT.x, FOOT.y, FOOT.rx, FOOT.ry);
  }
}

/**
 * An aero dancer `height` tall standing with its feet at (x, y): filled in one colour (the
 * caller's shadow, if set, falls under the whole shape), then its eyes.
 */
export function drawAeroCutout(g: Ctx, x: number, y: number, height: number, { fill, eyes = '#0a1c33', pose = REST }: CutoutStyle) {
  const s = height / (TOP - FLOOR);
  g.save();
  trace(g, x, y, s, pose);
  g.fillStyle = fill;
  g.fill();
  g.restore();
  if (!eyes) return;
  g.save();
  g.shadowColor = 'transparent';
  g.fillStyle = eyes;
  g.beginPath();
  for (const side of [-1, 1]) {
    g.moveTo(x + (side * EYE.x + EYE.rx) * s, y - (EYE.y - FLOOR) * s);
    g.ellipse(x + side * EYE.x * s, y - (EYE.y - FLOOR) * s, EYE.rx * s, EYE.ry * s, 0, 0, Math.PI * 2);
  }
  g.fill();
  g.restore();
}

/** The silhouette's outline alone, for a rim around a cutout (stroke it after drawAeroCutout). */
export function traceAeroCutout(g: Ctx, x: number, y: number, height: number, pose: CutoutPose = REST) {
  trace(g, x, y, height / (TOP - FLOOR), pose);
}
