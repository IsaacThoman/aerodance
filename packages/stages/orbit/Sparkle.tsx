import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { makeRandom } from '../shared/random.ts';
import { DECK_Y, world } from './layout.ts';
import { glintGLSL, life, pointSizeGLSL, useStretch } from './glints.ts';

// The glitter of the scene: space dust catching the sun round the deck, out-of-focus lens orbs,
// and under the dome, seed-puffs drifting among the plants.

/** Is a point in the calm space round the dancers, between them and the camera, or behind them? */
const nearDancers = (x: number, y: number, z: number) => Math.abs(x) < 5.5 && y < DECK_Y + 6 && z > -12;

interface DustProps {
  dome: boolean;
  count?: number;
}

/**
 * Specks of space dust drifting round the deck, each now and then catching the sun in a tiny
 * four-point glint, brightest looking towards the sun. None in the calm space round the dancers
 * or between them and the camera (nor inside the dome); fainter while the dancers dance.
 */
export function Dust({ dome, count = 170 }: DustProps) {
  const stretch = useStretch();
  const geometry = useDisposable(() => {
    const rand = makeRandom(23);
    const position = new Float32Array(count * 3);
    const data = new Float32Array(count * 3);
    for (let i = 0; i < count; ) {
      const a = rand.range(0, Math.PI * 2);
      const r = 5 + Math.pow(rand.next(), 0.8) * 20;
      const x = Math.sin(a) * r, y = DECK_Y + rand.range(-5, 12), z = Math.cos(a) * r;
      if (nearDancers(x, y, z) || (dome && r < 9.5 && y < DECK_Y + 9)) continue;
      position.set([x, y, z], i * 3);
      data.set([rand.range(0, 100), rand.range(0.5, 1.4), rand.range(0.6, 1.4)], i * 3);
      i++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aData', new THREE.BufferAttribute(data, 3));
    return g;
  }, [dome, count]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: world.uTime, uBeat: world.uBeat, uSunDir: world.uSunDir, uNight: world.uNight, uCalm: life.uCalm, uStretch: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aData;
        uniform float uTime, uBeat, uNight, uCalm;
        uniform vec3 uSunDir;
        varying vec3 vColor;
        ${pointSizeGLSL}
        void main() {
          float ph = aData.x;
          vec3 p = position + 0.4 * vec3(sin(uTime * 0.13 + ph), sin(uTime * 0.11 + ph * 1.3), cos(uTime * 0.09 + ph * 0.7));
          vec3 view = p - cameraPosition;
          float dist = length(view);
          // Twinkling as it tumbles, and lit most looking towards the sun (forward scattering).
          float twinkle = pow(max(sin(uTime * aData.y * 1.7 + ph), 0.0), 10.0);
          float sunward = pow(max(dot(view / dist, uSunDir), 0.0), 3.0);
          float gain = (0.12 + twinkle * (0.7 + 0.3 * uBeat)) * (0.5 + 1.2 * sunward) * (1.0 - 0.55 * uCalm);
          // Out of the way of a camera passing through.
          gain *= smoothstep(2.0, 5.0, dist);
          vec3 tint = mix(vec3(1.0, 0.9, 0.75), vec3(0.75, 0.88, 1.0), uNight);
          vColor = tint * gain * (1.0 - 0.4 * uNight);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(pointSize(0.09 * aData.z * (1.0 + twinkle), -mv.z), 2.5, 9.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStretch;
        varying vec3 vColor;
        ${glintGLSL}
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          p.x *= uStretch;
          gl_FragColor = vec4(vColor * glint(p), 1.0);
        }
      `,
    }),
  );
  material.uniforms.uStretch.value = stretch;

  return <points geometry={geometry} material={material} renderOrder={1} frustumCulled={false} />;
}

// Where the orbs float, [x, y] in the frame from the top left: round its top and sides, well
// clear of the dancers in the middle.
const ORBS: readonly (readonly [number, number])[] = [
  [0.06, 0.13], [0.17, 0.32], [0.27, 0.07], [0.04, 0.58], [0.76, 0.06], [0.88, 0.24], [0.96, 0.5],
];

/**
 * A few out-of-focus lens orbs drifting slowly over the frame, rims a little brighter than their
 * middles like real bokeh, in aqua, white and violet: the dreamy glass of the Aero look. They're
 * in the lens, so they keep to the frame as the camera swings round: faint, and only really
 * there the nearer the sun is to them on screen.
 */
export function Bokeh({ seed = 5 }: { seed?: number }) {
  const size = useThree((s) => s.size);
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const plane = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const orb = new Float32Array(ORBS.length * 4);
    const color = new Float32Array(ORBS.length * 3);
    const tints = [new THREE.Color('#7fe6ff'), new THREE.Color('#d8f4ff'), new THREE.Color('#a9b4ff'), new THREE.Color('#9dffe0')];
    ORBS.forEach(([x, y], i) => {
      orb.set([x * 2 - 1, 1 - y * 2, rand.range(0.04, 0.1), rand.range(0, Math.PI * 2)], i * 4);
      const tint = rand.pick(tints);
      color.set([tint.r, tint.g, tint.b], i * 3);
    });
    g.setAttribute('aOrb', new THREE.InstancedBufferAttribute(orb, 4));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    g.instanceCount = ORBS.length;
    return g;
  }, [seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: world.uTime, uSunDir: world.uSunDir, uNight: world.uNight, uCalm: life.uCalm, uAspect: { value: 16 / 9 } },
      vertexShader: /* glsl */ `
        attribute vec4 aOrb;
        attribute vec3 aColor;
        uniform float uTime, uAspect, uNight, uCalm;
        uniform vec3 uSunDir;
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          // Each drifts round its own slow loop and breathes.
          float t = uTime * 0.05 + aOrb.w;
          vec2 center = aOrb.xy + vec2(sin(t * 0.9), cos(t * 0.7)) * vec2(0.035, 0.05);
          // Where the sun is on screen, if ahead.
          vec4 sun = projectionMatrix * viewMatrix * vec4(uSunDir, 0.0);
          vec2 sunward = (center - sun.xy / max(sun.w, 1e-3)) * vec2(uAspect, 1.0);
          float glow = 0.15 + 0.85 * exp(-dot(sunward, sunward) * 0.8) * step(0.0, sun.w);
          vColor = aColor * glow * (0.75 + 0.25 * sin(t * 2.3)) * (1.0 - 0.35 * uNight) * (1.0 - 0.4 * uCalm);
          vUv = uv;
          vec2 q = position.xy * aOrb.z;
          q.x /= uAspect;
          gl_Position = vec4(center + q, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          float r = length(vUv * 2.0 - 1.0);
          float disc = 1.0 - smoothstep(0.82, 1.0, r);
          float a = disc * (0.3 + 0.7 * smoothstep(0.45, 0.92, r));
          gl_FragColor = vec4(vColor * a * 0.07, 1.0);
        }
      `,
    }),
  );
  material.uniforms.uAspect.value = size.width / Math.max(1, size.height);

  return <mesh geometry={geometry} material={material} renderOrder={999} frustumCulled={false} />;
}

/** Inside the dome, how far out from its middle the puffs drift, and the dome's reach overhead. */
const DOME_REACH = { min: 3.6, max: 6.2, radius: 7.4 };

/**
 * Under the dome: dandelion seed-puffs drifting slowly among the plants, soft white fluff round a
 * glowing seed that swells a little on the beat. They keep out at the sides, clear of the dancers
 * and of the camera's view of them.
 */
export function SeedPuffs({ count = 11 }: { count?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(41);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; ) {
      const a = rand.range(0, Math.PI * 2);
      const r = rand.range(DOME_REACH.min, DOME_REACH.max);
      // Alternately left and right.
      const x = Math.abs(Math.sin(a) * r) * (i % 2 ? 1 : -1), z = Math.cos(a) * r;
      // Below the dome's curve overhead, with room to drift.
      const top = Math.sqrt(DOME_REACH.radius ** 2 - r * r) - 0.8;
      const y = DECK_Y + rand.range(0.8, Math.min(top, 5));
      // Out at the sides, clear of the dancers and of the camera's view of them.
      if (Math.abs(x) < 4.2 || (z > 0 && Math.abs(x) < 4.8)) continue;
      data.set([x, y, z, rand.range(0, 100)], i * 4);
      i++;
    }
    g.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 4));
    g.instanceCount = count;
    return g;
  }, [count]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: { uTime: world.uTime, uBeat: world.uBeat },
      vertexShader: /* glsl */ `
        attribute vec4 aData;
        uniform float uTime;
        varying vec2 vUv;
        varying float vSpin, vSeed;
        void main() {
          float ph = aData.w;
          vec3 c = aData.xyz + vec3(sin(uTime * 0.11 + ph) * 0.5, sin(uTime * 0.17 + ph * 1.7) * 0.4, cos(uTime * 0.09 + ph) * 0.5);
          vSpin = uTime * 0.25 + ph;
          vSeed = ph;
          vUv = uv;
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += position.xy * 0.36;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uBeat;
        varying vec2 vUv;
        varying float vSpin, vSeed;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          if (r > 1.0) discard;
          float ang = atan(p.y, p.x) + vSpin;
          // A soft ball of fluff round the glowing seed, its rim a little denser and tufted.
          // Mostly light, so it brightens whatever it drifts in front of.
          float rim = exp(-pow((r - 0.6) * 3.2, 2.0)) * 0.3 * (0.8 + 0.2 * cos(ang * 7.0 + vSeed));
          float fuzz = exp(-r * r * 3.0) * 0.22;
          float seed = exp(-r * r * 50.0) * (0.9 + 0.6 * uBeat);
          float light = rim + fuzz + seed;
          gl_FragColor = vec4(vec3(1.0, 0.98, 0.92) * light, clamp(light * 0.2, 0.0, 1.0));
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} renderOrder={1} frustumCulled={false} />;
}
