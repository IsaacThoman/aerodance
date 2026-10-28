import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { SNOW_BOX } from './layout.ts';
import type { SharedUniforms } from './shaders.ts';

const ADDITIVE = { transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending } as const;

/**
 * Marine snow (dim motes sinking slowly, soft discs close to the camera) and plankton (tiny
 * bioluminescent sparkles that twinkle, most in the deep), wrapped round a box in front of the
 * camera and faded at its faces so none pops in.
 */
export function Motes({ shared, snow = 520, plankton = 320 }: { shared: SharedUniforms; snow?: number; plankton?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(91);
    const count = snow + plankton;
    const p = new Float32Array(count * 3);
    const a = new Float32Array(count * 4);
    const [cx, cy, cz] = SNOW_BOX.center;
    const [sx, sy, sz] = SNOW_BOX.size;
    for (let i = 0; i < count; i++) {
      const sparkle = i >= snow;
      p.set([cx + rand.range(-0.5, 0.5) * sx, cy + rand.range(-0.5, 0.5) * sy, cz + rand.range(-0.5, 0.5) * sz], i * 3);
      a.set([rand.next(), sparkle ? rand.range(0.035, 0.06) : rand.range(0.025, 0.06), sparkle ? 1 : 0, rand.range(0.6, 1.4)], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aP', new THREE.BufferAttribute(a, 4));
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      ...ADDITIVE,
      uniforms: {
        uTime: shared.uTime,
        uHalfRes: shared.uHalfRes,
        uBoxCenter: { value: new THREE.Vector3(...SNOW_BOX.center) },
        uBoxSize: { value: new THREE.Vector3(...SNOW_BOX.size) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec2 uHalfRes;
        uniform vec3 uBoxCenter;
        uniform vec3 uBoxSize;
        attribute vec4 aP;
        varying vec3 vCol;
        varying float vA;
        varying float vSoft;
        void main() {
          float s = aP.x * 6.2831853;
          float t = uTime;
          vec3 p = position + vec3(
            sin(t * 0.11 + s) * 0.8 + t * 0.05,
            (aP.z > 0.5 ? 0.02 : -0.06) * aP.w * t + sin(t * 0.17 + s * 2.0) * 0.4,
            cos(t * 0.09 + s) * 0.8
          );
          vec3 rel = mod(p - uBoxCenter + uBoxSize * 0.5, uBoxSize);
          vec3 edge = min(rel, uBoxSize - rel) / (uBoxSize * 0.1);
          float fade = clamp(min(min(edge.x, edge.y), edge.z), 0.0, 1.0);
          p = uBoxCenter - uBoxSize * 0.5 + rel;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float dist = max(-mv.z, 0.1);
          // Close to the camera, out of focus: bigger, softer and dimmer.
          float blur = smoothstep(7.0, 2.0, dist);
          float px = aP.y * projectionMatrix[1][1] * uHalfRes.y / dist * (1.0 + blur * 2.5);
          float size = clamp(px, aP.z > 0.5 ? 3.0 : 2.0, 22.0);
          // Points under two pixels are dimmed instead, so they don't flicker as they move.
          float energy = min(1.0, (px * px) / (size * size));
          vSoft = blur;
          float depth = exp(-max(dist - 10.0, 0.0) * 0.045);
          if (aP.z < 0.5) {
            vCol = vec3(0.75, 0.92, 1.0);
            vA = 0.7 * mix(1.0, 0.35, blur);
          } else {
            // Bioluminescent sparkles twinkle, and gather in the deep.
            float h = fract(aP.x * 13.0);
            vCol = h < 0.5 ? vec3(0.35, 1.0, 0.95) : h < 0.8 ? vec3(0.5, 0.75, 1.0) : vec3(1.0, 0.55, 0.9);
            float tw = pow(max(0.5 + 0.5 * sin(t * (0.7 + aP.w) + aP.x * 40.0), 0.0), 4.0);
            vA = (0.3 + 2.6 * tw) * mix(0.4, 1.0, smoothstep(6.0, -4.0, p.y));
          }
          vA *= fade * depth * energy;
          gl_PointSize = size;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vA;
        varying float vSoft;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float spot = exp(-d * d * 4.0);
          float disc = smoothstep(1.0, 0.7, d) * (0.6 + 0.4 * smoothstep(0.3, 0.9, d));
          float k = mix(spot, disc, vSoft) * smoothstep(1.0, 0.9, d);
          gl_FragColor = vec4(vCol * k * vA, 1.0);
        }
      `,
    }),
  );
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={4} />;
}

/**
 * Big soft bokeh discs drifting up just in front of the camera, out of focus: the Aero lens
 * look. Kept off the title and buttons, wrapping round below the frame.
 */
export function Bokeh({ shared, count = 12 }: { shared: SharedUniforms; count?: number }) {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    g.setAttribute('uv', plane.attributes.uv);
    const rand = makeRandom(5150);
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // In lanes clear of the title, the buttons and the dancers: the far edges and the gap
      // between the buttons and the dancers.
      const lane = rand.pick([-5.4, 0.4, 5.8]);
      const x = lane + rand.range(-0.5, 0.5);
      a.set([x, rand.range(-6.5, 10.5), rand.range(4, 8.5), rand.next()], i * 4);
      b.set([rand.range(0.2, 0.55), rand.chance(0.2) ? rand.range(0.3, 0.75) : rand.range(-0.05, 0.08), rand.range(0.08, 0.16), rand.range(0.035, 0.07)], i * 4);
    }
    g.setAttribute('aB', new THREE.InstancedBufferAttribute(a, 4));
    g.setAttribute('aB2', new THREE.InstancedBufferAttribute(b, 4));
    g.instanceCount = count;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      ...ADDITIVE,
      uniforms: { uTime: shared.uTime },
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute vec4 aB;
        attribute vec4 aB2;
        varying vec2 vP;
        varying vec3 vCol;
        varying float vA;
        varying float vBubble;
        vec3 pal(float h) {
          h = fract(h);
          return h < 0.33 ? mix(vec3(0.55, 0.95, 1.0), vec3(1.0, 0.6, 0.9), h * 3.0)
            : h < 0.66 ? mix(vec3(1.0, 0.6, 0.9), vec3(0.75, 0.6, 1.0), (h - 0.33) * 3.0)
            : mix(vec3(0.75, 0.6, 1.0), vec3(0.55, 0.95, 1.0), (h - 0.66) * 3.0);
        }
        void main() {
          float lo = -6.5, span = 17.0;
          float s = aB.w * 6.2831853;
          float y = lo + mod(aB.y - lo + uTime * aB2.z, span);
          vec3 c = vec3(aB.x + sin(uTime * 0.07 + s) * 0.4, y, aB.z + cos(uTime * 0.05 + s) * 0.3);
          vec4 mv = viewMatrix * vec4(c, 1.0);
          vP = uv * 2.0 - 1.0;
          mv.xy += vP * aB2.x;
          vCol = pal(aB2.y);
          vBubble = step(0.55, aB.w);
          vA = aB2.w * smoothstep(lo, lo + 1.5, y) * smoothstep(lo + span, lo + span - 1.5, y) * (0.8 + 0.2 * sin(uTime * 0.4 + s));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vP;
        varying vec3 vCol;
        varying float vA;
        varying float vBubble;
        void main() {
          float d = length(vP);
          float disc = smoothstep(1.0, 0.86, d);
          float rim = smoothstep(0.55, 0.95, d) * disc;
          // Some are out-of-focus bubbles: clearer inside, with a soft glint up and left.
          vec2 g = vP - vec2(-0.38, 0.42);
          float glint = exp(-dot(g, g * vec2(1.0, 2.2)) * 18.0) * vBubble;
          float fill = mix(0.55, 0.2, vBubble);
          gl_FragColor = vec4(vCol * (disc * fill + rim * 0.65 + glint * 1.6) * vA, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={5} />;
}
