import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { atmos, viewPoint } from './palette.ts';
import { atmosGLSL } from './shaders.ts';

const COUNT = 6;

// The loop they circle, out by the sun so they show as silhouettes against its glow.
const LOOP_CENTER = viewPoint(0.44, 0.64, 210);
const LOOP_RADIUS = 34;
// Radians per second around the loop (about a minute and a half a lap).
const LOOP_SPEED = 0.07;
// Wingspan, world units.
const SPAN = 8;

/**
 * A small flock circling lazily out by the sun: they string out along one big loop (so nothing
 * ever resets) and flap a few beats between long glides. Each is a soft-edged gull silhouette
 * drawn in a camera-facing quad, two tapering wings bent by the beat, which reads at a few pixels
 * where a little 3D bird would break up.
 */
export function Birds() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    const rand = makeRandom(23);
    const params = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      // Lag along the loop, sideways and vertical spread, and a personal rhythm.
      params.set([i * 0.07 + rand.range(0, 0.025), rand.range(-6, 6), rand.range(-4, 4), rand.range(0, 100)], i * 4);
    }
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    g.instanceCount = COUNT;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        ...atmos,
        uCenter: { value: LOOP_CENTER },
        uRadius: { value: LOOP_RADIUS },
        uSpeed: { value: LOOP_SPEED },
        uSpan: { value: SPAN },
        uFlap: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aParams;
        uniform float uTime, uRadius, uSpeed, uSpan, uFlap;
        uniform vec3 uCenter;
        varying vec2 vUv;
        varying float vFlap;
        varying vec3 vWorld;
        void main() {
          // A wide, slightly tilted loop with a gentle rise and fall.
          float a = uTime * uSpeed - aParams.x * 6.2832;
          vec3 p = uCenter + vec3(cos(a) * uRadius, sin(a * 2.0) * uRadius * 0.06 + sin(a) * uRadius * 0.14, sin(a) * uRadius * 0.55);
          p += vec3(aParams.y, aParams.z, aParams.y * 0.5);
          // A few wingbeats, then a glide with the wings held in a shallow V.
          float s = uTime + aParams.w;
          float beat = smoothstep(0.5, 0.8, sin(s * 0.4));
          vFlap = mix(0.8, sin(uFlap + aParams.w * 8.0), beat);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          mv.xy += position.xy * vec2(uSpan, uSpan * 0.6);
          vUv = position.xy * vec2(2.0, 1.2);
          vWorld = p;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vFlap;
        varying vec3 vWorld;
        ${atmosGLSL}
        void main() {
          // Each wing's centreline rises (or droops) from the shoulder and curls at the tip.
          float x = abs(vUv.x);
          float lift = vFlap * 0.55;
          float droop = 0.12 + 0.45 * max(lift, 0.0);
          float y = lift * sqrt(x) - droop * x * x;
          float dy = lift * 0.5 / sqrt(max(x, 0.02)) - 2.0 * droop * x;
          float dist = abs(vUv.y - y) / sqrt(1.0 + dy * dy);
          float thick = mix(0.2, 0.05, pow(x, 0.8));
          float aa = fwidth(dist) * 0.9 + 0.01;
          float wing = (1.0 - smoothstep(thick - aa, thick + aa, dist)) * step(x, 1.0);
          float body = 1.0 - smoothstep(0.14 - aa, 0.14 + aa, length(vUv * vec2(1.5, 1.0) - vec2(0.0, -0.03)));
          float a = max(wing, body);
          if (a < 0.01) discard;
          // Dusky plum, softened by the air.
          vec3 toCam = cameraPosition - vWorld;
          float dist3 = length(toCam);
          vec3 col = mix(vec3(0.09, 0.05, 0.12), hazeColor(-toCam / dist3), fogAmount(dist3) * 0.4);
          gl_FragColor = vec4(col, a);
        }
      `,
    }),
  );

  // The wingbeat's phase, wrapped here so the shader's sine stays precise however long the menu stays up.
  useBackdropFrame((_state, _delta, t) => {
    material.uniforms.uFlap.value = (t * 8) % (Math.PI * 2);
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={30} />;
}
