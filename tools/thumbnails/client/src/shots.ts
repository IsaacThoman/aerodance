import { isStageId } from '../../../../packages/stages/catalog.ts';
import type { DancerPlacement, StageId, Vec3 } from '../../../../packages/stages/catalog.ts';
import type { PostOverrides } from '../../../../packages/stages/shared/post.tsx';

// The game renders 640x480 and shows it at 16:9 (4:3-wide pixels). Cropped to 3:2 that
// grid is 540x480; each buffer pixel becomes a 4x3 block in the 2160x1440 PNG. An Apple TV
// app icon is 5:3: the same grid at 600x480, or 2400x1440. A phone's app icon is square: the
// same grid at 360x480, or 1440x1440. A splash screen is the game's whole 16:9 frame: 640x480,
// or 2560x1440.
export type ShotFormat = 'thumbnail' | 'tv-icon' | 'app-icon' | 'widescreen';
export interface FrameBuffer { width: number; height: number; aspect: number; }
const BUFFERS: Record<ShotFormat, FrameBuffer> = {
  thumbnail: { width: 540, height: 480, aspect: 3 / 2 },
  'tv-icon': { width: 600, height: 480, aspect: 5 / 3 },
  'app-icon': { width: 360, height: 480, aspect: 1 },
  widescreen: { width: 640, height: 480, aspect: 16 / 9 },
};
export const bufferFor = (shot: Shot): FrameBuffer => BUFFERS[shot.format ?? 'thumbnail'];
export const UPSCALE: readonly [x: number, y: number] = [4, 3];
// Wordmark layout units: the title menu's scale (its 1600x900 maps to 640x480), 900 high.
export const designFor = (buffer: FrameBuffer) => ({ width: 900 * buffer.aspect, height: 900 });

/*
 * One entry per thumbnail. Each renders with and without the wordmark.
 *   stage: stage id (packages/stages)
 *   time: seconds the stage plays before the capture (lights, water, creatures, beat)
 *   pose: seconds into the dance capture the dancers hold (0-14)
 *   camera: { position, target, fov, near?, far?, shift? }: shift [x, y] slides the picture
 *     without turning the camera, in frame widths and heights: [0.2, 0] moves it a fifth left
 *   dancers: overrides for the stage's dancer placement ({ position, rotationY, spacing })
 *   logo: { y: baseline, size, x?: 'left' | 'right' | number (default centered), stacked?: two lines,
 *     outline?, halo?, light?: see drawTitle } in design units
 *   format: 'thumbnail' (3:2, the default), 'tv-icon' (5:3), 'app-icon' (1:1) or 'widescreen' (16:9)
 *   layers: split the frame into layers for a parallax icon (ShotLayer)
 *   reflections: the dancers reflect the scene around them, captured in-engine at the camera's
 *     target with them hidden, at this brightness (1 as lit), instead of the stage's environment
 *     map: e.g. as dark as a back layer's exposure
 *   panels: with reflections, soft light panels the dancers reflect too, like a studio's softboxes:
 *     each at `from` (relative to the camera's target) facing it, `size` [w, h], and `intensity`
 *     its brightness in the reflections, whatever their brightness: { from, size, color?, intensity }
 */
export interface ShotCamera { position: Vec3; target: Vec3; fov?: number; near?: number; far?: number; shift?: readonly [x: number, y: number]; }
export interface ShotLogo { y: number; size: number; x?: 'left' | 'right' | number; stacked?: boolean; outline?: number; halo?: number; light?: 200 | 300 | 400; }
/**
 * One layer of a layered (parallax) image, back to front. Each layer is the shot rendered with
 * the camera's near plane at `near`, cutting away nearer scenery, and with the dancers shown or
 * hidden (their shadows stay). It keeps the pixels that differ from the layer behind it, so each
 * layer must show everything the one behind it does: `near` never grows, and once the dancers
 * are shown they stay. The wordmark, if any, is one more layer, on top unless a `wordmark` entry
 * puts it lower in the stack.
 * seeThrough: on the layer that adds the dancers, keep their glass partly transparent, so the
 * layers behind show through them as they move, instead of what was behind them in the shot.
 * wordmark: this entry is where the wordmark goes, rendering nothing itself.
 * hidden: render the layer (so the one above is cut against it) but leave it out of the image.
 * dancerParts: with the dancers, only their bodies (heads, eyes and feet too) or only their
 * floating hands; the other part draws nothing but still casts its shadow.
 * blur: soften the layer like a shallow depth of field: a Gaussian blur, its sigma in pixels of
 * a 1280-wide image (scaled with the size the layer is written at).
 * exposure: on the back layer only, scale the camera's exposure it's rendered with, before the
 * grade and tone mapping: below 1 for a darker sky. (A layer in front at the same depth is cut
 * against the colours of the one behind, so they must share an exposure.)
 */
export type DancerPart = 'body' | 'hands';
export interface ShotLayer {
  name: string; near?: number; dancers?: boolean; seeThrough?: boolean; wordmark?: boolean; hidden?: boolean; blur?: number;
  dancerParts?: DancerPart; exposure?: number;
}
export interface Shot {
  id: string;
  stage: StageId;
  time: number;
  pose: number;
  camera: ShotCamera;
  dancers?: Partial<DancerPlacement>;
  logo?: ShotLogo;
  format?: ShotFormat;
  layers?: readonly ShotLayer[];
  reflections?: number;
  panels?: readonly ShotPanel[];
  /** Per dancer (0 blue, 1 purple): a hand-set pose, null to leave them out, or unset for the capture. */
  figures?: readonly (FigurePose | null | undefined)[];
  /** Changes to the stage's post-processing, held every frame (exposure, saturation, tint, vignette, bloom). */
  post?: Omit<PostOverrides, 'toneMapping'>;
  /** Scales the stage's environment map (the glass's reflections). */
  environment?: number;
  /** Scene fog colour and density override (exp2), for dark rooms. */
  fog?: { color: string; density: number };
  /** Background colour instead of the stage's sky. */
  background?: string;
  lights?: readonly ShotLight[];
  /** Leave the stage's own scenery and lights out (its environment map stays), e.g. for a room alone. */
  hideStage?: boolean;
  room?: ShotRoom;
  /** A security camera's film over the finished frame: grain and scanline strength (0-1). */
  overlay?: { grain?: number; scanlines?: number };
}
/**
 * A dingy back room's corner built into the shot, in world space:
 *   position: the corner on the floor, where the back wall meets the side wall; rotationY turns
 *     the room about it. The back wall runs `size[0]` to the left (-x) of the corner, facing +z;
 *     the side wall runs `side[1]` forward (+z) from it, `side[0]` thick (thick and short for a pillar).
 *   size: [width, depth, height] (default [8, 6, 4.5]); the floor reaches `width` past the corner too
 *   tile: the floor's checker size (default 0.34, rounded to fit 2 units evenly)
 *   colors: floor [light, dark], walls, trim tiles [a, b]; gloss: the floor's clearcoat (0-1);
 *     wear: how grimy the floor and walls are (default 1, 0 for clean)
 *   trim: [bottom, height] of the tiled band along the walls (default [1.7, 0.36])
 *   cables: [left, out] where each cable hangs from above: `left` of the corner along the back
 *     wall, `out` from it
 */
export interface ShotRoom {
  position: Vec3; rotationY?: number; size?: Vec3; side?: readonly [thickness: number, length: number];
  tile?: number; gloss?: number; wear?: number; trim?: readonly [bottom: number, height: number];
  cables?: readonly (readonly [left: number, out: number])[];
  colors?: { floor?: readonly [string, string]; wall?: string; trim?: readonly [string, string] };
}
/**
 * A hand-set pose for one dancer instead of the capture, in the dancer's own space before the
 * stage mirrors it (feet on the floor at y 0, facing +z, ~2.6 tall standing):
 *   root: [x, y, z] of the rig's root (y -0.55 sits the body's flat bottom on the floor)
 *   body: [pitch, yaw, roll] of the body about its pivot (1.1 above the root); +pitch leans forward
 *   head: [pitch, yaw, roll] of the head about its neck (1 above the body pivot)
 *   hands: [right-of-screen, left-of-screen] hand centres (each a 0.33 sphere)
 *   feet: the two foot centres (0.43 x 0.275 x 0.40 ovals); footTurn: [pitch, yaw, roll] of each
 *     (-1.5 pitch stands them on their heels, soles to the front)
 *   look: the dancer's colour, gloss (0-100), opacity and accessory; hat: a black top hat tipped
 *     by [pitch, roll]
 */
export interface FigurePose {
  root?: Vec3; body?: Vec3; head?: Vec3;
  hands?: readonly [Vec3, Vec3]; feet?: readonly [Vec3, Vec3]; footTurn?: readonly [Vec3, Vec3];
  look?: { color?: string; gloss?: number; opacity?: number; accessory?: string };
  hat?: readonly [pitch: number, roll: number];
}
/** An extra spotlight for the shot, like a flashlight: angle (radians) and penumbra as three.js's. */
export interface ShotLight {
  position: Vec3; target: Vec3; color?: string; intensity: number; angle?: number; penumbra?: number; shadow?: boolean;
}
export interface ShotPanel { from: Vec3; size: readonly [w: number, h: number]; color?: string; intensity: number; }

/** One capture read back from the page: base64 RGBA, top row first. */
export interface ThumbnailFrame {
  width: number;
  height: number;
  plain: string;
  logo: string | null;
  /** The shot's layers, back to front, with the wordmark last: transparent outside each layer. */
  layers: { name: string; rgba: string }[] | null;
}
/** What the capture page exposes to scripts/render.ts as window.__thumb. */
export interface ThumbnailPage {
  shot: Shot;
  /** The WebGL renderer string, for the log. */
  renderer: string;
  render(): Promise<ThumbnailFrame>;
}
export type ThumbnailWindow = typeof window & { __thumb?: ThumbnailPage };

// One-off shots come in as JSON (?spec=, --spec): check them before rendering.
type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optionalNumber = (v: unknown) => v === undefined || isNumber(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNumber);
const isCamera = (v: unknown): v is ShotCamera => isFields(v) && isVec3(v.position) && isVec3(v.target) &&
  optionalNumber(v.fov) && optionalNumber(v.near) && optionalNumber(v.far) &&
  (v.shift === undefined || (Array.isArray(v.shift) && v.shift.length === 2 && v.shift.every(isNumber)));
const isDancers = (v: unknown): v is Partial<DancerPlacement> => isFields(v) && (v.position === undefined || isVec3(v.position)) &&
  optionalNumber(v.rotationY) && optionalNumber(v.spacing) && optionalNumber(v.scale);
const isLogo = (v: unknown): v is ShotLogo => isFields(v) && isNumber(v.y) && isNumber(v.size) &&
  (v.x === undefined || v.x === 'left' || v.x === 'right' || isNumber(v.x)) && (v.stacked === undefined || typeof v.stacked === 'boolean') &&
  optionalNumber(v.outline) && optionalNumber(v.halo) && (v.light === undefined || v.light === 200 || v.light === 300 || v.light === 400);

const optionalBoolean = (v: unknown) => v === undefined || typeof v === 'boolean';
const isLayer = (v: unknown): v is ShotLayer => isFields(v) && typeof v.name === 'string' && optionalNumber(v.near) &&
  optionalBoolean(v.dancers) && optionalBoolean(v.seeThrough) && optionalBoolean(v.wordmark) && optionalBoolean(v.hidden) && optionalNumber(v.blur) && optionalNumber(v.exposure) &&
  (v.dancerParts === undefined || v.dancerParts === 'body' || v.dancerParts === 'hands');
const isPanel = (v: unknown): v is ShotPanel => isFields(v) && isVec3(v.from) && isNumber(v.intensity) &&
  Array.isArray(v.size) && v.size.length === 2 && v.size.every(isNumber) && (v.color === undefined || typeof v.color === 'string');
// Each rendered layer shows everything the one behind it does (see ShotLayer); one wordmark at most.
const isLayerStack = (v: unknown) => {
  if (!Array.isArray(v) || !v.every(isLayer) || v.filter((layer) => layer.wordmark).length > 1) return false;
  const rendered = v.filter((layer) => !layer.wordmark);
  return rendered.length > 0 && rendered.every((layer, i) => i === 0 || (layer.exposure === undefined &&
    (layer.near ?? 0) <= (rendered[i - 1].near ?? 0) && (layer.dancers || !rendered[i - 1].dancers)));
};
const optionalString = (v: unknown) => v === undefined || typeof v === 'string';
const isPair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isNumber);
const optional = (v: unknown, is: (v: unknown) => boolean) => v === undefined || is(v);
const isVec3Pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isVec3);
const isFigure = (v: unknown) => v === null || v === undefined || (isFields(v) &&
  optional(v.root, isVec3) && optional(v.body, isVec3) && optional(v.head, isVec3) && optional(v.hands, isVec3Pair) &&
  optional(v.feet, isVec3Pair) && optional(v.footTurn, isVec3Pair) && optional(v.hat, isPair) &&
  optional(v.look, (l) => isFields(l) && optionalString(l.color) && optionalNumber(l.gloss) && optionalNumber(l.opacity) && optionalString(l.accessory)));
const isPost = (v: unknown) => isFields(v) && optionalNumber(v.exposure) && optionalNumber(v.saturation) && optionalNumber(v.vignette) &&
  optional(v.tint, isVec3) && optionalNumber(v.bloomStrength) && optionalNumber(v.bloomThreshold) && optionalNumber(v.bloomRadius);
const isLight = (v: unknown) => isFields(v) && isVec3(v.position) && isVec3(v.target) && optionalString(v.color) && isNumber(v.intensity) &&
  optionalNumber(v.angle) && optionalNumber(v.penumbra) && optionalBoolean(v.shadow);
const isStringPair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'string');
const isRoom = (v: unknown) => isFields(v) && isVec3(v.position) && optionalNumber(v.rotationY) && optional(v.size, isVec3) &&
  optional(v.side, isPair) && optionalNumber(v.tile) && optionalNumber(v.gloss) && optionalNumber(v.wear) && optional(v.trim, isPair) &&
  optional(v.cables, (c) => Array.isArray(c) && c.every(isPair)) &&
  optional(v.colors, (c) => isFields(c) && optional(c.floor, isStringPair) && optionalString(c.wall) && optional(c.trim, isStringPair));
// A shot's own scene, from its figures to its overlay: see Shot.
const isShotLook = (shot: Fields) => optional(shot.figures, (f) => Array.isArray(f) && f.every(isFigure)) && optional(shot.post, isPost) &&
  optionalNumber(shot.environment) && optional(shot.fog, (f) => isFields(f) && typeof f.color === 'string' && isNumber(f.density)) &&
  optionalString(shot.background) && optional(shot.lights, (l) => Array.isArray(l) && l.every(isLight)) &&
  optionalBoolean(shot.hideStage) && optional(shot.room, isRoom) &&
  optional(shot.overlay, (o) => isFields(o) && optionalNumber(o.grain) && optionalNumber(o.scanlines));

export function assertShot(shot: unknown): asserts shot is Shot {
  if (!isFields(shot) || typeof shot.id !== 'string' || !isStageId(shot.stage) || !isNumber(shot.time) || !isNumber(shot.pose) ||
      !isCamera(shot.camera) || !(shot.dancers === undefined || isDancers(shot.dancers)) || !(shot.logo === undefined || isLogo(shot.logo)) ||
      !(shot.format === undefined || shot.format === 'thumbnail' || shot.format === 'tv-icon' || shot.format === 'app-icon' || shot.format === 'widescreen') ||
      !(shot.layers === undefined || isLayerStack(shot.layers)) || !optionalNumber(shot.reflections) ||
      !(shot.panels === undefined || (shot.reflections !== undefined && Array.isArray(shot.panels) && shot.panels.every(isPanel))) ||
      !isShotLook(shot)) {
    throw new Error(`Invalid shot: ${JSON.stringify(shot)}`);
  }
}

export const SHOTS: readonly Shot[] = [
  // sanctuary: rooftop terrace over the glass eco-city.
  {
    id: 'sanctuary-skyline',
    stage: 'sanctuary',
    time: 10,
    pose: 5,
    camera: { position: [0, 7, 19], target: [0, 1.6, -4], fov: 45 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'sanctuary-hero',
    stage: 'sanctuary',
    time: 10,
    pose: 3.1,
    camera: { position: [0, 1.25, 10.5], target: [0, 2.55, 0], fov: 40 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'sanctuary-canopy',
    stage: 'sanctuary',
    time: 14,
    pose: 9,
    camera: { position: [7.2, 2.3, 8.6], target: [-0.3, 1.9, 0], fov: 40 },
    dancers: { rotationY: 0.35 },
    logo: { y: 215, size: 170, x: 'left' },
  },
  {
    id: 'sanctuary-towers',
    stage: 'sanctuary',
    time: 10,
    pose: 3.1,
    camera: { position: [0, 0.3, 6.8], target: [0, 2.9, 0], fov: 54 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'sanctuary-closeup',
    stage: 'sanctuary',
    time: 12,
    pose: 5,
    camera: { position: [-3, 1.65, 5.4], target: [-3.5, 1.9, 0], fov: 38 },
    logo: { y: 215, size: 140, x: 'left' },
  },

  // openreef: the dancers on the open sand.
  {
    id: 'openreef-surface',
    stage: 'openreef',
    time: 12,
    pose: 3.1,
    camera: { position: [0, -0.1, 6.8], target: [0, 2.5, 0], fov: 54 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'openreef-hero',
    stage: 'openreef',
    time: 10,
    pose: 5,
    camera: { position: [0, 0.85, 9.5], target: [0, 1.95, 0], fov: 42 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'openreef-garden',
    stage: 'openreef',
    time: 10,
    pose: 12.9,
    camera: { position: [0, 6.5, 19], target: [0, 1.2, -4], fov: 45 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'openreef-turtle',
    stage: 'openreef',
    time: 10,
    pose: 9,
    camera: { position: [6.2, 1.5, 7.5], target: [-0.3, 1.6, 0], fov: 40 },
    dancers: { rotationY: 0.35 },
    logo: { y: 215, size: 160, x: 'left' },
  },

  // falls: clifftop meadow over waterfalls.
  {
    id: 'falls-valley',
    stage: 'falls',
    time: 10,
    pose: 5,
    camera: { position: [0, 7, 19], target: [0, 1.8, -4], fov: 45 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'falls-rainbow',
    stage: 'falls',
    time: 10,
    pose: 9,
    camera: { position: [6.5, 2.2, 7.5], target: [-0.3, 1.9, 0], fov: 40 },
    dancers: { rotationY: 0.35 },
    logo: { y: 215, size: 160, x: 'left' },
  },
  {
    id: 'falls-meadow',
    stage: 'falls',
    time: 10,
    pose: 3.1,
    camera: { position: [0, 1.05, 8.5], target: [0, 2.35, 0], fov: 42 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'falls-closeup',
    stage: 'falls',
    time: 10,
    pose: 9,
    camera: { position: [3, 1.65, 5.4], target: [3.5, 1.9, 0], fov: 38 },
    logo: { y: 215, size: 140, x: 'right' },
  },
  {
    id: 'falls-cliffs',
    stage: 'falls',
    time: 14,
    pose: 3.1,
    camera: { position: [-6.5, 1.6, 7.5], target: [0.3, 1.9, 0], fov: 40 },
    dancers: { rotationY: -0.35 },
    logo: { y: 215, size: 160, x: 'right' },
  },

  // club: glass dance club.
  {
    id: 'club-floor',
    stage: 'club',
    time: 12.23,
    pose: 5,
    camera: { position: [0, 7, 19], target: [0, 2.2, -3], fov: 45 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'club-aquarium',
    stage: 'club',
    time: 13.25,
    pose: 9,
    camera: { position: [6.5, 2.2, 7.5], target: [-0.3, 1.7, 0], fov: 40 },
    dancers: { rotationY: 0.35 },
    logo: { y: 215, size: 160, x: 'left' },
  },
  {
    id: 'club-stage',
    stage: 'club',
    time: 16.3,
    pose: 5,
    camera: { position: [4.5, -0.1, 8.5], target: [0, 2.2, -0.5], fov: 44 },
    dancers: { rotationY: 0.25 },
    logo: { y: 215, size: 170, x: 'left' },
  },
  {
    id: 'club-dj',
    stage: 'club',
    time: 16.3,
    pose: 9,
    camera: { position: [0, 1.6, 9.5], target: [0, 2.6, 0], fov: 42 },
    logo: { y: 215, size: 190 },
  },

  // beach: golden-hour beach.
  {
    id: 'beach-sunset',
    stage: 'beach',
    time: 10,
    pose: 5,
    camera: { position: [0, 6.2, 19.5], target: [0, 1.4, -3], fov: 45 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'beach-hero',
    stage: 'beach',
    time: 4.25, // When the gulls are clear of the dancers' heads and the wordmark.
    pose: 3.1,
    camera: { position: [0, 0.55, 9.5], target: [0, 1.9, 1], fov: 40 },
    logo: { y: 215, size: 190 },
  },
  {
    id: 'beach-ball',
    stage: 'beach',
    time: 12,
    pose: 3.1,
    camera: { position: [-6.5, 1.27, 8.5], target: [0.3, 1.1, 1], fov: 40 },
    dancers: { rotationY: -0.35 },
    logo: { y: 215, size: 160, x: 'right' },
  },
  {
    id: 'beach-palm',
    stage: 'beach',
    time: 12,
    pose: 9,
    camera: { position: [6.5, 1.67, 8.5], target: [-0.3, 1.25, 1], fov: 40 },
    dancers: { rotationY: 0.35 },
    logo: { y: 215, size: 160, x: 'left' },
  },
  {
    id: 'beach-closeup',
    stage: 'beach',
    time: 12,
    pose: 5,
    camera: { position: [3, 1.12, 6.4], target: [3.5, 1.37, 1], fov: 38 },
    logo: { y: 215, size: 140, x: 'right' },
  },
];

const shotById = (id: string): Shot => {
  const shot = SHOTS.find((s) => s.id === id);
  if (!shot) throw new Error(`Unknown shot "${id}"`);
  return shot;
};

/*
 * The layered 5:3 Apple TV app icon (render.ts --tv-icons), made from a thumbnail above. Apple
 * allows two to five layers with an opaque one at the back; tvOS shifts and tilts them for the
 * parallax effect, so the layers are split by depth: `near` is a distance from the camera.
 */
export const TV_ICONS: readonly Shot[] = [
  {
    ...shotById('falls-closeup'),
    id: 'falls-sky-soft-glass',
    format: 'tv-icon',
    // The dancers a little to the left, so the purple one fills the left of the wider frame and
    // the wordmark, on two lines to be much bigger, has the sky on the right. A heavier "dance"
    // with a navy edge and a darker glow: the thin weight is hard to read on the pale sky.
    dancers: { position: [-0.8, 0, 0] },
    logo: { y: 391, size: 340, x: 'right', stacked: true, light: 400, outline: 0.02, halo: 1.4 },
    // The dancer against nothing but the soft sky, see-through, so the layers behind show
    // through her glass as they move.
    layers: [
      { name: 'sky', near: 800, blur: 7 }, // only the sky, far clouds and haze
      { name: 'meadow', near: 2, hidden: true },
      { name: 'logo', wordmark: true },
      { name: 'dancers', near: 2, dancers: true, dancerParts: 'body', seeThrough: true },
      { name: 'hands', near: 2, dancers: true, dancerParts: 'hands', seeThrough: true }, // in front, for more depth
      { name: 'foreground', dancers: true, hidden: true },
    ],
  },
];

/*
 * Square phone app icons (render.ts --app-icons), into assets/app-icon/. Layered like the TV
 * icons: the layers can make a layered icon (Icon Composer on iOS), and stacked they're the flat one.
 */
// The purple dancer's head close up, see-through like the Apple TV icon's dancer, her floating
// hands on a layer of their own. The scenery is rendered, so she's cut against it, but left out.
const GLASS_PORTRAIT: Omit<Shot, 'id'> = {
  format: 'app-icon',
  stage: 'falls',
  time: 10,
  pose: 5,
  camera: { position: [2, 2.45, 3.2], target: [2, 2.35, 0], fov: 40 },
  layers: [
    { name: 'scenery', near: 1, hidden: true },
    { name: 'dancers', near: 1, dancers: true, dancerParts: 'body', seeThrough: true },
    { name: 'hands', near: 1, dancers: true, dancerParts: 'hands', seeThrough: true },
  ],
};
export const APP_ICONS: readonly Shot[] = [
  // Against the Apple TV icon's soft sky.
  { ...GLASS_PORTRAIT, id: 'portrait-purple-sky-glass', layers: [{ name: 'sky', near: 800, blur: 7 }, ...GLASS_PORTRAIT.layers ?? []] },
  // The same sky rendered with a fiftieth of the light: near black, for a dark icon. She reflects
  // the scene just as dark (twice as bright, so she isn't lost in it) instead of the bright daytime
  // around her, and a studio's softboxes light her: a strip above and behind for a rim, a broad one
  // overhead, a key light up front to her left, and a faint fill below. Her glow stays the brightest.
  {
    ...GLASS_PORTRAIT,
    id: 'portrait-dark-sky-glass',
    reflections: 0.04,
    panels: [
      { from: [0, 3, -3], size: [6, 2.5], intensity: 1.4 },
      { from: [0, 4, 0], size: [9, 7], intensity: 1.4 },
      { from: [1.5, 2.5, 3], size: [5, 5], intensity: 1.2 },
      { from: [0, -0.5, 4], size: [8, 2.5], intensity: 0.4 },
    ],
    layers: [{ name: 'sky', near: 800, blur: 7, exposure: 0.02 }, ...GLASS_PORTRAIT.layers ?? []],
  },
  // Against nothing: transparent, for putting on a background of your own.
  { ...GLASS_PORTRAIT, id: 'portrait-transparent-bg' },
];

/*
 * Splash screens, 16:9, into assets/ as <id>.png (with the wordmark if the shot has one).
 * splash1: the gold dancer slumped in a dark back room's corner, in a top hat, seen from a
 * grainy security camera with a flashlight on her. The club stage only lends its
 * environment map: its scenery is hidden and the room stands in for it.
 */
const SLUMPED: FigurePose = {
  root: [0, -0.6, -0.1], body: [-0.18, 0.15, 0.14], head: [0.4, 0.3, 0.3],
  hands: [[-1.25, 0.33, 0.55], [1.35, 0.33, 0.35]],
  feet: [[-0.62, 0.4, 1.15], [0.58, 0.4, 1.25]], footTurn: [[-1.45, -0.4, 0.1], [-1.45, 0.4, -0.1]],
  hat: [0.05, 0.12], look: { color: '#f0b400', opacity: 0.95, gloss: 60 },
};
const SPLASH1: Shot = {
  id: 'splash1', stage: 'club', time: 10, pose: 5, format: 'widescreen', hideStage: true,
  camera: { position: [-4, 6.8, 6.4], target: [-1.3, 0.8, -0.3], fov: 40 },
  post: { exposure: 0.45, saturation: 0.6, vignette: 0.9, bloomStrength: 0.25, bloomThreshold: 1.6 },
  environment: 0.05, background: '#000000', fog: { color: '#000000', density: 0.02 },
  // A flashlight from the camera.
  lights: [{ position: [-4, 6.8, 6.4], target: [-1.4, 0.3, 0.6], intensity: 800, angle: 0.45, penumbra: 0.6, shadow: true }],
  room: { position: [-0.6, 0, -1.25], side: [1, 1.4], tile: 0.3, cables: [[3.3, 0.25], [2.9, 0.5], [1.7, 0.12], [0.25, 0.2], [0.4, 0.75]] },
  overlay: { grain: 0.12, scanlines: 0.15 },
  // The purple dancer is left out.
  figures: [SLUMPED, null],
};
export const SPLASHES: readonly Shot[] = [
  SPLASH1,
  // The same view slid left, with the wordmark in the dark at the top right.
  { ...SPLASH1, id: 'splash1-logo', camera: { ...SPLASH1.camera, shift: [0.2, 0] }, logo: { y: 190, size: 150, x: 'right' } },
];
