import type { WebGLRenderer } from 'three';
import { DANCER_TOP, dancerWidth } from '../ui/draw.ts';
import { CUTOUT } from '../ui/cutout.ts';
import type { Cutout, CutoutPose } from '../ui/cutout.ts';
import { leadOf } from '../../../../packages/pose/song.ts';
import type { Cast } from '../../../../packages/pose/song.ts';
import { PLAYERS } from './results.ts';

/*
 * Song Select's cast: each of a song's dancers as a pixel sprite, in a different moment of the
 * menu capture, in the colour of the first player following it with a one-pixel shadow down and
 * to the right, or a faint white silhouette if nobody follows it, close together: their bodies
 * overlap, but every face and hand stays in view (layoutCast). The sprites are the dancer
 * rendered in-engine and thresholded (ui/dancerCutouts.ts) at the overlay's own resolution and
 * drawn on its pixel grid, one sprite pixel to a buffer pixel, so they line up with the canvas
 * (and the world under it) exactly. The 640x480 buffer's pixels are 4:3 wide in widescreen and
 * square in 4:3, so each display mode gets its own set.
 *
 * const sprites = createCastSprites(gl, () => ui.invalidate());
 * if (!sprites.draw(g, right, floor, h, dancers, cast)) ...   // false until they're rendered
 */

// One moment per dancer, each facing front: a wave, a reach, a lean and a hand out.
export const CREW: readonly CutoutPose[] = [
  { take: 1, seconds: 5 },
  { take: 0, seconds: 12 },
  { take: 1, seconds: 3 },
  { take: 1, seconds: 10 },
];
// The closest the dancers stand, in dancer widths between their middles (hands included, so they
// overlap); further if that would hide a face or a hand.
const STEP = 0.7;
// A dancer nobody follows: an empty spot on the glass.
export const SPARE_ALPHA = 0.3;

type RGB = readonly [number, number, number];
const rgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as unknown as RGB;
const NIGHT: RGB = [0, 10, 40];
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

/** A player's sprite colours: the dancer, its eyes and its shadow. */
export function spriteInk(lead: number) {
  if (lead < 0) return null;
  const look = PLAYERS[lead];
  return { fill: rgb(look.color), eyes: mix(rgb(look.dark), BLACK, 0.5), shadow: mix(rgb(look.dark), NIGHT, 0.35) };
}

/**
 * One layer of a dancer's sprite (RGBA, one pixel wider and taller for the shadow), for the
 * player leading it or, as a white silhouette with its eyes cut out, for nobody (-1): its body
 * (with its head and eyes), or its hands, which go over every dancer's body.
 */
export function paintSprite(cut: Cutout, lead: number, layer: 'body' | 'hands' = 'body') {
  const width = cut.w + 1, height = cut.h + 1, data = new Uint8ClampedArray(width * height * 4);
  const ink = spriteInk(lead);
  const raw = (x: number, y: number) => x < 0 || y < 0 || x >= cut.w || y >= cut.h ? CUTOUT.none : cut.part[y * cut.w + x];
  // The layer's own parts; the rest is empty.
  const part = (x: number, y: number) => {
    const p = raw(x, y);
    return (p === CUTOUT.hand) === (layer === 'hands') ? p : CUTOUT.none;
  };
  const put = (x: number, y: number, [r, g, b]: RGB) => data.set([r, g, b, 255], (y * width + x) * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = part(x, y);
    const solid = p !== CUTOUT.none && p !== CUTOUT.eye;
    if (!ink) { if (solid) put(x, y, WHITE); }
    else if (solid) put(x, y, ink.fill);
    else if (p === CUTOUT.eye) put(x, y, ink.eyes);
    else if (part(x - 1, y - 1) !== CUTOUT.none) put(x, y, ink.shadow);
  }
  return { width, height, data };
}

// A hand drawn over another may cover at most this much of it.
const HAND_COVER = 0.4;

/**
 * Where each sprite goes, left to right, standing on one floor: each body's middle `step` pixels
 * after the one before's, or as little further as keeps every face and hand in view.
 * Bodies are drawn left to right and all the hands over them, so bodies may overlap each other
 * and a hand may lie over a body; but no body comes within `gap` pixels of a head, no hand covers
 * a head, and a hand covers at most HAND_COVER of another. Returns each one's
 * left edge in pixels from the group's, and the group's width (shadows included).
 */
export function layoutCast(cuts: readonly Cutout[], step = 1, gap = 1) {
  const at = (x: number, row: number) => row * 65536 + x + 32768;
  // Each dancer's pixels, by column from its body's middle and row up from the floor, and its
  // hands' (each as its own set: they're apart).
  const dancers = cuts.map((cut) => {
    const own: { x: number; row: number; hand: boolean; head: boolean }[] = [];
    for (let y = 0; y < cut.h; y++) for (let x = 0; x < cut.w; x++) {
      const p = cut.part[y * cut.w + x];
      if (p !== CUTOUT.none) own.push({ x: x - cut.cx, row: cut.h - 1 - y, hand: p === CUTOUT.hand, head: p === CUTOUT.head || p === CUTOUT.eye });
    }
    // Hand pixels in groups of touching ones.
    const left = new Map(own.filter((p) => p.hand).map((p) => [at(p.x, p.row), p]));
    const hands: { x: number; row: number }[][] = [];
    for (const start of [...left.values()]) {
      if (!left.delete(at(start.x, start.row))) continue;
      const group = [start], queue = [start];
      while (queue.length) {
        const { x, row } = queue.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = left.get(at(x + dx, row + dy));
          if (next && left.delete(at(next.x, next.row))) { group.push(next); queue.push(next); }
        }
      }
      hands.push(group);
    }
    return { own, hands };
  });
  // Heads, and heads with their margins (a hand may come right up to a head), and hands.
  const heads = new Set<number>(), margins = new Set<number>(), anyHand = new Set<number>();
  const hands: { pixels: Set<number>; size: number }[] = [];
  const middles: number[] = [];
  dancers.forEach(({ own, hands: mine }, d) => {
    const clashes = (m: number) => {
      if (own.some(({ x, row, hand, head }) => (hand ? heads : margins).has(at(m + x, row)) || (head && anyHand.has(at(m + x, row))))) return true;
      const covering = own.filter((p) => p.hand).map((p) => at(m + p.x, p.row));
      return hands.some(({ pixels, size }) => covering.filter((k) => pixels.has(k)).length > HAND_COVER * size);
    };
    let m = d ? middles[d - 1] + Math.max(1, step) : 0;
    while (clashes(m)) m++;
    middles.push(m);
    for (const { x, row, head } of own) {
      if (!head) continue;
      heads.add(at(m + x, row));
      for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) margins.add(at(m + x + dx, row + dy));
    }
    for (const hand of mine) {
      const pixels = new Set(hand.map((p) => at(m + p.x, p.row)));
      pixels.forEach((k) => anyHand.add(k));
      hands.push({ pixels, size: pixels.size });
    }
  });
  const lefts = cuts.map((cut, d) => middles[d] - cut.cx);
  const min = Math.min(...lefts), max = Math.max(...cuts.map((cut, d) => lefts[d] + cut.w + 1));
  return { x: lefts.map((x) => x - min), width: max - min };
}

/** The cutouts' resolution for dancers `h` design units tall under transform `t`: buffer pixels per character unit. */
export function spriteGrid(t: Pick<DOMMatrix, 'a' | 'd'>, h: number) {
  const round = (n: number) => Math.round(n * 100) / 100;
  return { ppu: round((h * t.d) / DANCER_TOP), ppuX: round((h * t.a) / DANCER_TOP) };
}

export function createCastSprites(gl: WebGLRenderer, onReady: () => void) {
  const sets = new Map<string, Cutout[] | 'baking' | 'failed'>();
  const sprites = new Map<string, HTMLCanvasElement>();
  // The cutouts for this resolution, or null while they render (or if they couldn't).
  const cutouts = (ppu: number, ppuX: number) => {
    const key = `${ppu}x${ppuX}`, set = sets.get(key);
    if (set === undefined) {
      sets.set(key, 'baking');
      import('../ui/dancerCutouts.ts').then(({ bakeCutouts }) => bakeCutouts(gl, CREW, ppu, ppuX)).then((cuts) => {
        sets.set(key, cuts);
        onReady();
      }, (err: unknown) => {
        sets.set(key, 'failed');
        console.warn("Song Select's dancers could not render", err);
      });
    }
    return Array.isArray(set) ? { key, cuts: set } : null;
  };
  const sprite = (key: string, cut: Cutout, pose: number, lead: number, layer: 'body' | 'hands') => {
    const id = `${key}|${pose}|${lead}|${layer}`;
    let canvas = sprites.get(id);
    if (!canvas) {
      const { width, height, data } = paintSprite(cut, lead, layer);
      canvas = Object.assign(document.createElement('canvas'), { width, height });
      canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
      sprites.set(id, canvas);
    }
    return canvas;
  };
  // A song's sprites and where they go under `g`'s transform, in buffer pixels.
  const arrange = (g: CanvasRenderingContext2D, h: number, dancers: number) => {
    const t = g.getTransform(), { ppu, ppuX } = spriteGrid(t, h), set = cutouts(ppu, ppuX);
    if (!set) return null;
    const poses = Array.from({ length: dancers }, (_, d) => d % set.cuts.length);
    const cuts = poses.map((pose) => set.cuts[pose]);
    return { t, key: set.key, poses, cuts, ...layoutCast(cuts, Math.round(dancerWidth(h) * STEP * t.a)) };
  };

  return {
    /** Loads the model and the capture ahead of the first draw. */
    preload: () => import('../ui/dancerCutouts.ts').then(({ loadCutoutAssets }) => loadCutoutAssets()).catch(() => {}),
    /** How wide (design units) a song's sprites are, or null until they're rendered. */
    width(g: CanvasRenderingContext2D, h: number, dancers: number) {
      const at = arrange(g, h, dancers);
      return at && at.width / at.t.a;
    },
    /**
     * A song's dancers, `h` design units tall, standing on `floor` and ending at `right`, snapped
     * to the buffer's pixels. False (drawing nothing) until they're rendered.
     */
    draw(g: CanvasRenderingContext2D, right: number, floor: number, h: number, dancers: number, cast: Cast) {
      const at = arrange(g, h, dancers);
      if (!at) return false;
      const { t } = at;
      const left = Math.round(t.a * right + t.e) - at.width, bottom = Math.round(t.d * floor + t.f);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.imageSmoothingEnabled = false;
      const alpha = g.globalAlpha;
      // The bodies, then the hands over them.
      for (const layer of ['body', 'hands'] as const) at.cuts.forEach((cut, d) => {
        const lead = leadOf(cast, d);
        g.globalAlpha = alpha * (lead < 0 ? SPARE_ALPHA : 1);
        g.drawImage(sprite(at.key, cut, at.poses[d], lead, layer), left + at.x[d], bottom - cut.h);
      });
      g.restore();
      return true;
    },
  };
}
export type CastSprites = ReturnType<typeof createCastSprites>;
