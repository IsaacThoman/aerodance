import { useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { noise, shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { atmos } from './palette.ts';
import { atmosGLSL } from './shaders.ts';

/**
 * The sunrise dome: the pastel gradient, a big soft sun just above the cloud horizon and a veil
 * of high cirrus, lit gold towards the sun and pink away from it. Below the horizon it's the
 * haze the far deck fades into, so the seam never shows.
 */
export function SunriseSky({ radius = 8000 }: { radius?: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { ...atmos },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vDir;
        ${atmosGLSL}
        ${noise}
        void main() {
          vec3 d = normalize(vDir);
          float e = d.y;
          vec3 col = skyGradient(d);

          // High cirrus: long thin streaks projected on a high ceiling, drifting very slowly.
          if (e > 0.015) {
            vec2 p = d.xz / (e + 0.12);
            p = mat2(0.94, -0.34, 0.34, 0.94) * p;
            p += vec2(uTime * 0.004, uTime * 0.0015);
            float n = fbm(p * vec2(0.45, 1.9) + vec2(4.0, 9.0));
            n += 0.35 * fbm(p * vec2(1.4, 5.0) - vec2(2.0, uTime * 0.002));
            float c = smoothstep(0.12, 0.75, n);
            c *= smoothstep(0.03, 0.12, e) * (1.0 - smoothstep(0.3, 0.7, e));
            float w = sunward(d);
            vec3 lit = mix(vec3(1.0, 0.62, 0.74), vec3(1.25, 0.9, 0.62), pow(w, 3.0));
            col = mix(col, lit, c * 0.32);
          }

          // Three long, thin streaks of altostratus resting just above the horizon, broken up
          // along their length and drifting slowly, gold towards the sun and pink away from it.
          if (e > -0.01 && e < 0.09) {
            float az = atan(d.x, -d.z);
            float streak = 0.0;
            for (int k = 0; k < 3; k++) {
              float fk = float(k);
              float center = 0.014 + fk * 0.017 + 0.005 * snoise(vec2(az * 2.2, fk * 5.0));
              float thick = 0.004 + 0.0015 * fk;
              float along = smoothstep(-0.1, 0.6, snoise(vec2(az * 3.2 + uTime * 0.0025 * (1.0 + fk), fk * 9.0)));
              streak += exp(-pow((e - center) / thick, 2.0)) * along * (1.0 - 0.25 * fk);
            }
            float w = sunward(d);
            vec3 lit = mix(vec3(0.98, 0.66, 0.74), vec3(1.35, 0.95, 0.66), pow(w, 4.0));
            col = mix(col, lit, clamp(streak, 0.0, 1.0) * 0.5);
          }

          // The sun: a round disc, white-gold at the centre and warmer at the limb.
          vec3 right = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
          vec3 up = cross(right, uSunDir);
          vec2 q = vec2(dot(d, right), dot(d, up));
          float r = length(q) / 0.03;
          float disc = (1.0 - smoothstep(0.9, 1.0, r)) * step(0.0, dot(d, uSunDir));
          vec3 discCol = mix(vec3(1.0, 0.98, 0.9), vec3(1.0, 0.8, 0.55), smoothstep(0.3, 1.0, r));
          col += sunHalo(d);
          col = mix(col, discCol * 7.0, disc);

          // Below the horizon: the haze the far deck melts into.
          col = mix(col, hazeColor(d), 1.0 - smoothstep(-0.012, 0.0, e));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );

  useBackdropFrame((state) => mesh.current?.position.copy(state.camera.position));

  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[radius, 64, 32]} />
    </mesh>
  );
}
