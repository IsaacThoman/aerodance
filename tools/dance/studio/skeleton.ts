// Skeletons drawn on a 2D canvas over (or instead of) the video, for the Studio's source view and
// the CLI's contact sheets. Scoring limbs are drawn heavier, the dancer's left side solid and
// the right side darker, and the wrists and ankles carry L/R tags, so left and right can't be
// misread in an unmirrored frame (the dancer's left is image right).
import { CONNECTIONS } from '../../../packages/pose/choreography.ts';
import type { Landmark } from '../../../packages/pose/choreography.ts';
import { LIMBS } from '../../../packages/score/features.ts';

/** Each dancer's colour: P1 blue, P2 purple, P3 green, P4 pink, as on the game's stages. */
export const DANCER_COLORS = ['#3fb4ff', '#c08bff', '#3fe08f', '#ff7cc4'];
export const REFERENCE_COLOR = '#fff3b0';
/** Frame coordinates → canvas pixels for a cell showing `crop` of the frame. */
export interface Viewport { x: number; y: number; w: number; h: number; crop: { x: number; y: number; w: number; h: number }; }
export const toCanvas = (v: Viewport, p: { x: number; y: number }) => ({
  x: v.x + (p.x - v.crop.x) / v.crop.w * v.w,
  y: v.y + (p.y - v.crop.y) / v.crop.h * v.h,
});
export const toFrame = (v: Viewport, px: number, py: number) => ({ x: v.crop.x + (px - v.x) / v.w * v.crop.w, y: v.crop.y + (py - v.y) / v.h * v.crop.h });

const LEFT = new Set([1, 2, 3, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]);
const RIGHT = new Set([4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);
const SCORED = new Set(LIMBS.flatMap(l => (typeof l.a === 'number' && typeof l.b === 'number' ? [`${Math.min(l.a, l.b)}-${Math.max(l.a, l.b)}`] : [])));
const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};
export interface SkeletonStyle {
  color: string;
  /** 0-1. */
  alpha?: number;
  /** Line width scale. */
  scale?: number;
  dashed?: boolean;
  /** Joints that don't count for scoring, drawn grey. */
  ineligible?: readonly boolean[] | null;
  /** Tag P1 and L/R. */
  label?: string | null;
  /** Hollow rings on these landmarks (elbows/knees placed automatically). */
  hollow?: readonly number[];
  /** Larger rings on these landmarks (the selected control). */
  highlight?: readonly number[];
  /** Bones drawn as a warning ("13-15"): limbs stretched past their length. */
  warn?: ReadonlySet<string>;
}
/** The arm and leg bones (as "a-b") longer on screen than the body allows (body lengths in frame heights). */
export function stretchedBones(landmarks: readonly Landmark[], body: { upperArm: number; forearm: number; thigh: number; shin: number }, aspect: number, slack = 1.15): Set<string> {
  const out = new Set<string>();
  for (const [a, b, length] of [[11, 13, body.upperArm], [13, 15, body.forearm], [12, 14, body.upperArm], [14, 16, body.forearm],
    [23, 25, body.thigh], [25, 27, body.shin], [24, 26, body.thigh], [26, 28, body.shin]] as const)
    if (Math.hypot((landmarks[b].x - landmarks[a].x) * aspect, landmarks[b].y - landmarks[a].y) > length * slack) out.add(`${a}-${b}`);
  return out;
}
export function drawSkeleton(g: CanvasRenderingContext2D, v: Viewport, landmarks: readonly Landmark[], style: SkeletonStyle) {
  const { color, alpha = 1, scale = 1, dashed = false, ineligible = null, label = null, hollow = [], highlight = [], warn } = style;
  const size = Math.max(0.6, Math.min(2.2, v.h / 420)) * scale;
  const p = landmarks.map(l => toCanvas(v, l));
  g.save();
  g.globalAlpha = alpha;
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (dashed) g.setLineDash([6 * size, 5 * size]);
  const torso = [[11, 12], [23, 24], [11, 23], [12, 24]];
  // A soft fill for the torso, so overlapping dancers read apart.
  if (!dashed) {
    g.fillStyle = color; g.globalAlpha = alpha * 0.12;
    g.beginPath(); g.moveTo(p[11].x, p[11].y); g.lineTo(p[12].x, p[12].y); g.lineTo(p[24].x, p[24].y); g.lineTo(p[23].x, p[23].y); g.closePath(); g.fill();
    g.globalAlpha = alpha;
  }
  for (const [a, b] of [...CONNECTIONS, ...torso.filter(([a, b]) => !CONNECTIONS.some(([c, d]) => c === a && d === b))]) {
    const scored = SCORED.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
    const grey = ineligible && (ineligible[a] || ineligible[b]);
    const left = LEFT.has(a) && LEFT.has(b), right = RIGHT.has(a) && RIGHT.has(b);
    const stretched = warn?.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
    g.strokeStyle = stretched ? '#ff5a4f' : grey ? '#8a949a' : dashed ? color : right ? shade(color, 0.62) : left ? color : shade(color, 0.85);
    g.lineWidth = (scored ? 4.2 : 2.2) * size;
    // A dark edge under each line keeps it visible over bright video.
    if (!dashed) {
      g.save(); g.strokeStyle = 'rgba(0,10,20,0.55)'; g.lineWidth += 2.4 * size;
      g.beginPath(); g.moveTo(p[a].x, p[a].y); g.lineTo(p[b].x, p[b].y); g.stroke(); g.restore();
    }
    g.beginPath(); g.moveTo(p[a].x, p[a].y); g.lineTo(p[b].x, p[b].y); g.stroke();
  }
  // The head: a ring through the ears, and its facing (head centre to nose).
  const ears = { x: (p[7].x + p[8].x) / 2, y: (p[7].y + p[8].y) / 2 };
  const radius = Math.max(4 * size, Math.hypot(p[7].x - p[8].x, p[7].y - p[8].y) * 0.62);
  g.strokeStyle = color; g.lineWidth = 2 * size;
  g.beginPath(); g.arc(ears.x, ears.y, radius, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(ears.x, ears.y); g.lineTo(p[0].x, p[0].y); g.stroke();
  g.setLineDash([]);
  if (!dashed) {
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      const r = (highlight.includes(i) ? 6.5 : 3.6) * size;
      g.beginPath(); g.arc(p[i].x, p[i].y, r, 0, Math.PI * 2);
      if (hollow.includes(i)) { g.strokeStyle = '#ffffff'; g.lineWidth = 1.6 * size; g.stroke(); }
      else { g.fillStyle = ineligible?.[i] ? '#8a949a' : LEFT.has(i) ? color : shade(color, 0.62); g.fill(); g.strokeStyle = '#ffffff'; g.lineWidth = 1.2 * size; g.stroke(); }
      if (highlight.includes(i)) { g.strokeStyle = '#ffffff'; g.lineWidth = 2.4 * size; g.beginPath(); g.arc(p[i].x, p[i].y, r + 3 * size, 0, Math.PI * 2); g.stroke(); }
    }
    if (label !== null) {
      g.font = `700 ${Math.round(10 * size + 2)}px Nunito, system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const tag = (text: string, at: { x: number; y: number }, dy: number, fill: string) => {
        const w = g.measureText(text).width + 6 * size, h = 13 * size + 2;
        g.fillStyle = 'rgba(0,12,24,0.72)';
        g.fillRect(at.x - w / 2, at.y + dy - h / 2, w, h);
        g.fillStyle = fill; g.fillText(text, at.x, at.y + dy + 0.5);
      };
      for (const [i, t] of [[15, 'L'], [16, 'R'], [27, 'L'], [28, 'R']] as const) tag(t, p[i], (i >= 27 ? 14 : -14) * size, i % 2 ? color : shade(color, 0.75));
      if (label) tag(label, ears, -radius - 11 * size, '#ffffff');
    }
  }
  g.restore();
}
/** A label with a dark backing, for sheet rows and cells. */
export function drawTag(g: CanvasRenderingContext2D, text: string, x: number, y: number, { size = 13, color = '#e6f4ff', align = 'left' as CanvasTextAlign } = {}) {
  g.save();
  g.font = `700 ${size}px Nunito, system-ui, sans-serif`;
  g.textBaseline = 'top'; g.textAlign = align;
  const w = g.measureText(text).width + 10;
  g.fillStyle = 'rgba(4,16,28,0.78)';
  g.fillRect(align === 'left' ? x : x - w, y, w, size + 8);
  g.fillStyle = color;
  g.fillText(text, align === 'left' ? x + 5 : x - 5, y + 4);
  g.restore();
}
