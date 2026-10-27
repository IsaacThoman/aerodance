// The sky over the lake: the polar kit's night sky (world.ts nightSky) made to go all the way
// round for the preview's full circle. The kit's sky is drawn for a view north, and its airglow,
// veil and painted far curtains jump where the azimuth wraps behind the camera; here they vary
// in whole cycles round the horizon and the star grid fits it evenly, so there's no seam.
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { nightSky, noiseTexture, palette, polar } from '../polar/world.ts';

/**
 * vec3 lakeSky(vec3 dir, float pixel): needs `hash`, `noiseTexture`, `palette` and the kit's
 * `nightSky` first (for its star, meteor and band helpers), and a `uTime` uniform.
 */
export const lakeSky = /* glsl */ `
// Clockwise from north (-z); 0 rather than NaN straight up.
float azimuth(vec3 d) {
  return atan(d.x, -d.z + step(abs(d.x) + abs(d.z), 0.0));
}

vec3 lakeGradient(float az, float h) {
  vec3 col = mix(SKY_HORIZON, SKY_MID, smoothstep(0.0, 0.24, h));
  col = mix(col, SKY_ZENITH, smoothstep(0.2, 0.8, h));
  // Airglow low over the peaks, strongest north under the brightest curtains.
  float band = exp(-max(h, 0.0) * 8.0) * (0.55 + 0.45 * sin(az * 2.0 - 0.2 + uTime * 0.015));
  col += AIRGLOW * band * (0.7 + 0.3 * cos(az));
  col += VEIL * smoothstep(0.12, 0.5, h) * (0.6 + 0.4 * sin(az * 2.0 - 0.5));
  return col;
}

// Two rayed bands of far curtains rising and falling round the whole sky.
vec3 lakeFarAurora(float az, float h) {
  float edgeA = 0.25 - 0.06 * cos(az) + 0.05 * cos(2.0 * az + 1.0) + 0.025 * sin(az * 5.0 + uTime * 0.07) + 0.012 * sin(az * 13.0 - uTime * 0.2);
  float edgeB = 0.44 + 0.07 * sin(az + 0.8) + 0.02 * sin(az * 6.0 - uTime * 0.06 + 1.7) + 0.01 * sin(az * 15.0 + uTime * 0.17);
  if (h < min(edgeA, edgeB)) return vec3(0.0);
  // Eleven noise tiles round the circle (the texture repeats every 32 units), so the rays wrap.
  vec4 n = noise4(vec2(az * 56.0225 + uTime * 0.08, uTime * 0.07 + az * 5.093));
  float vA = (h - edgeA) * 2.2;
  float vB = (h - edgeB) * 2.6;
  float a = farBand(vA, clamp(0.5 + 0.6 * (n.x * 0.65 + n.y * 0.5), 0.0, 1.0), 0.5 + 0.15 * sin(az * 3.0));
  float b = farBand(vB, clamp(0.5 + 0.6 * (n.z * 0.65 + n.w * 0.5), 0.0, 1.0), 0.6);
  float swell = 0.6 + 0.4 * sin(az * 2.0 - uTime * 0.12);
  vec3 col = mix(TEAL, VIOLET, smoothstep(0.06, 0.5, vA)) * a * 0.42 * swell;
  col += mix(TEAL, VIOLET, smoothstep(0.0, 0.4, vB)) * b * 0.22 * (0.65 + 0.35 * sin(az * 3.0 + uTime * 0.1));
  return col;
}

vec3 lakeSky(vec3 d, float pixel) {
  float az = azimuth(d);
  float el = asin(clamp(d.y, -1.0, 1.0));
  vec2 q = vec2(az, el);
  vec3 col = lakeGradient(az, d.y) + lakeFarAurora(az, d.y);
  // 314 and 114 cells round the horizon: whole numbers, so the grids close up behind the camera.
  vec3 stars = starLayer(q, el, 6.2831853 / 314.0, 0.16, pixel, 0.5, 3.0) + starLayer(q, el, 6.2831853 / 114.0, 0.3, pixel * 1.25, 1.5, 11.0);
  col += (stars + shootingStar(q, pixel)) * smoothstep(0.0, 0.14, el);
  return col;
}
`;

/** The sky dome (lakeSky), following the camera and drawn behind everything, down to just below the horizon. */
export function LakeSky() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise },
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
        ${hash}
        ${noiseTexture}
        ${palette}
        ${nightSky}
        ${lakeSky}
        void main() {
          vec3 d = normalize(vDir);
          float pixel = max(length(dFdx(d)), length(dFdy(d)));
          gl_FragColor = vec4(lakeSky(vec3(d.x, max(d.y, 0.0), d.z), pixel), 1.0);
        }
      `,
    }),
  );
  useFrame((state) => mesh.current?.position.copy(state.camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[100, 48, 14, 0, Math.PI * 2, 0, Math.PI * 0.56]} />
    </mesh>
  );
}
