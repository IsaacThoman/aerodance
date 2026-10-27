import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { CABIN, cabinPoint } from './layout.ts';
import { LANTERNS, snowcabin } from './palette.ts';
import { RAKE, rakePoint } from './cabinShape.ts';

// Everything that glows: the lanterns' flames and fairy lights scalloped along the gable's edges
// and the deck's rail. Bright enough to bloom; they breathe gently and lift on the beat.

const WARM = new THREE.Color(1.0, 0.66, 0.32);
const AMBER = new THREE.Color(1.0, 0.45, 0.14);

interface Bulb {
  at: Vec3;
  size: number;
  color: THREE.Color;
  /** HDR brightness. */
  power: number;
}

/** Bulbs every `step` along a wire hung from a to b, sagging `sag` in the middle. */
function strand(a: Vec3, b: Vec3, sag: number, step: number, out: Bulb[], size = 0.07) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.round(length / step));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    out.push({
      at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t],
      size,
      color: out.length % 3 === 1 ? AMBER : WARM,
      power: 5,
    });
  }
}

function bulbs(): Bulb[] {
  const out: Bulb[] = [];
  // Scallops under both front edges of the roof, hooked every 1.3 units.
  for (const side of [-1, 1] as const) {
    for (let a = 0; a + 1.3 <= RAKE + 0.01; a += 1.3) {
      const p = rakePoint(side, a);
      const q = rakePoint(side, a + 1.3);
      strand(cabinPoint(p[0], p[1] - 0.05, p[2] - 0.12), cabinPoint(q[0], q[1] - 0.05, q[2] - 0.12), 0.18, 0.33, out, 0.06);
    }
  }
  // Along the deck's front rail, post to post.
  const rail = CABIN.floor + 1.0;
  const front = CABIN.deck - 0.05;
  for (const [a, b] of [[1.45, 3.4], [3.4, CABIN.halfWidth + 0.3]]) {
    for (const s of [-1, 1]) strand(cabinPoint(s * a, rail, front), cabinPoint(s * b, rail, front), 0.16, 0.3, out, 0.055);
  }
  for (const at of LANTERNS) out.push({ at, size: 0.13, color: WARM, power: 7 });
  return out;
}

function glowGeometry(): THREE.BufferGeometry {
  const shape = new THREE.IcosahedronGeometry(1, 1);
  const list = bulbs();
  const g = new THREE.InstancedBufferGeometry();
  g.index = shape.index;
  g.setAttribute('position', shape.getAttribute('position'));
  g.setAttribute('aBulb', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((b) => [...b.at, b.size])), 4));
  g.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((b, i) => [b.color.r * b.power, b.color.g * b.power, b.color.b * b.power, i * 0.618])), 4));
  g.instanceCount = list.length;
  return g;
}

/** Soft halos round the lanterns: camera-facing glows, added over everything. */
function haloGeometry(): THREE.BufferGeometry {
  const plane = new THREE.PlaneGeometry(2, 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.getAttribute('position'));
  g.setAttribute('uv', plane.getAttribute('uv'));
  const spots: [Vec3, number][] = [...LANTERNS.map((p): [Vec3, number] => [p, 1.3]), [cabinPoint(0, CABIN.floor + 3.4, 0.6), 7.5]];
  g.setAttribute('aSpot', new THREE.InstancedBufferAttribute(new Float32Array(spots.flatMap(([p, s]) => [...p, s])), 4));
  g.instanceCount = spots.length;
  return g;
}

export function Lights() {
  const glow = useDisposable(glowGeometry);
  const halo = useDisposable(haloGeometry);
  const materials = useDisposable(() => ({
    glow: shaderMaterial({
      uniforms: { uTime: snowcabin.uTime, uBeat: snowcabin.uBeat },
      vertexShader: /* glsl */ `
        attribute vec4 aBulb;
        attribute vec4 aColor;
        uniform float uTime, uBeat;
        varying vec3 vColor;
        void main() {
          // Each breathes on its own slow cycle; all of them lift a little on the beat.
          float breath = 0.82 + 0.18 * sin(uTime * (0.9 + fract(aColor.w * 3.7) * 0.8) + aColor.w * 6.2832);
          vColor = aColor.rgb * breath * (1.0 + 0.25 * uBeat);
          gl_Position = projectionMatrix * viewMatrix * vec4(aBulb.xyz + position * aBulb.w, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }
      `,
    }),
    halo: shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uFire: snowcabin.uFire, uBeat: snowcabin.uBeat },
      vertexShader: /* glsl */ `
        attribute vec4 aSpot;
        varying vec2 vUv;
        varying float vBig;
        void main() {
          vUv = position.xy;
          vBig = step(3.0, aSpot.w);
          vec4 mv = viewMatrix * vec4(aSpot.xyz, 1.0);
          mv.xy += position.xy * aSpot.w;
          // Drawn a little towards the camera, so the lanterns' own posts don't cut them.
          mv.z += 0.4;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFire, uBeat;
        varying vec2 vUv;
        varying float vBig;
        void main() {
          float r2 = dot(vUv, vUv);
          float glow = exp(-r2 * 5.0) * 0.35 + exp(-r2 * 18.0) * 0.5;
          glow *= mix(1.0 + 0.2 * uBeat, 0.16 * uFire, vBig) * (1.0 - smoothstep(0.7, 1.0, r2));
          gl_FragColor = vec4(vec3(1.0, 0.6, 0.28) * glow, 1.0);
        }
      `,
    }),
  }));
  return (
    <>
      <mesh geometry={glow} material={materials.glow} frustumCulled={false} />
      {/* Before the glass dancers (which write no depth), so a halo behind one doesn't show through it. */}
      <mesh geometry={halo} material={materials.halo} frustumCulled={false} renderOrder={-20} />
    </>
  );
}
