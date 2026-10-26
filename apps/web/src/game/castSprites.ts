import type { WebGLRenderer } from 'three';
import { DANCER_TOP, dancerWidth } from '../ui/draw.ts';
import { CUTOUT, seams } from '../ui/cutout.ts';
import type { Cutout, CutoutPose } from '../ui/cutout.ts';
import { leadOf } from '../../../../packages/pose/song.ts';
import type { Cast } from '../../../../packages/pose/song.ts';
import { PLAYERS } from './results.ts';

/*
 * Song Select's cast: each of a song's dancers as a cutout in a different move, shaded light to
 * dark down it in the colour of the first player following it, or white (drawn faint) if nobody
 * follows it, with its eyes and the seams between its parts cut out, side by side. The cutouts
 * are the dancer model rendered in-engine and thresholded (ui/dancerCutouts.ts), once, large,
 * and drawn down to the row's size.
 *
 * const sprites = createCastSprites(gl, () => ui.invalidate());
 * if (!sprites.draw(g, right, floor, h, dancers, cast)) ...   // false until they're rendered
 */

// One move per dancer, as the retargeter posed four moments of the menu capture (dance.adpose:
// take 1 at 5 s, take 0 at 9.5 s, take 1 at 3 s and take 0 at 10 s) when they were picked, kept
// as the bones' poses so they stay those moves.
export const CREW: readonly CutoutPose[] = [
  {
    Root: [0.0461, -0.0492, 0, 0, 0, 0, 1],
    Body: [0, 1.1, 0, 0.001, 0.0455, 0.0228, 0.9987],
    Head: [0, 1, 0, 0.002, -0.0318, -0.0624, 0.9975],
    ArmL: [-0.5465, 2.2552, 0.6141, 0, 0, 0, 1],
    ArmR: [0.173, 1.2391, 0.5006, 0, 0, 0, 1],
    FootL: [-0.677, 0.4192, -0.3376, 0, 0, 0, 1],
    FootR: [0.4957, 0.3774, -0.4627, 0, 0, 0, 1],
  },
  {
    Root: [0.0038, -0.0977, 0, 0, 0, 0, 1],
    Body: [0, 1.1, 0, -0.0012, 0.1297, -0.0091, 0.9915],
    Head: [0, 1, 0, 0.0008, -0.0378, -0.0203, 0.9991],
    ArmL: [-0.1607, 1.7655, 0.7793, 0, 0, 0, 1],
    ArmR: [0.4781, 1.2065, 0.4574, 0, 0, 0, 1],
    FootL: [-0.3668, 0.3979, -0.3974, 0, 0, 0, 1],
    FootR: [0.106, 0.4097, -0.4163, 0, 0, 0, 1],
  },
  {
    Root: [-0.2449, 0.1054, 0, 0, 0, 0, 1],
    Body: [0, 1.1, 0, -0.002, 0.0184, -0.1068, 0.9941],
    Head: [0, 1, 0, 0.0007, 0.0082, 0.0817, 0.9966],
    ArmL: [0.2656, 1.3427, 0.389, 0, 0, 0, 1],
    ArmR: [-0.3628, 1.2113, 0.3141, 0, 0, 0, 1],
    FootL: [-0.7058, 0.1946, -0.127, 0, 0, 0, 1],
    FootR: [0.3989, 0.2725, -0.1744, 0, 0, 0, 1],
  },
  {
    Root: [-0.1315, 0.1813, 0, 0, 0, 0, 1],
    Body: [0, 1.1, 0, -0.0001, 0.179, -0.0003, 0.9838],
    Head: [0, 1, 0, -0.0059, -0.0408, 0.1427, 0.9889],
    ArmL: [0.7425, 1.8029, 0.47, 0, 0, 0, 1],
    ArmR: [0.6293, 1.4954, -0.0564, 0, 0, 0, 1],
    FootL: [0.0652, 0.2025, 0.0972, 0, 0, 0, 1],
    FootR: [-0.0348, 0.2567, -0.3298, 0, 0, 0, 1],
  },
];
// The cutouts' resolution (pixels per character unit), and their seams' width in those pixels.
const PPU = 72;
const SEAM = 6;
// The dancers' middles this many dancer widths apart.
const STEP = 0.8;
// A dancer nobody follows: an empty spot on the glass.
export const SPARE_ALPHA = 0.3;
// Clear pixels round each sprite, so it scales down without clipping its edges.
const PAD = 4;

type RGB = readonly [number, number, number];
const rgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as unknown as RGB;
const WHITE: RGB = [255, 255, 255];

/** A player's colours down their dancer, top to bottom: light, colour and dark (or white for nobody, -1). */
export function spriteInk(lead: number): readonly [RGB, RGB, RGB] {
  if (lead < 0) return [WHITE, WHITE, WHITE];
  const look = PLAYERS[lead];
  return [rgb(look.light), rgb(look.color), rgb(look.dark)];
}

/** A dancer's sprite (RGBA, PAD pixels clear all round) for the player leading it, or for nobody (-1). */
export function paintSprite(cut: Cutout, lead: number) {
  const width = cut.w + 2 * PAD, height = cut.h + 2 * PAD, data = new Uint8ClampedArray(width * height * 4);
  const [light, color, dark] = spriteInk(lead), seam = seams(cut, SEAM);
  for (let y = 0; y < cut.h; y++) for (let x = 0; x < cut.w; x++) {
    const i = y * cut.w + x, p = cut.part[i];
    if (p === CUTOUT.none || p === CUTOUT.eye || seam[i]) continue;
    // Light to dark down the dancer, as the vector cutouts are.
    const t = y / cut.h, [r, g, b] = t < 0.5 ? mix(light, color, t * 2) : mix(color, dark, t * 2 - 1);
    data.set([r, g, b, 255], ((y + PAD) * width + x + PAD) * 4);
  }
  return { width, height, data };
}

/**
 * Where a song's cutouts go, `h` design units tall (as tall as the vector dancers, or the tallest
 * pose that height): their scale (design units per cutout pixel), each body's middle from the
 * first's and the group's left and right edges from it.
 */
export function layoutCast(cuts: readonly Cutout[], h: number, crew: readonly Cutout[] = cuts) {
  const tallest = Math.max(DANCER_TOP, ...crew.map((cut) => cut.h / cut.ppu));
  const unit = h / tallest, step = dancerWidth(h * DANCER_TOP / tallest) * STEP;
  const x = cuts.map((_, d) => d * step);
  const scale = cuts.map((cut) => unit / cut.ppu);
  const left = Math.min(...cuts.map((cut, d) => x[d] - cut.cx * scale[d]));
  const right = Math.max(...cuts.map((cut, d) => x[d] + (cut.w - cut.cx) * scale[d]));
  return { x, scale, left, right };
}

export function createCastSprites(gl: WebGLRenderer, onReady: () => void) {
  let crew: Cutout[] | 'baking' | 'failed' | null = null;
  const sprites = new Map<string, HTMLCanvasElement>();
  // The cutouts, or null while they render (or if they couldn't).
  const cutouts = () => {
    if (!crew) {
      crew = 'baking';
      import('../ui/dancerCutouts.ts').then(({ bakeCutouts }) => bakeCutouts(gl, CREW, PPU)).then((cuts) => {
        crew = cuts;
        onReady();
      }, (err: unknown) => {
        crew = 'failed';
        console.warn("Song Select's dancers could not render", err);
      });
    }
    return Array.isArray(crew) ? crew : null;
  };
  const sprite = (cut: Cutout, pose: number, lead: number) => {
    const id = `${pose}|${lead}`;
    let canvas = sprites.get(id);
    if (!canvas) {
      const { width, height, data } = paintSprite(cut, lead);
      canvas = Object.assign(document.createElement('canvas'), { width, height });
      canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
      sprites.set(id, canvas);
    }
    return canvas;
  };
  // A song's cutouts, a pose each in turn, and where they go.
  const arrange = (h: number, dancers: number) => {
    const all = cutouts();
    if (!all) return null;
    const poses = Array.from({ length: dancers }, (_, d) => d % all.length);
    const cuts = poses.map((pose) => all[pose]);
    return { poses, cuts, ...layoutCast(cuts, h, all) };
  };

  return {
    /** Loads the model ahead of the first draw. */
    preload: () => import('../ui/dancerCutouts.ts').then(({ loadCutoutModel }) => loadCutoutModel()).catch(() => {}),
    /** How wide (design units) a song's dancers are, or null until they're rendered. */
    width(h: number, dancers: number) {
      const at = arrange(h, dancers);
      return at && at.right - at.left;
    },
    /**
     * A song's dancers, `h` design units tall, standing on `floor` and ending at `right`. False
     * (drawing nothing) until they're rendered.
     */
    draw(g: CanvasRenderingContext2D, right: number, floor: number, h: number, dancers: number, cast: Cast) {
      const at = arrange(h, dancers);
      if (!at) return false;
      const shift = right - at.right;
      g.save();
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const alpha = g.globalAlpha;
      at.cuts.forEach((cut, d) => {
        const lead = leadOf(cast, d), s = at.scale[d], canvas = sprite(cut, at.poses[d], lead);
        g.globalAlpha = alpha * (lead < 0 ? SPARE_ALPHA : 1);
        g.drawImage(canvas, shift + at.x[d] - (cut.cx + PAD) * s, floor - (cut.h + PAD) * s, canvas.width * s, canvas.height * s);
      });
      g.restore();
      return true;
    },
  };
}
export type CastSprites = ReturnType<typeof createCastSprites>;
