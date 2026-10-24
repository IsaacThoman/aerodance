import { useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { SUN_DIR, atmos } from './palette.ts';

// Ghosts along the line from the sun through the frame's centre: [position along it (0 at the
// sun, 1 at the centre), size (of the frame's height), shape (0 disc, 1 ring, 2 hexagon), rgb, alpha].
const GHOSTS: readonly (readonly number[])[] = [
  [0.36, 0.04, 2, 1.0, 0.78, 0.5, 0.12],
  [0.62, 0.02, 0, 0.55, 1.0, 0.85, 0.18],
  [0.86, 0.08, 1, 1.0, 0.62, 0.82, 0.07],
  [1.24, 0.035, 2, 0.55, 0.88, 1.0, 0.1],
  [1.5, 0.11, 0, 0.75, 0.62, 1.0, 0.04],
  [1.8, 0.05, 2, 0.6, 1.0, 0.7, 0.08],
];

/**
 * The sun's light in the lens and the air, drawn over the scene before the bloom: soft god rays
 * fanning out from it (slowly turning and breathing, strongest up into the sky), a warm
 * anamorphic streak and a starburst on the sun, and a chain of pastel Vista-style ghosts.
 */
export function SunFlare() {
  const rays = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: atmos.uTime,
        uSunCol: atmos.uSunCol,
        uSun: { value: new THREE.Vector2() },
        uAspect: { value: 16 / 9 },
        uHorizon: { value: 0.46 },
        uVis: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uAspect, uHorizon, uVis;
        uniform vec2 uSun;
        uniform vec3 uSunCol;
        varying vec2 vNdc;
        void main() {
          vec2 d = (vNdc - uSun) * vec2(uAspect, 1.0);
          float r = length(d);
          float a = atan(d.y, d.x);
          // Shafts: a few whole-number frequencies around the circle, each drifting on its own.
          float s = sin(a * 7.0 + uTime * 0.031) * 0.5 + sin(a * 12.0 - uTime * 0.043 + 1.3) * 0.35
            + sin(a * 19.0 + uTime * 0.057 + 4.0) * 0.25 + sin(a * 31.0 - uTime * 0.021 + 2.2) * 0.15;
          float shafts = pow(clamp(0.5 + 0.45 * s, 0.0, 1.0), 2.5);
          shafts *= 0.85 + 0.15 * sin(uTime * 0.11 + a * 3.0);
          // Up into the sky they run long; over the deck, only a little way.
          float sky = smoothstep(uHorizon - 0.25, uHorizon + 0.05, vNdc.y);
          float reach = mix(1.0 / 0.32, 1.0 / 0.75, sky);
          float glow = shafts * exp(-r * reach) * 0.5 * mix(0.45, 1.0, sky);
          // A starburst and an anamorphic streak on the sun itself.
          float burst = pow(abs(cos(a * 3.0 + uTime * 0.012)), 60.0) * exp(-r * 7.0) * 0.9;
          burst += pow(abs(cos(a * 2.0 - uTime * 0.009 + 0.4)), 90.0) * exp(-r * 9.0) * 0.6;
          float streak = exp(-abs(d.y) * 70.0) * exp(-abs(d.x) * 1.6) * 0.55;
          vec3 col = uSunCol * (glow + burst + streak) * uVis;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );

  const ghosts = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    const shape = new Float32Array(GHOSTS.length * 3);
    const color = new Float32Array(GHOSTS.length * 4);
    GHOSTS.forEach(([t, size, kind, r, gg, b, alpha], i) => {
      shape.set([t, size, kind], i * 3);
      color.set([r, gg, b, alpha], i * 4);
    });
    g.setAttribute('aGhost', new THREE.InstancedBufferAttribute(shape, 3));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 4));
    g.instanceCount = GHOSTS.length;
    return g;
  });
  const ghostMaterial = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSun: rays.uniforms.uSun, uAspect: rays.uniforms.uAspect, uVis: rays.uniforms.uVis },
      vertexShader: /* glsl */ `
        attribute vec3 aGhost;
        attribute vec4 aColor;
        uniform vec2 uSun;
        uniform float uAspect, uVis;
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vKind;
        void main() {
          vec2 center = mix(uSun, vec2(0.0), aGhost.x);
          vec2 q = position.xy * aGhost.y * 2.0;
          q.x /= uAspect;
          vUv = position.xy;
          vColor = aColor * vec4(1.0, 1.0, 1.0, uVis);
          vKind = aGhost.z;
          gl_Position = vec4(center + q, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vKind;
        void main() {
          vec2 p = vUv;
          float r = length(p);
          float a;
          if (vKind < 0.5) {
            a = exp(-r * r * 3.5);
          } else if (vKind < 1.5) {
            a = exp(-pow((r - 0.78) * 8.0, 2.0)) + 0.12 * exp(-r * r * 2.0);
          } else {
            vec2 q = abs(p);
            float h = max(dot(q, vec2(0.5, 0.8660254)), q.x);
            a = (1.0 - smoothstep(0.72, 0.84, h)) * (0.5 + 0.5 * smoothstep(0.2, 0.8, h));
          }
          gl_FragColor = vec4(vColor.rgb * a * vColor.a * 1.6, 1.0);
        }
      `,
    }),
  );

  const sun = useRef(new THREE.Vector3());
  const horizon = useRef(new THREE.Vector3());
  useBackdropFrame((state) => {
    const camera = state.camera;
    sun.current.copy(SUN_DIR).multiplyScalar(1000).add(camera.position).project(camera);
    const u = rays.uniforms;
    u.uSun.value.set(sun.current.x, sun.current.y);
    if (camera instanceof THREE.PerspectiveCamera) u.uAspect.value = camera.aspect;
    // Where the horizon crosses the frame, below the sun.
    horizon.current.set(SUN_DIR.x, 0, SUN_DIR.z).normalize().multiplyScalar(1000).add(camera.position).project(camera);
    u.uHorizon.value = horizon.current.y;
    const edge = Math.max(Math.abs(sun.current.x), Math.abs(sun.current.y));
    u.uVis.value = sun.current.z < 1 ? THREE.MathUtils.clamp((1.2 - edge) / 0.4, 0, 1) : 0;
  });

  return (
    <>
      <mesh material={rays} frustumCulled={false} renderOrder={40}>
        <planeGeometry args={[2, 2]} />
      </mesh>
      <mesh geometry={ghosts} material={ghostMaterial} frustumCulled={false} renderOrder={41} />
    </>
  );
}
