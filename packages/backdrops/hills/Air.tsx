import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { fx } from './fx.ts';
import { CAMERA } from './terrain.ts';

// The box of air in front of the camera the pollen drifts through, relative to the camera: min and size.
const BOX_MIN = new THREE.Vector3(-60, -4, -90);
const BOX_SIZE = new THREE.Vector3(120, 30, 76);

export interface MotesProps {
  /** Pollen glints drifting on the breeze. */
  pollen?: number;
  /** Big soft out-of-focus bokeh discs near the lens, on the sun's side. */
  bokeh?: number;
  seed?: number;
}

/**
 * Light in the air: pollen and seed fluff drifting downwind and twinkling as it turns in the sun,
 * and a few faint bokeh orbs floating near the lens. Additive, wrapped through a box of air with a
 * fade at its edges, so nothing ever pops.
 */
export function Motes({ pollen = 40, bokeh = 5, seed = 31 }: MotesProps) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const plane = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const count = pollen + bokeh;
    const starts = new Float32Array(count * 3);
    const looks = new Float32Array(count * 4);
    const [cx, cy, cz] = CAMERA.position;
    for (let i = 0; i < count; i++) {
      const isBokeh = i >= pollen;
      if (isBokeh) {
        // Near the lens, up and to the right of the menu, around the sun and the turbines.
        starts.set([cx + rand.range(1, 15), cy + rand.range(2, 9), cz - rand.range(16, 26)], i * 3);
        looks.set([rand.range(0.9, 1.7), 1, rand.next(), rand.range(0.4, 1)], i * 4);
      } else {
        starts.set([rand.next(), rand.next(), rand.next()], i * 3);
        looks.set([rand.range(0.14, 0.22), 0, rand.next(), rand.range(0.5, 1)], i * 4);
      }
    }
    g.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 3));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(looks, 4));
    g.instanceCount = count;
    return g;
  }, [pollen, bokeh, seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: fx.uTime,
        uWindDir: fx.uWindDir,
        uOrigin: { value: new THREE.Vector3(...CAMERA.position) },
        uBoxMin: { value: BOX_MIN },
        uBoxSize: { value: BOX_SIZE },
        uColor: { value: new THREE.Color('#fff6dc') },
        uBokeh: { value: new THREE.Color('#c8f4ff') },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aStart;
        attribute vec4 aLook;
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform vec3 uOrigin, uBoxMin, uBoxSize;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vBokeh;
        varying float vTwinkle;
        void main() {
          float size = aLook.x;
          float ph = aLook.z * 6.2831;
          vec3 c;
          float fade = 1.0;
          if (aLook.y > 0.5) {
            // Bokeh: a slow lazy circle in place.
            c = aStart + vec3(sin(uTime * 0.05 + ph) * 1.2, sin(uTime * 0.07 + ph * 1.3) * 0.6, 0.0);
            vTwinkle = 0.75 + 0.25 * sin(uTime * 0.2 + ph);
          } else {
            // Pollen: carried downwind and wrapped through the box, bobbing as it goes.
            vec3 drift = vec3(uWindDir.x, 0.05, uWindDir.y) * uTime * (1.4 + aLook.w * 1.2);
            vec3 u = fract(aStart + drift / uBoxSize);
            fade = smoothstep(0.0, 0.12, u.x) * smoothstep(1.0, 0.88, u.x) * smoothstep(0.0, 0.12, u.z) * smoothstep(1.0, 0.88, u.z)
              * smoothstep(0.0, 0.15, u.y) * smoothstep(1.0, 0.85, u.y);
            c = uOrigin + uBoxMin + u * uBoxSize + vec3(0.0, sin(uTime * 0.8 + ph) * 0.4, 0.0);
            // Glints as the fluff turns through the sunlight.
            vTwinkle = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (1.5 + aLook.w * 2.0) + ph * 3.0), 6.0);
          }
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 p = c + (camR * position.x + camU * position.y) * size;
          vUv = uv;
          vAlpha = fade * aLook.w;
          vBokeh = aLook.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor, uBokeh;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vBokeh;
        varying float vTwinkle;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          vec3 col;
          if (vBokeh > 0.5) {
            // A soft disc with a brighter rim, like an out-of-focus highlight.
            float disc = smoothstep(1.0, 0.86, r);
            float rim = smoothstep(0.62, 0.9, r) * disc;
            col = uBokeh * (disc * 0.035 + rim * 0.055) * vTwinkle;
          } else {
            float core = exp(-r * r * 9.0);
            col = uColor * (core * 1.6 + exp(-r * r * 2.5) * 0.2) * vTwinkle;
          }
          gl_FragColor = vec4(col * vAlpha, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={40} />;
}
