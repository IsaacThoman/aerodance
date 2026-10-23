// Frutiger Aero drawing kit for the in-engine 2D overlays. Everything takes design units;
// useCanvasUI scales them to the render buffer.
import type { WebcamStatus } from '../../../../packages/pose/browser/WebcamPoseSource.ts';

type Ctx = CanvasRenderingContext2D;
/** A point in design units. */
export interface Point { x: number; y: number; }
/** A layout rectangle in design units. */
export interface Rect { x: number; y: number; w: number; h: number; }
/** A layout circle (centre and radius) in design units. */
export interface Circle { x: number; y: number; r: number; }
/** Top, middle and baseline colours of a glossy headline face. */
export type Face = readonly [top: string, middle: string, bottom: string];

export const FONT = '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif';
export const NAVY = '#0c2f52';
export const TAU = Math.PI * 2;

// Canvas text needs the web font resident before it is drawn.
export const loadFonts = () =>
  Promise.all(['800', '700', '600', '200'].map((wt) => document.fonts.load(`${wt} 64px ${FONT}`))).catch(() => {});

export function pill(g: Ctx, x: number, y: number, w: number, h: number) {
  const r = h / 2;
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  g.lineTo(x + r, y + h);
  g.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
  g.closePath();
}

export function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// "aerodance." wordmark with its baseline at y. stacked puts "dance." on a second line under
// "aero", STACKED_LEADING sizes lower, both lines starting at x. outline (a fraction of size)
// edges the letters in the shadow's navy, so the thin "dance" reads on light backgrounds; halo
// scales the opacity of the wide dark glow behind them; light is the weight of "dance" (200).
export const STACKED_LEADING = 0.86;

export function drawTitle(g: Ctx, { x, y, size, stacked = false, outline = 0, halo = 1, light = 200 }: {
  x: number; y: number; size: number; stacked?: boolean; outline?: number; halo?: number; light?: number;
}) {
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${-size * 0.045}px`;
  g.textBaseline = 'alphabetic';
  g.font = `800 ${size}px ${FONT}`;
  const aeroW = g.measureText('aero').width;
  g.font = `${light} ${size}px ${FONT}`;
  const danceW = g.measureText('dance').width;
  const s = size * 0.15;
  const dance = stacked ? { x, y: y + size * STACKED_LEADING } : { x: x + aeroW, y };
  const dotX = dance.x + danceW + size * 0.04;

  const text = (fill: (baseline: number) => string | CanvasGradient) => {
    g.fillStyle = fill(y);
    g.font = `800 ${size}px ${FONT}`;
    g.fillText('aero', x, y);
    g.fillStyle = fill(dance.y);
    g.font = `${light} ${size}px ${FONT}`;
    g.fillText('dance', dance.x, dance.y);
  };

  // 1) Wide, dark halo so the title separates from bright sky and clouds.
  g.shadowColor = `rgba(0, 28, 70, ${Math.min(1, 0.55 * halo)})`;
  g.shadowBlur = 46;
  g.shadowOffsetY = 10;
  text(() => 'rgba(0, 40, 90, 0.35)');
  // 2) Tight, hard drop shadow for an embossed, aero-style edge.
  g.shadowColor = 'rgba(0, 34, 84, 0.75)';
  g.shadowBlur = 4;
  g.shadowOffsetY = 7;
  text(() => '#ffffff');
  // 3) Optional navy edge, half of it showing outside the face.
  g.shadowColor = 'transparent';
  if (outline > 0) {
    g.lineJoin = 'round';
    g.lineWidth = size * outline;
    g.strokeStyle = 'rgba(0, 34, 84, 0.7)';
    g.font = `800 ${size}px ${FONT}`;
    g.strokeText('aero', x, y);
    g.font = `${light} ${size}px ${FONT}`;
    g.strokeText('dance', dance.x, dance.y);
    g.strokeRect(dotX, dance.y - s, s, s);
  }
  // 4) Glossy face: white with a cool tint towards the baseline.
  text((baseline) => {
    const face = g.createLinearGradient(0, baseline - size * 0.75, 0, baseline);
    face.addColorStop(0, '#ffffff');
    face.addColorStop(0.55, '#ffffff');
    face.addColorStop(1, '#d5f3ff');
    return face;
  });

  // Mint full stop.
  g.shadowColor = 'rgba(0, 34, 84, 0.75)';
  g.shadowBlur = 4;
  g.shadowOffsetY = 7;
  g.fillStyle = '#6ff3d6';
  g.fillRect(dotX, dance.y - s, s, s);
  g.restore();
}

export function titleWidth(g: Ctx, size: number, stacked = false, light = 200) {
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${-size * 0.045}px`;
  g.font = `800 ${size}px ${FONT}`;
  const aeroW = g.measureText('aero').width;
  g.font = `${light} ${size}px ${FONT}`;
  const danceW = g.measureText('dance').width;
  g.restore();
  return stacked ? Math.max(aeroW, danceW + size * 0.19) : aeroW + danceW + size * 0.19;
}

export function drawDisc(g: Ctx, cx: number, cy: number, r: number) {
  g.save();
  g.shadowColor = 'rgba(0, 60, 120, 0.4)';
  g.shadowBlur = 10;
  g.shadowOffsetY = 3;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  const disc = g.createLinearGradient(0, cy - r, 0, cy + r);
  disc.addColorStop(0, '#5cc2ec');
  disc.addColorStop(0.5, '#1f8fd0');
  disc.addColorStop(1, '#0d63a8');
  g.fillStyle = disc;
  g.fill();
  g.restore();
  g.beginPath();
  g.ellipse(cx, cy - r * 0.45, r * 0.75, r * 0.42, 0, 0, TAU);
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.fill();
}

/** Draws an icon centred on (cx, cy), sized for a disc of radius r. */
export type IconDraw = (g: Ctx, cx: number, cy: number, r: number) => void;

// The aero dancer from the front, in its model's units (packages/character/source/build-character.py):
// x to the right, z up from the floor to the top of its head, its hands the widest part.
const DANCER_TOP = 3.36;
const DANCER_HALF_WIDTH = 1.29;
// The body is lathed from this profile, [height above BODY_BASE, half width].
const DANCER_BODY = [[0, 0], [0.015, 0.43], [0.045, 0.6], [0.1, 0.66], [0.2, 0.67], [0.38, 0.65], [0.62, 0.6], [0.87, 0.52], [1.1, 0.44], [1.3, 0.34], [1.41, 0.22], [1.45, 0]] as const;
const BODY_BASE = 0.55;
// [x, z, radius x, radius z]: the head, the floating hands, the feet and the eyes.
const DANCER_HEAD = [0, 2.715, 0.645, 0.645] as const;
const DANCER_ORBS = [DANCER_HEAD, [-0.96, 1.08, 0.33, 0.33], [0.96, 1.08, 0.33, 0.33], [-0.36, 0.3, 0.43, 0.275], [0.36, 0.3, 0.43, 0.275]] as const;
const DANCER_EYES = [[-0.185, 2.73, 0.082, 0.178], [0.185, 2.73, 0.082, 0.178]] as const;

/** How wide a dancer cutout `height` tall is, hands included. */
export const dancerWidth = (height: number) => (height * 2 * DANCER_HALF_WIDTH) / DANCER_TOP;

/**
 * An aero dancer's cutout, like the mirror's: its front silhouette in one flat fill (a colour or
 * gradient), `height` tall, standing on (cx, floor), with its eyes cut out.
 */
export function drawDancer(g: Ctx, cx: number, floor: number, height: number, fill: string | CanvasGradient) {
  const k = height / DANCER_TOP;
  const X = (x: number) => cx + x * k;
  const Y = (z: number) => floor - z * k;
  g.beginPath();
  // One path, every part clockwise on screen, so the parts merge where they overlap (a
  // translucent fill doesn't darken there) and the anticlockwise eyes cut holes. The body goes up
  // its left side from the bottom and down its right, rounded through the profile's midpoints.
  const loop = [...DANCER_BODY.map(([z, r]) => [-r, z + BODY_BASE]), ...DANCER_BODY.slice(1, -1).reverse().map(([z, r]) => [r, z + BODY_BASE])];
  const mid = (i: number) => {
    const [a, b] = [loop[i % loop.length], loop[(i + 1) % loop.length]];
    return [X((a[0] + b[0]) / 2), Y((a[1] + b[1]) / 2)];
  };
  g.moveTo(...(mid(loop.length - 1) as [number, number]));
  loop.forEach(([x, z], i) => {
    const [mx, my] = mid(i);
    g.quadraticCurveTo(X(x), Y(z), mx, my);
  });
  g.closePath();
  for (const [x, z, rx, rz] of DANCER_ORBS) {
    g.moveTo(X(x) + rx * k, Y(z));
    g.ellipse(X(x), Y(z), rx * k, rz * k, 0, 0, TAU);
  }
  for (const [x, z, rx, rz] of DANCER_EYES) {
    g.moveTo(X(x) + rx * k, Y(z));
    g.ellipse(X(x), Y(z), rx * k, rz * k, 0, 0, TAU, true);
  }
  g.fillStyle = fill;
  g.fill();
}

// Icons drawn in white on a blue disc of radius r.
export const ICONS = {
  fullscreen(g, cx, cy, r, collapse = false) {
    const a = r * 0.48;
    const b = r * 0.18;
    const corner = collapse ? b : a;
    const end = collapse ? a : b;
    g.beginPath();
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        g.moveTo(cx + sx * end, cy + sy * corner);
        g.lineTo(cx + sx * corner, cy + sy * corner);
        g.lineTo(cx + sx * corner, cy + sy * end);
      }
    }
    g.stroke();
  },
  play(g, cx, cy, r) {
    const t = r * 0.42;
    g.beginPath();
    g.moveTo(cx - t * 0.7, cy - t);
    g.lineTo(cx + t, cy);
    g.lineTo(cx - t * 0.7, cy + t);
    g.closePath();
    g.stroke();
  },
  note(g, cx, cy, r) {
    const s = r * 0.5;
    g.save();
    g.fillStyle = '#ffffff';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(cx - s * 0.35, cy + s * 0.6);
    g.lineTo(cx - s * 0.35, cy - s * 0.75);
    g.lineTo(cx + s * 0.75, cy - s);
    g.lineTo(cx + s * 0.75, cy + s * 0.35);
    g.stroke();
    for (const [x, y] of [[cx - s * 0.62, cy + s * 0.62], [cx + s * 0.48, cy + s * 0.37]]) {
      g.beginPath();
      g.ellipse(x, y, s * 0.32, s * 0.24, -0.4, 0, TAU);
      g.fill();
    }
    g.restore();
  },
  list(g, cx, cy, r) {
    const a = r * 0.44;
    g.beginPath();
    for (const dy of [-a * 0.7, 0, a * 0.7]) {
      g.moveTo(cx - a * 0.55, cy + dy);
      g.lineTo(cx + a, cy + dy);
      g.moveTo(cx - a, cy + dy);
      g.lineTo(cx - a * 0.92, cy + dy);
    }
    g.stroke();
  },
  // Circular arrow (play again).
  replay(g, cx, cy, r) {
    const a = r * 0.42;
    g.beginPath();
    g.arc(cx, cy, a, -Math.PI * 0.35, Math.PI * 1.45);
    g.stroke();
    const tx = cx + Math.cos(-Math.PI * 0.35) * a;
    const ty = cy + Math.sin(-Math.PI * 0.35) * a;
    g.save();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(tx + a * 0.62, ty - a * 0.12);
    g.lineTo(tx - a * 0.2, ty - a * 0.62);
    g.lineTo(tx - a * 0.04, ty + a * 0.46);
    g.closePath();
    g.fill();
    g.restore();
  },
  gear(g, cx, cy, r, angle = 0) {
    const teeth = 8;
    const outer = r * 0.5;
    const inner = r * 0.37;
    g.save();
    g.translate(cx, cy);
    g.rotate(angle);
    g.lineWidth = 5;
    g.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a0 = (i / (teeth * 2)) * TAU;
      const a1 = ((i + 1) / (teeth * 2)) * TAU;
      const rad = i % 2 === 0 ? outer : inner;
      g.lineTo(Math.cos(a0) * rad, Math.sin(a0) * rad);
      g.lineTo(Math.cos(a1) * rad, Math.sin(a1) * rad);
    }
    g.closePath();
    g.stroke();
    g.beginPath();
    g.arc(0, 0, r * 0.15, 0, TAU);
    g.stroke();
    g.restore();
  },
  // A camera body with its lens (start the camera).
  camera(g, cx, cy, r) {
    const w = r * 0.5;
    const h = r * 0.34;
    const top = cy - h + r * 0.06;
    g.beginPath();
    g.roundRect(cx - w, top, w * 2, h * 2, r * 0.1);
    g.moveTo(cx - w * 0.42, top);
    g.lineTo(cx - w * 0.28, top - r * 0.12);
    g.lineTo(cx + w * 0.28, top - r * 0.12);
    g.lineTo(cx + w * 0.42, top);
    g.stroke();
    g.beginPath();
    g.arc(cx, top + h, h * 0.55, 0, TAU);
    g.stroke();
  },
  // The camera struck through, with a gap cut either side of the line (play without a camera).
  noCamera(g, cx, cy, r) {
    const a = r * 0.5;
    const gap = g.lineWidth * 1.5;
    const [ux, uy] = [Math.SQRT1_2 * gap, -Math.SQRT1_2 * gap];
    g.save();
    g.beginPath();
    g.rect(cx - r, cy - r, r * 2, r * 2);
    g.moveTo(cx - r + ux, cy - r + uy);
    g.lineTo(cx + r + ux, cy + r + uy);
    g.lineTo(cx + r - ux, cy + r - uy);
    g.lineTo(cx - r - ux, cy - r - uy);
    g.closePath();
    g.clip('evenodd');
    ICONS.camera(g, cx, cy, r);
    g.restore();
    g.beginPath();
    g.moveTo(cx - a, cy - a);
    g.lineTo(cx + a, cy + a);
    g.stroke();
  },
  // A phone standing upright, with its speaker slot (pair a phone as the camera).
  phone(g, cx, cy, r) {
    const w = r * 0.3;
    const h = r * 0.5;
    g.beginPath();
    g.roundRect(cx - w, cy - h, w * 2, h * 2, r * 0.1);
    g.moveTo(cx - w * 0.3, cy - h * 0.72);
    g.lineTo(cx + w * 0.3, cy - h * 0.72);
    g.stroke();
  },
  close(g, cx, cy, r) {
    const a = r * 0.36;
    g.beginPath();
    g.moveTo(cx - a, cy - a);
    g.lineTo(cx + a, cy + a);
    g.moveTo(cx + a, cy - a);
    g.lineTo(cx - a, cy + a);
    g.stroke();
  },
  // Plus (Settings → Songs: import a song).
  add(g, cx, cy, r) {
    const a = r * 0.4;
    g.beginPath();
    g.moveTo(cx - a, cy);
    g.lineTo(cx + a, cy);
    g.moveTo(cx, cy - a);
    g.lineTo(cx, cy + a);
    g.stroke();
  },
  // Bin (Settings → Songs: remove a song).
  trash(g, cx, cy, r) {
    const a = r * 0.4;
    g.beginPath();
    g.moveTo(cx - a, cy - a * 0.6);
    g.lineTo(cx + a, cy - a * 0.6);
    g.moveTo(cx - a * 0.3, cy - a * 0.6);
    g.lineTo(cx - a * 0.3, cy - a);
    g.lineTo(cx + a * 0.3, cy - a);
    g.lineTo(cx + a * 0.3, cy - a * 0.6);
    g.moveTo(cx - a * 0.7, cy - a * 0.6);
    g.lineTo(cx - a * 0.55, cy + a);
    g.lineTo(cx + a * 0.55, cy + a);
    g.lineTo(cx + a * 0.7, cy - a * 0.6);
    g.stroke();
  },
  pause(g, cx, cy, r) {
    const a = r * 0.4;
    g.beginPath();
    g.moveTo(cx - a * 0.45, cy - a);
    g.lineTo(cx - a * 0.45, cy + a);
    g.moveTo(cx + a * 0.45, cy - a);
    g.lineTo(cx + a * 0.45, cy + a);
    g.stroke();
  },
  // A screen with a triangle rising into it from below: AirPlay (choose where it plays).
  airplay(g, cx, cy, r) {
    const w = r * 0.5;
    const top = cy - r * 0.42;
    const bottom = cy + r * 0.2;
    g.beginPath();
    g.moveTo(cx - w * 0.42, bottom);
    g.lineTo(cx - w, bottom);
    g.lineTo(cx - w, top);
    g.lineTo(cx + w, top);
    g.lineTo(cx + w, bottom);
    g.lineTo(cx + w * 0.42, bottom);
    g.stroke();
    g.save();
    g.fillStyle = g.strokeStyle;
    g.beginPath();
    g.moveTo(cx, cy - r * 0.02);
    g.lineTo(cx + r * 0.3, cy + r * 0.44);
    g.lineTo(cx - r * 0.3, cy + r * 0.44);
    g.closePath();
    g.fill();
    g.restore();
  },
  // An arrow pointing left (go back).
  back(g, cx, cy, r) {
    const a = r * 0.4;
    g.beginPath();
    g.moveTo(cx + a, cy);
    g.lineTo(cx - a, cy);
    g.moveTo(cx - a + a * 0.55, cy - a * 0.55);
    g.lineTo(cx - a, cy);
    g.lineTo(cx - a + a * 0.55, cy + a * 0.55);
    g.stroke();
  },
  // An aero dancer (choose who follows which dancer).
  dancer(g, cx, cy, r) {
    drawDancer(g, cx, cy + r * 0.6, r * 1.24, g.strokeStyle as string);
  },
  // Chevrons: up / down page a list, left / right step through choices.
  up(g, cx, cy, r) { chevron(g, cx, cy, r, -Math.PI / 2); },
  down(g, cx, cy, r) { chevron(g, cx, cy, r, Math.PI / 2); },
  left(g, cx, cy, r) { chevron(g, cx, cy, r, Math.PI); },
  right(g, cx, cy, r) { chevron(g, cx, cy, r, 0); },
} satisfies Record<string, IconDraw>;
export type IconName = keyof typeof ICONS;

function chevron(g: Ctx, cx: number, cy: number, r: number, angle: number) {
  const a = r * 0.3;
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  g.beginPath();
  g.moveTo(-a * 0.6, -a);
  g.lineTo(a * 0.6, 0);
  g.lineTo(-a * 0.6, a);
  g.stroke();
  g.restore();
}

export interface PillOptions {
  label: string;
  sub?: string;
  icon: IconName;
  hover?: number;
  press?: number;
  /** The gear icon's rotation. */
  angle?: number;
  disabled?: boolean;
}

// Glossy aqua bubble button with an icon disc on the left. Disabled buttons fade and stay put.
export function drawPill(g: Ctx, rect: Rect, { label, sub, icon, hover = 0, press = 0, angle, disabled = false }: PillOptions) {
  if (disabled) {
    hover = 0;
    press = 0;
  }
  const lift = hover * 3 - press * 3;
  const { x, w, h } = rect;
  const y = rect.y - lift;

  g.save();
  if (disabled) g.globalAlpha *= 0.5;
  g.save();
  g.shadowColor = `rgba(0, 50, 110, ${0.4 + hover * 0.1})`;
  g.shadowBlur = 24 + hover * 10;
  g.shadowOffsetY = 8;
  pill(g, x, y, w, h);
  const body = g.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, '#f4feff');
  body.addColorStop(0.48, `rgb(${200 + hover * 20}, ${244 + hover * 6}, 255)`);
  body.addColorStop(0.52, '#a9ecf6');
  body.addColorStop(1, '#7fdcef');
  g.fillStyle = body;
  g.fill();
  g.restore();

  // Glossy upper sheen.
  g.save();
  pill(g, x, y, w, h);
  g.clip();
  const sheen = g.createLinearGradient(0, y, 0, y + h * 0.5);
  sheen.addColorStop(0, 'rgba(255,255,255,0.85)');
  sheen.addColorStop(1, 'rgba(255,255,255,0.15)');
  g.fillStyle = sheen;
  pill(g, x + 10, y + 5, w - 20, h * 0.46);
  g.fill();
  g.restore();

  pill(g, x, y, w, h);
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.stroke();

  const cx = x + h / 2 + 2;
  const cy = y + h / 2;
  const r = h / 2 - 12;
  drawDisc(g, cx, cy, r);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = 6;
  g.strokeStyle = '#ffffff';
  if (icon === 'gear') ICONS.gear(g, cx, cy, r, angle);
  else ICONS[icon](g, cx, cy, r);

  g.fillStyle = NAVY;
  g.font = `700 ${Math.round(h * (sub ? 0.34 : 0.4))}px ${FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  if ('letterSpacing' in g) g.letterSpacing = '-1px';
  g.fillText(label, x + h + 14, sub ? cy - h * 0.13 : cy + 2);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  if (sub) {
    g.fillStyle = 'rgba(12, 47, 82, 0.7)';
    g.font = `600 ${Math.round(h * 0.22)}px ${FONT}`;
    g.fillText(sub, x + h + 15, cy + h * 0.2);
  }
  g.restore();
}

/** A glass button's corner radius for its height (give the widget `corner` so the focus ring follows it). */
export const glassCorner = (h: number) => Math.round(h * 0.24);

/**
 * The title buttons' looks: the five mockups in order, then dark (the players dial's glass
 * circles' blue). ?buttons=1..6 picks one (menu/MainMenu.tsx).
 */
export const GLASS_STYLES = ['tile', 'milk', 'porcelain', 'clear', 'frost', 'dark'] as const;
export type GlassStyle = typeof GLASS_STYLES[number];

export type GlassButtonOptions = Omit<PillOptions, 'icon'> & {
  /** One of ICONS, or a drawing of its own where the icon goes. */
  icon: IconName | IconDraw;
  style?: GlassStyle;
  /** Show the chevron on the right; the style decides by default. */
  chevron?: boolean;
  /** Room kept clear at the right end, for `content`: the label and line under it stop short of it. */
  reserve?: number;
  /** Draws more inside the button, given where it is drawn (it lifts under the pointer). */
  content?: (g: Ctx, rect: Rect) => void;
};

type Stops = readonly [top: string, bottom: string];
interface GlassLook {
  /** The body's colour at the top and bottom, over the blur, and what is added over it at full hover. */
  body: Stops;
  hover: string;
  /** The white sheen's opacity at the top. */
  sheen: number;
  /** A soft white glow just inside the rim. */
  glow: boolean;
  /** The rim's colour at the top and bottom, its width, and the white opacity added at full hover. */
  rim: Stops;
  rimWidth: number;
  rimHover: number;
  /** Label (and chevron) colour, and the label's size as a fraction of the height. */
  ink: string;
  size: number;
  /** A dark drop shadow under white ink: colour, blur, y offset. */
  shadow: readonly [string, number, number] | null;
  /** The icon sits on a glossy coloured tile (its colours by icon), else straight on the glass. */
  tile: ((icon: IconName) => Stops) | null;
  /** The play triangle filled rather than outlined. */
  filled: boolean;
  chevron: boolean;
}
const BLUE_TILE: Stops = ['#7fd3ff', '#1f82e2'];
const INK_SHADOW = ['rgba(0, 40, 60, 0.45)', 6, 2] as const;
const BIG_INK_SHADOW = ['rgba(0, 30, 50, 0.7)', 8, 3] as const;
// The mockups' glass: brightening while hovered, a glow inside a bright rim that fades downwards.
const BRIGHT = {
  hover: 'rgba(255,255,255,0.1)', glow: true, rim: ['rgba(255,255,255,0.95)', 'rgba(255,255,255,0.5)'], rimWidth: 2.5, rimHover: 0,
} as const;
const FROSTED: Stops = ['rgba(240, 255, 250, 0.3)', 'rgba(240, 255, 250, 0.15)'];
const DIAL_BLUE = 'rgba(20, 90, 160, 0.35)';
const LOOKS: Record<GlassStyle, GlassLook> = {
  // 1: frosted, white label, icons on blue tiles.
  tile: {
    ...BRIGHT, body: FROSTED, sheen: 0.2, ink: '#ffffff', size: 0.33,
    shadow: INK_SHADOW, tile: () => BLUE_TILE, filled: false, chevron: false,
  },
  // 2: milky white, navy label, blue and teal tiles, grey chevron.
  milk: {
    ...BRIGHT, body: ['rgba(246, 255, 252, 0.78)', 'rgba(232, 250, 243, 0.6)'], sheen: 0.35, ink: '#1c3a55', size: 0.33,
    shadow: null, tile: (icon) => (icon === 'gear' ? ['#86f2de', '#1cb5a3'] : BLUE_TILE), filled: true, chevron: true,
  },
  // 3: near-opaque porcelain fading to mint, navy label, blue and sky tiles, grey chevron.
  porcelain: {
    ...BRIGHT, body: ['rgba(252, 255, 254, 0.94)', 'rgba(220, 245, 237, 0.86)'], sheen: 0.4, ink: '#1c3a55', size: 0.33,
    shadow: null, tile: (icon) => (icon === 'gear' ? ['#d2f5ff', '#5cc4ec'] : BLUE_TILE), filled: true, chevron: true,
  },
  // 4: frosted, white outline icons and label.
  clear: {
    ...BRIGHT, body: FROSTED, sheen: 0.2, ink: '#ffffff', size: 0.33,
    shadow: INK_SHADOW, tile: null, filled: false, chevron: false,
  },
  // 5: frosted, filled play, white chevron; a larger label with a stronger shadow so it reads.
  frost: {
    ...BRIGHT, body: FROSTED, sheen: 0.2, ink: '#ffffff', size: 0.37,
    shadow: BIG_INK_SHADOW, tile: null, filled: true, chevron: true,
  },
  // 6: the players dial's glass circles (drawGlassCircle): see-through blue, deepening while
  // hovered, a faint top highlight and a white rim that brightens; frost's label and icons.
  dark: {
    body: [DIAL_BLUE, DIAL_BLUE], hover: 'rgba(20, 90, 160, 0.15)', sheen: 0.16, glow: false,
    rim: ['rgba(255,255,255,0.65)', 'rgba(255,255,255,0.65)'], rimWidth: 3, rimHover: 0.35,
    ink: '#ffffff', size: 0.37, shadow: BIG_INK_SHADOW, tile: null, filled: true, chevron: false,
  },
};

/** Where a glass button's label starts, in design units (after its icon or tile). */
export const glassLabelX = ({ x, h }: Rect, style: GlassStyle = 'dark') => x + h * (LOOKS[style].tile ? 1.08 : 1.05);

// A glossy rounded-square tile for a glass button's icon.
function drawIconTile(g: Ctx, x: number, y: number, s: number, [top, bottom]: Stops) {
  const r = s * 0.26;
  g.save();
  roundRect(g, x, y, s, s, r);
  const fill = g.createLinearGradient(0, y, 0, y + s);
  fill.addColorStop(0, top);
  fill.addColorStop(1, bottom);
  g.fillStyle = fill;
  g.fill();
  g.clip();
  const gloss = g.createLinearGradient(0, y, 0, y + s * 0.5);
  gloss.addColorStop(0, 'rgba(255,255,255,0.6)');
  gloss.addColorStop(1, 'rgba(255,255,255,0.05)');
  g.fillStyle = gloss;
  roundRect(g, x + 2, y + 2, s - 4, s * 0.48, r * 0.85);
  g.fill();
  g.restore();
  roundRect(g, x, y, s, s, r);
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.stroke();
}

// Glass button (the title menu) in one of GLASS_STYLES: a rounded slab with a bright rim, its
// icon, label and maybe a chevron. ui/useGlassBlur.ts blurs the world inside it; nothing
// outside it is blurred or shadowed. Disabled buttons fade and stay put.
export function drawGlassButton(g: Ctx, rect: Rect, { label, sub, icon, hover = 0, press = 0, angle, disabled = false, style = 'dark', chevron, reserve = 0, content }: GlassButtonOptions) {
  if (disabled) {
    hover = 0;
    press = 0;
  }
  const look = LOOKS[style];
  const lift = hover * 3 - press * 3;
  const { x, w, h } = rect;
  const y = rect.y - lift;
  const r = glassCorner(h);
  const shape = () => roundRect(g, x, y, w, h, r);

  g.save();
  if (disabled) g.globalAlpha *= 0.5;

  // Body over the blur, changing while hovered.
  shape();
  const body = g.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, look.body[0]);
  body.addColorStop(1, look.body[1]);
  g.fillStyle = body;
  g.fill();
  if (hover > 0.01) {
    g.save();
    g.globalAlpha *= hover;
    g.fillStyle = look.hover;
    g.fill();
    g.restore();
  }

  // Sheen over the top half, and maybe a soft glow just inside the rim.
  g.save();
  shape();
  g.clip();
  const sheen = g.createLinearGradient(0, y, 0, y + h * 0.55);
  sheen.addColorStop(0, `rgba(255,255,255,${look.sheen})`);
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(x, y, w, h * 0.55);
  if (look.glow) {
    g.shadowColor = 'rgba(255,255,255,0.8)';
    g.shadowBlur = 14;
    shape();
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.stroke();
  }
  g.restore();

  // The rim, brightening while hovered.
  shape();
  const rim = g.createLinearGradient(0, y, 0, y + h);
  rim.addColorStop(0, look.rim[0]);
  rim.addColorStop(1, look.rim[1]);
  g.lineWidth = look.rimWidth;
  g.strokeStyle = rim;
  g.stroke();
  if (look.rimHover && hover > 0.01) {
    g.strokeStyle = `rgba(255,255,255,${look.rimHover * hover})`;
    g.stroke();
  }

  const cy = y + h / 2;
  g.save();
  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const glyph = (cx: number, ir: number) => {
    if (typeof icon === 'function') icon(g, cx, cy, ir);
    else if (icon === 'gear') ICONS.gear(g, cx, cy, ir, angle);
    else ICONS[icon](g, cx, cy, ir);
    if (icon === 'play' && look.filled) g.fill();
  };
  if (look.tile) {
    // The icon in white on its tile.
    const s = h * 0.66;
    drawIconTile(g, x + h * 0.2, cy - s / 2, s, look.tile(typeof icon === 'string' ? icon : 'note'));
    g.lineWidth = 3.5;
    glyph(x + h * 0.2 + s / 2, s * 0.5);
  } else {
    // White icon straight on the glass, shadowed like the label.
    if (look.shadow) [g.shadowColor, g.shadowBlur, g.shadowOffsetY] = look.shadow;
    g.lineWidth = 4;
    glyph(x + h * 0.55, h * 0.4);
  }
  g.restore();

  // Label (and a smaller line under it), shortened to fit before the chevron, then the chevron.
  const arrow = chevron ?? look.chevron;
  const lx = glassLabelX(rect, style);
  const room = x + w - lx - h * (arrow ? 0.62 : 0.3) - reserve;
  g.save();
  if (look.shadow) [g.shadowColor, g.shadowBlur, g.shadowOffsetY] = look.shadow;
  g.fillStyle = look.ink;
  g.font = `800 ${Math.round(h * look.size * (sub ? 0.85 : 1))}px ${FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  if ('letterSpacing' in g) g.letterSpacing = '-0.5px';
  g.fillText(ellipsize(g, label, room), lx, sub ? cy - h * 0.13 : cy + 1);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  if (sub) {
    g.globalAlpha *= 0.82;
    g.font = `600 ${Math.round(h * 0.22)}px ${FONT}`;
    g.fillText(ellipsize(g, sub, room), lx + 1, cy + h * 0.2);
    g.globalAlpha /= 0.82;
  }
  if (arrow) {
    g.strokeStyle = look.ink;
    g.globalAlpha *= look.shadow ? 0.85 : 0.45;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 3.5;
    ICONS.right(g, x + w - h * 0.42 + hover * 4, cy, h * 0.3);
  }
  g.restore();
  if (content) content(g, { x, y, w, h });
  g.restore();
}

export function drawGlassCircle(g: Ctx, c: Circle, hover: number) {
  g.save();
  g.shadowColor = 'rgba(0, 34, 84, 0.45)';
  g.shadowBlur = 16;
  g.shadowOffsetY = 4;
  g.beginPath();
  g.arc(c.x, c.y, c.r, 0, TAU);
  g.fillStyle = `rgba(20, 90, 160, ${0.35 + hover * 0.15})`;
  g.fill();
  g.restore();
  g.beginPath();
  g.arc(c.x, c.y, c.r, 0, TAU);
  g.lineWidth = 3;
  g.strokeStyle = `rgba(255,255,255,${0.65 + hover * 0.35})`;
  g.stroke();
  g.beginPath();
  g.ellipse(c.x, c.y - c.r * 0.45, c.r * 0.7, c.r * 0.38, 0, 0, TAU);
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fill();
}

// Submenu header: glass back button (circle `back`) and a small-caps heading beside it.
export function drawHeader(g: Ctx, back: Circle, label: string, hover: number) {
  const { x, y, r } = back;
  drawGlassCircle(g, back, hover);
  const a = r * 0.4 + hover * 2;
  g.beginPath();
  g.moveTo(x + a, y);
  g.lineTo(x - a, y);
  g.moveTo(x - a + 11, y - 11);
  g.lineTo(x - a, y);
  g.lineTo(x - a + 11, y + 11);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = 4;
  g.strokeStyle = '#ffffff';
  g.stroke();

  drawCaps(g, label, x + r + 22, y + 1);
}

// White small-caps label with a navy drop shadow (headers, panel titles).
export function drawCaps(g: Ctx, label: string, x: number, y: number, { size = 26, align = 'left' }: { size?: number; align?: CanvasTextAlign } = {}) {
  g.save();
  g.font = `800 ${size}px ${FONT}`;
  if ('letterSpacing' in g) g.letterSpacing = `${Math.round(size * 0.23)}px`;
  g.textBaseline = 'middle';
  g.textAlign = align;
  g.shadowColor = 'rgba(0, 34, 84, 0.7)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 3;
  g.fillStyle = '#ffffff';
  g.fillText(label, x, y);
  g.restore();
}

// Deep-blue glass panel (the settings panel look) for cards and sheets.
export function drawGlassPanel(g: Ctx, { x, y, w, h }: Rect, radius = 34) {
  g.save();
  g.shadowColor = 'rgba(0, 30, 80, 0.45)';
  g.shadowBlur = 30;
  g.shadowOffsetY = 10;
  roundRect(g, x, y, w, h, radius);
  const body = g.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, 'rgba(34, 120, 196, 0.82)');
  body.addColorStop(1, 'rgba(6, 52, 116, 0.88)');
  g.fillStyle = body;
  g.fill();
  g.restore();
  g.save();
  roundRect(g, x, y, w, h, radius);
  g.clip();
  const sheen = g.createLinearGradient(0, y, 0, y + 70);
  sheen.addColorStop(0, 'rgba(255,255,255,0.28)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(x, y, w, 70);
  g.restore();
  roundRect(g, x, y, w, h, radius);
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.stroke();
}

// The dark glass buttons' panel (Settings): see-through blue with a faint top highlight and a
// white rim, no shadow. ui/useGlassBlur.ts blurs the world inside it.
export function drawDarkGlassPanel(g: Ctx, { x, y, w, h }: Rect, radius = 34) {
  const dark = LOOKS.dark;
  roundRect(g, x, y, w, h, radius);
  g.fillStyle = dark.body[0];
  g.fill();
  g.save();
  g.clip();
  const sheen = g.createLinearGradient(0, y, 0, y + 70);
  sheen.addColorStop(0, `rgba(255,255,255,${dark.sheen})`);
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(x, y, w, 70);
  g.restore();
  roundRect(g, x, y, w, h, radius);
  g.lineWidth = dark.rimWidth;
  g.strokeStyle = dark.rim[0];
  g.stroke();
}

export interface TextOptions {
  size?: number;
  weight?: number;
  align?: CanvasTextAlign;
  color?: string;
}

// White text with the navy drop shadow used over the bright world.
export function drawShadowText(g: Ctx, text: string, x: number, y: number, { size = 30, weight = 700, align = 'left', color = '#ffffff', alpha = 1 }: TextOptions & { alpha?: number } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0, 34, 84, 0.75)';
  g.shadowBlur = size * 0.2;
  g.shadowOffsetY = Math.max(2, size * 0.08);
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.restore();
}

// Shortens text with an ellipsis to fit maxW in the current font.
export function ellipsize(g: Ctx, text: string, maxW: number) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

// Text wider than maxW (in the current font, left-aligned) holds still for MARQUEE_HOLD_MS, then
// scrolls left and comes round again after a gap, faded where it's cut off, like the now-playing
// marquee on jamie's Pi display. elapsed (ms) is how long it's been showing. With
// prefers-reduced-motion it's ellipsized instead. color is #rrggbb. Returns the ms until it next moves (0 while it
// does, Infinity when it never will), so a demand-driven overlay knows when to draw again.
export const MARQUEE_HOLD_MS = 3000;
const MARQUEE_SPEED = 40;
const MARQUEE_GAP = 48;
const MARQUEE_FADE = 14;
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function drawMarquee(g: Ctx, str: string, x: number, y: number, maxW: number, color: `#${string}`, elapsed: number) {
  g.fillStyle = color;
  const m = g.measureText(str);
  if (m.width <= maxW) { g.fillText(str, x, y); return Infinity; }
  if (reduceMotion) { g.fillText(ellipsize(g, str, maxW), x, y); return Infinity; }
  const distance = m.width + MARQUEE_GAP;
  const scrollMs = (distance / MARQUEE_SPEED) * 1000;
  const phase = Math.max(0, elapsed) % (MARQUEE_HOLD_MS + scrollMs);
  const offset = phase <= MARQUEE_HOLD_MS ? 0 : ((phase - MARQUEE_HOLD_MS) / scrollMs) * distance;
  g.save();
  g.beginPath();
  g.rect(x, y - m.actualBoundingBoxAscent - 6, maxW, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 12);
  g.clip();
  // The text's own colour fading out at the cut edges (the left one only once it's moving).
  const fade = g.createLinearGradient(x, 0, x + maxW, 0);
  const edge = MARQUEE_FADE / maxW;
  fade.addColorStop(0, offset > 0 ? `${color}00` : color);
  fade.addColorStop(edge, color);
  fade.addColorStop(1 - edge, color);
  fade.addColorStop(1, `${color}00`);
  g.fillStyle = fade;
  g.fillText(str, x - offset, y);
  g.fillText(str, x - offset + distance, y);
  g.restore();
  return phase <= MARQUEE_HOLD_MS ? MARQUEE_HOLD_MS - phase : 0;
}

// Splits text into lines no wider than maxW in the current font.
export function wrapText(g: Ctx, text: string, maxW: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && g.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Plain text, vertically centred on y.
export function text(g: Ctx, str: string, x: number, y: number, { size = 28, weight = 600, color = '#ffffff', align = 'left' }: TextOptions = {}) {
  g.font = `${weight} ${size}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(str, x, y);
}

// Wrapped text from y down; returns the height it took.
export function paragraph(g: Ctx, str: string, x: number, y: number, maxW: number, { size = 26, weight = 600, color = 'rgba(255,255,255,0.88)', align = 'left', lineH = size * 1.35 }: TextOptions & { lineH?: number } = {}) {
  g.font = `${weight} ${size}px ${FONT}`;
  const lines = wrapText(g, str, maxW);
  lines.forEach((line, i) => text(g, line, x, y + i * lineH, { size, weight, color, align }));
  return lines.length * lineH;
}

// Connection status colours: green when live, amber while connecting.
export const STATUS_COLORS: Record<WebcamStatus, string> = {
  connected: '#3ad68a',
  connecting: '#ffc44d',
  initializing: '#ffc44d',
  error: '#ff6b70',
  disconnected: '#9db4bf',
};

// Glossy status light.
export function drawStatusDot(g: Ctx, x: number, y: number, status: WebcamStatus, r = 10) {
  const color = STATUS_COLORS[status];
  g.save();
  g.shadowColor = color;
  g.shadowBlur = status === 'disconnected' ? 0 : r;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = color;
  g.fill();
  g.restore();
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.stroke();
  g.beginPath();
  g.ellipse(x, y - r * 0.4, r * 0.55, r * 0.3, 0, 0, TAU);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fill();
}

// Glossy track filling to t (0..1), with a knob while hovered or dragged (scrubbing).
export function drawProgress(g: Ctx, rect: Rect, t: number, { hover = 0, knob = false }: { hover?: number; knob?: boolean } = {}) {
  const k = Math.min(1, Math.max(0, t));
  const { x, y, w, h } = rect;
  roundRect(g, x, y, w, h, h / 2);
  g.fillStyle = 'rgba(0, 30, 70, 0.4)';
  g.fill();
  if (k > 0) {
    roundRect(g, x, y, Math.max(h, w * k), h, h / 2);
    const fill = g.createLinearGradient(0, y, 0, y + h);
    fill.addColorStop(0, '#b9fff0');
    fill.addColorStop(1, '#2fc7d8');
    g.fillStyle = fill;
    g.fill();
  }
  roundRect(g, x, y, w, h, h / 2);
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.stroke();
  if (!knob) return;
  const kx = x + w * k;
  const cy = y + h / 2;
  g.save();
  g.shadowColor = 'rgba(0, 30, 70, 0.5)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.beginPath();
  g.arc(kx, cy, h * 0.75 + hover * 3, 0, TAU);
  const body = g.createLinearGradient(0, cy - h, 0, cy + h);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(1, '#bfeff8');
  g.fillStyle = body;
  g.fill();
  g.restore();
}

// ---------- Frutiger Aero celebration ----------

/** Headline in the wordmark's treatment: dark halo, hard drop shadow, glossy tinted face. */
export function drawHeadline(g: Ctx, str: string, x: number, y: number, size: number, face: Face, maxW?: number) {
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${-size * 0.015}px`;
  g.font = `800 ${size}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.shadowColor = 'rgba(0, 28, 70, 0.55)';
  g.shadowBlur = 46;
  g.shadowOffsetY = 10;
  g.fillStyle = 'rgba(0, 40, 90, 0.35)';
  g.fillText(str, x, y, maxW);
  g.shadowColor = 'rgba(0, 34, 84, 0.75)';
  g.shadowBlur = 4;
  g.shadowOffsetY = size * 0.09;
  g.fillStyle = '#ffffff';
  g.fillText(str, x, y, maxW);
  g.shadowColor = 'transparent';
  const grad = g.createLinearGradient(0, y - size * 0.75, 0, y);
  grad.addColorStop(0, face[0]);
  grad.addColorStop(0.5, face[1]);
  grad.addColorStop(1, face[2]);
  g.fillStyle = grad;
  g.fillText(str, x, y, maxW);
  g.restore();
}
