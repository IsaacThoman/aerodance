import { useMemo } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { makeRandom } from '../shared/random.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { FarPines, Mountains, landLight, scatterPines } from '../polar/Land.tsx';
import { noiseTexture, palette, polar } from '../polar/world.ts';
import { CABIN, LAND, LANTERN_HEIGHT, LANTERNS, at, cabinView, landHeight, shoreRadius } from './layout.ts';

// The shore all round the lake: snowy banks, pine woods and peaks (the polar kit's, mirrored in
// the ice), the glass cabin glowing up the far slope, mist lying along the foot of the woods, and
// the soft halos of the cabin's windows and the lanterns.

/** The land in its four pieces, snowy up its slopes, and their reflections. */
export function Land() {
  return (
    <>
      {LAND.map(({ area, grid, mirrorGrid }, i) => (
        <Mountains key={i} height={landHeight} area={area} grid={grid} mirrorGrid={mirrorGrid} snowLine={30} cut={0} />
      ))}
    </>
  );
}

/** Pines along the shore all round and thinning up the foothills, and their reflections. */
export function ShorePines() {
  const pines = useMemo(() => {
    const scattered = scatterPines({
      count: 1100,
      seed: 5,
      spot: (rand) => {
        const angle = rand.range(-Math.PI, Math.PI);
        const shore = shoreRadius(angle);
        const [x, z] = at(angle, shore + 3 + rand.next() ** 1.8 * 320);
        const h = landHeight(x, z);
        if (h < 1.2 || h > 48) return null;
        if (cabinView(x, z)) return null;
        const slope = Math.abs(landHeight(x + 4, z) - h) + Math.abs(landHeight(x, z - 4) - h);
        return slope > 6 ? null : [x, z];
      },
      height: landHeight,
      size: (x, z) => 13 * (1 + (Math.hypot(x, z) - shoreRadius(Math.atan2(x, -z))) / 600),
    });
    // Far to near seen from the middle of the lake, whichever way the camera looks.
    return scattered.sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z));
  }, []);
  return <FarPines pines={pines} reflected renderOrder={-40} />;
}

function cabinGeometry(): THREE.BufferGeometry {
  // An A-frame: a triangular prism whose front gable is all glass.
  const shape = new THREE.Shape([new THREE.Vector2(-6, 0), new THREE.Vector2(6, 0), new THREE.Vector2(0, 11)]);
  return new THREE.ExtrudeGeometry(shape, { depth: 11, bevelEnabled: false }).translate(0, 0, -11);
}

function cabinMaterial(mirror: boolean) {
  return shaderMaterial({
    side: mirror ? THREE.BackSide : THREE.FrontSide,
    defines: mirror ? { MIRROR: '' } : {},
    uniforms: { uTime: polar.uTime },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vFront;
      varying vec3 vPos;
      varying vec3 vNormal;
      void main() {
        vLocal = position;
        vFront = normal;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vPos = w.xyz;
        #ifdef MIRROR
        w.y = -w.y;
        #endif
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vLocal;
      varying vec3 vFront;
      varying vec3 vPos;
      varying vec3 vNormal;
      ${palette}
      ${landLight}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 col;
        // Its own front, whichever way the cabin is turned.
        if (vFront.z > 0.9) {
          // The glass gable: a warm lit interior behind mullions, with a glossy sheen across it.
          vec2 p = vLocal.xy;
          float inset = min(p.y - 0.5, (6.0 - abs(p.x)) * 0.877 - p.y * 0.48 - 0.9);
          float frame = 1.0 - smoothstep(0.0, 0.2, inset);
          float mull = max(1.0 - smoothstep(0.08, 0.2, abs(fract(p.x / 2.4 + 0.5) - 0.5) * 2.4), 1.0 - smoothstep(0.08, 0.2, abs(p.y - 4.2)));
          vec3 lit = mix(vec3(1.9, 0.95, 0.34), vec3(0.95, 0.4, 0.16), smoothstep(0.0, 9.0, p.y));
          lit *= 0.9 + 0.1 * sin(uTime * 1.3 + p.x * 0.4);
          vec3 edge = mix(vec3(0.02, 0.025, 0.04), vec3(0.3, 0.42, 0.62), smoothstep(-0.4, -0.85, inset) * step(0.6, p.y));
          col = mix(lit, edge, max(frame, mull * 0.85));
          float sheen = smoothstep(0.6, 0.0, abs(p.x * 0.7 + p.y - 6.0)) * 0.35;
          col += vec3(0.7, 0.85, 1.0) * sheen * (1.0 - frame);
        } else {
          // Snow on the roof, lit by the moon; dark timber at the back.
          float key = max(dot(n, KEY), 0.0);
          col = mix(vec3(0.05, 0.1, 0.22), vec3(0.55, 0.7, 0.95), key) * smoothstep(-0.2, 0.4, n.y);
          col += vec3(0.008, 0.01, 0.02);
        }
        col = hazed(col, vPos, 30.0);
        #ifdef MIRROR
        // Still, unlike the kit's rippling reflections: it's ice.
        col = mix(WATER, col, 0.7);
        #endif
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** The glass A-frame (after the Aurora backdrop's) up the far shore, warm windows facing the dancers, and its reflection. */
export function Cabin() {
  const geometry = useDisposable(cabinGeometry);
  const cabin = useDisposable(() => cabinMaterial(false));
  const reflection = useDisposable(() => cabinMaterial(true));
  const [x, y, z] = CABIN.position;
  return (
    <group position={[x, y - 0.3, z]} rotation={[0, CABIN.heading, 0]} scale={1.9}>
      <mesh geometry={geometry} material={cabin} renderOrder={3} frustumCulled={false} />
      <mesh geometry={geometry} material={reflection} renderOrder={4} frustumCulled={false} />
    </group>
  );
}

/** [angle, width, height, seed]: banks of mist lying on the ice along the foot of the woods. */
const BANDS = Array.from({ length: 12 }, (_, i) => {
  const rand = makeRandom(70 + i);
  return [(i / 12) * Math.PI * 2 + rand.range(-0.15, 0.15), rand.range(190, 260), rand.range(16, 30), i + 1] as const;
});

/**
 * Low mist on the ice at the foot of the shore, glowing faintly teal: flat bands round the lake
 * facing its middle, whose lower halves, below the ice, stand in for their own reflection.
 */
export function Mist() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('uv', plane.getAttribute('uv'));
    g.setAttribute(
      'aBand',
      new THREE.InstancedBufferAttribute(new Float32Array(BANDS.flatMap(([angle, w, h]) => [...at(angle, shoreRadius(angle) - 22), w, h])), 4),
    );
    g.setAttribute('aTurn', new THREE.InstancedBufferAttribute(new Float32Array(BANDS.flatMap(([angle, , , seed]) => [Math.cos(angle), Math.sin(angle), seed])), 3));
    g.instanceCount = BANDS.length;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise },
      vertexShader: /* glsl */ `
        attribute vec4 aBand;
        attribute vec3 aTurn;
        varying vec2 vUv;
        varying float vX;
        varying float vSeed;
        void main() {
          vec3 p = vec3(aBand.x, 0.0, aBand.y) + vec3(aTurn.x, 0.0, aTurn.y) * position.x * aBand.z + vec3(0.0, position.y * aBand.w, 0.0);
          vUv = uv;
          vX = position.x * aBand.z;
          vSeed = aTurn.z;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vX;
        varying float vSeed;
        ${noiseTexture}
        void main() {
          float y = vUv.y * 2.0 - 1.0;
          float n = 0.6 * noise4(vec2(vX * 0.005 + uTime * 0.01 + vSeed * 9.0, vSeed * 3.0 + uTime * 0.003)).r
            + 0.4 * noise4(vec2(vX * 0.016 - uTime * 0.018, vSeed * 7.0 + abs(y) * 0.7)).g;
          float density = smoothstep(-0.35, 0.8, n);
          float profile = exp(-abs(y) * 2.6) * (1.0 - smoothstep(0.7, 1.0, abs(y)));
          float ends = smoothstep(0.0, 0.25, vUv.x) * (1.0 - smoothstep(0.75, 1.0, vUv.x));
          float glow = density * profile * ends * (y < 0.0 ? 0.55 : 1.0);
          gl_FragColor = vec4(vec3(0.03, 0.12, 0.13) * glow, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-20} />;
}

interface Glow {
  at: readonly [number, number, number];
  size: number;
  brightness: number;
}

const GLOWS: readonly Glow[] = [
  { at: CABIN.light, size: 34, brightness: 0.7 },
  ...LANTERNS.map(([x, z]): Glow => ({ at: [x, LANTERN_HEIGHT, z], size: 2.4, brightness: 0.9 })),
];

/**
 * Warm halos round the cabin's windows and the lanterns, and their reflections: soft additive
 * sprites in one instanced draw, each drawn twice, once in the air and once below the ice.
 */
export function Halos() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('uv', plane.getAttribute('uv'));
    // Reflections first, dimmer; the third value just sets each one's flicker apart.
    const both = [...GLOWS.map((glow) => ({ glow, mirror: -1 })), ...GLOWS.map((glow) => ({ glow, mirror: 1 }))];
    g.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(new Float32Array(both.flatMap(({ glow, mirror }) => [glow.at[0], glow.at[1] * mirror, glow.at[2]])), 3));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(both.flatMap(({ glow, mirror }) => [glow.size, glow.brightness * (mirror < 0 ? 0.45 : 1), glow.at[0] * 0.37])), 3));
    g.instanceCount = both.length;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: polar.uTime },
      vertexShader: /* glsl */ `
        attribute vec3 aAnchor;
        attribute vec3 aLook;
        uniform float uTime;
        varying vec2 vUv;
        varying float vGlow;
        void main() {
          vec4 mv = viewMatrix * vec4(aAnchor, 1.0);
          mv.xy += position.xy * aLook.x;
          vUv = uv;
          // A candle's slow flicker.
          vGlow = aLook.y * (0.9 + 0.06 * sin(uTime * 2.3 + aLook.z) + 0.04 * sin(uTime * 5.7 + aLook.z * 3.0));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vGlow;
        ${palette}
        void main() {
          vec2 d = vUv - 0.5;
          float r2 = dot(d, d) * 4.0;
          float light = exp(-r2 * 28.0) * 1.6 + exp(-r2 * 6.0) * 0.4;
          light *= 1.0 - smoothstep(0.7, 1.0, r2);
          gl_FragColor = vec4(WARM * light * vGlow, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-15} />;
}
