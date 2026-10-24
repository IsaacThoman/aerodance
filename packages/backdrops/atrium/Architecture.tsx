import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { fill, mergeAll, sweepArc } from './geometry.ts';
import type { ProfilePoint } from './geometry.ts';
import {
  AXIS, BALCONY_THETA, DOME_R, DOME_RISE, GALLERY, GLASS_R, GLASS_THETA, LEVELS, PLANTER_R, POOL_R, ROOF_Y, TANK_R, TANK_TOP, TREES, VOID_R, WATER_Y, polar,
} from './layout.ts';
import { AA, COMMON, WORLD_VERTEX, atriumUniforms } from './shading.ts';

// Surface kinds of the merged structure, picked in its shader.
const KIND = { white: 0, soffit: 1, shopfront: 2, floor: 3, chrome: 4, stone: 5 } as const;

const tagged = (g: THREE.BufferGeometry, kind: number): THREE.BufferGeometry => fill(g, 'aKind', [kind]);

/** The balconies, shop fronts, floor, piers and ring beam: one mesh, one draw. */
function buildStructure(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const [t0, t1] = BALCONY_THETA;
  const segs = 96;
  const R = VOID_R;
  for (const y of LEVELS) {
    // The rounded white fascia doubles as the planter's front; plants sit on top.
    const fascia: ProfilePoint[] = [
      [R + 0.75, y - 0.85], [R + 0.28, y - 0.8], [R + 0.06, y - 0.58], [R - 0.02, y - 0.2],
      [R, y + 0.35], [R + 0.08, y + 0.66], [R + 0.22, y + 0.76], [R + 0.6, y + 0.76], [R + 0.66, y + 0.3], [DOME_R, y + 0.3],
    ];
    parts.push(tagged(sweepArc(fascia, t0, t1, segs), KIND.white));
    parts.push(tagged(sweepArc([[DOME_R, y - 0.85], [R + 0.75, y - 0.85]], t0, t1, segs), KIND.soffit));
    // A rounded end where each balcony meets the glass wall.
    const cap = new THREE.CylinderGeometry(0.82, 0.82, 1.62, 20, 1).translate(0, y - 0.05, 0);
    const end = polar(R + 0.82, t0);
    parts.push(tagged(cap.translate(end.x, 0, end.z), KIND.white));
  }
  // Shop fronts all the way up behind the balconies.
  parts.push(tagged(sweepArc([[DOME_R, ROOF_Y], [DOME_R, 0]], t0 - 0.05, t1, segs), KIND.shopfront));
  // The ring beam the dome rests on, and a white pier where the balconies end at the glass.
  parts.push(
    tagged(
      sweepArc([[DOME_R + 0.3, ROOF_Y - 0.9], [DOME_R - 0.6, ROOF_Y - 0.85], [DOME_R - 0.9, ROOF_Y - 0.4], [DOME_R - 0.8, ROOF_Y + 0.1], [DOME_R + 0.3, ROOF_Y + 0.2]], 0, Math.PI * 2, 160),
      KIND.white,
    ),
  );
  const pier = polar(GLASS_R - 0.2, GLASS_THETA[1] + 0.02);
  parts.push(tagged(new THREE.CylinderGeometry(1.1, 1.1, ROOF_Y, 28, 1).translate(pier.x, ROOF_Y / 2, pier.z), KIND.white));
  // Chrome collars where the column leaves the pool and meets the dome.
  const collar = (r0: number, r1: number, y0: number, y1: number) =>
    tagged(sweepArc([[r0, y0], [r1, y0 + 0.08], [r1, y1 - 0.08], [r0, y1]], 0, Math.PI * 2, 48), KIND.chrome);
  parts.push(collar(TANK_R, TANK_R + 0.32, 0, 1.0));
  parts.push(collar(TANK_R, TANK_R + 0.3, TANK_TOP - 1.4, TANK_TOP + 0.4));
  // The gallery round the column and its bridges: glass floors (see Balustrades) carried on
  // slim white edge beams, with a chrome collar where the ring meets the column.
  const gy = GALLERY.y;
  const gr = GALLERY.r;
  parts.push(tagged(sweepArc([[gr - 0.12, gy + 0.08], [gr + 0.1, gy + 0.08], [gr + 0.14, gy - 0.06], [gr + 0.06, gy - 0.2], [gr - 0.12, gy - 0.2]], 0, Math.PI * 2, 72), KIND.white));
  parts.push(collar(TANK_R, TANK_R + 0.22, gy - 0.3, gy + 0.15));
  for (const theta of GALLERY.bridges) {
    const length = VOID_R - gr + 0.4;
    const mid = polar((VOID_R + gr) / 2, theta, 0);
    for (const side of [-1, 1]) {
      const beam = new THREE.BoxGeometry(0.2, 0.28, length).translate((side * GALLERY.width) / 2, gy - 0.06, 0);
      parts.push(tagged(beam.rotateY(theta).translate(mid.x, 0, mid.z), KIND.white));
    }
  }
  // Slim pilotis under the balcony edges.
  for (let theta = t0 + 0.22; theta < t1; theta += 0.42) {
    const p = polar(R + 1.3, theta);
    parts.push(tagged(new THREE.CylinderGeometry(0.26, 0.26, LEVELS[2], 14, 1).translate(p.x, LEVELS[2] / 2, p.z), KIND.white));
  }
  // Round white planters for the trees.
  for (const spot of TREES.filter((t) => t.planter)) {
    const p = polar(spot.r, spot.theta);
    const lathe = [[0.01, 0.85], [PLANTER_R - 0.12, 0.85], [PLANTER_R - 0.1, 1.0], [PLANTER_R + 0.02, 1.04], [PLANTER_R + 0.1, 0.96], [PLANTER_R + 0.06, 0.2], [PLANTER_R - 0.1, 0]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(lathe, 40).translate(p.x, 0, p.z);
    parts.push(tagged(g, KIND.white));
  }
  // Floor: polished stone, with a raised stone rim round the pool.
  parts.push(tagged(new THREE.CircleGeometry(DOME_R + 8, 96).rotateX(-Math.PI / 2).translate(AXIS.x, 0, AXIS.z), KIND.floor));
  const rim: ProfilePoint[] = [[POOL_R, WATER_Y - 0.1], [POOL_R, 0.5], [POOL_R + 0.1, 0.58], [POOL_R + 0.62, 0.58], [POOL_R + 0.72, 0.5], [POOL_R + 0.74, 0]];
  parts.push(tagged(sweepArc(rim, 0, Math.PI * 2, 128), KIND.stone));
  return mergeAll(parts);
}

const structureFragment = /* glsl */ `
${COMMON}
${AA}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vKind;

// Shop fronts behind the balconies: glazed bays, white spandrels and living walls.
vec3 shopfront(vec3 w, out float gloss) {
  float level = w.y < LEVELS.x ? 0.0 : w.y < LEVELS.y ? LEVELS.x : w.y < LEVELS.z ? LEVELS.y : LEVELS.z;
  float h = w.y - level;
  float u = atan(w.x - AXIS.x, w.z - AXIS.z) * DOME_R;
  float bay = floor(u / 3.2);
  float fu = fract(u / 3.2);
  float rnd = hash12(vec2(bay, level));
  float top = level > LEVELS.y + 1.0 ? ROOF_Y - level - 1.0 : 3.5;
  float glazed = step(0.32, h) * step(h, top);
  float mullion = aaLine((fu - 0.5) * 3.2, 0.07) + aaLine(fract(u / 1.6 + 0.5) * 1.6 - 0.8, 0.03);
  // Interiors: soft white light, a hint of shelves and plants, sky reflected in the glass.
  vec3 room = mix(vec3(0.82, 0.86, 0.84), vec3(1.0, 0.97, 0.9), rnd);
  room = mix(room, vec3(0.3, 0.55, 0.3), step(0.72, rnd) * smoothstep(1.6, 0.4, abs(h - 1.2)) * 0.7);
  room *= 0.75 + 0.25 * smoothstep(0.3, 2.8, h);
  vec3 glass = mix(room, vec3(0.55, 0.78, 0.92), 0.35 + 0.25 * fu);
  vec3 col = mix(vec3(0.93, 0.94, 0.95), glass, glazed * (1.0 - mullion));
  // Some bays are living walls, floor to ceiling.
  float green = step(rnd, 0.28) * step(0.0, h) * step(h, 4.0);
  float leaves = snoise(vec2(u, w.y) * 1.3) * 0.5 + snoise(vec2(u, w.y) * 3.1) * 0.25;
  vec3 leaf = mix(vec3(0.12, 0.36, 0.08), vec3(0.42, 0.72, 0.16), leaves * 0.5 + 0.5);
  col = mix(col, leaf, green);
  gloss = mix(glazed * (1.0 - mullion) * 0.8, 0.0, green);
  return col;
}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  vec3 s = normalize(uSunDir);
  float k = vKind;
  vec3 albedo = vec3(0.86, 0.88, 0.9);
  float gloss = 0.55;
  vec3 emit = vec3(0.0);

  // Recesses under the balconies get no sun and less sky.
  vec2 d = w.xz - AXIS.xz;
  float r = length(d);
  float a = atan(d.x, d.y);
  float glassSector = smoothstep(GLASS_THETA.x, GLASS_THETA.x + 0.1, a) * smoothstep(GLASS_THETA.y + 0.05, GLASS_THETA.y - 0.1, a);
  float recess = smoothstep(VOID_R + 0.6, VOID_R + 2.5, r) * step(w.y, LEVELS.z + 0.25) * (1.0 - glassSector);
  float ao = 1.0 - recess * (0.35 + 0.25 * smoothstep(VOID_R + 1.0, DOME_R, r));
  ao *= mix(0.72, 1.0, foreLight(w));
  // Contact shade where walls, planters and rims meet the floor.
  ao *= mix(1.0, mix(0.62, 1.0, smoothstep(0.0, 1.1, w.y)), step(abs(n.y), 0.6));

  if (k < 0.5) {
    // Glossy white.
  } else if (k < 1.5) {
    // Soffits with soft downlights.
    vec2 g = vec2(vUv.x / 2.4, r / 2.0);
    vec2 cell = fract(g) - 0.5;
    float spot = exp(-dot(cell, cell) * 40.0) * step(r, DOME_R - 0.8);
    emit = vec3(1.0, 0.93, 0.8) * spot * 1.6;
    gloss = 0.15;
  } else if (k < 2.5) {
    albedo = shopfront(w, gloss);
  } else if (k < 3.5) {
    // Polished pale stone in big slabs.
    vec2 g = (w.xz - AXIS.xz) / 1.8;
    float joint = max(aaLine(fract(g.x) - 0.5, 0.012), aaLine(fract(g.y) - 0.5, 0.012));
    float tone = hash12(floor(g) + 3.0);
    albedo = mix(vec3(0.5, 0.5, 0.5), vec3(0.42, 0.43, 0.44), tone * 0.5 + joint * 0.6);
    gloss = 0.45 * mix(0.6, 1.0, foreLight(w));
  } else if (k < 4.5) {
    // Chrome.
    albedo = vec3(0.25);
    gloss = 1.6;
  } else {
    // The pool's stone rim, honed rather than polished.
    albedo = vec3(0.74, 0.75, 0.74);
    gloss = 0.22;
  }

  float sun = max(dot(n, s), 0.0) * sunLight(w) * (1.0 - recess);
  vec3 col = albedo * (ambient(n) * ao + SUN * sun * 0.85);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  col += roomReflect(reflect(-v, n)) * mix(0.05, 0.85, fres) * gloss * ao;
  col += SUN * pow(max(dot(reflect(-s, n), v), 0.0), 80.0) * sun * gloss * 1.4;
  col += emit;
  gl_FragColor = vec4(haze(col, w), 1.0);
}
`;

export function Structure() {
  const geometry = useDisposable(buildStructure);
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...atriumUniforms },
      side: THREE.DoubleSide,
      vertexShader: WORLD_VERTEX.replace('varying vec2 vUv;', 'varying vec2 vUv;\nattribute float aKind;\nvarying float vKind;').replace('vUv = uv;', 'vUv = uv;\nvKind = aKind;'),
      fragmentShader: structureFragment,
    }),
  );
  return <mesh geometry={geometry} material={material} />;
}

/** The dome: white ribs and glass panes over the whole atrium. */
function buildDome(): THREE.BufferGeometry {
  const rings = 24;
  const segs = 128;
  const r0 = TANK_R + 0.28;
  const profile: ProfilePoint[] = [];
  for (let i = 0; i <= rings; i++) {
    const r = r0 + (DOME_R - r0) * (i / rings);
    profile.push([r, ROOF_Y + DOME_RISE * (1 - (r / DOME_R) ** 2)]);
  }
  return sweepArc(profile, 0, Math.PI * 2, segs);
}

const domeFragment = /* glsl */ `
${COMMON}
${AA}
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  vec3 s = normalize(uSunDir);
  float rib = aaLine(domeRibDist(w.xz), 0.17);
  // Ribs seen from below: lit by the room, their sunward edges glowing.
  vec3 ribCol = vec3(0.86, 0.9, 0.95) * (0.9 + 0.2 * smoothstep(0.0, 0.6, w.y - ROOF_Y));
  // Glass: barely there, brightening towards the sun and at grazing angles.
  float toSun = max(dot(-v, s), 0.0);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), v)), 3.0);
  vec3 glassCol = vec3(0.85, 0.95, 1.05) * (0.5 + 0.8 * pow(toSun, 12.0)) + vec3(1.0, 0.95, 0.85) * pow(toSun, 120.0) * 2.0;
  float glassA = 0.02 + 0.16 * fres + 0.12 * pow(toSun, 8.0);
  vec3 col = mix(glassCol, ribCol, rib);
  float alpha = mix(glassA, 1.0, rib);
  gl_FragColor = vec4(haze(col, w) * alpha, alpha);
}
`;

export function Dome() {
  const geometry = useDisposable(buildDome);
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...atriumUniforms },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      vertexShader: WORLD_VERTEX,
      fragmentShader: domeFragment,
    }),
  );
  return <mesh geometry={geometry} material={material} renderOrder={10} />;
}

const glassFragment = /* glsl */ `
${COMMON}
${AA}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
uniform float uMullions;
void main() {
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  vec3 n = normalize(vNormal);
  float facing = abs(dot(n, v));
  float fres = pow(1.0 - facing, 4.0);
  // Broad diagonal sheen bands sliding slowly across the glass.
  float sheen = smoothstep(0.75, 1.0, sin((vUv.x * 0.08 + w.y * 0.05) * 6.2831 - uTime * 0.05) * 0.5 + 0.5);
  vec3 col = vec3(0.8, 0.94, 1.0) * (0.35 + 0.6 * fres + 0.5 * sheen);
  float alpha = 0.02 + 0.16 * fres + 0.07 * sheen;
  if (uMullions > 0.5) {
    float m = max(aaLine(fract(vUv.x / 4.4 + 0.5) * 4.4 - 2.2, 0.15), aaLine(fract(w.y / 4.8 + 0.5) * 4.8 - 2.4 + 0.0, 0.16));
    vec3 white = vec3(0.92, 0.94, 0.96) * (ambient(n) + SUN * 0.25 * sunLight(w));
    col = mix(col, white, m);
    alpha = mix(alpha, 1.0, m);
  } else {
    // A frameless balustrade: a bright polished top edge.
    float edge = smoothstep(0.86, 0.98, vUv.y);
    col += vec3(1.0) * edge * 0.6;
    alpha = max(alpha, edge * 0.5);
  }
  gl_FragColor = vec4(haze(col, w) * alpha, alpha);
}
`;

const makeGlass = (mullions: boolean) =>
  shaderMaterial({
    uniforms: { ...atriumUniforms, uMullions: { value: mullions ? 1 : 0 } },
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    vertexShader: WORLD_VERTEX,
    fragmentShader: glassFragment,
  });

/** The tall glass wall on the right, white mullions on a grid. */
export function GlassWall() {
  const geometry = useDisposable(() => sweepArc([[GLASS_R, 0], [GLASS_R, ROOF_Y]], GLASS_THETA[0] - 0.2, GLASS_THETA[1], 64));
  const material = useDisposable(() => makeGlass(true));
  return <mesh geometry={geometry} material={material} renderOrder={8} />;
}

/** Frameless glass balustrades along every balcony. */
export function Balustrades() {
  const geometry = useDisposable(() => {
    const parts = LEVELS.map((y) => sweepArc([[VOID_R + 0.9, y + 0.3], [VOID_R + 0.9, y + 1.35]], BALCONY_THETA[0], BALCONY_THETA[1], 96));
    // Round the gallery, open where the bridges leave it, and along both sides of each bridge.
    const gy = GALLERY.y;
    const gap = (GALLERY.width / 2 + 0.1) / GALLERY.r;
    const [b0, b1] = [...GALLERY.bridges].sort((a, b) => a - b);
    const rail: ProfilePoint[] = [[GALLERY.r - 0.05, gy + 0.08], [GALLERY.r - 0.05, gy + 1.13]];
    parts.push(sweepArc(rail, b0 + gap, b1 - gap, 24), sweepArc(rail, b1 + gap, b0 + Math.PI * 2 - gap, 72));
    // Glass floors: the ring and the bridges.
    parts.push(sweepArc([[TANK_R + 0.2, gy + 0.05], [GALLERY.r - 0.1, gy + 0.05]], 0, Math.PI * 2, 64));
    for (const theta of GALLERY.bridges) {
      const length = VOID_R - GALLERY.r;
      const mid = polar((VOID_R + GALLERY.r) / 2, theta, 0);
      for (const side of [-1, 1]) {
        const g = new THREE.PlaneGeometry(length, 1.05).rotateY(Math.PI / 2).translate((side * GALLERY.width) / 2, gy + 0.08 + 0.525, 0);
        parts.push(g.rotateY(theta).translate(mid.x, 0, mid.z));
      }
      const floor = new THREE.PlaneGeometry(GALLERY.width, length).rotateX(-Math.PI / 2).translate(0, gy + 0.05, 0);
      parts.push(floor.rotateY(theta).translate(mid.x, 0, mid.z));
    }
    return mergeAll(parts);
  });
  const material = useDisposable(() => makeGlass(false));
  return <mesh geometry={geometry} material={material} renderOrder={9} />;
}
