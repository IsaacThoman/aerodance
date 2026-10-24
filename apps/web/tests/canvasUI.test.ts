import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { RootState } from '@react-three/fiber';
import type { CanvasTexture, Scene } from 'three';
import type { CanvasUIOptions, Widget } from '../src/ui/useCanvasUI.ts';

// Mount the real hook/frame callback with small hook adapters; no renderer or browser starts.
const hookKey = Symbol.for('aerodance.canvas-ui-test');
const hookURL = new URL('../src/ui/useCanvasUI.ts', import.meta.url).href;
const adapterURL = `data:text/javascript,${encodeURIComponent(`
  const harness = () => globalThis[Symbol.for('aerodance.canvas-ui-test')];
  export const useRef = current => ({ current });
  export const useMemo = create => create();
  export const useLayoutEffect = effect => effect();
  export const useEffect = effect => { const cleanup = effect(); if (cleanup) harness().cleanups.push(cleanup); };
  export const useThree = select => select(harness().root);
  export const useFrame = callback => { harness().frame = callback; };
`)}`;
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === hookURL && (specifier === 'react' || specifier === '@react-three/fiber')) {
      return { url: adapterURL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { default: mountCanvasUI } = await import('../src/ui/useCanvasUI.ts').finally(() => loader.deregister());

const defaultState = () => ({
  globalAlpha: 1, globalCompositeOperation: 'source-over', shadowColor: 'transparent',
  shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none', lineWidth: 1,
  transform: [1, 0, 0, 1, 0, 0],
});
type ContextState = ReturnType<typeof defaultState>;

class TestContext2D {
  canvas: TestCanvas;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  shadowColor = 'transparent';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  filter = 'none';
  lineWidth = 1;
  transform = [1, 0, 0, 1, 0, 0];
  stack: ContextState[] = [];
  copies: { source: TestCanvas; state: ContextState }[] = [];
  strokes: ContextState[] = [];
  constructor(canvas: TestCanvas) { this.canvas = canvas; }
  state(): ContextState {
    const { globalAlpha, globalCompositeOperation, shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY, filter, lineWidth, transform } = this;
    return { globalAlpha, globalCompositeOperation, shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY, filter, lineWidth, transform };
  }
  reset() { Object.assign(this, defaultState()); this.stack = []; }
  save() { this.stack.push(this.state()); }
  restore() { Object.assign(this, this.stack.pop()); }
  setTransform(...values: number[]) { this.transform = values; }
  clearRect() { this.canvas.pixels = []; }
  drawImage(source: TestCanvas, ...position: number[]) {
    assert.deepEqual(position, [0, 0], 'copy without scaling or fractional offsets');
    assert.deepEqual(this.transform, [1, 0, 0, 1, 0, 0]);
    assert.equal(this.globalAlpha, 1);
    assert.equal(this.globalCompositeOperation, 'copy');
    assert.equal(this.shadowColor, 'transparent');
    assert.equal(this.filter, 'none');
    assert.equal(this.canvas.width, source.width);
    assert.equal(this.canvas.height, source.height);
    this.copies.push({ source, state: this.state() });
    this.canvas.pixels = [...source.pixels];
  }
  beginPath() {}
  roundRect() {}
  createConicGradient() { return { addColorStop() {} }; }
  stroke() { this.strokes.push(this.state()); this.canvas.pixels.push('ring'); }
}

class TestCanvas {
  private w = 300;
  private h = 150;
  pixels: string[] = [];
  g = new TestContext2D(this);
  get width() { return this.w; }
  set width(value: number) { this.w = value; this.pixels = []; this.g.reset(); }
  get height() { return this.h; }
  set height(value: number) { this.h = value; this.pixels = []; this.g.reset(); }
  getContext() { return this.g; }
}

const button: Widget = { id: 'button', rect: { x: 100, y: 100, w: 300, h: 80 } };

function fixture(t: TestContext) {
  const cleanups: (() => void)[] = [], canvases: TestCanvas[] = [];
  let resolveFonts!: () => void;
  const fonts = new Promise<void>(resolve => { resolveFonts = resolve; });
  const document = {
    createElement(tag: string) { assert.equal(tag, 'canvas'); const canvas = new TestCanvas(); canvases.push(canvas); return canvas; },
    fonts: { load: () => fonts },
  };
  const listeners = { addEventListener() {}, removeEventListener() {} };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: listeners });
  const buffer = { w: 640, h: 480 };
  const el = { ...listeners, clientWidth: 1600, clientHeight: 900, style: { cursor: '' } };
  let texture: CanvasTexture, draws = 0, renders = 0, requests = 0;
  const transforms: number[][] = [];
  const gl = {
    domElement: el, autoClear: true,
    getDrawingBufferSize(vector: { set(x: number, y: number): unknown }) { return vector.set(buffer.w, buffer.h); },
    clearDepth() {},
    render(scene: Scene) {
      renders++;
      texture = (scene.children[0] as unknown as { material: { map: CanvasTexture } }).material.map;
    },
  };
  const root = { gl, size: { width: 1600, height: 900 }, invalidate() { requests++; } } as unknown as RootState;
  const harness = { root, cleanups, frame: undefined as ((state: RootState, dt: number) => void) | undefined };
  Reflect.set(globalThis, hookKey, harness);
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    Reflect.deleteProperty(globalThis, hookKey);
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const options: CanvasUIOptions = {
    widgets: () => [button], keyNav: true,
    draw(g, s) {
      draws++;
      transforms.push([...(g as unknown as TestContext2D).transform]);
      (g.canvas as unknown as TestCanvas).pixels = [`content:${draws}`];
      s.contentHeight = 1800;
      // The ring must inherit this state on both content and cached redraws.
      g.globalAlpha = 0.6;
      g.shadowColor = '#123456';
      g.shadowBlur = 7;
      g.filter = 'blur(1px)';
    },
  };
  const ui = mountCanvasUI(options);
  const frame = (dt = 1 / 60) => { assert.ok(harness.frame); harness.frame(root, dt); };
  const settle = () => { ui.focus(button); for (let i = 0; i < 120; i++) frame(); assert.equal(ui.dirty, false); };
  return {
    ui, options, canvases, buffer, el, transforms, frame, settle,
    fontsReady: async () => { resolveFonts(); await new Promise(resolve => setImmediate(resolve)); },
    get draws() { return draws; }, get renders() { return renders; }, get requests() { return requests; },
    get uploads() { return texture.version; },
  };
}

test('settled content is cached while the ring keeps its cadence and draw context', t => {
  const f = fixture(t);
  f.settle();
  const [canvas, base] = f.canvases;
  const draws = f.draws, uploads = f.uploads, renders = f.renders;
  const lastStroke = canvas.g.strokes.at(-1)!;
  for (let i = 0; i < 240; i++) f.frame();
  assert.equal(f.draws, draws, 'ring animation never reruns content drawing');
  assert.ok(Math.abs(f.uploads - uploads - 60) <= 1, '15 texture updates per second at 60 Hz');
  assert.equal(f.renders - renders, 240, 'no additional GPU overlay passes');
  assert.equal(base.g.copies.length, 1, 'capture once after content settles');
  assert.ok(canvas.g.copies.length >= 60);
  assert.deepEqual(base.pixels, [`content:${draws}`], 'cache never contains a ring');
  assert.deepEqual(canvas.pixels, [`content:${draws}`, 'ring', 'ring'], 'old ring is replaced rather than accumulated');
  assert.deepEqual(canvas.g.strokes.at(-1), lastStroke, 'ring alpha, transform and effects survive the copy');
});

test('ring repaint survives a throttled frame without triggering a content redraw', t => {
  const f = fixture(t);
  f.settle();
  f.ui.time = 10.06;
  f.frame(0);
  const draws = f.draws, uploads = f.uploads, requests = f.requests;
  f.frame(0.01); // color step changes at 10.066..., too soon after the last redraw
  assert.equal(f.uploads, uploads);
  assert.equal(f.ui.dirty, false);
  assert.ok(f.requests > requests, 'the pending repaint asks for another frame');
  f.frame(0.015); // same color step, now beyond the existing redraw ceiling
  assert.equal(f.uploads, uploads + 1);
  assert.equal(f.draws, draws);
  f.frame(0.025);
  assert.equal(f.uploads, uploads + 1, 'the pending repaint is consumed once');
});

test('content invalidation, fonts, scrolling, press and resize refresh the cached base', async t => {
  const f = fixture(t);
  f.settle();
  const [canvas, base] = f.canvases;
  let draws = f.draws;
  f.options.update = (_, ui) => { ui.invalidate(); };
  f.frame(0.03);
  assert.equal(f.draws, ++draws, 'prop/content updates still redraw');
  f.options.update = undefined;
  await f.fontsReady();
  f.frame(0.03);
  assert.equal(f.draws, ++draws, 'loaded fonts invalidate the cache');
  f.ui.scroll = 150;
  f.ui.invalidate();
  f.frame(0.03);
  assert.equal(f.draws, ++draws);
  assert.deepEqual(f.transforms.at(-1), [640 / 1600, 0, 0, 480 / 900, 0, -150 * (480 / 900)]);
  f.ui.press = 1;
  f.frame(0.03);
  assert.equal(f.draws, ++draws, 'press easing remains content animation');
  f.ui.press = 0;
  f.buffer.w = 800;
  f.buffer.h = 600;
  f.el.clientWidth = 1200;
  f.frame(0.03);
  assert.equal(f.draws, ++draws);
  assert.equal(f.ui.w, 1200);
  assert.deepEqual([canvas.width, canvas.height, base.width, base.height], [800, 600, 800, 600]);
  assert.deepEqual(f.transforms.at(-1), [800 / 1200, 0, 0, 600 / 900, 0, -150 * (600 / 900)]);
  assert.deepEqual(canvas.pixels, [`content:${draws}`, 'ring', 'ring']);
  f.frame(0.1);
  assert.equal(f.draws, ++draws, 'rebuild the cache on the next ring-only repaint');
  assert.deepEqual(base.pixels, [`content:${draws}`]);
  f.ui.focus(null);
  for (let i = 0; i < 120; i++) f.frame();
  assert.deepEqual(canvas.pixels, base.pixels, 'fading out clears the final ring pixels');
  draws = f.draws;
  const uploads = f.uploads;
  for (let i = 0; i < 60; i++) f.frame();
  assert.equal(f.draws, draws);
  assert.equal(f.uploads, uploads, 'no uploads after content and ring both settle');
});

test('content changes draw with the ring before rebuilding the cache', t => {
  const f = fixture(t);
  f.frame(0.03);
  const [, base] = f.canvases;
  assert.equal(base.g.copies.length, 0, 'no snapshot between initial content and ring drawing');
  f.settle();
  const copies = base.g.copies.length;
  f.ui.invalidate();
  f.frame(0.03);
  assert.equal(base.g.copies.length, copies, 'a content redraw keeps its unresolved edge coverage');
  const draws = f.draws;
  f.frame(0.1);
  assert.equal(f.draws, draws + 1, 'first ring-only frame refreshes the invalid cache');
  assert.equal(base.g.copies.length, copies + 1);
  f.frame(0.1);
  assert.equal(f.draws, draws + 1, 'later ring-only frames reuse the cache');
});

test('short row content rasterizes with its overlapping ring at the original cadence', t => {
  const f = fixture(t);
  const row: Widget = { id: 'row', rect: { x: 100, y: 100, w: 300, h: 48 } };
  f.options.widgets = () => [row];
  f.ui.focus(row);
  for (let i = 0; i < 120; i++) f.frame();
  const draws = f.draws, uploads = f.uploads;
  for (let i = 0; i < 240; i++) f.frame();
  assert.equal(f.ui.dirty, false, 'ring motion remains separate from content invalidation');
  assert.ok(Math.abs(f.uploads - uploads - 60) <= 1);
  assert.equal(f.draws - draws, f.uploads - uploads);
  assert.equal(f.canvases[1].g.copies.length, 0, 'avoid resolving coverage between overlapping edges');
});
