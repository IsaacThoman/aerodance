import { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { SplitCamera, splitCell } from '../../../../../packages/stages/shared/post.tsx';
import type { HandTracking } from '../../../../../packages/pose/webcamRecord.ts';
import { PLAYERS, backOut, clamp01 } from '../../game/results.ts';
import type { PlayerLook } from '../../game/results.ts';
import { FONT, drawCaps, drawDarkGlassPanel, drawDisc, drawHeadline, drawShadowText, drawStatusDot, roundRect, wrapText } from '../../ui/draw.ts';
import type { Face, IconDraw, Rect } from '../../ui/draw.ts';
import useGlassBlur from '../../ui/useGlassBlur.ts';
import type { GlassPane } from '../../ui/useGlassBlur.ts';
import { useMinigameFrame, useMinigameOverlay } from '../hooks.ts';
import type { MinigameContext, MinigamePhase } from '../types.ts';
import { raiseIcon, swingIcon } from './art.ts';
import { describePass, shiftWords } from './calibrate.ts';
import { ASSIST_LABELS, HudModel, RALLY, TOAST_S, lookOf, nameOf, trackingNote } from './calls.ts';
import type { Prompt } from './calls.ts';
import { MATCH, deuce, matchPointFor } from './match.ts';
import { choiceLabel } from './options.ts';
import type { End } from './rally.ts';
import { drawLag } from './round.ts';
import type { Play, Round } from './round.ts';
import type { Rig } from './rig.ts';

/*
 * Table Tennis's HUD, in the manner of Wii Sports Resort's, on the game's overlay
 * (useMinigameOverlay) in the app's own glass. What it says is calls.ts's; this draws it:
 *
 *   the score bug   under the pause icon at the top centre: a gel chip in each side's colours
 *                   (You and the robot alone; Player 1 and Player 2 across the split screen's
 *                   divider), its digits bumping as a point goes in, a ball by the server, and
 *                   under them what the match is at (6-POINT MATCH, DEUCE, MATCH POINT). In
 *                   Return Challenge, the returns and the level instead
 *   the rally       RALLY 7 under it, from the fifth shot that lands
 *   the calls       where the ball decided a point, in each view's own picture: projected
 *                   through the world's camera (a split screen's views each, whatever camera that
 *                   is), kept within the view and clear of the banners and prompts
 *   the banners     calm headlines at the centre, a moment after the call
 *   the prompts     dark glass pills at the foot of each view, only while needed; the A key's new
 *                   aim assist is said for a moment in their place
 *   tracking        a small amber chip in the bottom corner (each view's outer one) while the
 *                   tracking isn't all there
 *   development     D (Game.tsx) shows a panel with everything diagnostic: how the last ball
 *                   went by each paddle, the paddles' calibration, the settings, the keys
 *
 * It's rendered inside the game's MinigameWorld, so useThree's camera is the world's. What doesn't
 * change from one frame to the next (a chip, a headline) is drawn once into a sprite (Sprites) and
 * copied each frame: the overlay is redrawn every frame of the round (docs/minigames.md,
 * Performance).
 *
 * It reports mgCall (the last call; with two, each view's, Player 1's first: NICE!|MISSED) and
 * mgBanner (the banner showing, or null).
 */

type Ctx = CanvasRenderingContext2D;
const DEV = import.meta.env.DEV;

const DIGITS: Face = ['#ffffff', '#ffffff', '#d9eeff'];
/** The Biodome's ball (Game.tsx BALL_LOOK), for the serve's marker. */
const BALL = '#ff8a1f';
const AMBER = '#ffe08a';
const ICON: Record<'raise' | 'swing', IconDraw> = { raise: raiseIcon, swing: swingIcon };

/** A call's life (s): popping in, rising (units a second) and fading out at the end; its size. */
const CALL = { life: 1.15, pop: 0.22, fade: 0.45, rise: 30, size: 56 } as const;
/** A banner's popping in and fading out (s), and its size. */
const BANNER = { pop: 0.3, fade: 0.25, size: 64 } as const;
/** How long a new score's digits take to bump in (s). */
const BUMP_S = 0.34;
const HUD_PHASES: readonly MinigamePhase[] = ['countdown', 'playing', 'paused', 'finishing'];

/**
 * The HUD's places, in design units: the score bug's top (under the pause icon, which reaches
 * about y 74), its chips' size, the caption and rally chip under it, the banner's baseline and
 * the band the calls keep to (below the banners, above the prompts), the prompts' middle and the
 * tracking chip's foot. The host's "step back into view" nudge is at y 860, centred.
 */
const L = {
  bug: { y: 84, h: 70, w: 270, wCompact: 236, gap: 10, r: 22 },
  caption: { y: 182, h: 34, size: 20 },
  rally: { y: 224, h: 34, size: 20 },
  banner: { y: 306, size: BANNER.size },
  calls: { top: 410, bottom: 690 },
  prompt: { y: 770, h: 62, size: 28 },
  warn: { bottom: 878, size: 20, max: 520 },
} as const;

/** What Game.tsx's keys change: the development panel (D). */
export interface HudState { dev: boolean; }
export const newHud = (): HudState => ({ dev: false });

/**
 * What the drawing keeps between frames: each view's prompt's opacity and what it last said, the
 * serve's marker's opacity by each chip, when it last drew, and the pills to frost.
 */
interface Drawn { prompts: number[]; asked: (Prompt | null)[]; serves: number[]; at: number; panes: GlassPane[]; }

const lagWords = (rig: Rig, play: Play, two: boolean) => (play.hitLag === 'auto' ? `auto (${rig.latency > 0 ? Math.round((rig.latency + drawLag(two)) * 1000) : '–'} ms)` : play.hitLag ? `${Math.round(play.hitLag * 1000)} ms` : 'off');

// ---------- Sprites ----------

/**
 * A drawing kept as an image at the overlay's resolution: its canvas, its box about the point it's
 * drawn at, and its content's (a pill's, a headline's letters, not their shadows and glow), in
 * design units.
 */
interface Sprite { canvas: HTMLCanvasElement; box: Rect; content: Rect; }

/**
 * Drawings that stay the same from frame to frame, each painted once into its own canvas at the
 * overlay's own pixel scale (so it's copied pixel for pixel, its shadows as they'd be drawn
 * there), and copied each frame. A change of the display's shape starts them over.
 */
class Sprites {
  private cache = new Map<string, Sprite>();
  sx = 1;
  sy = 1;
  /** For measuring text before a sprite is painted. */
  readonly measure: Ctx;
  constructor() {
    const m = document.createElement('canvas').getContext('2d');
    if (!m) throw Error('2D canvas unavailable');
    this.measure = m;
  }
  /** At the start of each draw: the overlay's scale (its transform, design units to pixels). */
  begin(g: Ctx) {
    const t = g.getTransform();
    if (t.a !== this.sx || t.d !== this.sy || this.cache.size > 96) { this.cache.clear(); this.sx = t.a; this.sy = t.d; }
  }
  /** The sprite for `key`, made (its box measured, then painted about its origin) the first time. */
  get(key: string, make: (m: Ctx) => { box: Rect; content?: Rect; paint: (s: Ctx) => void }): Sprite {
    let sprite = this.cache.get(key);
    if (sprite) return sprite;
    this.measure.save();
    const { box, content, paint } = make(this.measure);
    this.measure.restore();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(box.w * this.sx));
    canvas.height = Math.max(1, Math.ceil(box.h * this.sy));
    const s = canvas.getContext('2d');
    if (s) {
      s.setTransform(this.sx, 0, 0, this.sy, -box.x * this.sx, -box.y * this.sy);
      paint(s);
    }
    sprite = { canvas, box: { ...box, w: canvas.width / this.sx, h: canvas.height / this.sy }, content: content ?? box };
    this.cache.set(key, sprite);
    return sprite;
  }
  /** Copies a sprite with its origin at x, y, scaled by k about it, at alpha (whole pixels at its own size). */
  put(g: Ctx, { canvas, box }: Sprite, x: number, y: number, k = 1, alpha = 1) {
    if (alpha <= 0.003 || k <= 0.01) return;
    let left = x + box.x * k, top = y + box.y * k;
    if (k === 1) { left = Math.round(left * this.sx) / this.sx; top = Math.round(top * this.sy) / this.sy; }
    const a = g.globalAlpha;
    g.globalAlpha = a * alpha;
    g.drawImage(canvas, left, top, box.w * k, box.h * k);
    g.globalAlpha = a;
  }
  /** Pixels as design units, across and down (canvas shadows are in pixels, whatever the transform). */
  px(n: number) { return { x: n / this.sx, y: n / this.sy }; }
}

const hexRgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** A glossy gel slab (the glass buttons' icon tiles, larger): its colours top to bottom, a gloss over its top half, a white rim and a soft shadow. */
function paintGel(g: Ctx, { x, y, w, h }: Rect, r: number, top: string, bottom: string) {
  g.save();
  g.shadowColor = 'rgba(0, 30, 80, 0.4)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  roundRect(g, x, y, w, h, r);
  const body = g.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, top);
  body.addColorStop(1, bottom);
  g.fillStyle = body;
  g.fill();
  g.restore();
  g.save();
  roundRect(g, x, y, w, h, r);
  g.clip();
  const gloss = g.createLinearGradient(0, y, 0, y + h * 0.5);
  gloss.addColorStop(0, 'rgba(255,255,255,0.55)');
  gloss.addColorStop(1, 'rgba(255,255,255,0.04)');
  g.fillStyle = gloss;
  roundRect(g, x + 3, y + 3, w - 6, h * 0.48, Math.max(2, r - 3));
  g.fill();
  g.restore();
  roundRect(g, x, y, w, h, r);
  g.lineWidth = 2.5;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.stroke();
}

/** The dark glass of the app's panels (drawDarkGlassPanel), as a pill. */
const paintDarkPill = (g: Ctx, r: Rect) => drawDarkGlassPanel(g, r, r.h / 2);

/** A headline (drawHeadline), centred on its origin's x with its baseline on its y. */
function headlineSprite(sprites: Sprites, text: string, size: number, face: Face): Sprite {
  return sprites.get(`h|${text}|${size}|${face.join()}`, (m) => {
    m.font = `800 ${size}px ${FONT}`;
    if ('letterSpacing' in m) m.letterSpacing = `${-size * 0.015}px`;
    const w = m.measureText(text).width, pad = sprites.px(52);
    return { box: { x: -w / 2 - pad.x, y: -size * 0.85 - pad.y, w: w + 2 * pad.x, h: size * 1.1 + 2 * pad.y + sprites.px(size * 0.09).y }, content: { x: -w / 2, y: -size * 0.75, w, h: size * 0.75 }, paint: (s) => drawHeadline(s, text, 0, 0, size, face) };
  });
}

/** Small capitals' width (drawCaps' letter spacing). */
function capsWidth(m: Ctx, text: string, size: number) {
  m.font = `800 ${size}px ${FONT}`;
  if ('letterSpacing' in m) m.letterSpacing = `${Math.round(size * 0.23)}px`;
  return m.measureText(text).width;
}

type CaptionStyle = 'plain' | 'gold' | 'champagne' | 'aqua' | PlayerLook;
// (Aqua is the progress bars' gel: drawProgress.)
const CAPTION_GEL: Record<'gold' | 'champagne' | 'aqua', [string, string]> = { gold: ['#ffd75e', '#d98f00'], champagne: ['#f2deaa', '#a8843c'], aqua: ['rgba(92, 222, 226, 0.92)', 'rgba(14, 136, 168, 0.95)'] };

/** A pill of small capitals centred on its origin: dark glass, or a gel in gold, champagne or a side's colours. */
function captionSprite(sprites: Sprites, text: string, style: CaptionStyle, size: number, h: number): Sprite {
  const key = typeof style === 'string' ? style : style.color;
  return sprites.get(`c|${text}|${key}|${size}|${h}`, (m) => {
    const tw = capsWidth(m, text, size), w = tw + h * 1.1, pad = sprites.px(14);
    const rect = { x: -w / 2, y: -h / 2, w, h };
    return {
      box: { x: rect.x - pad.x, y: rect.y - pad.y, w: w + 2 * pad.x, h: h + 2 * pad.y },
      paint: (s) => {
        if (style === 'plain') paintDarkPill(s, rect);
        else if (typeof style === 'string') paintGel(s, rect, h / 2, ...CAPTION_GEL[style]);
        else paintGel(s, rect, h / 2, hexRgba(style.color, 0.92), hexRgba(style.dark, 0.95));
        // (Letter spacing trails the last letter: centred without it.)
        drawCaps(s, text, Math.round(size * 0.23) / 2, 1, { size, align: 'center' });
      },
    };
  });
}

// ---------- The HUD ----------

export function TableTennisHud({ ctx, round, hud }: { ctx: MinigameContext; round: Round; hud: HudState }) {
  const { rigs, two } = round;
  const get = useThree((s) => s.get);
  const m = useMemo(() => new HudModel(round.play.assist), [round]);
  const drawn = useMemo((): Drawn => ({ prompts: [0, 0], asked: [null, null], serves: [0, 0], at: 0, panes: [] }), []);
  const sprites = useMemo(() => new Sprites(), []);
  const at = useMemo(() => new THREE.Vector3(), []);

  // After the round's step (its ball's frame, 0), before the world is drawn: what happened.
  useMinigameFrame(() => {
    m.observe(round);
    ctx.report(m.report(round, ctx.phase()));
  }, 0.5);

  useMinigameOverlay({
    // From the countdown on: not over the how-to card.
    phases: HUD_PHASES,
    draw: (g, ui) => {
      sprites.begin(g);
      drawn.panes.length = 0;
      const { w, h } = ui;
      const now = performance.now() / 1000, dt = Math.min(0.1, Math.max(0, now - drawn.at));
      drawn.at = now;
      const phase = ctx.phase(), playing = phase === 'playing', t = round.real;
      // The world's views: a split screen's, or its one camera, each with its cell of the screen (design units).
      const camera = get().camera;
      const cameras: THREE.Camera[] = camera instanceof SplitCamera ? camera.cameras : [camera];
      const cells = cameras.map((_, i): Rect => {
        const c = camera instanceof SplitCamera ? splitCell(camera.grid, i) : { x: 0, y: 0, w: 1, h: 1 };
        return { x: c.x * w, y: (1 - c.y - c.h) * h, w: c.w * w, h: c.h * h };
      });
      if (cameras.length > 1) {
        // The line between the views.
        g.fillStyle = 'rgba(255, 255, 255, 0.55)';
        g.fillRect(w / 2 - 1.5, 0, 3, h);
      }

      // The calls, where their points were decided, in each view.
      if (playing) {
        for (const call of m.calls) {
          const age = t - call.t;
          if (age < 0 || age > CALL.life) continue;
          const k = backOut(clamp01(age / CALL.pop)), alpha = 1 - clamp01((age - (CALL.life - CALL.fade)) / CALL.fade);
          cameras.forEach((view, i) => {
            const look = call.looks[i];
            if (!look) return;
            const sprite = headlineSprite(sprites, look.text, CALL.size, look.face);
            const p = project(view, call.at, cells[i], at);
            const cell = cells[i], half = (sprite.content.w / 2) * k;
            const x = Math.min(Math.max(p.x, cell.x + half + 16), cell.x + cell.w - half - 16);
            const y = Math.min(Math.max(p.y, L.calls.top), L.calls.bottom) - age * CALL.rise;
            sprites.put(g, sprite, x, y, k, alpha);
          });
        }
      }

      drawBug(g, sprites, m, drawn, round, w, t, dt);

      // The rally so far, from its fifth shot (not once the point's over: the call has it).
      if (round.rally >= RALLY.shown && !round.between && playing) {
        sprites.put(g, captionSprite(sprites, `RALLY ${round.rally}`, 'aqua', L.rally.size, L.rally.h), w / 2, L.rally.y + L.rally.h / 2);
      }

      // The banner showing, popping in and fading out.
      const banner = playing ? m.banner(round) : null;
      if (banner) {
        const age = t - banner.from, left = banner.to - t;
        const k = 0.6 + 0.4 * backOut(clamp01(age / BANNER.pop)), alpha = clamp01(age / 0.12) * clamp01(left / BANNER.fade);
        sprites.put(g, headlineSprite(sprites, banner.text, L.banner.size, banner.face), w / 2, L.banner.y, k, alpha);
        if (banner.sub) {
          const sub = captionSprite(sprites, banner.sub.text, banner.sub.look ?? 'plain', L.caption.size, L.caption.h);
          sprites.put(g, sub, w / 2, L.banner.y + 40, 1, alpha * clamp01((age - 0.12) / 0.2));
        }
      }

      // The prompts at the foot of each view, or the aim assist's new level across them.
      const toast = m.toast && t - m.toast.t < TOAST_S && phase !== 'finishing' ? m.toast : null;
      if (toast) {
        const age = t - toast.t;
        drawPrompt(g, sprites, drawn.panes, toast.text, null, w / 2, clamp01(age / 0.15) * clamp01((TOAST_S - age) / 0.3));
      }
      cameras.forEach((_, i) => {
        const ask = !toast && (playing || phase === 'countdown') ? m.prompt(round, i as End) : null;
        drawn.prompts[i] += ((ask ? 1 : 0) - drawn.prompts[i]) * Math.min(1, dt * (ask ? 10 : 6));
        // (Fading out, it keeps saying what it said.)
        if (ask) drawn.asked[i] = ask;
        const said = drawn.asked[i];
        if (said && drawn.prompts[i] > 0.01) drawPrompt(g, sprites, drawn.panes, said.text, said.icon && ICON[said.icon], cells[i].x + cells[i].w / 2, drawn.prompts[i]);
      });

      // Tracking that isn't all there: each view's outer bottom corner.
      const tracking = ctx.handTracking();
      if (phase !== 'finishing') rigs.forEach((rig, i) => {
        const note = trackingNote(rig, tracking, two);
        if (note?.warn && cells[i]) drawWarning(g, sprites, drawn.panes, note.text, i === 0 ? cells[i].x + 24 : cells[i].x + cells[i].w - 24, i === 0 ? 'left' : 'right');
      });

      if (DEV && hud.dev) drawDevPanel(g, round, m, tracking, w);
    },
  });
  // The pills at the foot of the screen are frosted glass, as the app's dark glass is (as last
  // drawn: not once the overlay has gone, with the round's results).
  useGlassBlur(() => ({ panes: drawn.panes, alpha: HUD_PHASES.includes(ctx.phase()) ? 1 : 0 }), { priority: 2.05 });
  return null;
}

/** A world point in a view's picture (design units), through its camera; one behind the camera as if in front of it, low. */
function project(camera: THREE.Camera, world: THREE.Vector3, cell: Rect, out: THREE.Vector3) {
  camera.updateMatrixWorld();
  out.copy(world).applyMatrix4(camera.matrixWorldInverse);
  // (A ball gone past the player lands behind them: said at the foot of their view.)
  if (out.z > -0.25) out.z = -Math.max(0.25, Math.abs(out.z));
  out.applyMatrix4((camera as THREE.PerspectiveCamera).projectionMatrix);
  return { x: cell.x + ((out.x + 1) / 2) * cell.w, y: cell.y + ((1 - out.y) / 2) * cell.h };
}

/**
 * The score bug, under the pause icon: a gel chip a side, the scores' digits inside, side by
 * side, each bumping as it goes up, the serve's ball by the server's name; what the match is at
 * under them. Return Challenge: one chip with the returns, and the level.
 */
function drawBug(g: Ctx, sprites: Sprites, m: HudModel, drawn: Drawn, round: Round, w: number, t: number, dt: number) {
  const cx = w / 2, { y, h, gap, r } = L.bug, cw = w < 1400 ? L.bug.wCompact : L.bug.w;
  const caption = (text: string, style: CaptionStyle) => sprites.put(g, captionSprite(sprites, text, style, L.caption.size, L.caption.h), cx, L.caption.y);
  const digits = (score: number, x: number, end: End) => {
    const k = 0.55 + 0.45 * backOut(clamp01((t - m.bump[end]) / BUMP_S));
    sprites.put(g, headlineSprite(sprites, String(score), 52, DIGITS), x, y + h / 2 + 19, k);
  };
  if (round.mode === 'challenge') {
    const cw1 = cw + 40, x = cx - cw1 / 2;
    sprites.put(g, chipSprite(sprites, PLAYERS[0], 'Returns', cw1, h, r, 'left', 26), x, y);
    digits(round.challenge.returns, x + cw1 - 48, 0);
    caption(`RETURN CHALLENGE · LEVEL ${round.challenge.level + 1}`, 'plain');
    return;
  }
  const ends = [0, 1] as const;
  for (const end of ends) {
    const x = end === 0 ? cx - gap / 2 - cw : cx + gap / 2;
    const look = lookOf(round, end);
    sprites.put(g, chipSprite(sprites, look, nameOf(round, end), cw, h, r, end === 0 ? 'left' : 'right'), x, y);
    digits(round.match.score[end], end === 0 ? x + cw - 44 : x + 44, end);
    // The server's ball, fading across as the serve changes.
    const serving = round.match.winner === null && round.server() === end;
    drawn.serves[end] += ((serving ? 1 : 0) - drawn.serves[end]) * Math.min(1, dt * 8);
    if (drawn.serves[end] > 0.01) sprites.put(g, ballSprite(sprites), end === 0 ? x + 24 : x + cw - 24, y + h / 2, 1, drawn.serves[end]);
  }
  const match = round.match, point = matchPointFor(match);
  if (match.winner !== null) caption('FINAL SCORE', 'plain');
  else if (deuce(match)) caption('DEUCE', 'champagne');
  else if (point !== null) caption(`MATCH POINT · ${nameOf(round, point).toUpperCase()}`, 'gold');
  else caption(`${MATCH.firstTo}-POINT MATCH`, 'plain');
}

/** A side's chip: a gel slab in its colours, its name `inset` in from the outer end (after room for the serve's ball). */
function chipSprite(sprites: Sprites, look: PlayerLook, name: string, w: number, h: number, r: number, side: 'left' | 'right', inset = 46): Sprite {
  return sprites.get(`chip|${look.color}|${name}|${w}|${h}|${side}|${inset}`, () => {
    const pad = sprites.px(14);
    return {
      box: { x: -pad.x, y: -pad.y, w: w + 2 * pad.x, h: h + 2 * pad.y },
      paint: (s) => {
        paintGel(s, { x: 0, y: 0, w, h }, r, hexRgba(look.color, 0.9), hexRgba(look.dark, 0.94));
        drawShadowText(s, name, side === 'left' ? inset : w - inset, h / 2 + 1, { size: 26, weight: 800, align: side });
      },
    };
  });
}

/** The serve's marker: a glossy little ball, centred on its origin. */
function ballSprite(sprites: Sprites): Sprite {
  return sprites.get('ball', () => {
    const r = 10, pad = sprites.px(10);
    return {
      box: { x: -r - pad.x, y: -r - pad.y, w: 2 * (r + pad.x), h: 2 * (r + pad.y) },
      paint: (s) => {
        s.save();
        s.shadowColor = 'rgba(0, 30, 70, 0.45)';
        s.shadowBlur = 4;
        s.shadowOffsetY = 2;
        s.beginPath();
        s.arc(0, 0, r, 0, Math.PI * 2);
        const fill = s.createLinearGradient(0, -r, 0, r);
        fill.addColorStop(0, '#ffc27a');
        fill.addColorStop(1, BALL);
        s.fillStyle = fill;
        s.fill();
        s.restore();
        s.beginPath();
        s.arc(0, 0, r, 0, Math.PI * 2);
        s.lineWidth = 2;
        s.strokeStyle = 'rgba(255,255,255,0.9)';
        s.stroke();
        s.beginPath();
        s.ellipse(-r * 0.15, -r * 0.42, r * 0.5, r * 0.28, 0, 0, Math.PI * 2);
        s.fillStyle = 'rgba(255,255,255,0.6)';
        s.fill();
      },
    };
  });
}

/**
 * A prompt: a dark glass pill at the foot of the screen (or a view), centred on cx, its icon on a
 * blue gel disc (as the how-to card's are) and its line. Its pane goes in `panes` for the blur.
 */
function drawPrompt(g: Ctx, sprites: Sprites, panes: GlassPane[], text: string, icon: IconDraw | null, cx: number, alpha: number) {
  const { h, size } = L.prompt;
  const sprite = sprites.get(`p|${text}|${icon ? 'i' : ''}`, (m) => {
    const disc = h * 0.36, iconW = icon ? disc * 2 + 14 : 0;
    m.font = `700 ${size}px ${FONT}`;
    const tw = m.measureText(text).width, w = tw + iconW + (icon ? h * 0.2 : h * 0.4) + h * 0.4, pad = sprites.px(8);
    const content = { x: -w / 2, y: -h / 2, w, h };
    return {
      box: { x: -w / 2 - pad.x, y: -h / 2 - pad.y, w: w + 2 * pad.x, h: h + 2 * pad.y },
      content,
      paint: (s) => {
        paintDarkPill(s, content);
        const left = -w / 2 + (icon ? h * 0.14 : h * 0.4);
        if (icon) {
          drawDisc(s, left + disc, 0, disc);
          icon(s, left + disc, 0, disc);
        }
        drawShadowText(s, text, left + iconW, 1, { size, weight: 700 });
      },
    };
  });
  sprites.put(g, sprite, cx, L.prompt.y, 1, alpha);
  const { x, y, w } = sprite.content;
  panes.push({ rect: { x: cx + x, y: L.prompt.y + y, w, h }, corner: h / 2, alpha });
}

/** A tracking warning: a small dark glass chip with an amber light, in a bottom corner (x its outer edge). */
function drawWarning(g: Ctx, sprites: Sprites, panes: GlassPane[], text: string, x: number, side: 'left' | 'right') {
  const sprite = sprites.get(`w|${text}`, (m) => {
    const { size, max } = L.warn, lineH = size * 1.3;
    m.font = `700 ${size}px ${FONT}`;
    const lines = wrapText(m, text, max - 64);
    const tw = Math.max(...lines.map((line) => m.measureText(line).width)), w = tw + 64, h = lines.length * lineH + 18, pad = sprites.px(6);
    const content = { x: 0, y: -h, w, h };
    return {
      box: { x: -pad.x, y: -h - pad.y, w: w + 2 * pad.x, h: h + 2 * pad.y },
      content,
      paint: (s) => {
        drawDarkGlassPanel(s, content, Math.min(22, h / 2));
        drawStatusDot(s, 24, -h + 9 + lineH / 2, 'connecting', 8);
        lines.forEach((line, i) => drawShadowText(s, line, 44, -h + 9 + lineH * (i + 0.5), { size, weight: 700, color: AMBER }));
      },
    };
  });
  // (Its origin is its foot's left end.)
  const { w, h } = sprite.content, left = side === 'left' ? x : x - w;
  sprites.put(g, sprite, left, L.warn.bottom);
  panes.push({ rect: { x: left, y: L.warn.bottom - h, w, h }, corner: Math.min(22, h / 2) });
}

/**
 * Development (D): everything diagnostic in a dark glass panel in the top left, its lines wrapped
 * to keep it clear of the score bug: how the last ball went by each paddle, each paddle's
 * calibration, the settings, the hand tracking and the keys.
 */
function drawDevPanel(g: Ctx, round: Round, model: HudModel, tracking: HandTracking | null, width: number) {
  const { rigs, play, two } = round;
  const scale = play.timeScale === 1 ? '1×' : play.timeScale === 0.5 ? '½×' : '¼×';
  const lines: string[] = [];
  const easy = play.controls === 'easy';
  for (const rig of rigs) {
    const who = two ? `P${rig.end + 1} ` : '';
    if (easy) {
      // Easy: how the last swing was timed (below 0, early), and how late the camera shows a swing.
      const swing = model.swings[rig.end];
      lines.push(`${who}Last swing: ${swing ? `${swing.kind}, ${swing.timing >= 0 ? '+' : ''}${Math.round(swing.timing * 1000)} ms` : 'none yet'} · camera delay ${rig.latency > 0 ? `${Math.round(rig.latency * 1000)} ms` : '–'}`);
    } else {
      const pass = round.passes[rig.end];
      lines.push(`${who}Last ball: ${pass ? describePass(pass) : 'none yet'}`);
      lines.push(`${who}Paddle calibration: shifted ${shiftWords(rig.shift)} · hit timing ${lagWords(rig, play, two)}`);
    }
    const note = trackingNote(rig, tracking, two);
    if (note) lines.push(`${who}${note.text}`);
  }
  lines.push(`${easy ? 'Controls Easy' : `Controls Precise · Aim assist ${ASSIST_LABELS[play.assist]}`}${!two && round.mode === 'match' ? ` · Opponent ${choiceLabel('opponent', play.botLevel)}` : ''} · Time ${scale} · Forgiving ${play.forgiving ? 'on' : 'off'}`);
  lines.push(`Stand-ins ${rigs.some((r) => r.autoplay) ? rigs.filter((r) => r.autoplay).map((r) => `P${r.end + 1}`).join('+') : 'off'} · Hands ${tracking ?? 'off'} · Best rally ${round.best}`);
  lines.push(`Keys: Space serve${easy ? "" : " · A assist"} · T time · F forgiving · L hit timing · ${two ? 'O/P' : 'O'} stand-in · D this panel`);
  const size = 18, lineH = 23, pad = 14, x = 24, y = 24;
  const room = width / 2 - (width < 1400 ? L.bug.wCompact : L.bug.w) - L.bug.gap - 24 - x - pad * 2;
  g.font = `600 ${size}px ${FONT}`;
  // (A wrapped line's rest is indented.)
  const rows = lines.flatMap((line) => wrapText(g, line, room).map((row, i) => (i ? `   ${row}` : row)));
  const widest = Math.max(...rows.map((row) => g.measureText(row).width));
  drawDarkGlassPanel(g, { x, y, w: widest + pad * 2, h: rows.length * lineH + pad * 2 - 4 }, 16);
  rows.forEach((row, i) => drawShadowText(g, row, x + pad, y + pad + lineH / 2 - 2 + i * lineH, { size, weight: 600, color: '#dff4ff' }));
}
