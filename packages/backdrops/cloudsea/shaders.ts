// GLSL shared by the scene's shaders: one sky, one haze and one light, so the cloud deck melts
// into the sky at the horizon and the airships reflect the same sunrise. All of it reads the
// shared `atmos` uniforms (palette.ts); everything outputs linear HDR for the bloom and ACES.

export const atmosGLSL = /* glsl */ `
uniform vec3 uSunDir, uKeyDir, uZenith, uHigh, uMid, uLow, uHorizonWarm, uHorizonCool, uSunCol;
uniform vec3 uSkyFill, uBounce, uCrease, uCloudLit;
uniform float uFogDensity;

// 1 looking along the sun's azimuth, 0 looking away from it.
float sunward(vec3 d) {
  vec2 a = normalize(d.xz + vec2(1e-5, 0.0));
  return dot(a, normalize(uSunDir.xz)) * 0.5 + 0.5;
}

// Peach and gold at the horizon (warmest under the sun), pink, lavender, then pale blue overhead.
vec3 skyGradient(vec3 d) {
  float e = max(d.y, 0.0);
  float w = pow(sunward(d), 4.0);
  vec3 col = mix(uHorizonCool, uHorizonWarm, w);
  col = mix(col, uLow, smoothstep(0.0, 0.045, e) * mix(1.0, 0.55, w));
  col = mix(col, uMid, smoothstep(0.03, 0.11, e));
  col = mix(col, uHigh, smoothstep(0.08, 0.17, e));
  return mix(col, uZenith, smoothstep(0.14, 0.34, e));
}

// The sun's glow, by 1 - cos(angle from the sun): a hot core fading into a wide warm wash.
vec3 sunHalo(vec3 d) {
  float x = max(1.0 - dot(d, uSunDir), 0.0);
  return uSunCol * (exp(-x * 1400.0) * 1.4 + exp(-x * 220.0) * 0.5 + exp(-x * 28.0) * 0.26 + exp(-x * 4.0) * 0.1);
}

// The haze at the horizon in direction d: what the distant deck fades into, matching the sky there.
vec3 hazeColor(vec3 d) {
  vec3 h = normalize(vec3(d.x, 0.0, d.z) + vec3(0.0, 0.0, 1e-5));
  return skyGradient(h) + sunHalo(h);
}

float fogAmount(float dist) { return 1.0 - exp(-dist * uFogDensity); }

// Soft cloud light. n: normal; v: surface to camera; ao: 0 deep in a crease, 1 on a top;
// thin: how thin the cloud is there (edges let the sun through).
vec3 cloudShade(vec3 n, vec3 v, float ao, float thin) {
  // A soft two-tone ramp: lavender where the key light doesn't reach, peach where it does.
  float lit = smoothstep(-0.2, 0.9, dot(n, uKeyDir)) * mix(0.3, 1.0, ao);
  // Warmer and stronger looking towards the sun.
  float toward = sunward(-v);
  vec3 shade = mix(uCrease, uSkyFill, ao) * 0.74;
  vec3 col = mix(shade, uCloudLit * mix(0.75, 1.1, ao) * mix(0.85, 1.2, toward * toward), lit);
  // Pink light bounced up from the deck onto undersides.
  col += uBounce * (0.5 - 0.5 * n.y) * 0.3;
  // Looking towards the sun, edges glow: silver linings and light through the thin parts.
  float back = max(dot(-v, uSunDir), 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  col += uSunCol * rim * (pow(back, 40.0) * 2.6 + 0.05);
  col += uSunCol * thin * pow(back, 24.0) * 1.6;
  return col;
}

// What a glossy surface reflects: the sky above, the lavender deck fading into the haze below.
vec3 envColor(vec3 r) {
  if (r.y >= 0.0) return skyGradient(r) + sunHalo(r);
  return mix(uSkyFill * 0.95, hazeColor(r), exp(r.y * 7.0));
}

// Glossy enamel (the airships, the pods' white hulls): diffuse in the sunrise light, a fresnel
// reflection of the sky and a sharp sun highlight. gloss 0..1.
vec3 glossShade(vec3 albedo, float gloss, vec3 n, vec3 v) {
  float ndl = dot(n, uSunDir);
  float nv = max(dot(n, v), 0.0);
  vec3 sky = mix(uBounce, uSkyFill, n.y * 0.5 + 0.5);
  // Sky light, the sun where it reaches, and a soft warm fill from behind the camera.
  vec3 col = albedo * (sky * 0.85 + uSunCol * max(ndl, 0.0) * 1.3 + vec3(0.5, 0.45, 0.44) * nv);
  float fres = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  vec3 r = reflect(-v, n);
  col = mix(col, envColor(r), clamp(gloss * (0.12 + fres), 0.0, 1.0));
  // The sun's glint, and a broad sheen from high behind the camera: the glossy stripe of Aero.
  vec3 h = normalize(uSunDir + v);
  col += uSunCol * pow(max(dot(n, h), 0.0), 160.0) * 6.0 * gloss;
  vec3 hs = normalize(normalize(vec3(-0.3, 1.0, 0.7)) + v);
  col += vec3(1.0, 0.96, 0.94) * (pow(max(dot(n, hs), 0.0), 70.0) * 1.3 + pow(max(dot(n, hs), 0.0), 12.0) * 0.12) * gloss;
  // A long softbox reflection, the bright stripe that runs along glossy curves.
  float band = smoothstep(0.38, 0.48, r.y) * (1.0 - smoothstep(0.6, 0.72, r.y)) * smoothstep(-0.2, 0.4, r.z);
  col += vec3(1.0, 0.97, 0.95) * band * 0.55 * gloss * gloss;
  // The low sun behind it rims the edges.
  col += uSunCol * pow(1.0 - nv, 4.0) * pow(max(dot(-v, uSunDir), 0.0), 4.0) * 1.4;
  return col;
}
`;
