import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shaderMaterial } from '../shared/glsl.ts';
import { useDisposable } from '../shared/hooks.ts';
import { BUDS, LOTUS, NOTCH, ORDER, PADS } from './layout.ts';
import { pondGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// ---------------------------------------------------------------------------
// The small lily pads and lotus flowers riding the swell: one instanced draw for the pads, one for the
// open flowers and one for the buds. They bob, turn and tilt with the waves in their vertex
// shaders; their outlines fade over the last sliver of the shape so they stay smooth without MSAA.
// ---------------------------------------------------------------------------

/** A unit lily pad: a shallow saucer with a slit, its rim curling up. aPolar = (radius, 0..1 around from the slit). */
function padGeometry(): THREE.BufferGeometry {
  const rings = [0, 0.16, 0.36, 0.56, 0.74, 0.88, 0.95, 1];
  const SEGS = 48;
  const positions: number[] = [];
  const normals: number[] = [];
  const polar: number[] = [];
  const indices: number[] = [];
  const lift = (r: number) => 0.012 * r * r + 0.04 * THREE.MathUtils.smoothstep(r, 0.86, 1);
  const n = new THREE.Vector3();
  for (const r of rings) {
    for (let j = 0; j <= SEGS; j++) {
      const t = j / SEGS;
      const a = NOTCH + t * (Math.PI * 2 - 2 * NOTCH);
      positions.push(Math.cos(a) * r, lift(r), Math.sin(a) * r);
      const slope = (lift(Math.min(r + 0.01, 1)) - lift(Math.max(r - 0.01, 0))) / 0.02;
      n.set(-Math.cos(a) * slope, 1, -Math.sin(a) * slope).normalize();
      normals.push(n.x, n.y, n.z);
      polar.push(r, t);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j;
      const b = a + SEGS + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('aPolar', new THREE.Float32BufferAttribute(polar, 2));
  g.setIndex(indices);
  return g;
}

interface PetalRing {
  count: number;
  length: number;
  width: number;
  /** Rise of the petal's root above horizontal, radians. */
  tilt: number;
  /** Further rise (or, negative, curl inwards) by its tip. */
  bend: number;
  /** How much its edges cup upwards. */
  cup: number;
  /** Root's distance from the centre and height. */
  root: [number, number];
  offset: number;
}

/**
 * A lotus of rings of cupped, pointed petals (unit size about 0.5 across), with a golden seed pod
 * in the middle when open. aPetal = (along 0..1, across -1..1, ring 0..1, part: 0 petal, 1 pod).
 */
function lotusGeometry(rings: readonly PetalRing[], pod: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const U = 7;
  const V = 6;
  rings.forEach((ring, ri) => {
    for (let k = 0; k < ring.count; k++) {
      const az = ring.offset + (k / ring.count) * Math.PI * 2 + Math.sin(k * 2.3 + ri) * 0.08;
      const radial = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
      const tangent = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
      const positions: number[] = [];
      const petal: number[] = [];
      const indices: number[] = [];
      let cr = ring.root[0];
      let cy = ring.root[1];
      const length = ring.length * (0.92 + 0.16 * Math.abs(Math.sin(k * 1.7 + ri)));
      for (let i = 0; i <= U; i++) {
        const u = i / U;
        const phi = ring.tilt + ring.bend * u;
        if (i > 0) {
          cr += Math.cos(phi) * (length / U);
          cy += Math.sin(phi) * (length / U);
        }
        const w = ring.width * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * u)), 0.6) * (1 - 0.3 * u);
        for (let j = 0; j <= V; j++) {
          const v = (j / V) * 2 - 1;
          const lift = ring.cup * w * v * v;
          const r = cr - Math.sin(phi) * lift;
          const y = cy + Math.cos(phi) * lift;
          const across = v * w;
          positions.push(radial.x * r + tangent.x * across, y, radial.z * r + tangent.z * across);
          petal.push(u, v, ri / Math.max(rings.length - 1, 1), 0);
        }
      }
      for (let i = 0; i < U; i++) {
        for (let j = 0; j < V; j++) {
          const a = i * (V + 1) + j;
          const b = a + V + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('aPetal', new THREE.Float32BufferAttribute(petal, 4));
      g.setIndex(indices);
      g.computeVertexNormals();
      parts.push(g);
    }
  });
  if (pod) {
    const disc = new THREE.CircleGeometry(0.1, 20).rotateX(-Math.PI / 2).translate(0, 0.09, 0);
    disc.deleteAttribute('uv');
    const count = disc.getAttribute('position').count;
    const petal = new Float32Array(count * 4);
    const pos = disc.getAttribute('position');
    for (let i = 0; i < count; i++) petal.set([Math.hypot(pos.getX(i), pos.getZ(i)) / 0.1, 0, 0, 1], i * 4);
    disc.setAttribute('aPetal', new THREE.BufferAttribute(petal, 4));
    parts.push(disc);
  }
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return merged;
}

const OPEN: readonly PetalRing[] = [
  { count: 8, length: 0.5, width: 0.15, tilt: 0.22, bend: 0.5, cup: 0.4, root: [0.05, 0], offset: 0 },
  { count: 8, length: 0.44, width: 0.145, tilt: 0.55, bend: 0.42, cup: 0.45, root: [0.04, 0.02], offset: Math.PI / 8 },
  { count: 7, length: 0.36, width: 0.13, tilt: 0.92, bend: 0.3, cup: 0.5, root: [0.035, 0.04], offset: 0.2 },
  { count: 5, length: 0.25, width: 0.1, tilt: 1.18, bend: 0.12, cup: 0.5, root: [0.03, 0.05], offset: 0.55 },
];

/**
 * A closed bud: a smooth teardrop of wrapped petals (their seams are shaded in), pointed up.
 * aPetal = (height 0..1, seam -1..1 around, 0, 0).
 */
function budGeometry(): THREE.BufferGeometry {
  const HEIGHT = 0.5;
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const h = i / 12;
    profile.push(new THREE.Vector2(0.17 * Math.pow(Math.sin(Math.PI * Math.min(h * 0.92 + 0.08, 1)), 0.75) * (1 - 0.35 * h), h * HEIGHT));
  }
  const g = new THREE.LatheGeometry(profile, 30);
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position');
  const petal = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / HEIGHT;
    const around = Math.atan2(pos.getZ(i), pos.getX(i));
    petal.set([h, Math.cos(around * 5 + h * 1.4), 0, 0], i * 4);
  }
  g.setAttribute('aPetal', new THREE.BufferAttribute(petal, 4));
  // Leaning a little, as buds on their stalks do, so its teardrop shows from above.
  return g.rotateZ(-0.5).translate(0.05, 0, 0);
}

const padVertex = /* glsl */ `
${pondGLSL}
attribute vec4 aPad;
attribute vec2 aTone;
attribute vec2 aPolar;
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vPolar;
varying vec2 vLocal;
varying vec4 vPad;

void main() {
  float turn = aPad.w + sin(uTime * 0.045 + aTone.y * 6.0) * 0.12;
  float c = cos(turn);
  float s = sin(turn);
  vec2 lp = position.xz * aPad.z;
  vec2 xz = vec2(c * lp.x - s * lp.y, s * lp.x + c * lp.y) + aPad.xy;
  // Riding the swell, with a slow bob of its own.
  vec3 sw = swell(xz);
  float y = 0.02 + position.y * aPad.z + sw.z * 0.8 + sin(uTime * 0.8 + aTone.y * 20.0) * 0.006;
  vec2 nxz = vec2(c * normal.x - s * normal.z, s * normal.x + c * normal.z);
  vN = normalize(vec3(nxz.x - sw.x * 0.8, normal.y, nxz.y - sw.y * 0.8));
  vWorld = vec3(xz.x, y, xz.y);
  vPolar = aPolar;
  vLocal = position.xz;
  vPad = vec4(aTone, turn, aPad.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const padFragment = /* glsl */ `
${pondGLSL}
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vPolar;
varying vec2 vLocal;
varying vec4 vPad;

void main() {
  float r = vPolar.x;
  float around = vPolar.y;
  float tone = vPad.x;
  float seed = vPad.y;
  vec3 centre;
  vec3 edge;
  if (tone < 0.5) { centre = vec3(0.3, 0.58, 0.07); edge = vec3(0.08, 0.36, 0.03); }
  else if (tone < 1.5) { centre = vec3(0.13, 0.4, 0.06); edge = vec3(0.03, 0.2, 0.035); }
  else { centre = vec3(0.22, 0.42, 0.05); edge = vec3(0.2, 0.06, 0.05); }
  vec3 col = mix(centre, edge, smoothstep(tone > 1.5 ? 0.78 : 0.15, 1.0, r));
  col *= 0.88 + 0.24 * fract(seed * 31.0);
  // Veins radiating from the centre, lighter, fading out before the rim.
  float va = around * 23.0 + 0.15 * sin(r * 9.0 + seed * 20.0);
  float vd = abs(fract(va) - 0.5) * 2.0;
  float vein = smoothstep(1.0 - (0.08 + fwidth(va) * 1.5), 1.0, vd) * smoothstep(0.06, 0.3, r) * (1.0 - smoothstep(0.7, 0.95, r));
  col = mix(col, col * 1.25 + vec3(0.02, 0.03, 0.0), vein * 0.3);
  // A pale, slightly translucent rim.
  col = mix(col, edge * 1.6 + vec3(0.06, 0.08, 0.0), smoothstep(0.9, 0.985, r) * 0.6);

  // One water bead sitting on the pad.
  vec2 bead = vec2(cos(seed * 40.0), sin(seed * 40.0)) * (0.35 + 0.3 * fract(seed * 13.0));
  float beadR = 0.09 + 0.05 * fract(seed * 7.0);
  vec2 bd = (vLocal - bead) / beadR;
  float inBead = 1.0 - smoothstep(0.85, 1.0, length(bd));
  // Its highlight faces the sun (turn the bead's frame into the world's).
  float ct = cos(vPad.z);
  float st = sin(vPad.z);
  vec2 bw = vec2(ct * bd.x - st * bd.y, st * bd.x + ct * bd.y);

  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vWorld);
  float ndl = max(dot(n, uSun), 0.0);
  col *= vec3(0.36, 0.48, 0.55) + SUN_COLOR * ndl * 1.25;
  // Waxy gloss: the sun's highlight, a soft sky sheen and a glassy bloom of light on one side.
  vec3 h = normalize(uSun + v);
  float nh = max(dot(n, h), 0.0);
  col += SUN_COLOR * (pow(nh, 60.0) * 0.12 + pow(nh, 900.0) * 0.9);
  col += vec3(0.55, 0.75, 0.95) * pow(1.0 - max(dot(n, v), 0.0), 4.0) * 0.3;
  vec2 wl = vec2(ct * vLocal.x - st * vLocal.y, st * vLocal.x + ct * vLocal.y);
  float sheen = 1.0 - smoothstep(0.0, 0.75, length(wl - vec2(-0.25, -0.3)));
  col += vec3(0.32, 0.42, 0.25) * sheen * sheen * 0.35;
  // The bead: darker through the water, a bright glint towards the sun and a caustic crescent.
  vec3 beadCol = col * 0.75 + vec3(0.02, 0.04, 0.03);
  beadCol += SUN_COLOR * 3.0 * (1.0 - smoothstep(0.0, 0.32, length(bw - vec2(0.3, -0.35))));
  beadCol += vec3(0.5, 0.7, 0.3) * smoothstep(0.45, 0.85, length(bw + vec2(0.2, -0.25))) * (1.0 - smoothstep(0.85, 1.0, length(bd))) * 0.5;
  col = mix(col, beadCol, inBead);

  // Soft edges: over the last few pixels of the rim and along the slit.
  float px = length(fwidth(vWorld.xz));
  float rimDist = (1.0 - r) * vPad.w;
  float slitDist = min(around, 1.0 - around) * (6.2832 - ${(2 * NOTCH).toFixed(4)}) * r * vPad.w;
  float alpha = smoothstep(0.0, px * 1.5, min(rimDist, slitDist));
  gl_FragColor = vec4(col, alpha);
}
`;

const lotusVertex = /* glsl */ `
${pondGLSL}
attribute vec4 aFlower;
attribute float aSeed;
attribute vec4 aPetal;
varying vec3 vWorld;
varying vec3 vN;
varying vec4 vPetal;

void main() {
  float turn = aFlower.w + sin(uTime * 0.06 + aSeed * 5.0) * 0.15;
  float c = cos(turn);
  float s = sin(turn);
  vec3 p = position * aFlower.z;
  // Petals breathe open and closed a little.
  p.xz *= 1.0 + 0.04 * sin(uTime * 0.5 + aSeed * 3.0) * aPetal.x;
  vec2 xz = vec2(c * p.x - s * p.z, s * p.x + c * p.z) + aFlower.xy;
  vec3 sw = swell(aFlower.xy);
  // Tilt with the swell and bob.
  float y = p.y + sw.z * 0.8 + 0.02 + sin(uTime * 0.8 + aSeed * 11.0) * 0.008 - dot(sw.xy, xz - aFlower.xy) * 0.6;
  vWorld = vec3(xz.x, y, xz.y);
  vec2 nxz = vec2(c * normal.x - s * normal.z, s * normal.x + c * normal.z);
  vN = normalize(vec3(nxz.x, normal.y, nxz.y));
  vPetal = aPetal;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const lotusFragment = /* glsl */ `
${pondGLSL}
uniform float uBud;
varying vec3 vWorld;
varying vec3 vN;
varying vec4 vPetal;

void main() {
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vN);
  float facing = dot(n, v);
  if (facing < 0.0) n = -n;
  float u = vPetal.x;
  float across = abs(vPetal.y);
  float ring = vPetal.z;
  // Petal and pod outlines fade over a pixel or so, as do cupped petals where they fold out of
  // sight; the bud is closed, so only its silhouette fades.
  float rim = vPetal.w > 0.5 ? u : across;
  float alpha = 1.0 - smoothstep(1.0 - fwidth(rim) * 1.8 - 0.02, 1.0, rim);
  alpha *= smoothstep(0.0, fwidth(facing) * 1.5 + 0.01, abs(facing));
  if (uBud > 0.5) alpha = facing < 0.0 ? 0.0 : smoothstep(0.0, fwidth(facing) * 1.5 + 0.02, facing);
  // Nothing left to see: don't write depth either, or petals behind get clipped along the
  // triangle's hard edge instead of this soft one.
  if (alpha < 0.04) discard;
  vec3 col;
  if (vPetal.w > 0.5) {
    // The seed pod, ringed by golden stamens.
    col = mix(vec3(0.62, 0.72, 0.12), vec3(1.0, 0.62, 0.06), smoothstep(0.35, 0.75, u));
    col *= 0.8 + 0.2 * sin(u * 30.0);
  } else {
    // Cream at the root, through pink to a deep rose tip and edges.
    vec3 cream = vec3(1.0, 0.86, 0.8);
    vec3 pink = vec3(0.95, 0.36, 0.55);
    vec3 rose = vec3(0.8, 0.08, 0.3);
    float t = smoothstep(0.05, 0.9, u + across * 0.25 * u * (1.0 - uBud)) * mix(1.0, 0.75, ring * (1.0 - uBud)) + uBud * 0.2;
    col = mix(cream, pink, smoothstep(0.0, 0.6, t));
    col = mix(col, rose, smoothstep(0.6, 1.05, t + uBud * 0.25));
    // Fine veins along the petal, and shade deep in the cup (or, on a bud, along its seams).
    if (uBud > 0.5) {
      col *= 0.7 + 0.3 * smoothstep(-1.0, -0.2, vPetal.y);
    } else {
      col *= 0.94 + 0.06 * sin(vPetal.y * 14.0);
      col *= mix(0.55 + 0.25 * ring, 1.0, smoothstep(0.0, 0.55, u));
    }
  }
  float ndl = dot(n, uSun);
  col *= vec3(0.5, 0.48, 0.55) + SUN_COLOR * max(ndl, 0.0) * 1.1;
  // Sunlight glowing through the petals from behind.
  col += vec3(1.0, 0.4, 0.55) * max(-ndl, 0.0) * 0.45 * (1.0 - vPetal.w);
  vec3 h = normalize(uSun + v);
  float nh = max(dot(n, h), 0.0);
  col += SUN_COLOR * (pow(nh, 40.0) * 0.45 + pow(nh, 300.0) * 1.6);
  col += vec3(0.6, 0.7, 0.9) * pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.2;
  gl_FragColor = vec4(col, alpha);
}
`;

/** An instanced copy of a geometry, sharing its attributes. */
function instanced(base: THREE.BufferGeometry, count: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(base.getIndex());
  for (const [name, attribute] of Object.entries(base.attributes)) geometry.setAttribute(name, attribute);
  geometry.instanceCount = count;
  return geometry;
}

export function Lilies({ shared }: { shared: PondUniforms }) {
  const pads = useDisposable(() => {
    const geometry = instanced(padGeometry(), PADS.length);
    geometry.setAttribute('aPad', new THREE.InstancedBufferAttribute(new Float32Array(PADS.flatMap((p) => [p.at[0], p.at[1], p.radius, p.turn])), 4));
    geometry.setAttribute('aTone', new THREE.InstancedBufferAttribute(new Float32Array(PADS.flatMap((p, i) => [p.tone, i * 0.173 + 0.05])), 2));
    const material = shaderMaterial({
      uniforms: { ...shared },
      vertexShader: padVertex,
      fragmentShader: padFragment,
      transparent: true,
    });
    return { geometry, material };
  }, [shared]);

  const lotus = useDisposable(() => {
    const make = (shape: THREE.BufferGeometry, flowers: typeof LOTUS, bud: number) => {
      const geometry = instanced(shape, flowers.length);
      geometry.setAttribute('aFlower', new THREE.InstancedBufferAttribute(new Float32Array(flowers.flatMap((f) => [f.at[0], f.at[1], f.size, f.turn])), 4));
      geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(flowers.map((_, i) => i * 0.37 + 0.11 + bud)), 1));
      const material = shaderMaterial({
        uniforms: { ...shared, uBud: { value: bud } },
        vertexShader: lotusVertex,
        fragmentShader: lotusFragment,
        side: THREE.DoubleSide,
        transparent: true,
      });
      return { geometry, material };
    };
    return { open: make(lotusGeometry(OPEN, true), LOTUS, 0), buds: make(budGeometry(), BUDS, 1) };
  }, [shared]);

  return (
    <>
      <mesh geometry={pads.geometry} material={pads.material} renderOrder={ORDER.pads} frustumCulled={false} />
      <mesh geometry={lotus.open.geometry} material={lotus.open.material} renderOrder={ORDER.flowers} frustumCulled={false} />
      <mesh geometry={lotus.buds.geometry} material={lotus.buds.material} renderOrder={ORDER.flowers} frustumCulled={false} />
    </>
  );
}
