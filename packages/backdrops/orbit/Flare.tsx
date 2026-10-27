import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { sunVisibility, world } from './layout.ts';

// [along, size, shape, r, g, b, a]. `along` runs from the sun (0) through the middle of the frame
// (1) to its mirror image (2); shapes: 0 soft glow, 1 ring, 2 hexagon, 3 starburst and streak.
type Element = readonly [along: number, size: number, shape: number, r: number, g: number, b: number, a: number];
const ELEMENTS: readonly Element[] = [
  [0, 0.45, 0, 1.0, 0.82, 0.6, 0.07],
  [0, 0.12, 0, 1.0, 0.93, 0.8, 0.4],
  [0, 0.75, 3, 0.75, 0.9, 1.0, 0.6],
  [0.3, 0.035, 0, 1.0, 0.75, 0.4, 0.16],
  [0.46, 0.07, 2, 0.35, 0.95, 1.0, 0.08],
  [0.58, 0.025, 0, 0.6, 1.0, 0.7, 0.14],
  [0.72, 0.11, 1, 0.55, 0.6, 1.0, 0.05],
];

const sun = new THREE.Vector3();
const center = new THREE.Vector3();

/**
 * The sunrise's lens flare, drawn over everything in screen space: a warm glow, a slowly turning
 * starburst with a long anamorphic streak, and a few tinted ghosts and rings across the frame.
 * It brightens and dims as the sun rises clear of the limb and sinks back.
 */
export function SunFlare() {
  const size = useThree((s) => s.size);
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const shape = new Float32Array(ELEMENTS.length * 3);
    const color = new Float32Array(ELEMENTS.length * 4);
    ELEMENTS.forEach(([along, scale, kind, r, gg, b, a], i) => {
      shape.set([along, scale, kind], i * 3);
      color.set([r, gg, b, a], i * 4);
    });
    g.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 3));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 4));
    g.instanceCount = ELEMENTS.length;
    return g;
  });

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSun: { value: new THREE.Vector2() }, uDown: { value: new THREE.Vector2(0, -1) }, uVis: { value: 0 }, uAspect: { value: 16 / 9 }, uTime: world.uTime },
      vertexShader: /* glsl */ `
        attribute vec3 aShape;
        attribute vec4 aColor;
        uniform vec2 uSun;
        uniform float uAspect, uVis;
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vKind;
        void main() {
          vec2 center = mix(uSun, -uSun, aShape.x * 0.5);
          vec2 q = position.xy * aShape.y;
          if (aShape.z > 2.5) q.x *= 3.0;
          q.x /= uAspect;
          vUv = uv;
          vColor = aColor * vec4(1.0, 1.0, 1.0, uVis);
          vKind = aShape.z;
          gl_Position = vec4(center + q, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec2 uDown;
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vKind;
        float hexagon(vec2 p) {
          p = abs(p);
          return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x);
        }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float a = 0.0;
          if (vKind < 0.5) {
            a = exp(-dot(p, p) * 4.0) * (1.0 - smoothstep(0.8, 1.0, length(p)));
          } else if (vKind < 1.5) {
            float r = length(p);
            a = exp(-pow((r - 0.78) * 10.0, 2.0)) + 0.12 * exp(-r * r * 3.0);
          } else if (vKind < 2.5) {
            float h = hexagon(p);
            a = (1.0 - smoothstep(0.7, 0.8, h)) * (0.5 + 0.5 * smoothstep(0.2, 0.78, h));
          } else {
            // Stretched 3:1, so undo that for the round parts.
            vec2 s = vec2(p.x * 3.0, p.y);
            float r = length(s);
            float ang = atan(s.y, s.x);
            float rays = pow(abs(cos(ang * 4.0 + uTime * 0.03)), 60.0) + 0.6 * pow(abs(cos(ang * 6.0 - uTime * 0.02 + 0.4)), 90.0);
            // A crown fanning up into space: the rays reaching down over the planet are cut short.
            rays *= exp(-r * mix(3.2, 9.0, smoothstep(-0.2, 0.7, dot(s / max(r, 1e-4), uDown)))) * 0.8;
            float streak = exp(-abs(p.y) * 80.0) * exp(-abs(p.x) * 4.0);
            a = (rays + streak * 0.7 + exp(-r * r * 12.0) * 0.3) * (1.0 - smoothstep(0.9, 1.0, max(abs(p.x), abs(p.y))));
          }
          gl_FragColor = vec4(vColor.rgb * a * vColor.a, 1.0);
        }
      `,
    }),
  );
  material.uniforms.uAspect.value = size.width / Math.max(1, size.height);

  useBackdropFrame((state, _delta, time) => {
    const camera = state.camera;
    sun.copy(world.uSunDir.value).multiplyScalar(1000).add(camera.position).project(camera);
    material.uniforms.uSun.value.set(sun.x, sun.y);
    // Which way the planet lies from the sun on screen.
    center.copy(world.uCenter.value).project(camera);
    material.uniforms.uDown.value.set((center.x - sun.x) * material.uniforms.uAspect.value, center.y - sun.y).normalize();
    // Breathes a little on top of the sun's slow rise and set.
    material.uniforms.uVis.value = sun.z < 1 ? sunVisibility(camera.position, world.uSunDir.value) * (0.92 + 0.08 * Math.sin(time * 0.5)) : 0;
  });

  return <mesh geometry={geometry} material={material} renderOrder={1000} frustumCulled={false} />;
}
