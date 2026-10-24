import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { diagnostic } from '../diagnostics.ts';
import { displayDesign } from '../display.ts';
import { glassCorner } from './draw.ts';
import type { Rect } from './draw.ts';
import { glassTextureSize } from './glassTexture.ts';

/**
 * Frosted glass for canvas UI buttons (drawGlassButton): just before the overlay draws, the
 * world already on screen under the panes is copied and drawn back blurred, clipped to each
 * pane's rounded rect. Everything outside the panes stays sharp; the overlay then draws the
 * glass's tint, rim, icon and label on top.
 *
 * useGlassBlur(() => ({ panes: [{ rect, corner }], alpha, offsetX }), { priority: 1.9 });
 *
 * Panes are in the overlay's design units (1600x900 or 1200x900). alpha fades the blur with the
 * overlay; offsetX follows a sliding screen. Up to MAX_PANES panes.
 */

export interface GlassPane { rect: Rect; corner: number; }
export interface GlassBlurFrame { panes: readonly GlassPane[]; alpha: number; offsetX?: number; }

/** A drawGlassButton's pane: lifted as it is hovered and pressed, as the button is drawn. */
export function buttonPane(ui: { hover: Record<string, number>; press: number }, id: string, rect: Rect): GlassPane {
  const k = ui.hover[id] ?? 0;
  return { rect: { ...rect, y: rect.y - k * 3 + ui.press * k * 3 }, corner: glassCorner(rect.h) };
}
/** A drawDarkGlassPanel's pane. */
export const panelPane = (rect: Rect, corner = 34): GlassPane => ({ rect, corner });

const MAX_PANES = 4;
// Blur radius in design units, and the extra copied round the panes so the blur near their
// edges samples the world there instead of smearing the edge pixel.
const RADIUS = 24;
const TAPS = 40;

const vertexShader = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
// A Vogel-disk blur (golden-angle spiral of taps, weighted towards the middle), masked by the
// panes' rounded rects with a one-pixel soft edge.
const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform vec2 origin;
uniform vec2 size;
uniform float radius;
uniform vec4 rects[${MAX_PANES}];
uniform float corners[${MAX_PANES}];
uniform int count;
uniform float alpha;

float roundBox(vec2 p, vec4 r, float c) {
  vec2 hs = (r.zw - r.xy) * 0.5;
  vec2 q = abs(p - (r.xy + r.zw) * 0.5) - hs + c;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - c;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float d = 1e5;
  for (int i = 0; i < ${MAX_PANES}; i++) {
    if (i >= count) break;
    d = min(d, roundBox(p, rects[i], corners[i]));
  }
  float mask = clamp(0.5 - d, 0.0, 1.0);
  if (mask <= 0.0) discard;
  vec2 uv = (p - origin) / size;
  vec2 lo = 0.5 / size;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${TAPS}; i++) {
    float f = (float(i) + 0.5) / ${TAPS}.0;
    float a = float(i) * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * sqrt(f) * radius;
    float w = exp(-2.0 * f);
    sum += texture2D(map, clamp(uv + o / size, lo, 1.0 - lo)).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, mask * alpha);
}
`;

export default function useGlassBlur(frame: () => GlassBlurFrame, { priority = 1.9 }: { priority?: number } = {}) {
  const gl = useThree((state) => state.gl);
  const get = useRef(frame);
  get.current = frame;

  const pass = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        map: { value: null },
        origin: { value: new THREE.Vector2() },
        size: { value: new THREE.Vector2(1, 1) },
        radius: { value: 1 },
        rects: { value: Array.from({ length: MAX_PANES }, () => new THREE.Vector4()) },
        corners: { value: new Array<number>(MAX_PANES).fill(0) },
        count: { value: 0 },
        alpha: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    return {
      material, quad, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1),
      texture: null as THREE.FramebufferTexture | null, tw: 0, th: 0, at: new THREE.Vector2(), buf: new THREE.Vector2(),
    };
  }, []);

  useEffect(() => () => {
    pass.texture?.dispose();
    pass.material.dispose();
    pass.quad.geometry.dispose();
  }, [pass]);

  useFrame(() => {
    // ?diag=noui leaves the UI out of the picture, its frosted glass with it.
    if (diagnostic('noui')) return;
    const { panes, alpha, offsetX = 0 } = get.current();
    const count = Math.min(panes.length, MAX_PANES);
    if (!count || alpha < 0.005) return;
    const buf = gl.getDrawingBufferSize(pass.buf);
    const el = gl.domElement;
    const design = displayDesign(el.clientWidth || 1, el.clientHeight || 1);
    const sx = buf.x / design.w;
    const sy = buf.y / design.h;
    const radius = RADIUS * Math.min(sx, sy);
    const pad = Math.ceil(radius) + 2;
    const u = pass.material.uniforms;

    // Pane rects in buffer pixels, bottom-up like gl_FragCoord, and their bounds.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < count; i++) {
      const { rect: { x, y, w, h }, corner } = panes[i];
      const r = u.rects.value[i] as THREE.Vector4;
      r.set((x + offsetX) * sx, buf.y - (y + h) * sy, (x + offsetX + w) * sx, buf.y - y * sy);
      u.corners.value[i] = corner * Math.min(sx, sy);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.z); y1 = Math.max(y1, r.w);
    }
    // The region copied: the bounds plus the blur's reach, inside the buffer.
    let cx0 = Math.max(0, Math.floor(x0) - pad);
    let cy0 = Math.max(0, Math.floor(y0) - pad);
    const cx1 = Math.min(buf.x, Math.ceil(x1) + pad);
    const cy1 = Math.min(buf.y, Math.ceil(y1) + pad);
    const neededW = cx1 - cx0;
    const neededH = cy1 - cy0;
    if (neededW <= 0 || neededH <= 0) return;
    const { w: cw, h: ch } = glassTextureSize(neededW, neededH, buf.x, buf.y, pass.tw, pass.th);
    // Spare capacity can extend past a viewport edge: shift the copy back inside it.
    cx0 = Math.min(cx0, buf.x - cw);
    cy0 = Math.min(cy0, buf.y - ch);
    if (!pass.texture || pass.tw !== cw || pass.th !== ch) {
      pass.texture?.dispose();
      pass.texture = new THREE.FramebufferTexture(cw, ch);
      pass.tw = cw;
      pass.th = ch;
      pass.texture.minFilter = THREE.LinearFilter;
      pass.texture.magFilter = THREE.LinearFilter;
      u.map.value = pass.texture;
    }
    gl.copyFramebufferToTexture(pass.texture, pass.at.set(cx0, cy0));

    u.origin.value.set(cx0, cy0);
    u.size.value.set(cw, ch);
    u.radius.value = radius;
    u.count.value = count;
    u.alpha.value = alpha;
    // Draw only over the copied region.
    pass.quad.scale.set(cw / buf.x, ch / buf.y, 1);
    pass.quad.position.set(((cx0 + cw / 2) / buf.x) * 2 - 1, ((cy0 + ch / 2) / buf.y) * 2 - 1, 0);
    pass.quad.updateMatrixWorld();
    const ac = gl.autoClear;
    gl.autoClear = false;
    gl.render(pass.scene, pass.camera);
    gl.autoClear = ac;
  }, priority);
}
