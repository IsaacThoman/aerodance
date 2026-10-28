import * as THREE from 'three';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { pondGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// The pond's floor, seen through the water: one big plane covering the view with room to spare
// for the camera's drift and the pointer lean. Its pebbles come baked (bake.ts); each frame it
// adds the caustics, the koi's shadows and the water, then lays the surface over itself.

const PLANE_SIZE: [number, number] = [44, 32];
const PLANE_CENTRE: [number, number] = [0, -2];

const floorVertex = /* glsl */ `
${pondGLSL}
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  world.y = -floorDepth(world.xz);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const floorFragment = /* glsl */ `
${pondGLSL}
varying vec3 vWorld;

void main() {
  float depth = -vWorld.y;
  // The surface above, along the line of sight: its waves bend the view of the floor.
  vec3 s = surfacePoint(vWorld);
  vec3 ring = ripples(s.xz);
  vec3 w = swell(s.xz) + ring;
  vec2 q = vWorld.xz - w.xy * depth * 0.45;

  // Pebbles too small for the buffer settle towards their local average (a blurry level of the
  // map, keeping the silt, moss and shade) instead of shimmering.
  float px = length(fwidth(q));
  vec2 uv = mapUv(q);
  vec4 floorMap = mix(texture2D(uFloorMap, uv, 5.0), texture2D(uFloorMap, uv), 1.0 - smoothstep(0.05, 0.14, px * 2.1));
  vec3 albedo = floorMap.rgb * floorMap.rgb;
  float caus = caustics(q * 0.8, px * 2.0);
  float shade = koiShadow(q, vWorld.y);
  vec3 sun = SUN_COLOR * floorMap.a * (0.5 + caus) * (1.0 - shade * 0.9);
  vec3 col = albedo * (vec3(0.105, 0.19, 0.18) + sun * 1.05);
  // The slanted line of sight runs further through the water than the depth.
  vec3 view = normalize(cameraPosition - vWorld);
  col = waterColumn(col, depth / max(view.y, 0.3));
  gl_FragColor = vec4(overSurface(col, s, w, ring.z), 1.0);
}
`;

export function Pond({ shared }: { shared: PondUniforms }) {
  const floor = useDisposable(() => {
    const geometry = new THREE.PlaneGeometry(...PLANE_SIZE, 66, 48).rotateX(-Math.PI / 2).translate(PLANE_CENTRE[0], 0, PLANE_CENTRE[1]);
    const material = shaderMaterial({ uniforms: { ...shared }, vertexShader: floorVertex, fragmentShader: floorFragment });
    return { geometry, material };
  }, [shared]);

  return <mesh geometry={floor.geometry} material={floor.material} frustumCulled={false} />;
}
