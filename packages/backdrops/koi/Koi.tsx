import { useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { KOI } from './layout.ts';
import type { KoiSwim } from './layout.ts';
import { pondGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// ---------------------------------------------------------------------------
// Koi: one instanced draw. The CPU walks each fish along its loop (a few trig calls a fish),
// placing it and measuring how hard it is turning; the vertex shader bends the body along that
// arc and sends a lazy wave down to the tail. Fins are soft-edged translucent sheets.
// ---------------------------------------------------------------------------

/** Nose (+z) to the root of the tail, in model units; the tail fin trails behind. */
const NOSE = 0.5;
const ROOT = -0.27;
const TAIL = 0.36;

// Half width of the body from above at u (0 nose .. 1 tail root): a blunt round head, widest
// a third of the way back, tapering to a slim root.
function bodyWidth(u: number): number {
  const head = Math.pow(Math.sin(Math.min(u / 0.28, 1) * Math.PI * 0.5), 0.42);
  const taper = 1 - 0.76 * Math.pow(THREE.MathUtils.smoothstep(u, 0.26, 1), 1.15);
  return 0.132 * head * taper;
}

interface Sheet {
  positions: number[];
  /** part (0 body, 1 tail, 2 pectoral, 3 pelvic), opacity, along (0 root .. 1 tip), across (-1..1). */
  fins: number[];
  indices: number[];
}

/** A grid sheet (a fin) from a function of (along, across), with opacity fading towards its edges. */
function addFin(sheet: Sheet, part: number, rows: number, cols: number, at: (t: number, s: number) => THREE.Vector3, edge: (t: number, s: number) => number): void {
  const base = sheet.positions.length / 3;
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const t = i / rows;
      const s = (j / cols) * 2 - 1;
      const p = at(t, s);
      sheet.positions.push(p.x, p.y, p.z);
      sheet.fins.push(part, edge(t, s), t, s);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = base + i * (cols + 1) + j;
      const b = a + cols + 1;
      sheet.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/**
 * A koi, nose at +z, about 1.1 long. Attributes: aFin (see Sheet) and aU (0 nose .. 1 tail tip).
 * The body comes first in the index buffer, so a fish's fins blend over its own body.
 */
function koiGeometry(): THREE.BufferGeometry {
  // Body: elliptical rings along z, normals by finite differences of the surface.
  const RINGS = 26;
  const SEGS = 16;
  const surface = (u: number, a: number, out: THREE.Vector3) => {
    const w = bodyWidth(u);
    const s = Math.sin(a);
    // A rounded back, a fuller belly, the head a touch lower than the shoulders.
    const h = w * (s > 0 ? 0.82 : 0.95);
    return out.set(Math.cos(a) * w, s * h - 0.012 * (1 - u), NOSE - u * (NOSE - ROOT));
  };
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const du = new THREE.Vector3();
  const da = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let i = 0; i <= RINGS; i++) {
    const u = i / RINGS;
    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2 - Math.PI / 2;
      surface(u, a, p);
      positions.push(p.x, p.y, p.z);
      surface(Math.min(u + 0.01, 1), a, du).sub(surface(Math.max(u - 0.01, 0), a, q));
      surface(Math.max(u, 0.02), a + 0.01, da).sub(surface(Math.max(u, 0.02), a - 0.01, q));
      const n = q.crossVectors(du, da).normalize();
      if (i === 0) n.set(0, 0, 1);
      normals.push(n.x, n.y, n.z);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j;
      const b = a + SEGS + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  body.setAttribute('aFin', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 4).fill(0), 4));
  body.setIndex(indices);

  // Fins, flat and roughly horizontal so they read from above.
  const sheet: Sheet = { positions: [], fins: [], indices: [] };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // A flowing tail, forked in the middle with rounded lobes.
  addFin(
    sheet, 1, 7, 10,
    (t, s) => {
      const spread = 0.022 + 0.21 * Math.pow(t, 0.85);
      const fork = 1 - 0.36 * Math.pow(1 - Math.abs(s), 1.6);
      return v(s * spread, -0.005 - 0.01 * t, ROOT + 0.03 - t * TAIL * fork);
    },
    (t, s) => 0.92 * (1 - THREE.MathUtils.smoothstep(t, 0.62, 1)) * (1 - THREE.MathUtils.smoothstep(Math.abs(s), 0.7, 1)) * (0.8 + 0.2 * t),
  );
  for (const side of [-1, 1]) {
    // Pectoral fins: broad rounded paddles behind the head.
    const ux = 0.3;
    const zA = NOSE - ux * (NOSE - ROOT);
    const xA = bodyWidth(ux) * 0.75;
    addFin(
      sheet, 2, 4, 6,
      (t, s) => {
        const len = 0.2 * t;
        const width = 0.07 * Math.sin(Math.PI * Math.min(0.15 + t * 0.85, 1)) + 0.01;
        return v(side * (xA + len * 0.82), -0.035 - 0.02 * t, zA - len * 0.62 + s * width);
      },
      (t, s) => 0.9 * (1 - THREE.MathUtils.smoothstep(t, 0.6, 1)) * (1 - THREE.MathUtils.smoothstep(Math.abs(s), 0.6, 1)),
    );
    // Small pelvic fins further back.
    const uy = 0.62;
    const zB = NOSE - uy * (NOSE - ROOT);
    const xB = bodyWidth(uy) * 0.6;
    addFin(
      sheet, 3, 3, 4,
      (t, s) => {
        const len = 0.11 * t;
        const width = 0.035 * Math.sin(Math.PI * Math.min(0.15 + t * 0.85, 1)) + 0.006;
        return v(side * (xB + len * 0.7), -0.05 - 0.01 * t, zB - len * 0.75 + s * width);
      },
      (t, s) => 0.7 * (1 - THREE.MathUtils.smoothstep(t, 0.5, 1)) * (1 - THREE.MathUtils.smoothstep(Math.abs(s), 0.5, 1)),
    );
  }
  const fins = new THREE.BufferGeometry();
  fins.setAttribute('position', new THREE.Float32BufferAttribute(sheet.positions, 3));
  fins.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(sheet.positions.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  fins.setAttribute('aFin', new THREE.Float32BufferAttribute(sheet.fins, 4));
  fins.setIndex(sheet.indices);

  const merged = mergeGeometries([body, fins]);
  body.dispose();
  fins.dispose();
  const pos = merged.getAttribute('position');
  const aU = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) aU[i] = THREE.MathUtils.clamp((NOSE - pos.getZ(i)) / (NOSE - ROOT + TAIL), 0, 1);
  merged.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  return merged;
}

const koiVertex = /* glsl */ `
uniform float uTime;
attribute vec4 aFin;
attribute float aU;
// Per fish: curvature (1 / turning radius, in model units), tail phase, fin phase, effort.
attribute vec4 aSwim;
// Per fish: variant, pattern seed.
attribute vec2 aKind;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vLocal;
varying vec4 vFin;
varying vec2 vKind;

void main() {
  vec3 p = position;
  vec3 n = normal;
  float z = p.z;
  // Fins flap and sweep from their roots.
  if (aFin.x > 1.5) {
    float lag = aFin.x > 2.5 ? 1.9 : 0.0;
    float side = sign(p.x);
    p.y += sin(aSwim.z + lag) * aFin.z * 0.05;
    p.z += sin(aSwim.z + lag + 1.3) * aFin.z * 0.035;
    p.x += side * cos(aSwim.z + lag) * aFin.z * 0.012;
  }
  // The body follows the arc it is swimming, and a wave runs down it to the tail.
  float kappa = clamp(aSwim.x, -1.6, 1.6);
  float env = 1.0 - smoothstep(-0.62, 0.28, z);
  float amp = 0.075 * aSwim.w;
  float ph = aSwim.y + z * 6.5;
  float bend = 0.5 * kappa * z * z + amp * env * env * sin(ph) + 0.006 * sin(aSwim.y);
  float slope = kappa * z + amp * env * env * 6.5 * cos(ph);
  float th = atan(slope);
  float c = cos(th);
  float s = sin(th);
  vec3 bent = vec3(bend + p.x * c, p.y, z - p.x * s);
  vec3 bn = vec3(n.x * c + n.z * s, n.y, n.z * c - n.x * s);
  vec4 world = instanceMatrix * vec4(bent, 1.0);
  vWorld = world.xyz;
  vN = normalize(mat3(instanceMatrix) * bn);
  vLocal = position;
  vFin = aFin;
  vKind = aKind;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const koiFragment = /* glsl */ `
${pondGLSL}
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vLocal;
varying vec4 vFin;
varying vec2 vKind;

const vec3 WHITE = vec3(0.8, 0.78, 0.74);
const vec3 RED = vec3(0.82, 0.05, 0.015);
const vec3 ORANGE = vec3(1.0, 0.24, 0.015);
const vec3 GOLD = vec3(1.0, 0.46, 0.04);
const vec3 PLATINUM = vec3(0.72, 0.75, 0.76);
const vec3 SUMI = vec3(0.025, 0.025, 0.03);

// Soft-edged threshold, antialiased by the pattern's own rate of change.
float blotch(float v, float edge) {
  float w = fwidth(v) + 0.025;
  return smoothstep(edge - w, edge + w, v);
}

void main() {
  float variant = vKind.x;
  float seed = vKind.y;
  bool fin = vFin.x > 0.5;
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vN);
  // The body's silhouette fades over a pixel instead of stair-stepping; its far side is dropped
  // before any work is done on it. Fins are single sheets: light whichever side faces us.
  float facing = dot(n, v);
  float edge = fwidth(facing) * 1.5 + 0.02;
  if (!fin && facing < 0.0) discard;
  if (fin && facing < 0.0) n = -n;

  // The pattern, laid out in body coordinates seen from above.
  vec2 pc = vec2(vLocal.z * 3.2, vLocal.x * 5.0) + seed * 17.0;
  float blot = snoise(pc) * 0.65 + snoise(pc * 2.3 + 5.0) * 0.3;
  float back = smoothstep(-0.04, 0.03, vLocal.y);
  float metal = 0.0;
  vec3 base = WHITE;
  vec3 finCol = vec3(0.85, 0.85, 0.82);
  if (variant < 0.5 || (variant > 4.5 && variant < 5.5)) {
    // Kohaku / sanke: red patches on white, keeping the head's crown, not the belly.
    float red = blotch(blot + 0.32 * smoothstep(0.18, 0.4, vLocal.z) - 0.1 * (1.0 - smoothstep(-0.25, -0.1, vLocal.z)), 0.08) * back;
    base = mix(WHITE, RED, red);
    if (variant > 4.5) {
      float sumi = blotch(snoise(pc * 1.7 + 31.0) - 0.2 * smoothstep(0.3, 0.45, vLocal.z), 0.5) * back;
      base = mix(base, SUMI, sumi);
    }
  } else if (variant < 1.5) {
    // Tancho: pure white with one round red crown.
    float crown = 1.0 - smoothstep(0.055, 0.07, length(vec2(vLocal.z - 0.33, vLocal.x * 1.15)));
    base = mix(WHITE, RED, crown * back);
  } else if (variant < 2.5) {
    // Orange, paler underneath, with a little metallic sheen.
    base = mix(vec3(1.0, 0.5, 0.2), ORANGE, back);
    finCol = vec3(1.0, 0.45, 0.15);
    metal = 0.35;
  } else if (variant < 3.5) {
    base = GOLD;
    finCol = vec3(1.0, 0.6, 0.2);
    metal = 1.0;
  } else {
    base = PLATINUM;
    finCol = vec3(0.92, 0.94, 0.95);
    metal = 0.9;
  }
  // The dorsal fin as a soft translucent ridge along the spine.
  float dorsal = (1.0 - smoothstep(0.004, 0.012, abs(vLocal.x))) * smoothstep(0.0, 0.05, vLocal.y) * (1.0 - smoothstep(0.15, 0.25, vLocal.z)) * smoothstep(-0.2, -0.05, vLocal.z);
  base = mix(base, finCol * 0.85, dorsal * 0.6);
  // Eyes on the sides of the head.
  float eye = 1.0 - smoothstep(0.012, 0.02, length(vec2(abs(vLocal.x) - 0.062, vLocal.z - 0.4)));
  base = mix(base, vec3(0.02), eye * step(0.0, vLocal.y + 0.01) * (fin ? 0.0 : 1.0));

  float alpha = fin ? 1.0 : smoothstep(0.0, edge, facing);
  if (fin) {
    // Translucent fins with fine rays fanning out from their roots.
    float rays = 0.88 + 0.12 * sin(vFin.w * 28.0 + vFin.z * 2.0);
    base = mix(base, finCol, 0.7) * rays;
    alpha = vFin.y;
  }

  // Light: sunlight through the swell (caustics, pad shade), a bright sky above, dark below.
  vec3 L = uSunW;
  float depth = max(-vWorld.y, 0.0);
  vec2 surfaceP = vWorld.xz + L.xz / L.y * depth;
  float caus = caustics(surfaceP * 0.8, 0.15);
  float shade = padShadow(vWorld.xz, vWorld.y);
  float wrap = max((dot(n, L) + 0.35) / 1.35, 0.0);
  vec3 sun = SUN_COLOR * (1.0 - shade * 0.8) * (0.6 + caus * 0.5);
  vec3 amb = mix(vec3(0.05, 0.12, 0.11), vec3(0.3, 0.46, 0.45), n.y * 0.5 + 0.5);
  vec3 col = base * (amb + sun * wrap * (fin ? 1.0 : 0.85));
  // Glossy: a soft sheen of the bright water above and a crisp sun highlight along the back.
  vec3 h = normalize(L + v);
  float nh = max(dot(n, h), 0.0);
  float spec = pow(nh, 18.0) * 0.12 + pow(nh, mix(140.0, 90.0, metal)) * mix(1.4, 2.2, metal);
  vec3 specCol = mix(vec3(1.0), base * 1.3, metal * 0.6);
  vec3 r = reflect(-v, n);
  float sheen = smoothstep(0.6, 1.0, r.y) * (fin ? 0.08 : 0.16 + 0.22 * metal);
  col += specCol * (sun * spec * (fin ? 0.25 : 1.0) + vec3(0.5, 0.75, 0.78) * sheen);
  // A cool rim where the body turns away.
  col += vec3(0.25, 0.45, 0.45) * pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.35 * (fin ? 0.0 : 1.0);

  col = waterColumn(col, 0.85 * depth / max(v.y, 0.3));
  // And the surface over it.
  vec3 s = surfacePoint(vWorld);
  vec3 ring = ripples(s.xz);
  col = overSurface(col, s, swell(s.xz) + ring, ring.z);
  gl_FragColor = vec4(col, alpha);
}
`;

const TAU = Math.PI * 2;
const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU);

/** Where a koi is on its loop at time t (x, z into out). */
function swimAt(k: KoiSwim, t: number, out: THREE.Vector2): THREE.Vector2 {
  const s = k.phase + k.speed * t;
  const cx = k.centre[0] + Math.sin(t * 0.021 + k.phase * 3) * k.wander;
  const cz = k.centre[1] + Math.cos(t * 0.017 + k.phase * 5) * k.wander * 0.7;
  return out.set(
    cx + Math.cos(s) * k.radius[0] + Math.cos(k.lobes * s + k.phase) * k.lobe,
    cz + Math.sin(s) * k.radius[1] + Math.sin(k.lobes * s + k.phase) * k.lobe,
  );
}

export function Koi({ shared }: { shared: PondUniforms }) {
  // Deepest first, so shallower fish's fins blend over deeper ones.
  const school = useMemo(() => [...KOI].sort((a, b) => b.depth - a.depth), []);
  const count = school.length;

  const { geometry, material, swim } = useDisposable(() => {
    const geometry = koiGeometry();
    const swim = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    swim.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aSwim', swim);
    geometry.setAttribute('aKind', new THREE.InstancedBufferAttribute(new Float32Array(school.flatMap((k, i) => [k.variant, i * 1.37 + k.phase])), 2));
    const material = shaderMaterial({
      uniforms: { ...shared },
      vertexShader: koiVertex,
      fragmentShader: koiFragment,
      transparent: true,
      side: THREE.DoubleSide,
    });
    return { geometry, material, swim };
  }, [shared, school]);

  // Disposed too, which frees its instance matrices.
  const mesh = useDisposable(() => {
    const m = new THREE.InstancedMesh(geometry, material, count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.renderOrder = 1;
    return m;
  }, [geometry, material, count]);

  const scratch = useMemo(() => {
    const dummy = new THREE.Object3D();
    // Heading last, so the small pitch and roll stay the fish's own.
    dummy.rotation.order = 'YXZ';
    // Tail beats, integrated so their pace can follow each fish's speed without jumping.
    const tails = Float32Array.from(school, (k) => k.phase * 7);
    return { a: new THREE.Vector2(), b: new THREE.Vector2(), c: new THREE.Vector2(), dummy, tails };
  }, [school]);

  useBackdropFrame((_state, delta, time) => {
    const { a, b, c, dummy, tails } = scratch;
    const step = 0.35;
    for (let i = 0; i < count; i++) {
      const k = school[i];
      swimAt(k, time - step, a);
      swimAt(k, time, b);
      swimAt(k, time + step, c);
      const h0 = Math.atan2(b.x - a.x, b.y - a.y);
      const h1 = Math.atan2(c.x - b.x, c.y - b.y);
      const heading = h0 + wrapAngle(h1 - h0) * 0.5;
      const travelled = a.distanceTo(b) + b.distanceTo(c);
      const speed = travelled / (2 * step);
      // Turning rate per unit length (world units), and in the model's.
      const turn = wrapAngle(h1 - h0) / Math.max(travelled * 0.5, 1e-4);
      const kappa = turn * k.size;
      const y = -k.depth + Math.sin(time * 0.13 + k.phase * 2) * 0.06;
      dummy.position.set(b.x, y, b.y);
      dummy.rotation.set(Math.sin(time * 0.2 + k.phase) * 0.03, heading, -kappa * 0.06);
      dummy.scale.setScalar(k.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const effort = THREE.MathUtils.clamp(speed / 0.3, 0.6, 1.5);
      tails[i] += delta * (1.9 + 0.2 * Math.sin(k.phase)) * effort;
      swim.setXYZW(i, kappa, tails[i], time * 1.3 + k.phase * 3, effort);
      // Shadow casters: head, middle and tail root, bent along the same arc as the body.
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      const head = 0.42 * k.size;
      const root = -0.27 * k.size;
      const headSide = 0.5 * turn * head * head;
      const rootSide = 0.5 * turn * root * root;
      shared.uKoiA.value[i].set(b.x + fx * head + fz * headSide, b.y + fz * head - fx * headSide, b.x, b.y);
      shared.uKoiB.value[i].set(b.x + fx * root + fz * rootSide, b.y + fz * root - fx * rootSide, y, k.size);
    }
    mesh.instanceMatrix.needsUpdate = true;
    swim.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
