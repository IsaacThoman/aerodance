import * as THREE from 'three';
import { shaderMaterial } from '../shared/glsl.ts';
import { useDisposable } from '../shared/hooks.ts';
import { groundHeight, shoreRadius } from './layout.ts';
import { gardenGLSL, pondGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// The ground, in one mesh: the pond's pebble bed seen through the water, and the mossy banks
// rising from it. Its rings follow the shoreline, so the waterline runs along them. Under the
// water each frame adds the caustics, the koi's and the pads' shadows and the water column, then
// lays the surface over itself; above it, the banks are moss.

const SEGMENTS = 320;
/** Rings from the middle out to the shore, closer together towards the shore. */
const WATER_RINGS = 56;
/** Out from the shore up the banks, in world units. */
const BANK_RINGS = [0.08, 0.2, 0.36, 0.6, 0.9, 1.3, 1.8, 2.5, 3.3, 4.3, 5.5, 7, 9, 11.5, 14.5, 18, 23, 30, 40, 55, 75, 100, 130];

function groundGeometry(): THREE.BufferGeometry {
  const rings: ((a: number) => number)[] = [];
  for (let k = 0; k <= WATER_RINGS; k++) {
    const u = 1 - Math.pow(1 - k / WATER_RINGS, 1.5);
    rings.push((a) => shoreRadius(a) * u);
  }
  for (const e of BANK_RINGS) rings.push((a) => shoreRadius(a) + e);
  const positions = new Float32Array(rings.length * (SEGMENTS + 1) * 3);
  let o = 0;
  for (const ring of rings) {
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = -Math.PI + (j / SEGMENTS) * Math.PI * 2;
      const r = ring(a);
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;
      positions.set([x, groundHeight(x, z), z], o);
      o += 3;
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * (SEGMENTS + 1) + j;
      const b = a + SEGMENTS + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  // The seam where the rings close on themselves gets the average of both sides.
  const n = g.getAttribute('normal');
  const v = new THREE.Vector3();
  for (let i = 0; i < rings.length; i++) {
    const a = i * (SEGMENTS + 1);
    const b = a + SEGMENTS;
    v.set(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
    n.setXYZ(a, v.x, v.y, v.z);
    n.setXYZ(b, v.x, v.y, v.z);
  }
  return g;
}

const groundVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const groundFragment = /* glsl */ `
${pondGLSL}
${gardenGLSL}
varying vec3 vWorld;
varying vec3 vNormal;

// px: the size of a pixel on the ground.
vec3 bed(float px) {
  float depth = -vWorld.y;
  // The surface above, along the line of sight: its waves bend the view of the bed.
  vec3 s = surfacePoint(vWorld);
  vec3 ring = ripples(s.xz);
  vec3 w = swell(s.xz) + ring;
  vec2 q = vWorld.xz - w.xy * depth * 0.45;

  // Pebbles too small for the buffer settle towards their local average (a blurry level of the
  // map, keeping the silt, moss and shade) instead of shimmering.
  vec2 uv = mapUv(q);
  vec4 floorMap = mix(texture2D(uFloorMap, uv, 5.0), texture2D(uFloorMap, uv), 1.0 - smoothstep(0.05, 0.14, px * 2.1));
  vec3 albedo = floorMap.rgb * floorMap.rgb;
  float caus = caustics(q * 0.8, px * 2.0);
  float shade = max(koiShadow(q, vWorld.y), padShadow(q, vWorld.y) * 0.8);
  vec3 sun = SUN_COLOR * floorMap.a * (0.5 + caus) * (1.0 - shade * 0.9);
  vec3 col = albedo * (vec3(0.105, 0.19, 0.18) + sun * 1.05);
  // The slanted line of sight runs further through the water than the depth.
  vec3 view = normalize(cameraPosition - vWorld);
  col = waterColumn(col, depth / max(view.y, 0.3));
  return overSurface(col, s, w, ring.z);
}

vec3 bank() {
  vec3 n = normalize(vNormal);
  vec2 p = vWorld.xz;
  // Moss in soft drifts of lighter and deeper green.
  float drift = snoise(p * 0.16) * 0.6 + snoise(p * 0.5 + 3.0) * 0.3 + snoise(p * 1.7 + 7.0) * 0.1;
  vec3 col = mix(vec3(0.035, 0.13, 0.02), vec3(0.1, 0.3, 0.03), smoothstep(-0.6, 0.7, drift));
  col *= 0.9 + 0.2 * hash12(floor(p * 9.0));
  // Damp and dark just above the water, and in the steep faces.
  float damp = 1.0 - smoothstep(0.0, 0.3, vWorld.y);
  col = mix(col, vec3(0.08, 0.1, 0.06), damp * 0.75);
  col *= mix(0.7, 1.0, smoothstep(0.55, 0.9, n.y));
  return gardenHaze(gardenLight(col, n, vWorld, 0.3, 0.04), vWorld);
}

void main() {
  // Measured out here, where every pixel takes the same path.
  float px = length(fwidth(vWorld.xz));
  gl_FragColor = vec4(vWorld.y < 0.0 ? bed(px) : bank(), 1.0);
}
`;

export function Ground({ shared }: { shared: PondUniforms }) {
  const ground = useDisposable(() => ({
    geometry: groundGeometry(),
    material: shaderMaterial({ uniforms: { ...shared }, vertexShader: groundVertex, fragmentShader: groundFragment }),
  }), [shared]);

  return <mesh geometry={ground.geometry} material={ground.material} frustumCulled={false} />;
}
