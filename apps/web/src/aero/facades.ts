import * as THREE from 'three';
import type { AeroContext } from './context.ts';
import { TAU, canvas2d, col, hexMul } from './util.ts';

export type StyleKey = 'blue' | 'white' | 'teal' | 'silver' | 'deep';

export interface FacadeStyle {
  frame: string;
  /** Mullion widths and spandrel height in texels at 1/2 scale. */
  mx: number;
  my: number;
  sp: number;
  /** Spandrel colour, when sp > 0. */
  spc?: string;
  panes: readonly string[];
  metal: number;
  pilasters?: boolean;
  fins?: boolean;
}

export const STYLES: Record<StyleKey, FacadeStyle> = {
  blue: { frame: '#dfe9f3', mx: 3, my: 3, sp: 9, spc: '#a9c3df', panes: ['#1d5ec8', '#2c78de', '#3a8cf0', '#2468d2', '#4a9cf5'], metal: 0.6, pilasters: false },
  white: { frame: '#f5f8fb', mx: 9, my: 10, sp: 0, panes: ['#2f6688', '#3d7fa3', '#28597a', '#4b8db0'], metal: 0.35, pilasters: true },
  teal: { frame: '#d3eeee', mx: 3, my: 3, sp: 4, spc: '#9fd6d8', panes: ['#26aebf', '#3cc4cf', '#58d2da', '#1f97aa'], fins: true, metal: 0.55 },
  silver: { frame: '#f2f5f8', mx: 3, my: 3, sp: 16, spc: '#ffffff', panes: ['#7c97b2', '#93adc6', '#6886a3', '#a5bdd3'], metal: 0.5, pilasters: true },
  deep: { frame: '#a9c0d8', mx: 2, my: 2, sp: 0, panes: ['#123c8c', '#1a4ea6', '#0f3478', '#1d5ab8'], metal: 0.75 },
};
export const STYLE_KEYS: readonly StyleKey[] = ['blue', 'white', 'teal', 'silver', 'deep'];
export const isStyleKey = (k: string): k is StyleKey => Object.hasOwn(STYLES, k);

export type PlainMaterialKey = 'trim' | 'podium' | 'capglass' | 'lobby' | 'units' | 'dark' | 'red' | 'bridge' | 'deck' | 'helipad' | 'roofgrass' | 'solar';
export type CityMaterialKey = StyleKey | PlainMaterialKey;
export type CityMaterials = Record<CityMaterialKey, THREE.Material>;

const RU = 1 / 1024, RV = 1 / 1024; // UV of a frame-coloured texel, used for roofs

// Colour map plus a matching roughness (G) / metalness (B) map: matte frames, mirror glass.
function facadeTextures(ctx: AeroContext, s: FacadeStyle) {
  const { R, rnd, pick } = ctx.random;
  const S = 512, cw = 128, rh = 128, sc = 2;
  const { c, g } = canvas2d(S, S);
  const { c: rm, g: r } = canvas2d(S, S);
  g.fillStyle = s.frame; g.fillRect(0, 0, S, S);
  r.fillStyle = 'rgb(0,170,25)'; r.fillRect(0, 0, S, S);
  const mx = s.mx * sc, my = s.my * sc, sp = s.sp * sc;
  for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) {
    const x = k * cw + mx, y = row * rh + my, w = cw - 2 * mx, h = rh - 2 * my - sp;
    const base = pick(s.panes);
    const gr = g.createLinearGradient(x, y, x + w * 0.6, y + h);
    gr.addColorStop(0, hexMul(base, 1.4)); gr.addColorStop(0.55, base); gr.addColorStop(1, hexMul(base, rnd() < 0.15 ? 0.75 : 0.95));
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    // centre mullion splits each bay into two panes
    g.fillStyle = s.frame; g.fillRect(x + w / 2 - 1.5, y, 3, h);
    // diagonal sky glint
    g.fillStyle = 'rgba(255,255,255,.14)';
    g.beginPath(); g.moveTo(x + w * 0.1, y); g.lineTo(x + w * 0.38, y); g.lineTo(x + w * 0.1, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h * 0.65); g.closePath(); g.fill();
    // interior: blinds, ceiling light strip, occasional plants
    if (rnd() < 0.22) { g.fillStyle = 'rgba(235,245,255,.42)'; const bh = h * R(0.2, 0.55); g.fillRect(x, y, w, bh); g.fillStyle = 'rgba(180,200,220,.35)'; for (let yy = y + 3; yy < y + bh; yy += 4) g.fillRect(x, yy, w, 1); }
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + 4, y + 6, w - 8, 2);
    if (rnd() < 0.08) { g.fillStyle = 'rgba(40,120,40,.55)'; g.beginPath(); g.arc(x + R(10, w - 10), y + h - 8, 7, 0, TAU); g.fill(); }
    // mullion edge highlights
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(x - 1, y, 1, h); g.fillRect(x, y - 1, w, 1);
    g.fillStyle = 'rgba(0,30,60,.25)'; g.fillRect(x + w, y, 1, h); g.fillRect(x, y + h, w, 1);
    // spandrel panel with seam lines
    if (sp && s.spc) { g.fillStyle = s.spc; g.fillRect(k * cw, y + h, cw, sp); g.fillStyle = 'rgba(0,30,60,.12)'; g.fillRect(k * cw, y + h + sp - 2, cw, 2); }
    r.fillStyle = `rgb(0,${Math.round(R(10, 28))},${Math.round(s.metal * 255)})`; r.fillRect(x, y, w, h);
    r.fillStyle = 'rgb(0,170,25)'; r.fillRect(x + w / 2 - 1.5, y, 3, h);
  }
  if (s.fins) { g.fillStyle = '#e9fbfb'; for (let k = 0; k < 8; k++) g.fillRect(k * 64 - 2, 0, 4, S); }
  g.fillStyle = s.frame; g.fillRect(0, S - 6, 6, 6);
  return { map: ctx.tex(c, true), rough: ctx.tex(rm, true, false) };
}

function helipadTex(ctx: AeroContext) {
  const { c, g } = canvas2d(256, 256);
  g.fillStyle = '#5b6672'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#ffffff'; g.lineWidth = 10; g.beginPath(); g.arc(128, 128, 100, 0, TAU); g.stroke();
  g.strokeStyle = '#ffd23a'; g.lineWidth = 6; g.beginPath(); g.arc(128, 128, 118, 0, TAU); g.stroke();
  g.fillStyle = '#ffffff'; g.fillRect(88, 72, 18, 112); g.fillRect(150, 72, 18, 112); g.fillRect(88, 119, 80, 18);
  return ctx.tex(c);
}

/** Facade materials (one per style, drawing from the random stream) and the shared trim materials. */
export function createCityMaterials(ctx: AeroContext, grassCanvas: HTMLCanvasElement): CityMaterials {
  const facade = (k: StyleKey) => {
    const t = facadeTextures(ctx, STYLES[k]);
    return new THREE.MeshStandardMaterial({ map: t.map, roughnessMap: t.rough, metalnessMap: t.rough, roughness: 1, metalness: 1, envMapIntensity: 1.35 });
  };
  const blue = facade('blue'), white = facade('white'), teal = facade('teal'), silver = facade('silver'), deep = facade('deep');
  const roofGrassTex = ctx.tex(grassCanvas, true);
  return {
    blue, white, teal, silver, deep,
    trim: new THREE.MeshStandardMaterial({ color: col('#f3f7fb'), metalness: 0.15, roughness: 0.35 }),
    podium: new THREE.MeshStandardMaterial({ color: col('#dbe6f0'), metalness: 0.2, roughness: 0.4 }),
    capglass: new THREE.MeshStandardMaterial({ color: col('#8fd6ff'), metalness: 0.9, roughness: 0.06, envMapIntensity: 1.6 }),
    lobby: new THREE.MeshStandardMaterial({ color: col('#b9e6ff'), metalness: 0.85, roughness: 0.05, envMapIntensity: 1.5 }),
    units: new THREE.MeshLambertMaterial({ color: col('#b7c3ce') }),
    dark: new THREE.MeshStandardMaterial({ color: col('#4a5560'), metalness: 0.6, roughness: 0.4 }),
    red: new THREE.MeshBasicMaterial({ color: col('#ff3b3b') }),
    bridge: new THREE.MeshStandardMaterial({ color: col('#e8302f'), metalness: 0.35, roughness: 0.35 }),
    deck: new THREE.MeshLambertMaterial({ color: col('#d8dde3') }),
    helipad: new THREE.MeshLambertMaterial({ map: helipadTex(ctx) }),
    roofgrass: new THREE.MeshLambertMaterial({ map: roofGrassTex }),
    solar: new THREE.MeshStandardMaterial({ color: col('#1b3f8f'), metalness: 0.8, roughness: 0.15, envMapIntensity: 1.4 }),
  };
}

/** Box with facade UVs: 12 m bays across, 16 m storeys up, roofs on a frame texel. */
export function facadeBox(w: number, h: number, d: number, hs = 1) {
  const g = new THREE.BoxGeometry(w, h, d, 1, hs, 1), uv = g.attributes.uv, n = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(n.getY(i)) > 0.5) uv.setXY(i, RU, RV);
    else { const fw = Math.abs(n.getX(i)) > 0.5 ? d : w; uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(fw / 12)), (uv.getY(i) * h) / 16); }
  }
  return g;
}

/** Facade UVs for a cylinder (round and octagonal towers). */
export function facadeCylinderUVs(g: THREE.CylinderGeometry, r: number, h: number, seg: number) {
  const uv = g.attributes.uv, n = g.attributes.normal;
  const side = 2 * r * Math.sin(Math.PI / seg) * seg;
  const rep = seg <= 12 ? seg * Math.max(1, Math.round(side / seg / 12)) : Math.max(2, Math.round(side / 12));
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(n.getY(i)) > 0.5) uv.setXY(i, RU, RV); else uv.setXY(i, uv.getX(i) * rep, (uv.getY(i) * h) / 16);
  }
}
