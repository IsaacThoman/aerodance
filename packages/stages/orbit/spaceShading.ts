import { MOON_DIR, world } from './layout.ts';

// Space lighting for the station's glass and solar wings, worked out on the spot: reflections of
// space, the planet's disc with its bright limb, and the sun; blue light off the planet; and the
// sun catching the edges. Shared by the station's glass and wings and the dome's glass.
export const spaceGLSL = /* glsl */ `
  uniform vec3 uSunDir, uMoonDir, uCenter;
  uniform float uRadius, uNight;

  vec3 environment(vec3 r, vec3 at) {
    vec3 toPlanet = uCenter - at;
    float dist = length(toPlanet);
    toPlanet /= dist;
    float limb = sqrt(max(1.0 - uRadius * uRadius / (dist * dist), 0.0));
    float k = dot(r, toPlanet);
    float onPlanet = smoothstep(limb - 0.03, limb + 0.03, k);
    vec3 space = vec3(0.004, 0.01, 0.03) + vec3(0.05, 0.2, 0.5) * exp(-abs(k - limb) * 14.0) * (1.0 - 0.6 * uNight);
    vec3 planet = mix(vec3(0.06, 0.24, 0.6), vec3(0.4, 0.75, 1.0), exp(-(k - limb) * 6.0)) * (1.0 - 0.8 * uNight);
    vec3 c = mix(space, planet, onPlanet);
    float s = max(dot(r, uSunDir), 0.0) * (1.0 - uNight);
    return c + vec3(1.0, 0.92, 0.8) * (pow(s, 500.0) * 30.0 + pow(s, 24.0) * 0.3);
  }

  // The sunrise behind catching the edges (at night, a cool moonlit rim).
  vec3 sunRim(vec3 n, vec3 v) {
    vec3 tint = mix(vec3(1.6, 1.15, 0.7), vec3(0.5, 0.65, 1.0), uNight);
    return tint * pow(1.0 - max(dot(n, v), 0.0), 3.0) * max(dot(n, mix(uSunDir, uMoonDir, uNight)), 0.0);
  }
`;

/** World position, normal and uv, for plain and instanced meshes. */
export const VERTEX = /* glsl */ `
  varying vec3 vNormal, vWorld;
  varying vec2 vUv;
  void main() {
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = modelMatrix * instanceMatrix;
    #endif
    vec4 w = m * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(m) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/** The uniforms spaceGLSL reads, shared by reference with the stage clock. */
export const spaceUniforms = () => ({
  uSunDir: world.uSunDir,
  uMoonDir: { value: MOON_DIR },
  uCenter: world.uCenter,
  uRadius: world.uRadius,
  uNight: world.uNight,
});
