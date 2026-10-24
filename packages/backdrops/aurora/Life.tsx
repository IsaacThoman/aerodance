import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial, simplex } from '../../stages/shared/glsl.ts';
import { CABIN, palette, ripple, world } from './world.ts';

interface Glow {
  anchor: [number, number, number];
  size: number;
  /** 0 mint green to 1 warm gold. */
  warmth: number;
  phase: number;
  /** Blink rate; 0 holds still and steady (the cabin's halo). */
  blink: number;
}

function layoutGlows(): Glow[] {
  const rand = makeRandom(23);
  const glows: Glow[] = [];
  // Fireflies drifting over the water along the far shore, mostly right of the menu.
  for (let i = 0; i < 34; i++) {
    glows.push({
      anchor: [rand.range(-90, 230), rand.range(2.5, 11), rand.range(-196, -130)],
      size: rand.range(2.8, 4.4),
      warmth: rand.chance(0.25) ? rand.range(0.7, 1) : rand.range(0, 0.25),
      phase: rand.range(0, 100),
      blink: rand.range(0.5, 1.3),
    });
  }
  // A few nearer, bigger and softer.
  for (let i = 0; i < 8; i++) {
    glows.push({
      anchor: [rand.range(-20, 70), rand.range(3, 7), rand.range(-110, -60)],
      size: rand.range(2.2, 3.2),
      warmth: rand.range(0, 0.3),
      phase: rand.range(0, 100),
      blink: rand.range(0.4, 0.9),
    });
  }
  // The cabin's warm halo.
  glows.push({ anchor: [...CABIN.light], size: 30, warmth: 1, phase: 0, blink: 0 });
  return glows;
}

/**
 * Fireflies and the cabin's halo: soft additive sprites, each drawn twice in one instanced draw,
 * once in the air and once mirrored in the lake. They wander on endless Lissajous paths.
 */
export function Fireflies() {
  const geometry = useDisposable(() => {
    const glows = layoutGlows();
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('uv', plane.getAttribute('uv'));
    // Reflections first, so the real ones draw over them.
    const both = [...glows.map((glow) => ({ glow, mirror: 1 })), ...glows.map((glow) => ({ glow, mirror: 0 }))];
    g.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(new Float32Array(both.flatMap(({ glow }) => glow.anchor)), 3));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(both.flatMap(({ glow: o }) => [o.size, o.warmth, o.phase, o.blink])), 4));
    g.setAttribute('aMirror', new THREE.InstancedBufferAttribute(new Float32Array(both.map(({ mirror }) => mirror)), 1));
    g.instanceCount = both.length;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: world.uTime },
      vertexShader: /* glsl */ `
        attribute vec3 aAnchor;
        attribute vec4 aLook;
        attribute float aMirror;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vGlow;
        varying float vWarm;
        varying float vMirror;
        void main() {
          float ph = aLook.z;
          vec3 p = aAnchor;
          if (aLook.w > 0.0) {
            p += vec3(
              sin(uTime * 0.13 + ph) * 7.0 + sin(uTime * 0.071 + ph * 2.0) * 4.0,
              sin(uTime * 0.21 + ph * 1.7) * 1.6,
              sin(uTime * 0.11 + ph * 2.3) * 5.0);
            p.y = max(p.y, 1.2);
            vGlow = 0.15 + 0.85 * pow(0.5 + 0.5 * sin(uTime * aLook.w + ph * 5.0), 2.0);
          } else {
            vGlow = 0.55;
          }
          if (aMirror > 0.5) p.y = -p.y;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          mv.xy += position.xy * aLook.x;
          vUv = uv;
          vWorld = p;
          vWarm = aLook.y;
          vMirror = aMirror;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vGlow;
        varying float vWarm;
        varying float vMirror;
        ${simplex}
        ${palette}
        ${ripple}
        void main() {
          vec2 d = vUv - 0.5;
          float r2 = dot(d, d) * 4.0;
          float light = exp(-r2 * 28.0) * 2.4 + exp(-r2 * 6.0) * 0.45;
          light *= 1.0 - smoothstep(0.7, 1.0, r2);
          vec3 col = mix(vec3(0.35, 1.0, 0.7), WARM * 1.2, vWarm) * light * vGlow;
          if (vMirror > 0.5) {
            vec2 slope = rippleSlope(waterHit(vWorld).xz);
            col *= 0.5 * (1.0 + slope.y * 30.0);
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={40} />;
}
