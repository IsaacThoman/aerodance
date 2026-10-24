import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { world } from './layout.ts';

// Where the orbs float, [x, y] in the 16:9 frame from the top left: scattered round the sunrise,
// well away from the title and buttons on the left.
const ORBS: readonly (readonly [number, number])[] = [
  [0.56, 0.1], [0.66, 0.28], [0.72, 0.05], [0.9, 0.34], [0.98, 0.16], [0.86, 0.52],
];

/**
 * A few out-of-focus lens orbs drifting slowly over the frame, rims a little brighter than their
 * middles like real bokeh, in aqua, white and violet: the dreamy glass of the Aero look. Faint,
 * and brighter the nearer the sun they float.
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
      uniforms: { uTime: world.uTime, uAspect: { value: 16 / 9 } },
      vertexShader: /* glsl */ `
        attribute vec4 aOrb;
        attribute vec3 aColor;
        uniform float uTime, uAspect;
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          // Each drifts round its own slow loop and breathes.
          float t = uTime * 0.05 + aOrb.w;
          vec2 center = aOrb.xy + vec2(sin(t * 0.9), cos(t * 0.7)) * vec2(0.035, 0.05);
          vec2 sunward = center - vec2(0.58, 0.58);
          float glow = 0.45 + 0.55 * exp(-dot(sunward, sunward) * 1.2);
          vColor = aColor * glow * (0.75 + 0.25 * sin(t * 2.3));
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
          gl_FragColor = vec4(vColor * a * 0.09, 1.0);
        }
      `,
    }),
  );
  material.uniforms.uAspect.value = size.width / Math.max(1, size.height);

  return <mesh geometry={geometry} material={material} renderOrder={999} frustumCulled={false} />;
}
