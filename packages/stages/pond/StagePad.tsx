import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { STAGE_PAD } from './layout.ts';

// The dancers' floor: a giant water lily pad, like a Victoria's, flat and quilted with veins,
// its rim turned up and crimson outside. A lit standard material, so it takes the dancers'
// shadows; its pattern is drawn in the shader from the pad's own coordinates.

/** The pad's profile out from its middle: (radius, height, part), part 0 the top, 1 the rim's inside, 2 its outside. */
function profile(): [number, number, number][] {
  const { radius: R, rim, top } = STAGE_PAD;
  const curl = 0.32;
  const points: [number, number, number][] = [];
  for (const r of [0, 0.4, 0.9, 1.5, 2.1, 2.7, 3.2, 3.6]) if (r < R - curl) points.push([r, top, 0]);
  points.push([R - curl, top, 0]);
  for (let i = 1; i <= 6; i++) {
    const t = (i / 6) * Math.PI * 0.5;
    points.push([R - curl + curl * Math.sin(t), top + rim * (1 - Math.cos(t)), 1]);
  }
  points.push([R + 0.02, top + rim + 0.012, 2], [R + 0.05, top + rim - 0.02, 2], [R + 0.065, top + rim * 0.45, 2], [R + 0.07, -0.03, 2], [R + 0.05, -0.12, 2]);
  return points;
}

function padGeometry(): THREE.BufferGeometry {
  const SEGMENTS = 160;
  const points = profile();
  const positions: number[] = [];
  const normals: number[] = [];
  const parts: number[] = [];
  const indices: number[] = [];
  points.forEach(([r, y, part], i) => {
    // The profile's normal, from its neighbours.
    const [r0, y0] = points[Math.max(i - 1, 0)];
    const [r1, y1] = points[Math.min(i + 1, points.length - 1)];
    const t = new THREE.Vector2(r1 - r0, y1 - y0).normalize();
    const nr = i === 0 ? 0 : -t.y;
    const ny = i === 0 ? 1 : t.x;
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = (j / SEGMENTS) * Math.PI * 2;
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
      normals.push(Math.cos(a) * nr, ny, Math.sin(a) * nr);
      parts.push(part);
    }
  });
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * (SEGMENTS + 1) + j;
      const b = a + SEGMENTS + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(parts, 1));
  g.setIndex(indices);
  return g;
}

const head = /* glsl */ `
varying vec3 vPadLocal;
varying float vPart;
float padHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// The quilting on top: ribs running out from the middle, branching twice on the way, crossed by
// wavy rings, so the leaf is divided into small puffy cells. Returns the distance to the nearest
// vein; cell is the cell's id, slope how the cell's dome tilts (radial, around), in world units.
float quilt(vec3 p, out vec2 cell, out vec2 slope) {
  float r = length(p.xz);
  float th = atan(p.z, p.x);
  float ribs = r < 1.3 ? 28.0 : (r < 2.6 ? 56.0 : 112.0);
  float width = 6.2831853 * max(r, 0.05) / ribs;
  float ring = 0.26;
  float ar = th / 6.2831853 * ribs;
  float rr = r / ring + 0.18 * sin(th * 9.0 + r * 1.3);
  vec2 f = vec2(fract(rr), fract(ar)) - 0.5;
  cell = vec2(floor(rr), floor(ar) + ribs);
  vec2 edge = (0.5 - abs(f)) * vec2(ring, width);
  // A gentle dome in each cell: (1 - (2f)^2) both ways.
  vec2 k = 1.0 - 4.0 * f * f;
  slope = -8.0 * f * k.yx / vec2(ring, width);
  return r < 0.12 ? 1.0 : min(edge.x, edge.y);
}
`;

const vertexHead = /* glsl */ `
attribute float aPart;
varying vec3 vPadLocal;
varying float vPart;
`;

const colorPatch = /* glsl */ `
{
  vec3 p = vPadLocal;
  float r = length(p.xz);
  if (vPart < 0.5) {
    vec2 cell;
    vec2 slope;
    float vein = quilt(p, cell, slope);
    float h = padHash(cell);
    vec3 leaf = mix(vec3(0.07, 0.24, 0.025), vec3(0.14, 0.36, 0.04), h * 0.3 + 0.2 + 0.3 * smoothstep(2.4, 0.0, r));
    // Veins a little darker, fading out where they're finer than a pixel.
    float line = 1.0 - smoothstep(0.006, 0.006 + fwidth(vein) * 1.5 + 0.01, vein);
    leaf = mix(leaf, vec3(0.05, 0.15, 0.02), line * 0.4);
    // A paler, yellow-green band inside the rim.
    leaf = mix(leaf, vec3(0.24, 0.4, 0.06), smoothstep(${(STAGE_PAD.radius - 0.9).toFixed(2)}, ${(STAGE_PAD.radius - 0.32).toFixed(2)}, r) * 0.45);
    diffuseColor.rgb = leaf;
  } else {
    // The rim: green at its foot, flushing crimson to the lip and all down its outside, with ribs.
    float up = clamp((p.y - ${STAGE_PAD.top.toFixed(3)}) / ${STAGE_PAD.rim.toFixed(3)}, 0.0, 1.0);
    vec3 crimson = vec3(0.42, 0.03, 0.07);
    vec3 col = vPart < 1.5 ? mix(vec3(0.12, 0.3, 0.04), crimson, smoothstep(0.35, 0.95, up)) : crimson * (0.75 + 0.25 * up);
    float rib = abs(fract(atan(p.z, p.x) / 6.2831853 * 220.0) - 0.5);
    col *= 0.86 + 0.14 * smoothstep(0.1, 0.35, rib);
    diffuseColor.rgb = col;
  }
}
`;

// The cells' domes tilt the normal (world space, turned into view space).
const normalPatch = /* glsl */ `
if (vPart < 0.5) {
  vec2 cell;
  vec2 slope;
  float vein = quilt(vPadLocal, cell, slope);
  float r = max(length(vPadLocal.xz), 1e-3);
  vec3 out_ = vec3(vPadLocal.x / r, 0.0, vPadLocal.z / r);
  vec3 around = vec3(-out_.z, 0.0, out_.x);
  // Fading out with distance, where the cells get too small to show.
  float k = 0.022 * (1.0 - smoothstep(0.03, 0.09, length(fwidth(vPadLocal.xz))));
  vec3 tilt = -(out_ * slope.x + around * slope.y) * k;
  normal = normalize(normal + (viewMatrix * vec4(tilt, 0.0)).xyz);
}
`;

function padMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.38, metalness: 0, envMapIntensity: 0.3 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPadLocal = position;\nvPart = aPart;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${head}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${colorPatch}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${normalPatch}`)
      // The waxy top is glossier than the rim.
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vPart < 0.5 ? 0.34 : 0.5;');
  };
  material.customProgramCacheKey = () => 'pond-stage-pad';
  return material;
}

export function StagePad() {
  const pad = useDisposable(() => ({ geometry: padGeometry(), material: padMaterial() }));
  return <mesh geometry={pad.geometry} material={pad.material} receiveShadow />;
}
