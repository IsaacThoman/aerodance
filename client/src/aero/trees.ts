import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AeroContext } from './context.ts';
import type { FlightPath } from './flight.ts';
import { groundY } from './ground.ts';
import { STREETS } from './streets.ts';
import { TreeField, type FieldTree } from './treeField.ts';
import { mergeTreeGeometry } from './treeGeometry.ts';
import { TAU, clamp, col, hsl, noise3, paintGeo } from './util.ts';

export type TreeKind = 'round' | 'poplar' | 'conifer' | 'farRound' | 'farPoplar';

export interface TreeSpec {
  x: number;
  /** Base height: 0 on the ground, higher on roofs and terraces. */
  y: number;
  z: number;
  /** Scale. */
  s: number;
  kind: TreeKind;
  /** Planted to keep the random stream in step, but shown at zero scale. */
  hidden?: boolean;
}

/** One modelled tree, instanced many times. */
interface TreeVariant {
  /** Detail levels: [as modelled, coarser, coarsest] (see treeField.ts). */
  trunk: THREE.BufferGeometry[];
  canopy: THREE.BufferGeometry[];
  /** A random leaf colour for one instance. */
  tint(): THREE.Color;
}

const LEVELS = [0, 1, 2] as const;
type Level = (typeof LEVELS)[number];

const KIND_SCALE: Record<TreeKind, number> = { round: 1, poplar: 0.9, conifer: 0.85, farRound: 1, farPoplar: 0.9 };

// The world shares one random stream. Consume the removed leaf details' draws so
// canopy shapes, tree placement and all later builders keep their established layout.
function skipLeafRandom(ctx: AeroContext, draws: number) {
  for (let i = 0; i < draws; i++) ctx.random.rnd();
}

/** A lumpy, vertex-shaded canopy blob. */
function blob(cx: number, cy: number, cz: number, r: number, sy: number, seed: number, det: number) {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, det);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (noise3(x * 2.3 + seed, y * 2.3, z * 2.3) - 0.5) * 0.5 + (noise3(x * 6 + seed, y * 6, z * 6) - 0.5) * 0.14;
    p.setXYZ(i, cx + x * r * k, cy + y * r * k * sy, cz + z * r * k);
  }
  g.computeVertexNormals();
  paintGeo(g, (x, y, z, c) => { const t = clamp((y - (cy - r * sy)) / (2 * r * sy), 0, 1); const v = 0.52 + 0.5 * t + (noise3(x * 3, y * 3, z * 3 + seed) - 0.5) * 0.25; c.setRGB(v * 0.97, v, v * 0.88); });
  return g;
}
/** Trunk plus branches [x, y, z, fromHeight], vertex-shaded bark; coarser (fewer sides, no branches) at higher levels. */
function trunkGeo(h: number, r0: number, r1: number, branches: [number, number, number, number][], level: Level = 0) {
  const parts: THREE.BufferGeometry[] = [];
  const t = new THREE.CylinderGeometry(r1, r0, h, [7, 5, 4][level], level ? 1 : 3); t.translate(0, h / 2, 0); parts.push(t);
  for (const [bx, by, bz, from] of level === 2 ? [] : branches) {
    const v = new THREE.Vector3(bx, by - from, bz), L = v.length();
    const b = new THREE.CylinderGeometry(r1 * 0.35, r1 * 0.7, L, level ? 4 : 5); b.translate(0, L / 2, 0);
    b.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()));
    b.translate(0, from, 0); parts.push(b);
  }
  const flat = parts.map((g) => { g.deleteAttribute('uv'); return paintGeo(g.toNonIndexed(), (x, y, z, c) => { const v = 0.75 + 0.25 * noise3(x * 8, y * 3, z * 8); c.copy(col('#7a5534')).multiplyScalar(v); }); });
  const g = mergeTreeGeometry(flat); parts.forEach((p) => p.dispose()); flat.forEach((p) => p.dispose());
  return g;
}
function canopyMerge(list: THREE.BufferGeometry[]) { const g = mergeTreeGeometry(list); list.forEach((x) => x.dispose()); return g; }
type Blob = [cx: number, cy: number, cz: number, r: number, sy: number, seed: number];
/** A canopy of blobs at each detail level: icosphere detail `top`, then one and none (never finer than top). */
function blobCanopy(blobs: Blob[], top: number) {
  const byDetail = new Map<number, THREE.BufferGeometry>();
  return LEVELS.map((level) => {
    const det = Math.min(top, 2 - level);
    let g = byDetail.get(det);
    if (!g) byDetail.set(det, g = canopyMerge(blobs.map((b) => blob(...b, det))));
    return g;
  });
}
const trunkLevels = (h: number, r0: number, r1: number, branches: [number, number, number, number][] = []) => LEVELS.map((level) => trunkGeo(h, r0, r1, branches, level));

function makeRound(ctx: AeroContext, seed: number): TreeVariant {
  const { R, RI } = ctx.random;
  const small = ctx.quality.small, detail = small ? 1 : 2;
  const blobs: Blob[] = [], br: [number, number, number, number][] = [];
  blobs.push([0, 3.0, 0, 1.25, 0.88, seed]); skipLeafRandom(ctx, (small ? 10 : 18) * 6);
  const n = RI(6, 8);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + R(-0.3, 0.3), rr = R(0.75, 0.95), y = R(2.45, 3.7), r = R(0.62, 0.92);
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    blobs.push([x, y, z, r, 0.85, seed + i * 7.1]); skipLeafRandom(ctx, (small ? 5 : 9) * 6);
    if (i % 2 === 0) br.push([x * 0.6, y - 0.5, z * 0.6, 1.5]);
  }
  return { trunk: trunkLevels(2.2, 0.2, 0.12, br), canopy: blobCanopy(blobs, detail), tint: () => hsl(R(0.23, 0.32), R(0.55, 0.75), R(0.32, 0.45)) };
}
function makePoplar(ctx: AeroContext, seed: number): TreeVariant {
  const { R } = ctx.random;
  const small = ctx.quality.small, detail = small ? 1 : 2;
  const blobs: Blob[] = [];
  [[2.0, 0.7], [2.9, 0.78], [3.8, 0.68], [4.6, 0.5], [5.2, 0.3]].forEach(([y, r], i) => {
    blobs.push([R(-0.1, 0.1), y, R(-0.1, 0.1), r, 1.35, seed + i * 3.3]);
    skipLeafRandom(ctx, (small ? 5 : 9) * 6);
  });
  return { trunk: trunkLevels(1.6, 0.16, 0.1), canopy: blobCanopy(blobs, detail), tint: () => hsl(R(0.22, 0.28), R(0.6, 0.8), R(0.36, 0.48)) };
}
function coniferCanopy(seed: number, level: Level) {
  const tiers: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    let g: THREE.BufferGeometry = new THREE.ConeGeometry(1.55 - i * 0.28, 2.0, [11, 7, 5][level], [3, 2, 1][level], false);
    g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g);
    const p = g.attributes.position, yb = 1.0 + i * 1.05;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k), rr = Math.hypot(x, z);
      const j = rr > 0.01 ? 1 + (noise3(x * 3 + seed, y * 3, z * 3) - 0.5) * 0.45 : 1;
      p.setXYZ(k, x * j, y + yb + (rr > 0.5 && y < -0.9 ? -0.18 * noise3(x * 5, 0, z * 5 + seed) : 0), z * j);
    }
    g.computeVertexNormals();
    paintGeo(g, (x, y, z, c) => { const v = 0.6 + 0.4 * clamp((Math.hypot(x, z) + (y - yb) * 0.3) / 1.4, 0, 1) + (noise3(x * 4, y * 4, z * 4) - 0.5) * 0.2; c.setRGB(v * 0.9, v, v * 0.95); });
    tiers.push(g);
  }
  return canopyMerge(tiers);
}
function makeConifer(ctx: AeroContext, seed: number): TreeVariant {
  const { R } = ctx.random;
  return { trunk: trunkLevels(1.4, 0.2, 0.12), canopy: LEVELS.map((level) => coniferCanopy(seed, level)), tint: () => hsl(R(0.36, 0.42), R(0.45, 0.6), R(0.22, 0.32)) };
}
// Lighter variants for trees only seen from a distance: coarse canopies.
function makeRoundFar(ctx: AeroContext, seed: number): TreeVariant {
  const { R } = ctx.random;
  const blobs: Blob[] = [[0, 3.0, 0, 1.3, 0.88, seed]];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + R(-0.3, 0.3);
    blobs.push([Math.cos(a) * 0.8, R(2.5, 3.4), Math.sin(a) * 0.8, R(0.75, 0.95), 0.85, seed + i * 7.1]);
  }
  return { trunk: trunkLevels(2.2, 0.2, 0.12), canopy: blobCanopy(blobs, 1), tint: () => hsl(R(0.23, 0.32), R(0.55, 0.75), R(0.3, 0.43)) };
}
function makePoplarFar(ctx: AeroContext, seed: number): TreeVariant {
  const { R } = ctx.random;
  const blobs = [[2.2, 0.75], [3.4, 0.72], [4.5, 0.5]].map(([y, r], i): Blob => [0, y, 0, r, 1.4, seed + i * 3.3]);
  return { trunk: trunkLevels(1.6, 0.16, 0.1), canopy: blobCanopy(blobs, 1), tint: () => hsl(R(0.22, 0.28), R(0.6, 0.8), R(0.34, 0.46)) };
}

export interface TreeLists {
  /** Downtown trees (roofs, terraces, parks); street, lakeside and meadow trees are added here. */
  city: TreeSpec[];
  /** Trees in the outer districts, instanced from their own random stream. */
  district: TreeSpec[];
}

export interface Trees {
  /** Picks the trees to draw for this camera. */
  update(camera: THREE.Camera): void;
  /** Call before each render: a frame that draws the shadow map draws every tree as modelled. */
  beforeRender(renderer: THREE.WebGLRenderer): void;
}

/** Plants and instances every tree: city, lakeside, meadow groves and the countryside woods. */
export function buildTrees(ctx: AeroContext, path: FlightPath, { city: TREES, district: DTREES }: TreeLists): Trees {
  const { root } = ctx;
  const { R, RI, rnd, pick, withRng } = ctx.random;
  skipLeafRandom(ctx, 70 * 8); // Former leaf texture: eight draws for each painted leaf.
  const TREE_KINDS: Record<TreeKind, TreeVariant[]> = {
    round: [makeRound(ctx, 1.3), makeRound(ctx, 5.7), makeRound(ctx, 9.1)],
    poplar: [makePoplar(ctx, 2.2), makePoplar(ctx, 7.4)],
    conifer: [makeConifer(ctx, 3.1), makeConifer(ctx, 8.8)],
    farRound: [],
    farPoplar: [],
  };
  const tree = (x: number, z: number, s: number, kind: TreeKind = 'round', y = 0) => { TREES.push({ x, y, z, s, kind }); };

  // street trees, park edges, lakeside, meadow groves
  for (const c of STREETS) for (let s = -238; s <= 238; s += 15) {
    if (STREETS.some((o) => Math.abs(o - s) < 17)) continue;
    for (const o of [-11, 11]) { tree(c + o, s, R(1.1, 1.5)); tree(s, c + o, R(1.1, 1.5)); }
  }
  for (let i = 0; i < 240; i++) {
    const a = R(0, TAU), r = R(258, 290);
    const x = clamp(Math.cos(a) * r * 1.2, -300, 300), z = clamp(Math.sin(a) * r * 1.2, -262, 300);
    if (Math.abs(x) < 250 && Math.abs(z) < 250) continue;
    tree(x, z, R(1.7, 3.2), pick(['round', 'round', 'poplar', 'conifer'] as const));
    if (z < 250) TREES[TREES.length - 1].hidden = true; // now covered by the street grid
  }
  for (let x = -600; x < 600; x += R(10, 18)) { tree(x, -258 + R(-3, 3), R(1.7, 2.7), rnd() < 0.4 ? 'poplar' : 'round'); tree(x, -492 + R(-3, 3), R(1.7, 2.7)); }
  for (let i = 0; i < 70; i++) {
    const cx = R(-320, 380), cz = R(320, 1050), n = RI(3, 9), kind = rnd() < 0.3 ? 'conifer' : 'round';
    for (let k = 0; k < n; k++) tree(cx + R(-18, 18), cz + R(-18, 18), R(2.4, 4.8), rnd() < 0.2 ? 'poplar' : kind);
  }
  for (let i = 0; i < 120; i++) tree(rnd() < 0.5 ? R(-320, -230) : R(240, 360), R(300, 1100), R(2.8, 5.2), pick(['round', 'poplar', 'conifer'] as const));
  const trunkMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const canopyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // Two copies of every tree: `full`, as modelled, all of them, for the sun's shadow map (drawn
  // only in a frame that renders it); and `lod`, culled and simplified by area (treeField.ts),
  // drawn the rest of the time.
  const full = new THREE.Group(), lod = new THREE.Group(), all = new THREE.Group();
  all.add(full, lod); root.add(all);
  const batches: { v: TreeVariant; kind: TreeKind; trees: FieldTree[]; matrices: number[]; colors: number[] }[] = [];
  function instanceTrees(list: TreeSpec[]) {
    const keep = list.filter((t) => t.y > 0 || path.clearOfPath(t.x, 2.2 * t.s, t.z, t.s * 2.6 + 9));
    const groups = new Map<string, { v: TreeVariant; kind: TreeKind; list: TreeSpec[] }>();
    for (const t of keep) {
      const variants = TREE_KINDS[t.kind], vi = Math.floor(rnd() * variants.length), key = t.kind + vi;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { v: variants[vi], kind: t.kind, list: [] });
      group.list.push(t);
    }
    const d = new THREE.Object3D();
    for (const { v, kind, list: items } of groups.values()) {
      const n = items.length;
      const tm = new THREE.InstancedMesh(v.trunk[0], trunkMat, n), cm = new THREE.InstancedMesh(v.canopy[0], canopyMat, n);
      const batch = { v, kind, trees: [] as FieldTree[], matrices: [] as number[], colors: [] as number[] };
      items.forEach((t, i) => {
        const s = t.hidden ? 0 : t.s * KIND_SCALE[kind];
        d.position.set(t.x, t.y, t.z); d.rotation.set(R(-0.04, 0.04), R(0, TAU), R(-0.04, 0.04)); d.scale.set(s * R(0.9, 1.1), s * R(0.9, 1.15), s * R(0.9, 1.1)); d.updateMatrix();
        tm.setMatrixAt(i, d.matrix); cm.setMatrixAt(i, d.matrix);
        const tint = v.tint(); cm.setColorAt(i, tint);
        // Every model fits in a sphere of 3.6 m around (0, 3, 0) at scale 1 (1.15 with the stretch above).
        if (s) { batch.trees.push({ x: t.x, y: t.y + 3 * s * 1.15, z: t.z, radius: 3.6 * s * 1.15 }); batch.matrices.push(...d.matrix.elements); batch.colors.push(tint.r, tint.g, tint.b); }
      });
      for (const m of [tm, cm]) { m.castShadow = true; m.receiveShadow = m !== tm; full.add(m); }
      batches.push(batch);
    }
  }
  instanceTrees(TREES);
  withRng(515151, () => instanceTrees(DTREES));

  /* --------------------------------------------------- countryside woods */
  // Woods, copses, hedgerows and lone trees across the plain and up the rim hills, so the
  // countryside around the meadow isn't bare grass from altitude. These are only seen from
  // a distance, so they use the lighter variants.
  withRng(737373, () => {
    TREE_KINDS.farRound = [makeRoundFar(ctx, 4.4), makeRoundFar(ctx, 8.2), makeRoundFar(ctx, 12.6)];
    TREE_KINDS.farPoplar = [makePoplarFar(ctx, 6.6)];
    const FTREES: TreeSpec[] = [];
    const excluded = (x: number, z: number) =>
      (Math.abs(x) < 690 && z > -760 && z < 265) || // city and districts
      (Math.abs(x) < 1230 && z > -505 && z < -245) || // lake and quays
      (x > -160 && x < -30 && z > 500 && z < 790) || // tulip field
      (x > -190 && x < -145 && z > 555 && z < 745); // windmills
    const add = (x: number, z: number, s: number, kind: TreeKind) => {
      if (excluded(x, z) || Math.hypot(x, z - 150) > 2400) return;
      const y = groundY(x, z);
      // Keep the low meadow pass open: the detailed groves own the foreground.
      if (y < 30 && !path.clearOfPath(x, 2.2 * s, z, s * 2.6 + 30)) return;
      FTREES.push({ x, y: y - 0.4, z, s, kind });
    };
    const woodKind = (x: number, z: number): TreeKind => {
      if (noise3(x * 0.003 + 90, 0, z * 0.003) > 0.55) return 'conifer';
      return rnd() < 0.12 ? 'farPoplar' : 'farRound';
    };
    // Hedgerows: broken tree lines along field edges around the meadow.
    const rows = [[[380, 880], [1300, 900]], [[420, 1180], [1250, 1150]], [[-370, 900], [-1300, 930]], [[-360, 1230], [-1200, 1200]], [[820, 300], [800, 1450]], [[-760, 290], [-790, 1400]], [[-300, 1400], [600, 1420]], [[760, -820], [1500, -760]], [[-760, -840], [-1500, -800]]];
    for (const [[x0, z0], [x1, z1]] of rows) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (let u = 0; u < len; u += R(8, 13)) {
        if (noise3(u * 0.02, x0 * 0.01, z0 * 0.01) < 0.3) continue; // gaps and gates
        const k = u / len;
        add(x0 + (x1 - x0) * k + R(-2, 2), z0 + (z1 - z0) * k + R(-2, 2), R(2.4, 3.6), rnd() < 0.3 ? 'farPoplar' : 'farRound');
      }
    }
    // Woods where a low-frequency noise field is high, copses on their fringes, lone trees elsewhere.
    const clump = (x: number, z: number) => noise3(x * 0.0045, 0, z * 0.0045) * 0.7 + noise3(x * 0.017 + 40, 0, z * 0.017) * 0.3;
    const target = Math.round(5200 * ctx.quality.Q);
    for (let i = 0; i < 60000 && FTREES.length < target; i++) {
      const x = R(-2400, 2400), z = 150 + R(-2400, 2400), c = clump(x, z);
      if (c > 0.64) add(x, z, R(3, 5.5), woodKind(x, z));
      else if (c > 0.56 && rnd() < 0.18) add(x, z, R(2.6, 4.6), woodKind(x, z));
      else if (rnd() < 0.012) add(x, z, R(3, 5), rnd() < 0.2 ? 'farPoplar' : 'farRound');
    }
    instanceTrees(FTREES);
  });

  // The culled, simplified copy. Close up, trunk and canopy as modelled; further away, one
  // coarser mesh with both (the trunk untinted); furthest, one mesh per kind of tree, since
  // the variants can't be told apart there.
  const field = new TreeField(160, ctx.quality.treeLod);
  const coarseMat = canopyMat.clone();
  coarseMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float treeTint;')
      .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.rgb *= instanceColor.rgb;', 'vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, treeTint);'));
  };
  coarseMat.customProgramCacheKey = () => 'aero-tree-coarse';
  const coarse = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  const coarseGeo = (trunk: THREE.BufferGeometry, canopy: THREE.BufferGeometry) => {
    let g = coarse.get(canopy);
    if (!g) {
      const parts = [trunk, canopy].map((p, tinted) => {
        const c = p.clone();
        c.setAttribute('treeTint', new THREE.BufferAttribute(new Float32Array(c.attributes.position.count).fill(tinted), 1));
        return c;
      });
      g = mergeGeometries(parts);
      parts.forEach((p) => p.dispose());
      coarse.set(canopy, g);
      ctx.disposables.push(g);
    }
    return g;
  };
  const mesh = (g: THREE.BufferGeometry, mat: THREE.Material, n: number, tinted: boolean) => {
    const m = new THREE.InstancedMesh(g, mat, n);
    if (tinted) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    m.receiveShadow = tinted;
    lod.add(m);
    return m;
  };
  const furthest = new Map<TreeKind, THREE.InstancedMesh>();
  for (const kind of new Set(batches.map((b) => b.kind))) {
    const v = TREE_KINDS[kind][0], n = batches.filter((b) => b.kind === kind).reduce((sum, b) => sum + b.trees.length, 0);
    furthest.set(kind, mesh(coarseGeo(v.trunk[2], v.canopy[2]), coarseMat, n, true));
  }
  for (const { v, kind, trees, matrices, colors } of batches) {
    const n = trees.length, far = furthest.get(kind);
    if (!far) continue;
    field.add({
      trees, matrices: Float32Array.from(matrices), colors: Float32Array.from(colors),
      levels: [
        [mesh(v.trunk[0], trunkMat, n, false), mesh(v.canopy[0], canopyMat, n, true)],
        [mesh(coarseGeo(v.trunk[1], v.canopy[1]), coarseMat, n, true)],
        [far],
      ],
    });
  }

  for (const v of Object.values(TREE_KINDS).flat()) ctx.disposables.push(...v.trunk, ...v.canopy);

  return {
    /** Picks the trees to draw for this camera. */
    update(camera: THREE.Camera) { field.update(camera); },
    /** Before rendering: all trees, as modelled, while the shadow map is being drawn. */
    beforeRender(renderer: THREE.WebGLRenderer) {
      const shadows = renderer.shadowMap.enabled && renderer.shadowMap.needsUpdate;
      full.visible = shadows; lod.visible = !shadows;
    },
  };
}
