import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { hash, shaderMaterial } from '../../stages/shared/glsl.ts';
import { CABIN, nightSky, noiseTexture, palette, ripple, world } from './world.ts';

/**
 * The lake: a near-mirror plane at y = 0 that reflects the sky along its rippled reflection ray,
 * with a warm path of light under the cabin. It writes no depth, so the mirrored land, curtains
 * and fireflies drawn after it show through as its reflections.
 */
export function Lake() {
  const material = useDisposable(() =>
    shaderMaterial({
      depthWrite: false,
      uniforms: { uTime: world.uTime, uNoise: world.uNoise, uLight: { value: new THREE.Vector3(...CABIN.light) } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uLight;
        varying vec3 vWorld;
        ${hash}
        ${noiseTexture}
        ${palette}
        ${nightSky}
        ${ripple}
        void main() {
          vec3 toEye = cameraPosition - vWorld;
          vec3 view = normalize(toEye);
          vec2 slope = rippleSlope(vWorld.xz);
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
          vec3 r = reflect(-view, n);
          r.y = abs(r.y);
          float pixel = max(max(length(dFdx(r)), length(dFdy(r))), 0.0018);
          float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
          vec3 col = mix(WATER, nightSky(r, pixel), mix(0.62, 1.0, fresnel));
          // The cabin's windows, stretched into a rippling path of warm light.
          vec3 toLight = normalize(uLight - vWorld);
          vec3 off = r - toLight;
          col += WARM * exp(-off.x * off.x / 0.00003 - off.y * off.y / 0.0012) * 1.6;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  return (
    <mesh material={material} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -1300]} renderOrder={-900} frustumCulled={false}>
      <planeGeometry args={[7000, 3200]} />
    </mesh>
  );
}

/** [x, z, width, height, seed]: bands of mist lying on the water in front of the far shore. */
const BANDS: readonly [number, number, number, number, number][] = [
  [0, -199, 900, 30, 1],
  [-40, -160, 760, 16, 2],
];

/**
 * Low mist over the water at the foot of the shore, glowing faintly teal: flat bands across
 * the view whose lower halves, below the waterline, stand in for their own reflection.
 */
export function Mist() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('uv', plane.getAttribute('uv'));
    g.setAttribute('aBand', new THREE.InstancedBufferAttribute(new Float32Array(BANDS.flatMap(([x, z, w, h]) => [x, z, w, h])), 4));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(BANDS.map((b) => b[4])), 1));
    g.instanceCount = BANDS.length;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: world.uTime, uNoise: world.uNoise },
      vertexShader: /* glsl */ `
        attribute vec4 aBand;
        attribute float aSeed;
        varying vec2 vUv;
        varying float vX;
        varying float vSeed;
        void main() {
          vec3 p = vec3(aBand.x + position.x * aBand.z, position.y * aBand.w, aBand.y);
          vUv = uv;
          vX = p.x;
          vSeed = aSeed;
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
          gl_FragColor = vec4(vec3(0.014, 0.06, 0.065) * glow, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={30} />;
}
