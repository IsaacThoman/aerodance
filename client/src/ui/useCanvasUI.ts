import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { loadFonts } from './draw.ts';
import { createFocusRing, drawFocusRing, updateFocusRing } from './focusRing.ts';
import type { Circle, Point, Rect } from './draw.ts';

/**
 * An in-engine 2D overlay: a canvas the size of the render buffer, laid out in design
 * units, uploaded as a texture and drawn on a full-screen quad after the world. It shares
 * the world's pixels and stretch, so UI and world always match in resolution and aspect.
 *
 * const ui = useCanvasUI({
 *   priority: 2,                          // useFrame priority (the world renders at 1)
 *   design: (cssW, cssH) => ({ w, h }),   // design units for the displayed size (default 1600x900)
 *   widgets: (ui) => [{ id, rect | circle, drag?, nav?, primary? }],  // current hit areas, in content units
 *   active: (ui) => bool,                 // input and hover go to widgets only while true
 *   onActivate: (wdg, ui) => {},          // press and release on the same widget
 *   onDrag: (wdg, point, ui) => {},       // widgets with drag: true (sliders)
 *   onStep: (wdg, dir, ui, repeat) => bool,  // Left/Right on the keyboard cursor's widget; true if used
 *   onKey: (event, ui) => {},
 *   keyNav: bool | (ui) => bool,          // arrow keys step through the widgets, Enter/Space presses
 *   update: (dt, ui) => {},               // per-frame animation; ui.ease() marks the overlay dirty
 *   draw: (g, ui) => {},                  // redraw in design units, only when dirty
 *   opacity: (ui) => 1,                   // the overlay isn't drawn below 0.005
 * });
 *
 * With keyNav, Up/Down (or Tab/Shift+Tab) move a keyboard cursor (ui.focus(), pointerKind
 * 'key') to the next widget while the overlay is active, skipping widgets with nav: false;
 * the widget under it gets the focus ring (ui/focusRing.ts) and Enter/Space press it. The
 * cursor is shared by every keyNav overlay, in priority order, so it runs from a screen's
 * buttons on to controls other overlays draw beside them (the Connect Client pill, the
 * fullscreen bubble). It starts on the screen's primary widget, which Enter/Space also press
 * while there is no cursor and the mouse isn't over another; it follows its widget by id and
 * lets go once the widget is gone, the overlay hides or the mouse moves.
 * Left/Right go to onStep first (a slider steps, a camera arrow switches camera) and
 * otherwise move the cursor like Up/Down.
 * Content taller than the design height scrolls by drag or wheel: draw sets ui.contentHeight.
 * Works with <Canvas frameloop="demand">: input, ui.invalidate() and running animations
 * (anything that marks the overlay dirty) request the next frame.
 */

/** A hit area: a rect or a circle, in content units. Screens add their own fields. */
export type Widget = {
  id: string;
  /** Pressing drags (sliders): onDrag instead of onActivate. */
  drag?: boolean;
  /** false: keyboard navigation skips it. */
  nav?: boolean;
  /** The screen's main action: the keyboard cursor starts here, and Enter/Space press it while there is no cursor. */
  primary?: boolean;
} & ({ rect: Rect; circle?: undefined } | { circle: Circle; rect?: undefined });

/** Design size in units for a displayed CSS size. */
export interface DesignSize { w: number; h: number; }

/** An overlay's live state: layout size, pointer, hover/press animation and scrolling. */
export interface CanvasUI<W extends Widget = Widget> {
  /** Design size. */
  w: number;
  h: number;
  /** In content units (scroll included); null when the pointer is away. */
  pointer: Point | null;
  /** 0..1 per widget id, eased. */
  hover: Record<string, number>;
  /** 1 on activation, easing back to 0. */
  press: number;
  /** The id of the widget held down. */
  pressed: string | null;
  /** The last input's pointerType, or 'key' for keyboard navigation. */
  pointerKind: string | null;
  /** The id of this overlay's widget the keyboard cursor is on. */
  readonly keyFocus: string | null;
  /** The keyboard cursor is out, on this overlay or another. */
  readonly keyboard: boolean;
  /** Puts the keyboard cursor on a widget (taking it from any other overlay), or takes it away (null), wherever it is. */
  focus(wdg: Widget | null): void;
  /** The slider being dragged. */
  drag: W | null;
  scroll: number;
  /** Set by draw: content taller than h scrolls. */
  contentHeight: number;
  dirty: boolean;
  dt: number;
  time: number;
  requestFrame: () => void;
  /** Marks the overlay dirty and asks for a frame. */
  invalidate(): void;
  readonly maxScroll: number;
  /** Eases v towards `to`, marking the overlay dirty while it moves. */
  ease(v: number, to: number, rate: number): number;
}

export interface CanvasUIOptions<W extends Widget = Widget> {
  /** useFrame priority (the world renders at 1). */
  priority?: number;
  design?: (cssW: number, cssH: number) => DesignSize;
  widgets?: (ui: CanvasUI<W>) => readonly W[];
  active?: (ui: CanvasUI<W>) => boolean;
  onActivate?: (wdg: W, ui: CanvasUI<W>) => void;
  onDrag?: (wdg: W, point: Point, ui: CanvasUI<W>) => void;
  /** Left (-1) / Right (1) on the keyboard cursor's widget (repeat: the key is held): true when it used the key. */
  onStep?: (wdg: W, dir: -1 | 1, ui: CanvasUI<W>, repeat: boolean) => boolean;
  onKey?: (event: KeyboardEvent, ui: CanvasUI<W>) => void;
  keyNav?: boolean | ((ui: CanvasUI<W>) => boolean);
  update?: (dt: number, ui: CanvasUI<W>) => void;
  draw: (g: CanvasRenderingContext2D, ui: CanvasUI<W>) => void;
  opacity?: (ui: CanvasUI<W>) => number;
}

// Hit areas are padded a little so a bubble's rim and edge count as part of it.
const PAD = 8;
export const inRect = (p: Point | null, r: Rect) => !!p && p.x >= r.x - PAD && p.x <= r.x + r.w + PAD && p.y >= r.y - PAD && p.y <= r.y + r.h + PAD;
export const inCircle = (p: Point | null, c: Circle) => !!p && Math.hypot(p.x - c.x, p.y - c.y) <= c.r + 6;
export const hit = (p: Point | null, wdg: Widget) => (wdg.rect ? inRect(p, wdg.rect) : inCircle(p, wdg.circle));

// Overlays share the canvas element, so the cursor is a pointer while any of them wants one.
const cursorWants = new WeakMap<HTMLElement, Set<object>>();
function wantCursor(el: HTMLElement, key: object, want: boolean) {
  const wants = cursorWants.get(el) ?? new Set();
  cursorWants.set(el, wants);
  if (want) wants.add(key);
  else wants.delete(key);
  el.style.cursor = wants.size ? 'pointer' : '';
}

const center = (wdg: Widget): Point => (wdg.rect ? { x: wdg.rect.x + wdg.rect.w / 2, y: wdg.rect.y + wdg.rect.h / 2 } : { x: wdg.circle.x, y: wdg.circle.y });

/** An overlay taking part in keyboard navigation. */
interface NavOverlay {
  readonly priority: number;
  ui: CanvasUI<Widget>;
  /** The widgets the cursor can visit now: none while inactive or without keyNav. */
  widgets(): readonly Widget[];
  /** Left/Right on a widget; true when the overlay used it (stepped a slider). */
  step(wdg: Widget, dir: -1 | 1, repeat: boolean): boolean;
  activate(wdg: Widget): void;
}
const navOverlays = new Set<NavOverlay>();
// The keyboard cursor: one for every overlay, on a widget (by id) of one of them.
let keyCursor: { ui: CanvasUI<Widget>; id: string } | null = null;

// The navigation keys, for every keyNav overlay at once: the arrows (and Tab) move the
// keyboard cursor, Left/Right step its widget first, and Enter/Space press it, or the primary
// widget while there is no cursor and the mouse isn't over another.
function onNavKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]')) return;
  const press = e.key === 'Enter' || e.key === ' ';
  const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab';
  const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (!press && !vertical && !horizontal) return;
  const overlays = [...navOverlays].sort((a, b) => a.priority - b.priority);
  const stops = overlays.flatMap((o) => o.widgets().map((wdg) => ({ o, wdg })));
  if (!stops.length) return;
  const at = stops.findIndex(({ o, wdg }) => o.ui === keyCursor?.ui && wdg.id === keyCursor.id);
  const primary = stops.findIndex(({ wdg }) => wdg.primary);
  const hovered = stops.findIndex(({ o, wdg }) => o.ui.pointerKind !== 'key' && hit(o.ui.pointer, wdg));
  if (press) {
    // (A cursor on an overlay that is fading or on hold counts as none.)
    const target = at >= 0 ? stops[at] : hovered < 0 || hovered === primary ? stops[primary] : undefined;
    if (!target) return;
    e.preventDefault();
    if (e.repeat || target.wdg.drag) return;
    target.o.ui.focus(target.wdg);
    target.o.activate(target.wdg);
    return;
  }
  e.preventDefault();
  const dir = e.key === 'ArrowUp' || e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
  if (horizontal && at >= 0 && stops[at].o.step(stops[at].wdg, dir, e.repeat)) return;
  // Without a cursor, start from the widget under the mouse, else the primary one.
  const from = at >= 0 ? at : hovered;
  const n = stops.length;
  const next = from >= 0 ? (from + dir + n) % n : primary >= 0 ? primary : dir > 0 ? 0 : n - 1;
  // The mouse's hover gives way to the cursor.
  for (const o of overlays) o.ui.pointer = null;
  stops[next].o.ui.focus(stops[next].wdg);
}

const DEFAULT_DESIGN = (): DesignSize => ({ w: 1600, h: 900 });
// A press that travels this far (design units) turns into a scroll.
const SCROLL_SLOP = 14;

function createState<W extends Widget>(): CanvasUI<W> {
  return {
    w: 1600,
    h: 900,
    pointer: null,
    hover: {},
    press: 0,
    pressed: null,
    pointerKind: null,
    get keyFocus() { return keyCursor?.ui === this ? keyCursor.id : null; },
    get keyboard() { return !!keyCursor; },
    focus(wdg) {
      if (wdg) {
        if (keyCursor && keyCursor.ui !== this) {
          keyCursor.ui.pointer = null;
          keyCursor.ui.invalidate();
        }
        keyCursor = { ui: this, id: wdg.id };
        this.pointer = center(wdg);
        this.pointerKind = 'key';
      } else if (keyCursor) {
        keyCursor.ui.pointer = null;
        keyCursor.ui.invalidate();
        keyCursor = null;
      }
      this.invalidate();
    },
    drag: null,
    scroll: 0,
    contentHeight: 0,
    dirty: true,
    dt: 0,
    time: 0,
    requestFrame: () => {},
    invalidate() { this.dirty = true; this.requestFrame(); },
    get maxScroll() { return Math.max(0, this.contentHeight - this.h); },
    // Eases v towards `to`, marking the overlay dirty while it moves.
    ease(v, to, rate) {
      const n = v + (to - v) * Math.min(1, this.dt * rate);
      if (Math.abs(n - to) > 1e-3) { this.dirty = true; return n; }
      if (n !== v) this.dirty = true;
      return to;
    },
  };
}

export default function useCanvasUI<W extends Widget = Widget>(options: CanvasUIOptions<W>): CanvasUI<W> {
  const gl = useThree((state) => state.gl);
  const requestFrame = useThree((state) => state.invalidate);
  const opts = useRef(options);
  opts.current = options;

  const overlay = useMemo(() => {
    const canvas = document.createElement('canvas');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    // The same context every time the canvas is asked for it, across resizes.
    const g = canvas.getContext('2d');
    if (!g) throw Error('2D canvas unavailable');
    return { canvas, g, texture, material, quad, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1) };
  }, []);

  const ref = useRef<CanvasUI<W> | null>(null);
  ref.current ??= createState<W>();
  const ui = ref.current;
  ui.requestFrame = requestFrame;
  const focusRing = useRef(createFocusRing()).current;

  useEffect(() => {
    const el = gl.domElement;
    const s = ui;
    const key = {};
    const toDesign = (e: MouseEvent): Point => {
      const rect = el.getBoundingClientRect();
      return { x: ((e.clientX - rect.left) / rect.width) * s.w, y: ((e.clientY - rect.top) / rect.height) * s.h + s.scroll };
    };
    const active = () => opts.current.active?.(s) ?? true;
    const widgetAt = (p: Point | null) => (active() ? opts.current.widgets?.(s).find((wdg) => hit(p, wdg)) : undefined);
    let down: { y: number; scroll: number } | null = null; // for drag-to-scroll

    const onMove = (e: PointerEvent) => {
      // The mouse takes over from the keyboard cursor.
      if (s.keyFocus) s.focus(null);
      s.pointer = toDesign(e);
      s.pointerKind = e.pointerType;
      if (s.drag) opts.current.onDrag?.(s.drag, s.pointer, s);
      if (down && s.maxScroll > 0) {
        const dy = s.pointer.y - s.scroll - down.y;
        if (s.pressed && Math.abs(dy) > SCROLL_SLOP) s.pressed = null;
        if (!s.pressed) {
          s.scroll = Math.min(s.maxScroll, Math.max(0, down.scroll - dy));
          s.dirty = true;
        }
      }
      wantCursor(el, key, !!(s.drag || widgetAt(s.pointer)));
    };
    const onLeave = () => { s.pointer = null; wantCursor(el, key, false); };
    // Buttons fire on release when the press started on the same button, so a
    // press anywhere on the bubble counts even if the pointer wobbles a little.
    // Returns the widget pressed.
    const pressAt = (p: Point) => {
      s.pointer = p;
      const wdg = widgetAt(p);
      if (!wdg) return undefined;
      if (wdg.drag) {
        s.drag = wdg;
        opts.current.onDrag?.(wdg, p, s);
      } else {
        s.pressed = wdg.id;
      }
      return wdg;
    };
    const activate = (wdg: W) => {
      s.press = 1;
      opts.current.onActivate?.(wdg, s);
    };
    const releaseAt = (p: Point) => {
      if (s.drag) { s.drag = null; return; }
      const id = s.pressed;
      s.pressed = null;
      if (!id) return;
      const wdg = widgetAt(p);
      if (wdg?.id === id) activate(wdg);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // A tap takes over from the keyboard cursor too (it may come without a move).
      if (s.keyFocus) s.focus(null);
      const p = toDesign(e);
      if (!widgetAt(p) && !(s.maxScroll > 0 && active())) return;
      el.setPointerCapture(e.pointerId);
      const wdg = pressAt(p);
      down = wdg?.drag ? null : { y: p.y - s.scroll, scroll: s.scroll };
    };
    const onUp = (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      down = null;
      // A lifted finger isn't hovering anything.
      if (e.pointerType === 'touch') setTimeout(() => { s.pointer = null; }, 0);
      releaseAt(toDesign(e));
    };
    const onCancel = (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      down = null;
      s.drag = null;
      s.pressed = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!(s.maxScroll > 0) || !active()) return;
      const rect = el.getBoundingClientRect();
      s.scroll = Math.min(s.maxScroll, Math.max(0, s.scroll + (e.deltaY / rect.height) * s.h));
      s.dirty = true;
    };
    const keyNav = () => {
      const { keyNav: on } = opts.current;
      return (typeof on === 'function' ? on(s) : !!on) && active();
    };
    const nav: NavOverlay = {
      get priority() { return opts.current.priority ?? 2; },
      ui: s,
      widgets: () => (keyNav() ? (opts.current.widgets?.(s) ?? []).filter((wdg) => wdg.nav !== false) : []),
      step: (wdg, dir, repeat) => {
        if (!opts.current.onStep?.(wdg as W, dir, s, repeat)) return false;
        s.invalidate();
        return true;
      },
      activate: (wdg) => {
        activate(wdg as W);
        s.invalidate();
      },
    };
    // One listener handles the navigation keys for every overlay.
    navOverlays.add(nav);
    if (navOverlays.size === 1) window.addEventListener('keydown', onNavKey);
    const onKey = (e: KeyboardEvent) => opts.current.onKey?.(e, s);

    // Each input asks for a frame (frameloop="demand" renders nothing otherwise).
    const offs: (() => void)[] = [];
    const listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      const framed = (e: HTMLElementEventMap[K]) => { fn(e); s.requestFrame(); };
      el.addEventListener(type, framed, o);
      offs.push(() => el.removeEventListener(type, framed));
    };
    listen('pointermove', onMove);
    listen('pointerleave', onLeave);
    listen('pointerdown', onDown);
    listen('pointerup', onUp);
    listen('pointercancel', onCancel);
    listen('wheel', onWheel, { passive: true });
    const keyFramed = (e: KeyboardEvent) => { onKey(e); s.requestFrame(); };
    window.addEventListener('keydown', keyFramed);
    offs.push(() => window.removeEventListener('keydown', keyFramed));

    let cancelled = false;
    loadFonts().then(() => { if (!cancelled) s.invalidate(); });

    return () => {
      cancelled = true;
      navOverlays.delete(nav);
      if (!navOverlays.size) window.removeEventListener('keydown', onNavKey);
      if (keyCursor?.ui === s) keyCursor = null;
      for (const off of offs) off();
      wantCursor(el, key, false);
    };
  }, [gl, ui]);

  useEffect(() => () => {
    overlay.texture.dispose();
    overlay.material.dispose();
    overlay.quad.geometry.dispose();
  }, [overlay]);

  useFrame((_, delta) => {
    const s = ui;
    const o = opts.current;
    s.dt = Math.min(delta, 0.1);
    s.time += s.dt;

    // Match the render buffer exactly so overlay pixels line up with world pixels.
    const buf = gl.getDrawingBufferSize(new THREE.Vector2());
    if (overlay.canvas.width !== buf.x || overlay.canvas.height !== buf.y) {
      overlay.canvas.width = buf.x;
      overlay.canvas.height = buf.y;
      overlay.texture.dispose();
      s.dirty = true;
    }
    const el = gl.domElement;
    const d = (o.design ?? DEFAULT_DESIGN)(el.clientWidth || 1, el.clientHeight || 1);
    if (d.w !== s.w || d.h !== s.h) {
      s.w = d.w;
      s.h = d.h;
      s.dirty = true;
    }

    const live = o.active?.(s) ?? true;
    const widgets = o.widgets?.(s) ?? [];
    // The keyboard cursor stays on its widget: it follows it, and lets go once the widget is
    // gone or can't be visited (another screen, phase or page).
    const focused = live && s.keyFocus ? widgets.find((wdg) => wdg.id === s.keyFocus) : undefined;
    if (live && s.keyFocus && (!focused || focused.nav === false)) s.focus(null);
    else if (focused) {
      const c = center(focused);
      if (c.x !== s.pointer?.x || c.y !== s.pointer.y) { s.pointer = c; s.dirty = true; }
    }
    const hovered = live && (s.drag?.id ?? widgets.find((wdg) => hit(s.pointer, wdg))?.id);
    for (const id of new Set([...Object.keys(s.hover), ...widgets.map((wdg) => wdg.id)])) {
      s.hover[id] = s.ease(s.hover[id] ?? 0, id === hovered ? 1 : 0, 12);
    }
    s.press = s.ease(s.press, 0, 10);
    // The keyboard cursor's widget gets the focus ring (ui/focusRing.ts).
    updateFocusRing(focusRing, s.keyFocus ? focused : undefined, s);
    o.update?.(s.dt, s);
    if (s.scroll > s.maxScroll) { s.scroll = s.maxScroll; s.dirty = true; }

    const alpha = o.opacity?.(s) ?? 1;
    if (alpha < 0.005) {
      // A hidden overlay lets go of the keyboard cursor, so it can't come back with it.
      if (s.keyFocus) s.focus(null);
      return;
    }

    if (s.dirty) {
      s.dirty = false;
      const { g } = overlay;
      const sx = overlay.canvas.width / s.w;
      const sy = overlay.canvas.height / s.h;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, overlay.canvas.width, overlay.canvas.height);
      // The context outlives each draw: start every redraw from the same state.
      Object.assign(g, {
        globalAlpha: 1, textAlign: 'start', textBaseline: 'alphabetic', shadowColor: 'transparent',
        shadowBlur: 0, shadowOffsetY: 0, lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
      });
      if ('letterSpacing' in g) g.letterSpacing = '0px';
      g.setTransform(sx, 0, 0, sy, 0, -s.scroll * sy);
      o.draw(g, s);
      drawFocusRing(g, focusRing);
      overlay.texture.needsUpdate = true;
      // Still animating (easing, particles): keep frames coming until it settles.
      s.requestFrame();
    }

    overlay.material.opacity = alpha;
    const ac = gl.autoClear;
    gl.autoClear = false;
    gl.clearDepth();
    gl.render(overlay.scene, overlay.camera);
    gl.autoClear = ac;
  }, options.priority ?? 2);

  return ui;
}
