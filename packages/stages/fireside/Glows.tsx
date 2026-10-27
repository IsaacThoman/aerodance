// The room's little lights: warm fairy lights swagged along the gable's frame and the collar
// ties, candle flames, and the halo round the globe lamp. All of them are camera-facing glows
// in one instanced draw (their wires in one more), twinkling in the shader.
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { noiseTexture, polar } from '../polar/world.ts';
import { CANDLES, COLLAR, FLOOR, GABLE, HALF, LAMP, RAFTERS, RIDGE, roofX } from './layout.ts';
import { roomPalette } from './room.ts';

const BULB_STEP = 0.42;

/**
 * A strand of fairy lights hung from `anchors`, sagging between them: the wire's points (fine)
 * and the bulbs' (every BULB_STEP along it).
 */
function strand(anchors: readonly THREE.Vector3[], sag: number): { wire: THREE.Vector3[]; bulbs: THREE.Vector3[] } {
  const wire: THREE.Vector3[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const steps = Math.max(4, Math.ceil(a.distanceTo(b) / 0.1));
    for (let s = i ? 1 : 0; s <= steps; s++) {
      const t = s / steps;
      wire.push(a.clone().lerp(b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t)));
    }
  }
  const bulbs: THREE.Vector3[] = [];
  let carry = BULB_STEP / 2;
  for (let i = 0; i < wire.length - 1; i++) {
    const length = wire[i].distanceTo(wire[i + 1]);
    while (carry <= length) {
      bulbs.push(wire[i].clone().lerp(wire[i + 1], carry / length));
      carry += BULB_STEP;
    }
    carry -= length;
  }
  return { wire, bulbs };
}

/** Anchors every `step` or so from a to b. */
function anchorsAlong(a: THREE.Vector3, b: THREE.Vector3, step: number): THREE.Vector3[] {
  const n = Math.max(1, Math.round(a.distanceTo(b) / step));
  return Array.from({ length: n + 1 }, (_, i) => a.clone().lerp(b, i / n));
}

function strands() {
  // Along the front of the gable's rafters and transom, and across the next collar tie back.
  const front = GABLE + 0.66;
  const slope = new THREE.Vector2(HALF, RIDGE).normalize();
  const onRafter = (side: number, y: number) => new THREE.Vector3(side * (roofX(y) - slope.y * 0.55), FLOOR + y - slope.x * 0.55, front);
  const collarY = FLOOR + COLLAR - 0.08;
  const collarX = roofX(COLLAR) - 0.9;
  const second = RAFTERS[1] + 0.22;
  return [
    strand(anchorsAlong(onRafter(-1, 0.8), onRafter(-1, RIDGE - 1.4), 2.3), 0.16),
    strand(anchorsAlong(onRafter(1, 0.8), onRafter(1, RIDGE - 1.4), 2.3), 0.16),
    strand(anchorsAlong(new THREE.Vector3(-collarX, collarY, front), new THREE.Vector3(collarX, collarY, front), 1.9), 0.2),
    strand(anchorsAlong(new THREE.Vector3(-collarX + 0.3, collarY, second), new THREE.Vector3(collarX - 0.3, collarY, second), 2.4), 0.32),
  ];
}

// Kinds of glow, in aSpot.w.
const BULB = 0;
const FLAME = 1;
const HALO = 2;

/** The bulbs, candle flames and halos, and the strands' wires. */
export function Glows() {
  const { glows, wires } = useDisposable(() => {
    const list = strands();
    const spots: number[] = [];
    const looks: number[] = [];
    list.forEach(({ bulbs }, s) =>
      bulbs.forEach((p, i) => {
        spots.push(p.x, p.y, p.z, BULB);
        looks.push(0.42, (i * 0.618 + s * 0.31) % 1, 0, 0);
      }),
    );
    CANDLES.forEach(([x, y, z, size], i) => {
      spots.push(x, y, z, HALO);
      looks.push(1.3 * size, i * 0.37, 0, 0);
      spots.push(x, y - 0.06, z, FLAME);
      looks.push(size, i * 0.37, 0, 0);
    });
    spots.push(LAMP.x, FLOOR + LAMP.height, LAMP.z, HALO);
    looks.push(2.6, 0, 1, 0);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('uv', plane.getAttribute('uv'));
    g.setAttribute('aSpot', new THREE.InstancedBufferAttribute(new Float32Array(spots), 4));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(looks), 4));
    g.instanceCount = spots.length / 4;
    const segments: number[] = [];
    for (const { wire } of list) for (let i = 0; i < wire.length - 1; i++) segments.push(...wire[i].toArray(), ...wire[i + 1].toArray());
    const w = new THREE.BufferGeometry();
    w.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
    return { glows: g, wires: w };
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise },
      vertexShader: /* glsl */ `
        attribute vec4 aSpot;
        attribute vec4 aLook;
        uniform float uTime;
        varying vec2 vUv;
        varying float vKind;
        varying float vGlow;
        varying float vSeed;
        void main() {
          vUv = uv;
          vKind = aSpot.w;
          vSeed = aLook.y;
          vec4 mv = viewMatrix * vec4(aSpot.xyz, 1.0);
          vec2 size = vec2(aLook.x);
          if (aSpot.w == ${FLAME.toFixed(1)}) {
            size = vec2(0.13, 0.26) * aLook.x * (1.0 + 0.08 * sin(uTime * 11.0 + vSeed * 40.0) * vec2(0.4, 1.0));
            mv.xy += vec2(0.0, size.y * 0.35);
          }
          mv.xy += position.xy * size;
          // Bulbs twinkle slowly out of step with each other, candles flicker, the lamp (aLook.z) holds steady.
          vGlow = aSpot.w == ${BULB.toFixed(1)} ? 0.7 + 0.3 * sin(uTime * (0.6 + vSeed) + vSeed * 31.0)
            : aLook.z > 0.5 ? 1.0 : 0.85 + 0.1 * sin(uTime * 9.0 + vSeed * 40.0) + 0.05 * sin(uTime * 17.0 + vSeed * 13.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vKind;
        varying float vGlow;
        varying float vSeed;
        ${noiseTexture}
        ${roomPalette}
        void main() {
          vec2 d = vUv - 0.5;
          float r2 = dot(d, d) * 4.0;
          vec3 col;
          if (vKind == ${BULB.toFixed(1)}) {
            col = BULB * (exp(-r2 * 70.0) * 4.0 + exp(-r2 * 9.0) * 0.18) * vGlow;
          } else if (vKind == ${FLAME.toFixed(1)}) {
            // A small teardrop: a white-gold core, orange at its edge, licking in the draught.
            float y = vUv.y;
            float x = (vUv.x - 0.5 + noise4(vec2(y * 1.5 - uTime * 2.0, vSeed * 9.0)).r * 0.08 * y) * 2.0;
            float width = pow(max(1.0 - y, 0.0), 0.7) * smoothstep(0.0, 0.3, y) + 0.001;
            float body = 1.0 - smoothstep(0.55, 1.0, abs(x) / width);
            col = mix(vec3(2.4, 0.9, 0.25), vec3(4.2, 3.0, 1.6), 1.0 - smoothstep(0.0, 0.6, abs(x) / width)) * body * vGlow;
          } else {
            col = BULB * (exp(-r2 * 5.0) * 0.16 + exp(-r2 * 22.0) * 0.12) * (1.0 - smoothstep(0.7, 1.0, r2)) * vGlow;
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  const wire = useDisposable(() => new THREE.LineBasicMaterial({ color: '#24170e', transparent: true, opacity: 0.55 }));
  return (
    <>
      <lineSegments geometry={wires} material={wire} renderOrder={-460} />
      <mesh geometry={glows} material={material} frustumCulled={false} renderOrder={-450} />
    </>
  );
}
