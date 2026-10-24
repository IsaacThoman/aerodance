import * as THREE from 'three';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { pondGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// The pond's floor and surface: two big planes whose looks come entirely from their shaders.
// Both cover the view with room to spare for the camera's drift and the pointer lean.

const PLANE_SIZE: [number, number] = [44, 32];
const PLANE_CENTRE: [number, number] = [0, -2];

const floorVertex = /* glsl */ `
${pondGLSL}
varying vec3 vWorld;
// Broad fields, smooth enough to interpolate between vertices: how stony the floor is, silt, moss.
varying vec3 vField;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  world.y = -floorDepth(world.xz);
  vec2 p = world.xz;
  // Fewer stones in sandy patches, and towards the dancers and the deep water under the menu.
  float density = 0.82 + 0.4 * snoise(p * 0.11 + 4.2)
    - 0.45 * smoothstep(0.5, 4.0, p.x) * smoothstep(-1.5, 2.0, p.y)
    - 0.35 * (1.0 - smoothstep(-7.0, -2.0, p.x + 0.3 * p.y));
  float silt = smoothstep(-0.5, 0.6, snoise(p * 0.085 + 1.7));
  float moss = smoothstep(0.05, 0.75, snoise(p * 0.16 + 5.0));
  vField = vec3(density, silt, moss);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const floorFragment = /* glsl */ `
${pondGLSL}
varying vec3 vWorld;
varying vec3 vField;

// Smooth river pebbles: one rounded, randomly turned stone per cell of a jittered grid, the
// tallest winning where they overlap, on coarse sand. Returns the albedo; n is the stone's dome
// normal, ao the shading where it meets the sand.
vec3 pebbles(vec2 p, float px, float density, out vec3 n, out float ao) {
  vec2 sp = p * 2.1;
  // A gentle warp so the stones don't line up.
  sp += 0.2 * vec2(sin(sp.y * 0.83 + sin(sp.x * 0.47)), sin(sp.x * 0.77 + 1.3 + sin(sp.y * 0.53)));
  vec2 i = floor(sp);
  vec2 fr = fract(sp);
  float best = -1.0;
  float bestE = 2.0;
  vec2 bestDir = vec2(0.0);
  vec2 cell = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 hc = hash22(i + g);
      vec2 hs = hash22(i + g + 31.7);
      if (hash12(i + g + 5.3) > density) continue;
      vec2 r = fr - (g + 0.15 + 0.7 * hc);
      float a = hs.x * 3.1416;
      vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * r;
      vec2 rad = vec2(0.42 + 0.2 * hs.y, 0.32 + 0.14 * hc.x);
      float e = length(q / rad);
      // Dome height, offset per stone so overlaps stack.
      float h = sqrt(max(1.0 - e * e, 0.0)) * (0.7 + 0.3 * hs.y);
      if (e < 1.0 && h > best) { best = h; bestE = e; bestDir = r / max(length(r), 1e-4); cell = i + g; }
    }
  }
  float aa = px * 2.1 * 1.5;
  float inside = 1.0 - smoothstep(1.0 - 0.08 - aa, 1.0, bestE);
  float slope = bestE / (sqrt(max(1.0 - bestE * bestE, 0.0)) + 0.45) * 0.6;
  n = normalize(vec3(bestDir.x * slope * inside, 1.0, bestDir.y * slope * inside));
  ao = mix(0.65, 1.0, smoothstep(0.0, 0.5, best));
  float h = hash12(cell);
  float h2 = hash12(cell + 17.3);
  vec3 stone;
  if (h < 0.26) stone = vec3(0.6, 0.47, 0.32);
  else if (h < 0.48) stone = vec3(0.46, 0.46, 0.43);
  else if (h < 0.6) stone = vec3(0.2, 0.23, 0.25);
  else if (h < 0.82) stone = vec3(0.72, 0.65, 0.53);
  else if (h < 0.92) stone = vec3(0.36, 0.44, 0.34);
  else stone = vec3(0.62, 0.36, 0.26);
  stone *= 0.8 + 0.35 * h2;
  // Each stone a little lighter on one side.
  stone *= 0.94 + 0.14 * bestE * dot(bestDir, vec2(cos(h * 40.0), sin(h * 40.0)));
  vec3 sand = vec3(0.3, 0.27, 0.2);
  return mix(sand, stone, inside);
}

void main() {
  vec2 p = vWorld.xz;
  float depth = -vWorld.y;
  // Refraction: the floor wobbles with the surface above it.
  vec3 w = surfaceWaves(p);
  vec2 q = p - w.xy * depth * 0.45;
  float px = length(fwidth(q));

  vec3 n;
  float ao;
  vec3 albedo = pebbles(q, px, vField.x, n, ao);
  // Pebbles too small for the buffer settle to their average instead of shimmering.
  float detail = 1.0 - smoothstep(0.05, 0.14, px * 2.1);
  albedo = mix(vec3(0.5, 0.46, 0.38), albedo, detail);
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, detail));
  ao = mix(0.8, ao, detail);
  // Darker silt and soft green moss lying in drifts.
  albedo *= 0.6 + 0.4 * vField.y;
  albedo = mix(albedo, vec3(0.16, 0.3, 0.08), vField.z * 0.65 * smoothstep(0.4, 0.9, n.y));

  float caus = caustics(q * 0.8, px * 2.0);
  float shade = max(koiShadow(q, vWorld.y), padShadow(q, vWorld.y) * 0.85);
  float ndl = max(dot(n, uSunW), 0.0);
  vec3 sky = vec3(0.11, 0.2, 0.19) * (0.6 + 0.4 * n.y);
  vec3 sun = SUN_COLOR * ndl * (0.5 + caus * 1.0) * (1.0 - shade * 0.9);
  vec3 col = albedo * (sky + sun * 1.05) * ao;
  // The slanted line of sight runs further through the water than the depth.
  vec3 view = normalize(cameraPosition - vWorld);
  col = waterColumn(col, depth / max(view.y, 0.3));
  gl_FragColor = vec4(col, 1.0);
}
`;

const surfaceVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const surfaceFragment = /* glsl */ `
${pondGLSL}
varying vec3 vWorld;

// The sky the surface mirrors: deep blue overhead, paling to white, with soft drifting clouds
// and the sun's glow.
vec3 skyColor(vec3 r) {
  float h = clamp(r.y, 0.0, 1.0);
  vec3 c = mix(vec3(0.72, 0.9, 1.0), vec3(0.16, 0.45, 0.95), pow(h, 0.7));
  vec2 cp = r.xz / (r.y + 0.3) * 1.4 + vec2(uTime * 0.012, uTime * 0.005);
  float cl = snoise(cp) * 0.55 + snoise(cp * 2.2 + 4.0) * 0.3;
  c = mix(c, vec3(1.05), smoothstep(0.05, 0.7, cl) * 0.75);
  c += SUN_COLOR * pow(max(dot(r, uSun), 0.0), 40.0) * 0.4;
  return c;
}

void main() {
  vec2 p = vWorld.xz;
  vec3 ring = ripples(p);
  vec3 w = swell(p) + ring;
  // A finer, slowly boiling chop on top for the glitter.
  vec2 chop = vec2(snoise(p * 2.4 + vec2(uTime * 0.31, uTime * 0.17)), snoise(p * 2.4 + vec2(11.0 - uTime * 0.23, 4.0 + uTime * 0.29))) * 0.03;
  vec3 n = normalize(vec3(-(w.x + chop.x), 1.0, -(w.y + chop.y)));
  vec3 v = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, v), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 r = reflect(-v, n);
  r.y = abs(r.y);
  vec3 sky = skyColor(r);
  float rs = max(dot(r, uSun), 0.0);
  vec3 glint = SUN_COLOR * (pow(rs, 2600.0) * 3.0 + pow(rs, 500.0) * 0.06);
  // The ripple rings' crests catch the sky; their troughs shade a little.
  vec3 crest = vec3(0.55, 0.8, 0.85) * clamp(ring.z * 30.0, 0.0, 1.0) * 0.35;
  float trough = clamp(-ring.z * 30.0, 0.0, 1.0) * 0.1;
  // Around the pads: a thin bright meniscus where the water climbs their rims, then a soft
  // shade on the water beside them.
  float men = 0.0;
  float shade = 0.0;
  for (int i = 0; i < PAD_COUNT; i++) {
    float d = max(length(p - uPads[i].xy) - uPads[i].z, 0.0);
    men = max(men, exp(-d * 40.0));
    shade = max(shade, exp(-d * 6.0));
  }
  float a = clamp(fres * 1.8 + 0.02 + men * 0.12, 0.0, 1.0);
  // Premultiplied: the sky's reflection over what shows through, plus the sun's glitter; the
  // shade adds coverage without light, darkening what is beneath.
  gl_FragColor = vec4(sky * a + glint + crest, clamp(a + shade * 0.22 + trough, 0.0, 1.0));
}
`;

export function Pond({ shared }: { shared: PondUniforms }) {
  const floor = useDisposable(() => {
    const geometry = new THREE.PlaneGeometry(...PLANE_SIZE, 66, 48).rotateX(-Math.PI / 2).translate(PLANE_CENTRE[0], 0, PLANE_CENTRE[1]);
    const material = shaderMaterial({ uniforms: { ...shared }, vertexShader: floorVertex, fragmentShader: floorFragment });
    return { geometry, material };
  }, [shared]);

  const surface = useDisposable(() => {
    const geometry = new THREE.PlaneGeometry(...PLANE_SIZE).rotateX(-Math.PI / 2).translate(PLANE_CENTRE[0], 0, PLANE_CENTRE[1]);
    const material = shaderMaterial({
      uniforms: { ...shared },
      vertexShader: surfaceVertex,
      fragmentShader: surfaceFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    return { geometry, material };
  }, [shared]);

  return (
    <>
      <mesh geometry={floor.geometry} material={floor.material} frustumCulled={false} />
      <mesh geometry={surface.geometry} material={surface.material} renderOrder={2} frustumCulled={false} />
    </>
  );
}
