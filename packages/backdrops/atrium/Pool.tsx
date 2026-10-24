import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { AXIS, POOL_R, WATER_Y } from './layout.ts';
import { AA, COMMON, WORLD_VERTEX, atriumUniforms } from './shading.ts';

// The round reflecting pool at the column's foot. Rather than render the room twice, its
// reflection is traced against the few big shapes that matter: the aquarium column, the ring
// of balconies (or the glass wall), and the dome overhead.

const poolFragment = /* glsl */ `
${COMMON}
${AA}
varying vec3 vWorld;

vec3 tankColor(float y) {
  float h = clamp((y - 1.0) / (TANK_TOP - 2.0), 0.0, 1.0);
  return mix(vec3(0.02, 0.4, 0.7), vec3(0.3, 0.9, 1.0), h) * 1.1;
}

// The balconies seen from the pool: white fascias, hanging green, shaded shop fronts.
vec3 tierColor(float y, float ang) {
  vec3 col = vec3(0.45, 0.55, 0.62);
  for (int i = 0; i < 3; i++) {
    float L = LEVELS[i];
    float fascia = smoothstep(L - 0.95, L - 0.8, y) * smoothstep(L + 0.85, L + 0.7, y);
    float hang = 1.0 + 1.6 * (sin(ang * 23.0 + L) * 0.5 + 0.5);
    float green = smoothstep(L - 0.8 - hang - 0.3, L - 0.8 - hang, y) * step(y, L - 0.8) + smoothstep(L + 0.6, L + 0.8, y) * step(y, L + 1.2);
    col = mix(col, vec3(0.1, 0.3, 0.18), clamp(green, 0.0, 1.0));
    col = mix(col, vec3(0.85, 0.88, 0.92), fascia);
  }
  return col;
}

vec3 reflection(vec3 w, vec3 R) {
  vec2 o = w.xz - AXIS.xz;
  vec2 d = R.xz;
  float a = max(dot(d, d), 1e-5);
  float b = 2.0 * dot(o, d);
  // The column.
  float c = dot(o, o) - TANK_R * TANK_R;
  float disc = b * b - 4.0 * a * c;
  if (disc > 0.0) {
    float t = (-b - sqrt(disc)) / (2.0 * a);
    float y = w.y + R.y * t;
    if (t > 0.0 && y < TANK_TOP) {
      vec2 hit = o + d * t;
      float edge = abs(dot(normalize(hit), normalize(vec2(-d.y, d.x))));
      return mix(tankColor(y), vec3(0.8, 1.0, 1.0), pow(edge, 6.0) * 0.6);
    }
  }
  // The ring of balconies round the void, from inside.
  c = dot(o, o) - VOID_R * VOID_R;
  disc = max(b * b - 4.0 * a * c, 0.0);
  float t = (-b + sqrt(disc)) / (2.0 * a);
  float y = w.y + R.y * t;
  vec2 hit = o + d * t;
  float ang = atan(hit.x, hit.y);
  float glass = smoothstep(GLASS_THETA.x, GLASS_THETA.x + 0.15, ang) * smoothstep(GLASS_THETA.y, GLASS_THETA.y - 0.15, ang);
  vec3 sky = mix(vec3(0.7, 0.88, 1.0), vec3(0.3, 0.62, 1.0), clamp(R.y * 1.4, 0.0, 1.0));
  vec3 ring = mix(tierColor(y, ang), mix(vec3(0.2, 0.45, 0.25), sky, smoothstep(1.5, 3.5, y)), glass);
  // The dome: sky between white ribs.
  float tr = (ROOF_Y + 3.0 - w.y) / max(R.y, 1e-3);
  vec2 q = w.xz + R.xz * tr;
  float rib = 1.0 - smoothstep(0.15, 0.5, domeRibDist(q));
  vec3 dome = mix(sky * 1.15, vec3(0.92, 0.95, 1.0), rib * 0.85);
  return mix(ring, dome, smoothstep(ROOF_Y - 1.5, ROOF_Y + 0.5, y));
}

void main() {
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  vec2 rel = w.xz - AXIS.xz;
  float r = length(rel);
  // Rings spreading from the column's foot and a slow breeze, faded out where they'd shimmer.
  float px = length(fwidth(w.xz));
  float detail = 1.0 - smoothstep(0.05, 0.22, px);
  vec2 g = normalize(rel) * cos(r * 3.6 - uTime * 1.5) * 0.05 * exp(-(r - TANK_R) * 0.3);
  g += vec2(0.8, 0.6) * cos(dot(w.xz, vec2(0.8, 0.6)) * 2.2 + uTime * 0.9) * 0.035;
  g += vec2(-0.5, 0.86) * cos(dot(w.xz, vec2(-0.5, 0.86)) * 3.1 - uTime * 0.7) * 0.03;
  g *= detail;
  g += vec2(snoise(vec3(w.xz * 0.7, uTime * 0.2)), snoise(vec3(w.xz * 0.7 + 7.0, uTime * 0.2))) * 0.05;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 R = reflect(-v, n);
  vec3 refl = reflection(w, R);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  // The pool floor: aqua tiles under rippling caustics, in sun and shadow.
  vec2 cp = w.xz * 1.1;
  float ca = snoise(vec3(cp, uTime * 0.4)) + 0.5 * snoise(vec3(cp * 2.0 + 3.0, uTime * 0.55));
  float caustic = pow(max(1.0 - abs(ca), 0.0), 4.0);
  float sun = sunLight(vec3(w.x, 0.0, w.z));
  // A dark pool floor makes a better mirror: deep teal, caustics where the sun reaches it.
  vec3 bottom = vec3(0.01, 0.16, 0.3) * (0.6 + 0.5 * sun) + vec3(0.3, 0.8, 0.95) * caustic * (0.05 + 0.25 * sun);
  vec3 col = mix(bottom, refl * vec3(0.5, 0.72, 0.9), clamp(fres + 0.25, 0.0, 0.75));
  // Glints where ripples catch the sun.
  vec3 s = normalize(uSunDir);
  col += SUN * pow(max(dot(R, s), 0.0), 400.0) * sun * 1.5;
  gl_FragColor = vec4(haze(col, w), 1.0);
}
`;

export function Pool() {
  const geometry = useDisposable(() => new THREE.CircleGeometry(POOL_R + 0.05, 96).rotateX(-Math.PI / 2).translate(AXIS.x, WATER_Y, AXIS.z));
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...atriumUniforms }, vertexShader: WORLD_VERTEX, fragmentShader: poolFragment }));
  return <mesh geometry={geometry} material={material} />;
}
