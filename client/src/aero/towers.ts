import * as THREE from 'three';
import type { CityBuilder } from './cityBuilder.ts';
import { STYLES, STYLE_KEYS, facadeBox, type FacadeStyle } from './facades.ts';
import { TAU } from './util.ts';

function antenna(b: CityBuilder, x: number, top: number, z: number, ah: number) {
  b.cyl('dark', x, top + ah / 2, z, 0.35, ah, 6, 0.18);
  for (let k = 1; k <= 3; k++) b.cyl('dark', x, top + (ah * k) / 4, z, 0.9 - k * 0.15, 0.3, 8);
  const s = new THREE.SphereGeometry(0.7, 8, 6); s.translate(x, top + ah, z); b.add('red', s);
}

/** Roof treatment; returns the height of the roof top. */
function crown(b: CityBuilder, x: number, z: number, w: number, d: number, top: number, tall: boolean) {
  const { R, RI, rnd } = b.random;
  const c = rnd();
  if (c < 0.2) { // glass lantern crown with frame
    const ch = R(7, 14), p = 0.9;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('trim', x + sx * (w / 2 - p / 2), top + ch / 2, z + sz * (d / 2 - p / 2), p, ch, p);
    b.box('trim', x, top + ch - 0.6, z + (d / 2 - 0.4), w, 1.2, 0.8); b.box('trim', x, top + ch - 0.6, z - (d / 2 - 0.4), w, 1.2, 0.8);
    b.box('trim', x + (w / 2 - 0.4), top + ch - 0.6, z, 0.8, 1.2, d); b.box('trim', x - (w / 2 - 0.4), top + ch - 0.6, z, 0.8, 1.2, d);
    for (let k = 1; k < 4; k++) b.box('trim', x, top + (ch * k) / 4, z, w * 0.72, 0.3, d * 0.72);
    b.box('capglass', x, top + ch * 0.36, z, w * 0.7, ch * 0.72, d * 0.7);
    return top + ch * 0.72;
  }
  if (c < 0.36) { // glass pyramid on a trim plinth
    b.box('trim', x, top + 0.6, z, w + 0.8, 1.2, d + 0.8);
    const hh = R(6, 16), g = new THREE.ConeGeometry(0.7071, 1, 4); g.rotateY(Math.PI / 4); g.scale(w, hh, d); g.translate(x, top + 1.2 + hh / 2, z); b.add('capglass', g);
    return top + 1.2 + hh * 0.5;
  }
  if (c < 0.52 && w > 16 && d > 16) { // helipad
    b.box('trim', x, top + 0.8, z, w + 0.8, 1.6, d + 0.8);
    const r = Math.min(w, d) * 0.42;
    b.cyl('trim', x, top + 2.3, z, r, 1.4, 24);
    for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; b.box('dark', x + Math.cos(a) * r * 0.6, top + 1.8, z + Math.sin(a) * r * 0.6, 0.5, 1.6, 0.5); }
    const pad = new THREE.CircleGeometry(r * 0.96, 32); pad.rotateX(-Math.PI / 2); pad.translate(x, top + 3.02, z); b.add('helipad', pad);
    return top + 3;
  }
  if (c < 0.68 && !tall) { // roof garden with glass balustrade
    b.box('trim', x, top + 0.6, z, w + 0.6, 1.2, d + 0.6);
    b.box('roofgrass', x, top + 1.4, z, w - 1.4, 0.4, d - 1.4);
    for (const [bw, bd, bx, bz] of [[w, 0.15, 0, d / 2 - 0.2], [w, 0.15, 0, -d / 2 + 0.2], [0.15, d, w / 2 - 0.2, 0], [0.15, d, -w / 2 + 0.2, 0]]) b.box('lobby', x + bx, top + 2.2, z + bz, bw, 2, bd);
    for (let k = 0, n = RI(3, 6); k < n; k++) b.tree(x + R(-w / 2 + 2.5, w / 2 - 2.5), z + R(-d / 2 + 2.5, d / 2 - 2.5), R(0.55, 0.9), rnd() < 0.3 ? 'conifer' : 'round', top + 1.6);
    b.box('trim', x + R(-w / 5, w / 5), top + 3, z + R(-d / 5, d / 5), R(3, 5), 3, R(3, 5)); // stair house
    return top + 1.6;
  }
  // mechanical roof: parapet, plant units, water tank, solar panels
  b.box('trim', x, top + 0.8, z, w + 1.2, 1.6, d + 1.2);
  b.box('units', x, top + 1.7, z, w - 0.6, 0.2, d - 0.6);
  for (let k = 0, n = RI(1, 3); k < n; k++) {
    const uw = R(2, w * 0.3), ud = R(2, d * 0.3), uh = R(1.5, 3.5), ux = x + R(-w / 4, w / 4), uz = z + R(-d / 4, d / 4);
    b.box('units', ux, top + 1.6 + uh / 2, uz, uw, uh, ud);
    b.cyl('dark', ux, top + 1.6 + uh + 0.25, uz, Math.min(uw, ud) * 0.3, 0.5, 10);
  }
  if (rnd() < 0.5) { const tx = x + R(-w / 4, w / 4), tz = z + R(-d / 4, d / 4); b.cyl('podium', tx, top + 4, tz, 1.6, 3, 12); b.cyl('dark', tx, top + 5.9, tz, 0.1, 0.8, 12, 1.7); for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box('dark', tx + sx, top + 2, tz + sz, 0.2, 1.6, 0.2); }
  if (rnd() < 0.5) for (let k = 0; k < 3; k++) { const g = new THREE.BoxGeometry(w * 0.25, 0.12, 1.6); g.rotateX(-0.35); g.translate(x - w * 0.3 + k * 0.01, top + 2.2, z - d * 0.35 + k * 2.2); b.add('solar', g); }
  return top + 1.6;
}

function addLedges(b: CityBuilder, x: number, z: number, w: number, d: number, y0: number, y1: number, round: boolean) {
  for (let y = y0 + 16; y < y1 - 3; y += 16) {
    if (round) b.cyl('trim', x, y, z, w / 2 + 0.35, 0.45, 28);
    else b.box('trim', x, y, z, w + 0.5, 0.45, d + 0.5);
  }
}
function addVerticals(b: CityBuilder, x: number, z: number, w: number, d: number, y0: number, y1: number, s: Pick<FacadeStyle, 'pilasters' | 'fins'>) {
  const h = y1 - y0, ym = (y0 + y1) / 2;
  if (s.pilasters) for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('trim', x + sx * (w / 2 - 0.2), ym, z + sz * (d / 2 - 0.2), 1.1, h, 1.1);
  if (s.fins) {
    for (let fx = -w / 2 + 4.5; fx < w / 2 - 2; fx += 4.5) { b.box('trim', x + fx, ym, z + d / 2 + 0.35, 0.25, h, 0.7); b.box('trim', x + fx, ym, z - d / 2 - 0.35, 0.25, h, 0.7); }
    for (let fz = -d / 2 + 4.5; fz < d / 2 - 2; fz += 4.5) { b.box('trim', x + w / 2 + 0.35, ym, z + fz, 0.7, h, 0.25); b.box('trim', x - w / 2 - 0.35, ym, z + fz, 0.7, h, 0.25); }
  }
}

/** A generic glass tower; `far` skips the street-level and roof detail. Returns its top height. */
export function tower(b: CityBuilder, x: number, z: number, w: number, d: number, h: number, far = false) {
  const { R, RI, rnd, pick } = b.random;
  const st = pick(STYLE_KEYS), s = STYLES[st];
  let base = 0;
  if (!far) {
    const r = rnd();
    if (r < 0.45) { // double-height glass lobby, columns, entrance canopy
      b.box('lobby', x, 3, z, w - 1.6, 6, d - 1.6);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('trim', x + sx * (w / 2 - 0.5), 3, z + sz * (d / 2 - 0.5), 1, 6, 1);
      b.box('trim', x, 6.3, z, w + 0.4, 0.6, d + 0.4);
      const side = RI(0, 3), cw = Math.min(w, d) * 0.5;
      if (side < 2) b.box('trim', x, 4.6, z + (side ? 1 : -1) * (d / 2 + 2), cw, 0.35, 4);
      else b.box('trim', x + (side === 2 ? 1 : -1) * (w / 2 + 2), 4.6, z, 4, 0.35, cw);
      base = 6.6;
    } else if (r < 0.75) {
      b.box('podium', x, 4.5, z, w + 4, 9, d + 4);
      b.box('lobby', x, 2, z, w + 4.1, 3, d + 4.1);
      b.box('trim', x, 9.2, z, w + 4.6, 0.5, d + 4.6);
      base = 9.4;
    }
  }
  const round = !far && rnd() < 0.12 && Math.abs(w - d) < 6;
  const octa = !round && !far && rnd() < 0.12 && Math.abs(w - d) < 6;
  if (round || octa) {
    const r = Math.min(w, d) / 2, seg = octa ? 8 : 28;
    b.cyl(st, x, base + (h - base) / 2, z, r, h - base, seg);
    if (round) addLedges(b, x, z, r * 2, r * 2, base, h, true);
    b.cyl('trim', x, h + 0.7, z, r + 0.6, 1.4, seg);
    let top = h + 1.4;
    if (rnd() < 0.6) { const h2 = R(8, 22); b.cyl(st, x, top + h2 / 2, z, r * 0.7, h2, seg); top += h2; b.cyl('trim', x, top + 0.5, z, r * 0.7 + 0.5, 1, seg); top += 1; }
    if (h > 120) antenna(b, x, top, z, R(14, 30));
    b.occ([x - r, x + r, top, z - r, z + r]);
    return top;
  }
  const fr = (h > 110 && rnd() < 0.55) ? (rnd() < 0.5 ? [0.66, 0.34] : [0.52, 0.3, 0.18]) : [1];
  let cw = w, cd = d, y0 = base;
  const total = h - base;
  for (let t = 0; t < fr.length; t++) {
    const hh = total * fr[t];
    b.box(st, x, y0 + hh / 2, z, cw, hh, cd);
    if (!far) { addLedges(b, x, z, cw, cd, y0, y0 + hh, false); addVerticals(b, x, z, cw, cd, y0, y0 + hh, s); }
    y0 += hh;
    if (t < fr.length - 1) { // setback terrace with planting
      b.box('trim', x, y0 + 0.5, z, cw + 0.8, 1, cd + 0.8);
      if (!far) {
        b.box('roofgrass', x, y0 + 1.15, z, cw - 1, 0.3, cd - 1);
        const nw = cw * R(0.68, 0.8), nd = cd * R(0.68, 0.8);
        for (let k = 0; k < 4; k++) { const sx = k & 1 ? 1 : -1, sz = k & 2 ? 1 : -1; b.tree(x + sx * (cw / 2 + nw / 2) / 2, z + sz * (cd / 2 + nd / 2) / 2, R(0.5, 0.75), 'round', y0 + 1.3); }
        cw = nw; cd = nd;
      } else { cw *= 0.75; cd *= 0.75; }
      y0 += 1;
    }
  }
  let top: number;
  if (far) { b.box('trim', x, y0 + 0.8, z, cw + 1.2, 1.6, cd + 1.2); top = y0 + 1.6; } else top = crown(b, x, z, cw, cd, y0, h > 160);
  if (h > 150 && rnd() < 0.55) antenna(b, x + R(-cw / 5, cw / 5), top, z + R(-cd / 5, cd / 5), R(14, 30));
  b.occ([x - w / 2, x + w / 2, top, z - d / 2, z + d / 2]);
  return top;
}

// Landmark 1: twisting teal glass tower
export function twistTower(b: CityBuilder, x: number, z: number, w: number, h: number, turn: number) {
  b.box('podium', x, 5, z, w + 10, 10, w + 10); b.box('trim', x, 10.3, z, w + 10.6, 0.6, w + 10.6);
  b.box('lobby', x, 2.5, z, w + 10.2, 4, w + 10.2);
  const g = facadeBox(w, h, w, 80); g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const a = (p.getY(i) / h) * turn, px = p.getX(i), pz = p.getZ(i); p.setXYZ(i, px * Math.cos(a) - pz * Math.sin(a), p.getY(i) + 10.6, px * Math.sin(a) + pz * Math.cos(a)); }
  g.computeVertexNormals(); g.translate(x, 0, z); b.add('teal', g);
  for (let y = 16; y < h - 4; y += 16) b.box('trim', x, y + 10.6, z, w + 0.7, 0.5, w + 0.7, (y / h) * turn);
  const top = h + 10.6;
  b.box('trim', x, top + 1, z, w + 1, 2, w + 1, turn);
  for (let k = 0; k < 4; k++) { const g2 = new THREE.BoxGeometry(1, 22, 1); g2.translate((w / 2) * (k & 1 ? 1 : -1), 11, (w / 2) * (k & 2 ? 1 : -1)); g2.rotateY(turn); g2.translate(x, top + 2, z); b.add('trim', g2); }
  const lan = new THREE.BoxGeometry(w * 0.8, 18, w * 0.8); lan.rotateY(turn); lan.translate(x, top + 11, z); b.add('capglass', lan);
  antenna(b, x, top + 22, z, 34);
  b.occ([x - w * 0.7, x + w * 0.7, top + 22, z - w * 0.7, z + w * 0.7]);
}

// Landmark 2: tiered tower with a needle spire
export function spireTower(b: CityBuilder, x: number, z: number) {
  b.box('podium', x, 6, z, 46, 12, 46); b.box('lobby', x, 3, z, 46.2, 5, 46.2); b.box('trim', x, 12.3, z, 46.6, 0.6, 46.6);
  const tiers = [[36, 150], [28, 90], [20, 60], [13, 35]];
  let y = 12.6;
  for (const [w, h] of tiers) {
    b.box('blue', x, y + h / 2, z, w, h, w); addLedges(b, x, z, w, w, y, y + h, false); addVerticals(b, x, z, w, w, y, y + h, { pilasters: true });
    y += h; b.box('trim', x, y + 0.7, z, w + 1.4, 1.4, w + 1.4); y += 1.4;
  }
  b.box('capglass', x, y + 5, z, 9, 10, 9);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('trim', x + sx * 4.6, y + 5, z + sz * 4.6, 0.8, 10, 0.8);
  y += 10;
  b.cyl('trim', x, y + 40, z, 2.2, 80, 12, 0.15);
  const s = new THREE.SphereGeometry(0.9, 8, 6); s.translate(x, y + 80, z); b.add('red', s);
  b.occ([x - 18, x + 18, y + 80, z - 18, z + 18]);
}
