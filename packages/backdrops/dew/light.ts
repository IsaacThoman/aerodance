// Shared light and clock for the dewdrops backdrop. Every material references these uniform
// objects, so one update a frame (DewBackdrop) moves the leaves, drops, bokeh and rain together.
import * as THREE from 'three';

// Where the light comes from, as world directions towards it. The sun sits high behind the
// leaves at the upper right, so they glow where it shines through them; a soft sky light from
// the same side but in front gives their waxy tops and the drops their gloss.
const SUN = new THREE.Vector3(0.55, 0.62, -0.56).normalize();
const KEY = new THREE.Vector3(0.42, 0.78, 0.46).normalize();

export const dew = {
  uTime: { value: 0 },
  uSunDir: { value: SUN },
  uKeyDir: { value: KEY },
  // Radiance of the sun shining through a leaf, and of the sky light on its waxy top.
  uSunColor: { value: new THREE.Color('#fff1b8').multiplyScalar(1.6) },
  uKeyColor: { value: new THREE.Color('#f4fff0').multiplyScalar(1.0) },
  // What a glossy surface reflects: low (the shaded foliage) to high (the bright canopy gap).
  uEnvLow: { value: new THREE.Color('#123f1c') },
  uEnvHigh: { value: new THREE.Color('#e9ffd8').multiplyScalar(1.15) },
  // The far, blurred foliage everything melts into with distance.
  uHaze: { value: new THREE.Color('#5f9a3c') },
};

export type DewUniforms = typeof dew;

// Light and reflection helpers shared by the leaf and drop shaders (needs the `dew` uniforms).
export const lightGLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir, uKeyDir, uSunColor, uKeyColor, uEnvLow, uEnvHigh, uHaze;
// What a glossy surface mirrors in direction r: dark foliage below, the bright canopy above
// and a warm patch towards the sun.
vec3 envColor(vec3 r) {
  vec3 c = mix(uEnvLow, uEnvHigh, smoothstep(-0.25, 0.85, r.y));
  c += uSunColor * 0.35 * pow(max(dot(r, uSunDir), 0.0), 6.0);
  return c;
}
`;
