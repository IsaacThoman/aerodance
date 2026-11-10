import * as THREE from 'three';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { riser } from './layout.ts';
import type { SharedUniforms } from './shaders.ts';

/** A depth band of motes: how many, how far, how big (radius over frame height), how bright. */
interface BokehLayer {
  count: number;
  distance: readonly [number, number];
  size: readonly [number, number];
  bright: readonly [number, number];
  /** Edge softness, as a fraction of the radius. */
  soft: number;
  /** How much brighter the rim of the disc is than its middle (an out-of-focus lens's ring). */
  ring: number;
  seconds: readonly [number, number];
}

const LAYERS: readonly BokehLayer[] = [
  // Tiny sparkles of light far off.
  { count: 70, distance: [20, 45], size: [0.0035, 0.0075], bright: [0.45, 1.3], soft: 0.6, ring: 0, seconds: [70, 120] },
  // Defocused motes in the middle distance.
  { count: 26, distance: [9, 16], size: [0.009, 0.02], bright: [0.2, 0.45], soft: 0.16, ring: 0.7, seconds: [55, 90] },
  // Big soft discs drifting just in front of the lens.
  { count: 10, distance: [3, 5.5], size: [0.04, 0.09], bright: [0.04, 0.1], soft: 0.3, ring: 0.45, seconds: [60, 90] },
];

// Mostly white and aqua, now and then a fresh lime.
const COLORS = ['#e8ffff', '#7aeeff', '#3fd8ff', '#b4ecff', '#b4ff7a'].map((c) => new THREE.Color(c));
const COLOR_ODDS = [0.3, 0.27, 0.2, 0.13, 0.1];

function pickColor(roll: number): THREE.Color {
  let sum = 0;
  for (let i = 0; i < COLORS.length; i++) {
    sum += COLOR_ODDS[i];
    if (roll < sum) return COLORS[i];
  }
  return COLORS[0];
}

/**
 * Bokeh at three depths in one additive instanced draw: round discs of light that rise and
 * drift slowly and breathe in brightness, crisp sparkles far off and big soft discs up close.
 */
export function Bokeh({ shared }: { shared: SharedUniforms }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(1717);
    const total = LAYERS.reduce((n, l) => n + l.count, 0);
    const body = new Float32Array(total * 4);
    const rise = new Float32Array(total * 4);
    const look = new Float32Array(total * 4);
    const shape = new Float32Array(total * 2);
    let i = 0;
    for (const layer of LAYERS) {
      for (let k = 0; k < layer.count; k++, i++) {
        const r = riser({
          fx: rand.range(-0.03, 1.03),
          distance: rand.range(...layer.distance),
          size: rand.range(...layer.size),
          seconds: rand.range(...layer.seconds),
          start: rand.next(),
          pad: 1.2,
        });
        const color = pickColor(rand.next());
        const bright = rand.range(...layer.bright);
        body.set([r.x, r.z, r.r, rand.next()], i * 4);
        rise.set([r.y0, r.yMin, r.yRange, r.speed], i * 4);
        look.set([color.r * bright, color.g * bright, color.b * bright, r.r * rand.range(0.4, 1.2)], i * 4);
        shape.set([layer.soft, layer.ring], i * 2);
      }
    }
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    g.setAttribute('aBody', new THREE.InstancedBufferAttribute(body, 4));
    g.setAttribute('aRise', new THREE.InstancedBufferAttribute(rise, 4));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 4));
    g.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 2));
    g.instanceCount = total;
    return g;
  });

  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { uTime: shared.uTime },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute vec4 aBody;
        attribute vec4 aRise;
        attribute vec4 aLook;
        attribute vec2 aShape;
        varying vec2 vP;
        varying vec3 vColor;
        varying vec2 vShape;
        void main() {
          float seed = aBody.w;
          float y = aRise.y + mod(aRise.x + uTime * aRise.w, aRise.z);
          float x = aBody.x + sin(uTime * (0.12 + seed * 0.1) + seed * 31.0) * aLook.w;
          vec4 mv = modelViewMatrix * vec4(x, y, aBody.y, 1.0);
          vP = position.xy * 2.0;
          mv.xy += vP * aBody.z;
          float breathe = 0.65 + 0.35 * sin(uTime * (0.35 + seed * 0.5) + seed * 40.0);
          vColor = aLook.rgb * breathe;
          vShape = aShape;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vP;
        varying vec3 vColor;
        varying vec2 vShape;
        void main() {
          float d = length(vP);
          float soft = max(fwidth(d) * 1.5, vShape.x);
          float disc = 1.0 - smoothstep(1.0 - soft, 1.0, d);
          if (disc <= 0.0) discard;
          float ring = mix(1.0, mix(0.55, 1.15, smoothstep(0.35, 0.92, d)), vShape.y);
          // A glowing core for the far, point-like ones.
          float core = mix(1.0, exp(-d * d * 3.0) * 1.6, step(0.5, vShape.x));
          gl_FragColor = vec4(vColor * disc * ring * core, 1.0);
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={20} />;
}
