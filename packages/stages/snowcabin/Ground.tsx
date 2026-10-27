import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import type { Vec3 } from '../catalog.ts';
import { patchScenery } from './materials.ts';
import type { FragmentPatch } from './materials.ts';
import { CABIN, SLED, SNOWMAN, STEPS } from './layout.ts';
import { MOON_LIGHT, SHADOW_PINES } from './forest.ts';
import { FIELD_RADIUS, fieldHeight } from './terrain.ts';

const vec2 = ([x, , z]: Vec3) => `vec2(${x.toFixed(2)}, ${z.toFixed(2)})`;
const f = (v: number) => v.toFixed(2);

/** Where the snow angel lies, and which way its head points. */
const ANGEL = { x: 3.4, z: 8.6, heading: 2.6 };

const snowFragment: FragmentPatch = {
  uniforms: {
    uMoonDir: { value: MOON_LIGHT.clone().normalize() },
    uTrees: { value: SHADOW_PINES.map((p) => new THREE.Vector4(p.x, p.z, p.height, p.height * 0.33)) },
  },
  head: /* glsl */ `
    uniform vec3 uMoonDir;
    uniform vec4 uTrees[${SHADOW_PINES.length}];
    float snowTrail;

    // Footprints from a to b: alternating left and right boot prints along a gentle wander.
    float footprints(vec2 p, vec2 a, vec2 b, float wiggle) {
      vec2 d = normalize(b - a);
      vec2 n = vec2(-d.y, d.x);
      float len = length(b - a);
      float i0 = floor(dot(p - a, d) / 0.7 + 0.5);
      float best = 0.0;
      for (int k = -1; k <= 1; k++) {
        float i = i0 + float(k);
        if (i < 0.0 || i * 0.7 > len) continue;
        float side = mod(i, 2.0) * 2.0 - 1.0;
        vec2 c = a + d * (i * 0.7) + n * (side * 0.16 + sin(i * 0.5) * wiggle);
        vec2 q = vec2(dot(p - c, d), dot(p - c, n));
        float w = 0.08 + 0.04 * smoothstep(-0.16, 0.12, q.x);
        best = max(best, 1.0 - smoothstep(0.6, 1.0, length(vec2(q.x / 0.2, q.y / w))));
      }
      return best;
    }

    // A pair of runner grooves along a segment.
    float runners(vec2 p, vec2 a, vec2 b) {
      vec2 ab = b - a;
      float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
      vec2 d = p - a - ab * t;
      float across = dot(d, normalize(vec2(-ab.y, ab.x)));
      across += sin(t * 9.0) * 0.12;
      return (1.0 - smoothstep(0.035, 0.08, abs(abs(across) - 0.27))) * smoothstep(0.0, 0.03, t) * smoothstep(1.0, 0.97, t);
    }

    // A snow angel, head towards +y: distance to its outline (negative inside).
    float angel(vec2 p) {
      float d = length(p - vec2(0.0, 0.88)) - 0.21;
      d = min(d, (length((p - vec2(0.0, 0.25)) / vec2(0.3, 0.52)) - 1.0) * 0.3);
      // Wings: the fan the arms swept, about the shoulders.
      vec2 s = p - vec2(0.0, 0.5);
      float r = length(s);
      float a = atan(abs(s.x), s.y + 1e-5);
      d = min(d, max(abs(r - 0.66) - 0.2, max(0.5 - a, a - 1.9) * r));
      // Legs: the fan they swept, below the hips.
      vec2 h = p - vec2(0.0, -0.1);
      float lr = length(h);
      float la = atan(abs(h.x), -h.y + 1e-5);
      return min(d, max(lr - 0.9, (la - 0.42) * lr));
    }

    // Moon shadows of the nearest spruces: each a ragged wedge from its foot, as wide as the
    // lowest boughs and narrowing to the tip, softer further from the tree.
    float treeShade(vec2 p) {
      vec2 away = -normalize(uMoonDir.xz);
      vec2 side = vec2(-away.y, away.x);
      float reach = length(uMoonDir.xz) / uMoonDir.y;
      float lit = 1.0;
      for (int i = 0; i < ${SHADOW_PINES.length}; i++) {
        vec4 t = uTrees[i];
        vec2 d = p - t.xy;
        float along = dot(d, away) / (t.z * reach);
        float across = abs(dot(d, side)) / t.w;
        float soft = 0.08 + 0.3 * max(along, 0.0);
        float width = pow(max(1.0 - along, 0.0), 0.85) * (0.82 + 0.18 * abs(sin(along * 22.0 + t.x)));
        float wedge = (1.0 - smoothstep(width - soft, width + soft, across)) * step(0.0, along);
        float foot = 1.0 - smoothstep(0.85, 1.05, length(vec2(along * t.z * reach / t.w, across)));
        lit = min(lit, 1.0 - max(wedge, foot) * 0.85);
      }
      return lit;
    }

    // The cabin's moon shadow: does the line to the moon pass through its A-frame (cabin space)?
    void clip(float o, float d, float bound, inout vec2 span) {
      if (abs(d) < 1e-5) { if (o > bound) span = vec2(1.0, 0.0); return; }
      float t = (bound - o) / d;
      if (d > 0.0) span.y = min(span.y, t); else span.x = max(span.x, t);
    }
    float cabinShade(vec3 p) {
      vec3 o = (uCabin * vec4(p, 1.0)).xyz;
      vec3 d = mat3(uCabin) * uMoonDir;
      vec2 span = vec2(0.0, 1e4);
      const float K = ${f(CABIN.halfWidth / CABIN.height)};
      const float C = ${f(CABIN.halfWidth + (CABIN.halfWidth / CABIN.height) * CABIN.floor + 1.0)};
      clip(o.z, d.z, ${f(CABIN.overhang + 0.2)}, span);
      clip(-o.z, -d.z, ${f(CABIN.depth + 0.7)}, span);
      clip(o.x + K * o.y, d.x + K * d.y, C, span);
      clip(-o.x + K * o.y, -d.x + K * d.y, C, span);
      return 1.0 - smoothstep(0.0, 1.2, span.y - span.x) * 0.85;
    }
  `,
  color: /* glsl */ `
    {
      vec2 p = vWorld.xz;
      vec4 n = noise4(p * 0.09);
      diffuseColor.rgb = vec3(0.8, 0.88, 1.0) * (0.93 + 0.07 * n.r);
      vec2 steps = ${vec2(STEPS)};
      // A trodden path from the deck steps out to the dancers, prints along it, over to the
      // snowman, and across the front to the sled; and the sled's runners down from the woods.
      vec2 path = steps - vec2(-2.4, 0.6);
      float along = clamp(dot(p - vec2(-2.4, 0.6), path) / dot(path, path), 0.0, 1.0);
      float trodden = (1.0 - smoothstep(0.35, 0.95, length(p - vec2(-2.4, 0.6) - path * along) + n.g * 0.25)) * smoothstep(0.0, 0.08, along);
      // Prints only show close up: skip them (and their loops) where they'd be too small to see.
      float detail = 1.0 - smoothstep(0.5, 1.4, length(fwidth(p)) * 5.0);
      float wings = 1.0;
      snowTrail = 0.0;
      if (detail > 0.0) {
        float prints = max(footprints(p, steps, vec2(-2.4, 0.6), 0.2), footprints(p, vec2(2.4, 0.8), vec2(${f(SNOWMAN.x - 0.8)}, ${f(SNOWMAN.z + 1.1)}), 0.24));
        prints = max(prints, footprints(p, vec2(-9.0, 14.0), vec2(${f(SLED.x - 0.6)}, ${f(SLED.z + 0.7)}), 0.3));
        float track = max(runners(p, vec2(26.0, -26.0), vec2(16.0, -10.0)), runners(p, vec2(16.0, -10.0), vec2(${f(SLED.x + 2.4)}, ${f(SLED.z - 1.6)})));
        vec2 q = p - vec2(${f(ANGEL.x)}, ${f(ANGEL.z)});
        q = mat2(${f(Math.cos(ANGEL.heading))}, ${f(Math.sin(ANGEL.heading))}, ${f(-Math.sin(ANGEL.heading))}, ${f(Math.cos(ANGEL.heading))}) * q;
        wings = angel(q);
        snowTrail = max(max(prints, track * 0.8), 1.0 - smoothstep(-0.03, 0.03, wings)) * detail;
      }
      // Trodden snow sits in its own shade: bluer and darker; the angel's rim catches the light.
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.6, 0.86), trodden * 0.6);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.48, 0.8), snowTrail * 0.65 * (1.0 - 0.45 * step(wings, 0.04)));
      diffuseColor.rgb *= 1.0 + 0.2 * (1.0 - smoothstep(0.0, 0.07, abs(wings - 0.05))) * detail;
    }
  `,
  // Wind-carved ripples catching the low moon, fading out before they'd shimmer.
  normal: /* glsl */ `
    {
      vec2 p = vWorld.xz;
      vec4 warp = noise4(p * 0.05 + 3.0);
      float ph = (p.x * 0.55 + p.y * 1.1) * 2.6 + warp.r * 3.0;
      float detail = 1.0 - smoothstep(0.08, 0.3, length(fwidth(p)) * 2.6);
      float amp = 0.13 * smoothstep(-0.2, 0.5, warp.g) * detail;
      vec3 tilt = vec3(0.45, 0.0, 0.9) * cos(ph) * amp + vec3(warp.b, 0.0, warp.a) * 0.08;
      tilt.xz -= snowTrail * vec2(0.0, 0.25);
      normal = normalize(normal + (viewMatrix * vec4(tilt, 0.0)).xyz);
    }
  `,
  // The spruces' and the cabin's long moon shadows across the snow (the shadow map only covers
  // the dancers).
  light: /* glsl */ `
    {
      // Nothing out past the trees' shadows needs the loop.
      float moonlit = cabinShade(vWorld);
      if (dot(vWorld.xz, vWorld.xz) < 3600.0) moonlit = min(moonlit, treeShade(vWorld.xz));
      reflectedLight.directDiffuse *= moonlit;
      reflectedLight.directSpecular *= moonlit;
    }
  `,
};

/** The snowfield: a radial grid, fine under the dancers and coarse out at the treeline. */
function fieldGeometry(): THREE.BufferGeometry {
  const RINGS = 96;
  const SEGMENTS = 200;
  const positions = new Float32Array((RINGS * SEGMENTS + 1) * 3);
  positions.set([0, fieldHeight(0, 0), 0], 0);
  for (let i = 1; i <= RINGS; i++) {
    const r = FIELD_RADIUS * (i / RINGS) ** 1.9;
    for (let j = 0; j < SEGMENTS; j++) {
      const a = (j / SEGMENTS) * Math.PI * 2;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      positions.set([x, fieldHeight(x, z), z], (1 + (i - 1) * SEGMENTS + j) * 3);
    }
  }
  const index: number[] = [];
  const at = (i: number, j: number) => (i === 0 ? 0 : 1 + (i - 1) * SEGMENTS + (j % SEGMENTS));
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      if (i === 0) index.push(0, at(1, j), at(1, j + 1));
      else index.push(at(i, j), at(i + 1, j), at(i, j + 1), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The snow underfoot: takes the dancers' shadows, the trees' and cabin's, the warm light and the sparkle. */
export function Ground() {
  const geometry = useDisposable(fieldGeometry);
  const material = useDisposable(() =>
    patchScenery(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.62 }), { key: 'field', ibl: 0.12, sparkle: 0.2, fragment: snowFragment }),
  );
  return <mesh geometry={geometry} material={material} receiveShadow />;
}
