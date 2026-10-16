import * as THREE from 'three';
import type { AeroContext } from './context.ts';
import { createMountainGeometry } from './mountainGeometry.ts';
import { TAU, canvas2d, col, sstep } from './util.ts';

function grassCanvas(ctx: AeroContext) {
  const { R, rnd } = ctx.random;
  const S = 512, { c, g } = canvas2d(S, S);
  g.fillStyle = '#5cba2c'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    const x = R(0, S), y = R(0, S), r = R(30, 90), light = rnd() < 0.5;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, light ? 'rgba(200,255,120,.10)' : 'rgba(20,90,10,.10)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 11000; i++) { g.fillStyle = `hsl(${R(84, 112)},${R(55, 78)}%,${R(30, 58)}%)`; g.fillRect(R(0, S), R(0, S), R(1, 2.2), R(2, 6)); }
  return c;
}

// Flat plain in the middle, rising into rolling rim hills from ~1150 m out.
export function groundY(x: number, z: number) {
  const rim = sstep(1150, 2700, Math.hypot(x, z - 150));
  return rim * (110 + 80 * Math.sin(x * 0.0021) * Math.cos(z * 0.0017) + 38 * Math.sin(x * 0.005 + z * 0.004)) - 0.02;
}

function roadCanvas() {
  const S = 256, { c, g } = canvas2d(S, S), rw = (13 / 70) * S;
  g.fillStyle = '#5f6973'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#d7e0e8'; g.fillRect(rw - 6, rw - 6, S - 2 * rw + 12, S - 2 * rw + 12);
  g.fillStyle = '#c4ced8'; g.fillRect(rw, rw, S - 2 * rw, S - 2 * rw);
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
  for (let i = rw; i < S - rw; i += 12) { g.beginPath(); g.moveTo(i, rw); g.lineTo(i, S - rw); g.stroke(); }
  g.fillStyle = '#f6d84a';
  for (let i = rw; i < S - rw; i += 14) { g.fillRect(0, i, 1.5, 8); g.fillRect(S - 1.5, i, 1.5, 8); g.fillRect(i, 0, 8, 1.5); g.fillRect(i, S - 1.5, 8, 1.5); }
  g.fillStyle = 'rgba(255,255,255,.85)';
  for (const [x0, y0] of [[0, 0], [S, 0], [0, S], [S, S]]) for (let k = 0; k < 5; k++) {
    const o = 4 + k * 4.5;
    g.fillRect(x0 ? S - rw + 2 : rw - 8, y0 ? S - rw + o : o, 6, 2.2);
    g.fillRect(x0 ? S - rw + o : o, y0 ? S - rw + 2 : rw - 8, 2.2, 6);
  }
  return c;
}

export interface Ground {
  /** The grass canvas, reused for roof gardens. */
  grassCanvas: HTMLCanvasElement;
  /** Tiling grass texture, reused for parks. */
  grassTex: THREE.CanvasTexture;
}

/** Terrain, the mountain ring and the street grid. */
export function buildGround(ctx: AeroContext): Ground {
  const { root } = ctx;
  const { R } = ctx.random;
  const grassCanvasEl = grassCanvas(ctx);
  const grassTex = ctx.tex(grassCanvasEl, true); grassTex.repeat.set(380, 380);
  {
    const g = new THREE.PlaneGeometry(9000, 9000, 200, 200); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, groundY(p.getX(i), p.getZ(i)));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: grassTex }));
    m.receiveShadow = true; root.add(m);
  }
  {
    const mm = new THREE.MeshLambertMaterial({ color: col('#8fb9d6'), flatShading: true });
    const sm = new THREE.MeshLambertMaterial({ color: col('#ffffff'), flatShading: true });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU + R(-0.1, 0.1), r = R(3500, 3950), h = R(380, 720), rad = R(380, 620);
      const c = new THREE.Mesh(createMountainGeometry(rad, h), [mm, sm]);
      c.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r); c.rotation.y = R(0, TAU); root.add(c);
    }
  }
  {
    // One street grid (x -665..665) in two pieces: downtown + east/west districts (z -265..245)
    // and the north district (z -735..-485). It stops at the quays so it never sits under the lake.
    // UVs come from world position so every piece lines up with the 70 m blocks.
    const t = ctx.tex(roadCanvas(), true);
    const mat = new THREE.MeshLambertMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    for (const [z0, z1] of [[-265, 245], [-735, -485]]) {
      const g = new THREE.PlaneGeometry(1330, z1 - z0); g.rotateX(-Math.PI / 2); g.translate(0, 0.05, (z0 + z1) / 2);
      const pos = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + 665) / 70, -(pos.getZ(i) + 735) / 70);
      const m = new THREE.Mesh(g, mat); m.receiveShadow = true; root.add(m);
    }
  }
  return { grassCanvas: grassCanvasEl, grassTex };
}
