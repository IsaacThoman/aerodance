import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { atmos, viewPoint } from './palette.ts';

const COUNT = 14;
// How far they rise before fading out and coming round again, and how fast.
const RISE = 9;
const RISE_SPEED = 0.22;

/**
 * Bokeh: a few out-of-focus motes of light hanging close to the lens, gathered towards the sun,
 * rising slowly and twinkling. Each fades out at the top of its climb and back in at the bottom,
 * so the loop never shows.
 */
export function Motes() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    const rand = makeRandom(41);
    const centers = new Float32Array(COUNT * 3);
    const params = new Float32Array(COUNT * 4);
    const tints = [new THREE.Color('#ffe6b8'), new THREE.Color('#bff4ff'), new THREE.Color('#ffd0e4'), new THREE.Color('#dfffd0')];
    const colors = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      // Up in the sky on the sun's side, above the title and the dancers' heads.
      const x = THREE.MathUtils.clamp(0.3 + rand.range(-0.6, 0.65) * rand.range(0.4, 1), -0.3, 0.98);
      const p = viewPoint(x, rand.range(0.28, 0.85), rand.range(32, 70));
      centers.set([p.x, p.y - RISE / 2, p.z], i * 3);
      params.set([rand.range(0.7, 2.2), rand.next(), rand.range(0, 100), rand.range(0.1, 0.26)], i * 4);
      tints[i % tints.length].toArray(colors, i * 3);
    }
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    g.instanceCount = COUNT;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: atmos.uTime, uRise: { value: RISE }, uSpeed: { value: RISE_SPEED } },
      vertexShader: /* glsl */ `
        attribute vec3 aCenter;
        attribute vec4 aParams;
        attribute vec3 aColor;
        uniform float uTime, uRise, uSpeed;
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          // Climb, with a lazy sideways sway; fade in at the bottom and out at the top.
          float k = fract(aParams.y + uTime * uSpeed / uRise);
          vec3 c = aCenter + vec3(sin(uTime * 0.13 + aParams.z) * 1.5, k * uRise, 0.0);
          float fade = smoothstep(0.0, 0.2, k) * smoothstep(1.0, 0.75, k);
          float twinkle = 0.7 + 0.3 * sin(uTime * (0.6 + aParams.y) + aParams.z);
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += position.xy * aParams.x;
          vUv = position.xy;
          vColor = aColor * aParams.w * fade * twinkle;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          // A soft disc with a slightly brighter rim, like an out-of-focus highlight.
          float r = length(vUv);
          float disc = 1.0 - smoothstep(0.82, 1.0, r);
          float a = disc * (0.55 + 0.45 * smoothstep(0.45, 0.92, r));
          gl_FragColor = vec4(vColor * a, 1.0);
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={35} />;
}
