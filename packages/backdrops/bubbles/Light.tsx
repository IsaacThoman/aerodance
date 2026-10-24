import { useRef } from 'react';
import * as THREE from 'three';
import { noise, shaderMaterial } from '../../stages/shared/glsl.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { CAMERA, TAN_X, TAN_Y_TALL } from './layout.ts';
import { aquaGLSL } from './shaders.ts';
import type { SharedUniforms } from './shaders.ts';

interface LightProps {
  shared: SharedUniforms;
}

// Joltz0r's tileable water caustic, softened (a lower power) so its web stays smooth at 640×480.
const causticGLSL = /* glsl */ `
float caustic(vec2 p, float time) {
  const float TAU = 6.28318530718;
  vec2 q = mod(p * TAU, TAU) - 250.0;
  vec2 i = q;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = q + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(q.x / (sin(i.x + t) / inten), q.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 5.0);
}
`;

/**
 * The aqua space itself, on a sphere that follows the camera: the luminous gradient, a slow
 * airy mottling, and far overhead the bright rippling underside of the water, its caustic web
 * drifting and fading into the haze towards the middle of the frame.
 */
export function Background({ shared }: LightProps) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...shared },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vDir;
        ${aquaGLSL}
        ${noise}
        ${causticGLSL}
        void main() {
          vec3 d = normalize(vDir);
          vec2 s = d.xy / max(-d.z, 0.1);
          vec3 col = aqua(s);
          // Soft lighter and darker drifts, like light scattering in deep clear water.
          col *= 1.0 + snoise(vec3(s * vec2(1.3, 2.1), uTime * 0.02)) * 0.06;
          // The surface overhead, its perspective flattened so the web stays round rather than
          // smearing into streaks towards the horizon.
          if (s.y > 0.04) {
            float t = 1.0 / (s.y + 0.3);
            vec2 p = vec2(s.x * t, t);
            float c = caustic(p * 1.5 + vec2(uTime * 0.01, -uTime * 0.005), uTime * 0.16);
            c += 0.6 * caustic(p * 1.05 + vec2(0.37, 0.11), uTime * 0.12 + 7.0);
            float fade = smoothstep(0.1, 0.55, s.y);
            col += vec3(0.55, 1.0, 1.0) * c * fade * 0.45;
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  useBackdropFrame((state) => mesh.current?.position.copy(state.camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[400, 48, 24]} />
    </mesh>
  );
}

// The rays' plane: in front of the far bubbles, behind the near ones.
const RAYS_DISTANCE = 24;

/**
 * Soft god rays fanning down from the light overhead: one additive plane across the frame,
 * its shafts drawn from noise around the light so they drift, part and merge slowly.
 */
export function GodRays({ shared, intensity = 0.24 }: LightProps & { intensity?: number }) {
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...shared, uIntensity: { value: intensity }, uDistance: { value: RAYS_DISTANCE } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() {
          vP = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uIntensity, uDistance;
        uniform vec3 uGlow;
        uniform vec2 uLight;
        varying vec2 vP;
        ${noise}
        void main() {
          vec2 d = vP - uLight * uDistance;
          float r = length(d);
          float a = atan(d.x, -d.y);
          // Broad shafts and narrower ones drifting at their own paces, over a faint haze of light,
          // so there are always a few.
          float n1 = snoise(vec2(a * 4.2, uTime * 0.025));
          float n2 = snoise(vec2(a * 9.0 + 11.0, uTime * 0.035 + 3.0));
          float n3 = snoise(vec2(a * 18.0 - 3.0, uTime * 0.05 + 5.0));
          float shafts = 0.15 + smoothstep(0.0, 0.9, n1) * 0.6 + smoothstep(0.1, 0.9, n2) * 0.5;
          shafts *= 0.6 + 0.4 * smoothstep(-0.5, 0.8, n3);
          float fall = smoothstep(3.0, 10.0, r) * exp(-max(r - 9.0, 0.0) * 0.09);
          float fan = smoothstep(0.85, 0.1, abs(a + 0.08));
          gl_FragColor = vec4(uGlow * shafts * fall * fan * uIntensity, 1.0);
        }
      `,
    }),
  );
  material.uniforms.uIntensity.value = intensity;
  const w = TAN_X * RAYS_DISTANCE * 2.4;
  const h = TAN_Y_TALL * RAYS_DISTANCE * 2.4;
  return (
    <mesh material={material} position={[0, 0, CAMERA.position[2] - RAYS_DISTANCE]} renderOrder={10} frustumCulled={false}>
      <planeGeometry args={[w, h]} />
    </mesh>
  );
}
