import * as THREE from 'three';

/**
 * Uniforms every material shares by reference, so one write a frame moves them all. Colours
 * are linear (THREE.Color converts the hex); the light is where the glow and the rays come from,
 * in the camera's tangent plane (x right, y up, per unit of distance; the 16:9 frame spans
 * ±0.74 × ±0.41, 4:3 ±0.74 × ±0.55).
 */
export function makeShared() {
  return {
    uTime: { value: 0 },
    uTop: { value: new THREE.Color('#86eeff') },
    uHigh: { value: new THREE.Color('#3fd0f2') },
    uMid: { value: new THREE.Color('#1aa2dc') },
    uLow: { value: new THREE.Color('#0b62b4') },
    uDeep: { value: new THREE.Color('#063c86') },
    uGlow: { value: new THREE.Color('#b0f6ff') },
    uLight: { value: new THREE.Vector2(0.14, 0.7) },
  };
}

export type SharedUniforms = ReturnType<typeof makeShared>;

/**
 * The aqua light, by tangent-plane position: a vertical gradient from the deep blue below to
 * the bright water above, and the glow of the light overhead. The background draws it, and the
 * bubbles sample it for what they show through themselves.
 */
export const aquaGLSL = /* glsl */ `
uniform vec3 uTop, uHigh, uMid, uLow, uDeep, uGlow;
uniform vec2 uLight;
vec3 aqua(vec2 s) {
  float y = s.y - s.x * 0.06;
  vec3 c = mix(uDeep, uLow, smoothstep(-0.62, -0.22, y));
  c = mix(c, uMid, smoothstep(-0.3, 0.06, y));
  c = mix(c, uHigh, smoothstep(0.02, 0.36, y));
  c = mix(c, uTop, smoothstep(0.3, 0.62, y));
  vec2 l = (s - uLight) * vec2(0.85, 1.0);
  float d = length(l);
  c += uGlow * (exp(-d * 3.2) * 0.35 + exp(-d * 9.0) * 0.45);
  return c;
}
`;
