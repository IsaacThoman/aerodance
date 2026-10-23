/*
 * Tiles for three or four players. MediaPipe's person detector sees the whole picture shrunk to a
 * small square, and with three or four people in it finds only about two per frame: its searches
 * knock out people it was following, and a search runs every frame while it follows fewer people
 * than it was asked for. So each player gets their own full-height strip of the picture, where
 * the model follows exactly one person and only searches when it loses them. The strips' results
 * are put back into the whole picture; somebody two strips both see counts once, from the strip
 * they're farther inside. Joints beyond a strip's cut edges are the model's guesses, so they're
 * marked unsure. The strips stay put, evenly spread and covering the whole width: a strip moved
 * onto where a player was can lose them. A strip following somebody another strip keeps (or
 * nobody) would never look for anyone else, so those people are hidden from it next time.
 */
import { reliable } from './appearance.ts';


/** A full-height strip of the picture: where it starts and how wide it is, as fractions of the width. */
export interface Tile { x: number; width: number; }
/** A landmark as the model reports it. */
interface Point { x: number; y: number; z: number; visibility?: number; presence?: number; }
/** A box in the picture, its edges as fractions of the width and height. */
export interface Box { x0: number; y0: number; x1: number; y1: number; }

/** How wide each strip is, by player count. */
const EVEN_WIDTH: Partial<Record<number, number>> = { 3: 0.45, 4: 0.35 };
/**
 * Two results whose joints are mostly this close (in body sizes) are one person; with too few
 * sure joints to tell, torso centres this close. Sure torsos this close (and sizes this alike,
 * log) are one person whatever their arms say: two strips can disagree about the arms.
 */
const SAME_JOINTS = 0.35, SAME_CENTRE = 0.5, SAME_TORSO = 0.25, SAME_SIZE = 0.3;
/** How sure a joint beyond a strip's cut edge can be. */
const CUT = 0.2;
const TORSO = [11, 12, 23, 24];
const LIMBS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/** A strip centred on x (a fraction of the width), kept inside the picture. */
const around = (x: number, width: number): Tile => ({ x: Math.min(1 - width, Math.max(0, x - width / 2)), width });

/** Strips spread evenly across the picture, or none for player counts that don't need them. */
export function evenTiles(players: number): Tile[] | null {
  const width = EVEN_WIDTH[players];
  return width ? Array.from({ length: players }, (_, i) => around((i + 0.5) / players, width)) : null;
}

/** A strip's result in the whole picture's coordinates, with joints beyond its cut edges unsure. */
export function fromTile<P extends Point>(points: readonly P[], tile: Tile): P[] {
  const left = tile.x > 0 ? tile.x : -Infinity, right = tile.x + tile.width < 1 ? tile.x + tile.width : Infinity;
  return points.map(p => {
    const x = tile.x + p.x * tile.width;
    const cut = x < left || x > right;
    return { ...p, x, z: p.z * tile.width,
      ...(cut ? { visibility: Math.min(p.visibility ?? 0, CUT), ...(p.presence === undefined ? {} : { presence: Math.min(p.presence, CUT) }) } : {}) };
  });
}

/** The strips' results as one list, each person once (the copy farthest inside its strip). */
export function mergeTiles<P extends Point>(found: readonly { points: P[]; tile: Tile }[], aspect: number): P[][] {
  const bodies = found.map(({ points, tile }) => {
    const torso = TORSO.map(i => points[i]);
    const sure = torso.every(reliable);
    const x = torso.reduce((s, p) => s + p.x, 0) / 4, y = torso.reduce((s, p) => s + p.y, 0) / 4;
    const [ls, rs, lh, rh] = torso;
    const scale = Math.max(Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2 * aspect, (ls.y + rs.y - lh.y - rh.y) / 2),
      Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y) / 0.75, 0.01);
    // How far inside its strip it is: from the torso to the nearest cut edge, in picture widths.
    const inside = Math.min(tile.x > 0 ? x - tile.x : Infinity, tile.x + tile.width < 1 ? tile.x + tile.width - x : Infinity);
    return { points, tile, sure, x: x * aspect, y, scale, inside,
      limbs: LIMBS.map(i => reliable(points[i]) ? { x: points[i].x * aspect, y: points[i].y } : null) };
  });
  // (Two people, one partly behind the other, can have torsos close together: their joints tell them apart.)
  const same = (a: typeof bodies[number], b: typeof bodies[number]) => {
    const s = Math.min(a.scale, b.scale);
    if (a.sure && b.sure && Math.hypot(a.x - b.x, a.y - b.y) < SAME_TORSO * s && Math.abs(Math.log(a.scale / b.scale)) < SAME_SIZE) return true;
    let sum = 0, n = 0;
    a.limbs.forEach((p, i) => { const q = b.limbs[i]; if (p && q) { sum += Math.hypot(p.x - q.x, p.y - q.y); n++; } });
    return n >= 4 ? sum / n < SAME_JOINTS * s : Math.hypot(a.x - b.x, a.y - b.y) < SAME_CENTRE * s;
  };
  const kept: typeof bodies = [];
  for (const body of [...bodies].sort((a, b) => Number(b.sure) - Number(a.sure) || b.inside - a.inside)) {
    if (!kept.some(k => k.tile !== body.tile && same(k, body))) kept.push(body);
  }
  return kept.map(b => b.points);
}

/** Around somebody's sure joints (all of them if none is), with room for their head and clothes. */
function outline(points: readonly Point[]): Box {
  const sure = points.filter(reliable), use = sure.length ? sure : points;
  const xs = use.map(p => p.x), ys = use.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = 0.1 * (x1 - x0), py = 0.1 * (y1 - y0);
  return { x0: x0 - px, x1: x1 + px, y0: y0 - 2 * py, y1: y1 + py };
}

/**
 * Who to hide from each strip next time. A strip whose result was somebody another strip keeps,
 * or that found nobody, is shown the picture without the people the others keep, so it looks for
 * whoever else is in it: a strip follows one person and only searches once it loses them, so
 * otherwise somebody standing between two people the strips overlap on is never looked for, and
 * a strip whose player stepped out of it keeps following a neighbour when they come back.
 */
export function hidden<P extends Point>(found: readonly { points: P[]; tile: Tile }[], kept: readonly P[][], tiles: readonly Tile[]): Box[][] {
  return tiles.map(tile => found.some(f => f.tile === tile && kept.includes(f.points)) ? []
    : found.filter(f => f.tile !== tile && kept.includes(f.points)).map(f => outline(f.points))
      .filter(b => b.x1 > tile.x && b.x0 < tile.x + tile.width));
}
