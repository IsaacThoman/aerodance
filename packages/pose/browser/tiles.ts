/*
 * Tiles for three or four players. MediaPipe's person detector sees the whole picture shrunk to a
 * small square, and with three or four people in it finds only about two per frame: its searches
 * knock out people it was following, and a search runs every frame while it follows fewer people
 * than it was asked for. So each player gets their own full-height strip of the picture, where
 * the model follows exactly one person and only searches when it loses them. The strips' results
 * are put back into the whole picture; somebody two strips both see counts once (the copy with a
 * sure torso, from the strip they're farther inside). Joints beyond a strip's cut edges are the model's guesses, so they're
 * marked unsure. The strips stay put, evenly spread and covering the whole width: a strip moved
 * onto where a player was can lose them. A strip follows one person and only searches once it
 * loses them, so who it looks for is steered by greying people out of its picture (StripHiding).
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
/**
 * While a player is missing: a strip shown people hidden that has found nobody new for IDLE
 * results takes over a person it shares with another strip, which gets TRY results to find
 * somebody else; then no other try for REST results, nor between the same two strips for AGAIN.
 */
const IDLE = 15, TRY = 6, REST = 90, AGAIN = 300;
const TORSO = [11, 12, 23, 24];
const LIMBS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/** Where somebody's torso is, in picture heights (x scaled by the aspect ratio), and their size. */
function torso(points: readonly Point[], aspect: number) {
  const [ls, rs, lh, rh] = TORSO.map(i => points[i]);
  return { x: (ls.x + rs.x + lh.x + rh.x) / 4 * aspect, y: (ls.y + rs.y + lh.y + rh.y) / 4,
    scale: Math.max(Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2 * aspect, (ls.y + rs.y - lh.y - rh.y) / 2), Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y) / 0.75, 0.01) };
}

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
    const sure = TORSO.every(i => reliable(points[i]));
    const { x, y, scale } = torso(points, aspect);
    // How far inside its strip it is: from the torso to the nearest cut edge, in picture widths.
    const inside = Math.min(tile.x > 0 ? x / aspect - tile.x : Infinity, tile.x + tile.width < 1 ? tile.x + tile.width - x / aspect : Infinity);
    return { points, tile, sure, x, y, scale, inside,
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

/**
 * Around somebody's head, torso and legs (their sure joints, all of them if none is), with room
 * for their hair and clothes: hiding that is enough for the model to lose them, and leaves
 * whoever their outstretched arms reach over in view.
 */
function outline(points: readonly Point[]): Box {
  const core = points.filter((_, i) => i < 13 || i > 22), sure = core.filter(reliable), use = sure.length ? sure : core;
  const xs = use.map(p => p.x), ys = use.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = 0.25 * (x1 - x0), py = 0.1 * (y1 - y0);
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
  // (Only people whose torsos are sure: a copy cut off at its strip's edge may be no use to the
  // tracker, and the strip that would see them whole mustn't lose them for it.)
  return tiles.map(tile => found.some(f => f.tile === tile && kept.includes(f.points)) ? []
    : found.filter(f => f.tile !== tile && kept.includes(f.points) && TORSO.every(i => reliable(f.points[i]))).map(f => outline(f.points))
      .filter(b => b.x1 > tile.x && b.x0 < tile.x + tile.width));
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Who each strip is shown hidden, from one result to the next:
 * - a strip whose result was somebody another strip keeps, or nobody, the people the others keep
 *   (hidden());
 * - while a player is missing, a strip that has looked for a while and found nobody new takes
 *   over somebody it shares with another strip (whose torso is well inside it), so that strip
 *   looks for whoever else is in it instead: the strip a shared person is kept from may be the
 *   only one that could see somebody else. If it finds nobody, it sees them again (whichever of
 *   the two sees them better follows them), and the two don't hand anybody over for a while.
 *
 * (The model can make a squashed copy of somebody from what's left of them; the tracker drops it.)
 */
export class StripHiding {
  readonly tiles: readonly Tile[];
  /** Who each strip is shown hidden in the next frame. */
  hide: Box[][];
  /** Per strip: in how many results running it was shown people hidden and found nobody new. */
  idle: number[];
  /** A strip that took over somebody another strip followed, who they were, and when. */
  handoff: { from: number; to: number; box: Box; at: number } | null = null;
  results = 0;
  /** No hand-off before this result. */
  rest = 0;
  /** Hand-offs that found nobody ("from,to"): not again before this result. */
  tried = new Map<string, number>();
  constructor(tiles: readonly Tile[]) {
    this.tiles = tiles;
    this.hide = tiles.map(() => []);
    this.idle = tiles.map(() => 0);
  }

  /**
   * Who to hide from each strip next, given this result (each strip's people, those kept) and,
   * when known, how many players the tracker found in the last one.
   */
  next<P extends Point>(found: readonly { points: P[]; tile: Tile }[], kept: readonly P[][], aspect: number, players?: number): Box[][] {
    const n = ++this.results;
    const shown = this.hide;
    const next = hidden(found, kept, this.tiles);
    // Each strip's own person, when kept.
    const own = this.tiles.map(tile => found.find(f => f.tile === tile && kept.includes(f.points))?.points);
    const missing = players !== undefined && players < this.tiles.length;
    this.idle = this.idle.map((count, i) => shown[i].length && !own[i] ? count + 1 : 0);
    if (this.handoff) {
      const { from, to, box, at } = this.handoff;
      const mine = own[from], centre = mine && torso(mine, aspect);
      // Found somebody else: they keep them. Nobody: they see the shared person again.
      if (centre && !(centre.x / aspect > box.x0 && centre.x / aspect < box.x1)) { this.handoff = null; this.rest = n + REST; }
      else if (n - at >= TRY) {
        next[from] = next[from].filter(b => !overlaps(b, box));
        this.handoff = null; this.rest = n + REST; this.tried.set(`${from},${to}`, n + AGAIN).set(`${to},${from}`, n + AGAIN);
      }
    } else if (missing && n >= this.rest) {
      // Somebody another strip keeps whom an idle strip sees whole (none of their sure joints
      // beyond its edges), nearest its middle.
      const shared = this.idle.flatMap((count, to) => count < IDLE ? [] : own.flatMap((points, from) => {
        const tile = this.tiles[to];
        if (!points || from === to || (this.tried.get(`${from},${to}`) ?? 0) > n || !TORSO.every(i => reliable(points[i]))) return [];
        const { x, scale } = torso(points, aspect), margin = 0.4 * scale / aspect;
        return x / aspect > tile.x + margin && x / aspect < tile.x + tile.width - margin
          ? [{ from, to, points, off: Math.abs(x / aspect - tile.x - tile.width / 2) }] : [];
      })).sort((a, b) => a.off - b.off)[0];
      if (shared) {
        const { to } = shared;
        const box = outline(shared.points);
        next[shared.from].push(box);
        next[to] = next[to].filter(b => !overlaps(b, box));
        this.handoff = { from: shared.from, to, box, at: n };
        this.idle[to] = 0;
      }
    }
    this.hide = next.map((boxes, i) => boxes.filter(b => b.x1 > this.tiles[i].x && b.x0 < this.tiles[i].x + this.tiles[i].width));
    return this.hide;
  }
}
