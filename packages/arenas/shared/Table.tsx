import type { ReactNode } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { useDisposable } from '../../stages/shared/hooks.ts';
import type { Vec3 } from '../../stages/catalog.ts';

/**
 * A regulation table, in metres: 2.74 m long (along z), 1.525 m wide (along x), its playing
 * surface 76 cm above the floor (y = 0), with 2 cm edge lines, a 3 mm centre line, and a net
 * 15.25 cm high that overhangs each side by 15.25 cm. Arenas build round a table at the origin.
 */
export const TABLE = {
  length: 2.74,
  width: 1.525,
  height: 0.76,
  thickness: 0.025,
  edgeLine: 0.02,
  centreLine: 0.003,
  netHeight: 0.1525,
  netOverhang: 0.1525,
  /** A ball's diameter. */
  ball: 0.04,
} as const;

const { length: L, width: W, height: H, thickness: T } = TABLE;

export type LegStyle =
  /** Two glossy arches across the width, one under each half. */
  | 'arch'
  /** A flared column under each half, on a round foot. */
  | 'pedestal'
  /** Four square legs on an apron. */
  | 'classic'
  /** Nothing under the top: the arena brings its own base (a plinth, a float...). */
  | 'none';

export interface TableProps {
  position?: Vec3;
  rotationY?: number;
  /** The playing surface. */
  top?: THREE.ColorRepresentation;
  /** The edge and centre lines. */
  lines?: THREE.ColorRepresentation;
  /** The top's edge band and the apron under it. */
  edge?: THREE.ColorRepresentation;
  legs?: LegStyle;
  /** The legs' (and net posts') colour. */
  legColor?: THREE.ColorRepresentation;
  /** 0 = gloss paint, 1 = chrome. */
  legMetalness?: number;
  /** A strip of light along the top's edge band (an emissive colour), or none. */
  trim?: THREE.ColorRepresentation | null;
  trimIntensity?: number;
  /** The net's mesh and its top tape. */
  net?: THREE.ColorRepresentation;
  netTape?: THREE.ColorRepresentation;
  /** How glossy the top is: the clearcoat over its paint (0 = matte, 1 = lacquer). */
  gloss?: number;
  children?: ReactNode;
}

// The playing surface: its colour, the lines and a faint lacquer mottle, drawn once.
function surfaceTexture(top: THREE.ColorRepresentation, lines: THREE.ColorRepresentation): THREE.CanvasTexture {
  const ppm = 380; // pixels a metre
  const w = Math.round(W * ppm), h = Math.round(L * ppm);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const base = new THREE.Color(top);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, w, h);
  // A soft sheen across the middle, so the colour isn't flat under even light.
  const sheen = g.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, 'rgba(255,255,255,0.05)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.05)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, w, h);
  g.fillStyle = `#${new THREE.Color(lines).getHexString()}`;
  const e = TABLE.edgeLine * ppm;
  g.fillRect(0, 0, w, e);
  g.fillRect(0, h - e, w, e);
  g.fillRect(0, 0, e, h);
  g.fillRect(w - e, 0, e, h);
  const c = Math.max(2, TABLE.centreLine * ppm);
  g.fillRect(w / 2 - c / 2, 0, c, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// The net: a fine mesh under a white tape, with a cord along the bottom (alpha in the texture).
function netTexture(mesh: THREE.ColorRepresentation, tape: THREE.ColorRepresentation): THREE.CanvasTexture {
  const w = 1024, h = 96;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  g.strokeStyle = `#${new THREE.Color(mesh).getHexString()}`;
  g.globalAlpha = 0.85;
  g.lineWidth = 1.4;
  const cell = 7;
  for (let x = 0; x <= w; x += cell) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y <= h; y += cell) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.globalAlpha = 1;
  g.fillStyle = `#${new THREE.Color(tape).getHexString()}`;
  g.fillRect(0, 0, w, Math.round(h * 0.11));
  g.fillStyle = `#${new THREE.Color(mesh).getHexString()}`;
  g.fillRect(0, h - 3, w, 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function legGeometries(style: LegStyle): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const under = H - T;
  if (style === 'arch') {
    // An arch across the width under each half, its feet on little pucks.
    const rx = W / 2 - 0.1, ry = under - 0.04;
    const arc = new THREE.CatmullRomCurve3(
      Array.from({ length: 17 }, (_, i) => {
        const t = (i / 16) * Math.PI;
        return new THREE.Vector3(rx * Math.cos(t), 0.035 + ry * Math.sin(t), 0);
      }),
    );
    for (const s of [-1, 1]) {
      parts.push(new THREE.TubeGeometry(arc, 48, 0.028, 12).translate(0, 0, s * L * 0.3));
      for (const x of [-rx, rx]) parts.push(new THREE.CylinderGeometry(0.06, 0.07, 0.035, 20).translate(x, 0.0175, s * L * 0.3));
    }
    // A rail between the arches' crowns, under the net.
    parts.push(new THREE.CylinderGeometry(0.022, 0.022, L * 0.6, 12).rotateX(Math.PI / 2).translate(0, under - 0.04, 0));
  } else if (style === 'pedestal') {
    const profile = [
      [0.3, 0], [0.3, 0.025], [0.26, 0.04], [0.1, 0.07], [0.065, 0.16], [0.055, 0.4], [0.065, 0.62], [0.12, under - 0.035], [0.14, under - 0.015], [0, under - 0.015],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    for (const s of [-1, 1]) parts.push(new THREE.LatheGeometry(profile, 40).translate(0, 0, s * L * 0.28));
  } else if (style === 'classic') {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      parts.push(new RoundedBoxGeometry(0.045, under - 0.06, 0.045, 2, 0.008).translate(sx * (W / 2 - 0.14), (under - 0.06) / 2, sz * (L / 2 - 0.22)));
      parts.push(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 16).translate(sx * (W / 2 - 0.14), 0.01, sz * (L / 2 - 0.22)));
    }
    for (const sz of [-1, 1]) parts.push(new RoundedBoxGeometry(W - 0.28, 0.035, 0.035, 2, 0.008).translate(0, 0.16, sz * (L / 2 - 0.22)));
  }
  if (style !== 'none') {
    // The apron under the top.
    const d = 0.05, inset = 0.07;
    for (const s of [-1, 1]) {
      parts.push(new THREE.BoxGeometry(W - 2 * inset, d, 0.025).translate(0, under - d / 2, s * (L / 2 - inset)));
      parts.push(new THREE.BoxGeometry(0.025, d, L - 2 * inset).translate(s * (W / 2 - inset), under - d / 2, 0));
    }
  }
  return parts;
}

/**
 * The table, its net and posts, centred on `position` (the floor under the table's middle).
 *
 * <Table top="#1a7fd6" lines="#ffffff" edge="#e9f6ff" legs="arch" legColor="#ffffff" trim="#6ff7ff" />
 */
export function Table({
  position = [0, 0, 0],
  rotationY = 0,
  top = '#1677d2',
  lines = '#ffffff',
  edge = '#eef8ff',
  legs = 'arch',
  legColor = '#f4fbff',
  legMetalness = 0.2,
  trim = null,
  trimIntensity = 2.2,
  net = '#16223b',
  netTape = '#ffffff',
  gloss = 0.7,
  children,
}: TableProps) {
  const key = JSON.stringify([top, lines, edge, legs, legColor, legMetalness, trim, trimIntensity, net, netTape, gloss]);
  const parts = useDisposable(() => {
    const surfaceMap = surfaceTexture(top, lines);
    const surface = new THREE.MeshPhysicalMaterial({ map: surfaceMap, roughness: 0.38, clearcoat: gloss, clearcoatRoughness: 0.1 });
    const band = new THREE.MeshPhysicalMaterial({ color: edge, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.08 });
    const leg = new THREE.MeshPhysicalMaterial({ color: legColor, metalness: legMetalness, roughness: 0.18 + 0.1 * (1 - legMetalness), clearcoat: 0.6, clearcoatRoughness: 0.1 });
    const netMap = netTexture(net, netTape);
    const netMaterial = new THREE.MeshStandardMaterial({ map: netMap, transparent: true, alphaTest: 0.02, side: THREE.DoubleSide, roughness: 0.8, depthWrite: false });
    const glow = trim === null ? null : new THREE.MeshBasicMaterial({ color: new THREE.Color(trim).multiplyScalar(trimIntensity), toneMapped: true });

    const slab = new RoundedBoxGeometry(W, T, L, 3, 0.006).translate(0, H - T / 2, 0);
    const face = new THREE.PlaneGeometry(W - 0.004, L - 0.004).rotateX(-Math.PI / 2).translate(0, H + 0.0004, 0);
    const legParts = legGeometries(legs);
    const legGeometry = legParts.length ? mergeAll(legParts) : null;
    // The posts: a clamp under each side's edge and a round post up to the net's height.
    const ox = W / 2 + TABLE.netOverhang;
    const postParts: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      postParts.push(new THREE.CylinderGeometry(0.009, 0.009, TABLE.netHeight + 0.01, 12).translate(s * ox, H + (TABLE.netHeight + 0.01) / 2, 0));
      postParts.push(new THREE.SphereGeometry(0.013, 12, 8).translate(s * ox, H + TABLE.netHeight + 0.01, 0));
      postParts.push(new RoundedBoxGeometry(TABLE.netOverhang + 0.04, 0.02, 0.05, 2, 0.006).translate(s * (W / 2 + TABLE.netOverhang / 2 - 0.02), H + 0.01, 0));
      postParts.push(new RoundedBoxGeometry(0.05, 0.07, 0.05, 2, 0.008).translate(s * (W / 2 - 0.01), H - 0.03, 0));
    }
    const posts = mergeAll(postParts);
    const netPlane = new THREE.PlaneGeometry(2 * ox - 0.02, TABLE.netHeight).translate(0, H + TABLE.netHeight / 2, 0);
    // The trim: a thin strip round the edge band, a little proud of it.
    const trimGeometry = glow ? edgeStrip() : null;
    return { surface, band, leg, netMaterial, glow, slab, face, legGeometry, posts, netPlane, trimGeometry, surfaceMap, netMap };
  }, [key]);

  return (
    <group position={[position[0], position[1], position[2]]} rotation={[0, rotationY, 0]}>
      <mesh geometry={parts.slab} material={parts.band} castShadow receiveShadow />
      <mesh geometry={parts.face} material={parts.surface} receiveShadow />
      {parts.legGeometry && <mesh geometry={parts.legGeometry} material={parts.leg} castShadow receiveShadow />}
      <mesh geometry={parts.posts} material={parts.leg} castShadow />
      <mesh geometry={parts.netPlane} material={parts.netMaterial} castShadow />
      {parts.glow && parts.trimGeometry && <mesh geometry={parts.trimGeometry} material={parts.glow} />}
      {children}
    </group>
  );
}

// A thin band round the slab's sides, a millimetre proud of them.
function edgeStrip(): THREE.BufferGeometry {
  const h = 0.006, d = 0.002, y = H - T * 0.55;
  return mergeAll([
    new THREE.BoxGeometry(W + 2 * d, h, d).translate(0, y, L / 2 + d / 2),
    new THREE.BoxGeometry(W + 2 * d, h, d).translate(0, y, -L / 2 - d / 2),
    new THREE.BoxGeometry(d, h, L).translate(W / 2 + d / 2, y, 0),
    new THREE.BoxGeometry(d, h, L).translate(-W / 2 - d / 2, y, 0),
  ]);
}

/** Merges geometries with the same attributes (position, normal, uv) into one, non-indexed. */
export function mergeAll(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geometries.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    for (const name of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(name)) n.deleteAttribute(name);
    return n;
  });
  let count = 0;
  for (const g of flat) count += g.attributes.position.count;
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const size = name === 'uv' ? 2 : 3;
    const array = new Float32Array(count * size);
    let at = 0;
    for (const g of flat) {
      const attr = g.attributes[name] as THREE.BufferAttribute | undefined;
      if (attr) array.set(attr.array as Float32Array, at);
      at += g.attributes.position.count * size;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  flat.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
