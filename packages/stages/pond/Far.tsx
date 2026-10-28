import * as THREE from 'three';
import { shaderMaterial } from '../shared/glsl.ts';
import { useDisposable } from '../shared/hooks.ts';
import { smoothstep } from '../shared/random.ts';
import { noise2 } from './layout.ts';
import { gardenGLSL, pondCommonGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// Rolling wooded hills beyond the garden, fading into the haze, and blue ridges behind them.

const INNER = 135;
const OUTER = 900;
const SEGMENTS = 192;
const RINGS = 40;

function farHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const hills = (noise2(x * 0.014 + 2, z * 0.014) * 0.5 + 0.5) * 22 + noise2(x * 0.04 + 5, z * 0.04) * 5;
  const ridges = (noise2(x * 0.005 + 11, z * 0.005 + 3) * 0.5 + 0.5) * 70 * smoothstep(260, 520, r);
  return -2 + (hills + 4) * smoothstep(INNER, INNER + 60, r) + ridges;
}

function farGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const r = INNER + (OUTER - INNER) * Math.pow(i / RINGS, 1.6);
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = (j / SEGMENTS) * Math.PI * 2;
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;
      positions.push(x, farHeight(x, z), z);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * (SEGMENTS + 1) + j;
      const b = a + SEGMENTS + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

const farVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vWorld = position;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const farFragment = /* glsl */ `
${pondCommonGLSL}
${gardenGLSL}
varying vec3 vWorld;
varying vec3 vNormal;

void main() {
  vec3 n = normalize(vNormal);
  // Woods in soft clumps, with paler meadows on the gentler slopes.
  float clump = snoise(vWorld.xz * 0.05) * 0.6 + snoise(vWorld.xz * 0.16) * 0.4;
  vec3 col = mix(vec3(0.08, 0.24, 0.07), vec3(0.2, 0.42, 0.1), smoothstep(-0.4, 0.6, clump));
  col = mix(col, vec3(0.42, 0.6, 0.2), smoothstep(0.93, 0.99, n.y) * 0.5);
  col = gardenLight(col, n, vWorld, 0.3, 0.0);
  // The haze thickens with distance, bluer in the far ridges.
  float d = distance(vWorld, cameraPosition);
  col = mix(col, HAZE, 1.0 - exp(-d * 0.0042));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function Far({ shared }: { shared: PondUniforms }) {
  const far = useDisposable(() => ({
    geometry: farGeometry(),
    material: shaderMaterial({ uniforms: { ...shared }, vertexShader: farVertex, fragmentShader: farFragment }),
  }), [shared]);
  return <mesh geometry={far.geometry} material={far.material} frustumCulled={false} />;
}
