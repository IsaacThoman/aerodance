import { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '../../stages/catalog.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { clamp, makeRandom, smoothstep } from '../../stages/shared/random.ts';
import { DROP_FALL, DROP_HANG, DROP_REST, DROP_SLIDE, dropFragmentShader, dropVertexShader } from './dropShader.ts';
import { Ladybug } from './Ladybug.tsx';
import type { LadybugSpec } from './Ladybug.tsx';
import { leafFragmentShader, leafVertexShader } from './leafShader.ts';
import { dew } from './light.ts';

export interface LeafColors {
  deep: THREE.ColorRepresentation;
  fresh: THREE.ColorRepresentation;
  vein: THREE.ColorRepresentation;
  under: THREE.ColorRepresentation;
  /** What the sun turns to shining through the blade. */
  glow: THREE.ColorRepresentation;
}

export interface LeafDrip {
  /** Seconds for one drop to slide down and fall. */
  period: number;
  /** 0..1 into the cycle at time 0. */
  offset: number;
  /** Where the sliding drop rests: u along the leaf, s across it (fraction of the half width). */
  from: [u: number, s: number];
  /** The sliding drop's radius. */
  size: number;
  /** The hanging drop's radius when it lets go. */
  hang: number;
}

export interface LeafSpec {
  /** Where the midrib starts (u 0), world units. */
  base: Vec3;
  /** Towards the tip from the base (world; any length). */
  dir: Vec3;
  /** Roughly where the top face looks (world). */
  face: Vec3;
  length: number;
  /** Half the width at the widest. */
  width: number;
  /** Radians the midrib arcs through, away from the top face. */
  droop?: number;
  /** How far the halves rise from the midrib, in half widths. */
  cup?: number;
  /** Radians the blade twists about the midrib by the tip. */
  twist?: number;
  ripple?: number;
  /** Sideways curve of the midrib, in lengths. */
  curve?: number;
  /** Radians of breeze. */
  sway?: number;
  phase?: number;
  /** Half width of the stem (0: none) and the u the mesh starts at (negative shows the stem). */
  stem?: number;
  start?: number;
  /** Edge softness in world units: depth of field. */
  blur?: number;
  /** 0..1 melt into the far foliage. */
  haze?: number;
  translucency?: number;
  gloss?: number;
  colors: LeafColors;
  /** Secondary veins: count, slant, width (fraction of their spacing), strength. */
  veins?: [count: number, slant: number, width: number, strength: number];
  drops?: { count: number; seed: number; size: [min: number, max: number] };
  drip?: LeafDrip;
  ladybug?: LadybugSpec;
  renderOrder: number;
}

const halfWidth = (u: number, width: number) => {
  const a = Math.pow(clamp(u), 0.8);
  return width * Math.max(Math.sin(Math.PI * a) * (1 - 0.55 * smoothstep(0.5, 1, u)), 0);
};

// The grid the vertex shader bends into the leaf: u along it, s across it.
function leafGrid(start: number, along = 96, across = 16): THREE.BufferGeometry {
  const coords = new Float32Array((along + 1) * (across + 1) * 2);
  const index: number[] = [];
  for (let i = 0; i <= along; i++) {
    for (let j = 0; j <= across; j++) {
      const k = i * (across + 1) + j;
      coords[k * 2] = start + (1 - start) * (i / along);
      coords[k * 2 + 1] = -1 + (2 * j) / across;
      // Wound so the top face (+y) is the front.
      if (i < along && j < across) index.push(k, k + 1, k + across + 1, k + 1, k + across + 2, k + across + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  // Positions are computed in the shader; three still wants an attribute to count vertices by.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(coords.length * 1.5), 3));
  geometry.setAttribute('aLeaf', new THREE.BufferAttribute(coords, 2));
  geometry.setIndex(index);
  return geometry;
}

interface DropSeed {
  u: number;
  s: number;
  r: number;
  kind: number;
}

// Drops scattered over the blade without touching each other, the sliding drop's path or the
// tip, bigger ones rarer, gathered a little towards the midrib's groove.
function scatterDrops(spec: LeafSpec): DropSeed[] {
  const out: DropSeed[] = [];
  const { drops, drip, length, width } = spec;
  if (drip) {
    out.push({ u: drip.from[0], s: drip.from[1], r: drip.size, kind: DROP_SLIDE });
    out.push({ u: 1, s: 0, r: drip.hang, kind: DROP_HANG });
    out.push({ u: 1, s: 0, r: drip.hang, kind: DROP_FALL });
  }
  if (!drops) return out;
  const rand = makeRandom(drops.seed);
  const placed: { u: number; z: number; r: number }[] = [];
  const pathZ = (u: number) => {
    if (!drip) return Infinity;
    const [u0, s0] = drip.from;
    return s0 * halfWidth(u0, width) * (1 - smoothstep(u0, u0 + 0.28, u));
  };
  for (let attempt = 0; attempt < drops.count * 40 && placed.length < drops.count; attempt++) {
    const u = rand.range(0.1, 0.9);
    const s = rand.sign() * Math.pow(rand.next(), 1.25) * 0.85;
    const r = drops.size[0] + (drops.size[1] - drops.size[0]) * Math.pow(rand.next(), 2.4);
    const w = halfWidth(u, width);
    const z = s * w;
    if (Math.abs(z) + r * 1.25 > w * 0.94) continue;
    if (drip && u > drip.from[0] - 0.06 && Math.abs(z - pathZ(u)) < r + drip.size * 1.6) continue;
    if (placed.some((o) => Math.hypot((o.u - u) * length, o.z - z) < (o.r + r) * 1.35)) continue;
    // Leave the ladybug room to walk.
    const bug = spec.ladybug;
    if (bug && Math.abs(u - bug.centre[0]) < bug.reach[0] + 0.08 && Math.abs(s - bug.centre[1]) < bug.reach[1] + 0.2) continue;
    placed.push({ u, z, r });
    out.push({ u, s, r, kind: DROP_REST });
  }
  return out;
}

function dropGeometry(seeds: DropSeed[]): THREE.InstancedBufferGeometry {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  const drop = new Float32Array(seeds.length * 4);
  seeds.forEach((d, i) => drop.set([d.u, d.s, d.r, d.kind], i * 4));
  geometry.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drop, 4));
  geometry.instanceCount = seeds.length;
  return geometry;
}

const DEFAULT_VEINS: [number, number, number, number] = [9, 1.4, 0.07, 0.55];

/**
 * A glossy leaf, bent and swayed in its shader, with drops beaded on it and, given a drip,
 * a drop that slides down to the tip and falls.
 */
export function Leaf(spec: LeafSpec) {
  const { base, dir, face, renderOrder } = spec;
  const quaternion = useMemo(() => {
    const x = new THREE.Vector3(...dir).normalize();
    const f = new THREE.Vector3(...face);
    const y = f.sub(x.clone().multiplyScalar(f.dot(x))).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }, [...dir, ...face]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = spec.start ?? 0;
  const grid = useDisposable(() => leafGrid(start), [start]);
  const drops = useDisposable(() => dropGeometry(scatterDrops(spec)), []);

  // One set of uniforms for the leaf and its drops: they share the shape and the colours.
  const uniforms = useMemo(() => {
    const c = spec.colors;
    const drip = spec.drip;
    return {
      ...dew,
      uShape: { value: new THREE.Vector4(spec.length, spec.width, spec.droop ?? 0.3, spec.cup ?? 0.25) },
      uShape2: { value: new THREE.Vector4(spec.twist ?? 0, spec.ripple ?? 0.03, spec.sway ?? 0.04, spec.phase ?? 0) },
      // Out of focus, a soft round fold: a sharp one would draw a crisp highlight down the midrib.
      uShape3: { value: new THREE.Vector4(spec.curve ?? 0, Math.max(spec.blur ?? 0, 0.002) * 2 + 0.02, spec.stem ?? 0, (spec.blur ?? 0) > 0.1 ? 2.2 : 1.5) },
      uDrip: { value: new THREE.Vector4(drip?.period ?? 10, drip?.offset ?? 0, drip ? 1 : 0, drip?.hang ?? 0.2) },
      uSlide: { value: new THREE.Vector4(drip?.from[0] ?? 0.5, drip?.from[1] ?? 0, drip?.size ?? 0.1, 0) },
      uDeep: { value: new THREE.Color(c.deep) },
      uFresh: { value: new THREE.Color(c.fresh) },
      uVeinColor: { value: new THREE.Color(c.vein) },
      uUnder: { value: new THREE.Color(c.under) },
      uGlow: { value: new THREE.Color(c.glow) },
      uVein: { value: new THREE.Vector4(...(spec.veins ?? DEFAULT_VEINS)) },
      uLook: { value: new THREE.Vector4(spec.translucency ?? 1, spec.gloss ?? 1, spec.haze ?? 0, spec.blur ?? 0) },
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const leafMaterial = useDisposable(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: leafVertexShader,
        fragmentShader: leafFragmentShader,
        side: THREE.DoubleSide,
        transparent: true,
        premultipliedAlpha: true,
      }),
  );
  const dropMaterial = useDisposable(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: dropVertexShader,
        fragmentShader: dropFragmentShader,
        // The quads on the leaf face into it (T x B = -N).
        side: THREE.DoubleSide,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        depthTest: false,
      }),
  );

  return (
    <group position={base} quaternion={quaternion}>
      <mesh geometry={grid} material={leafMaterial} frustumCulled={false} renderOrder={renderOrder} />
      {drops.instanceCount > 0 && <mesh geometry={drops} material={dropMaterial} frustumCulled={false} renderOrder={renderOrder + 0.5} />}
      {spec.ladybug && <Ladybug uniforms={uniforms} spec={spec.ladybug} renderOrder={renderOrder + 0.6} />}
    </group>
  );
}
