import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { CloudField, SkyDome } from '../../stages/shared/Sky.tsx';
import { makeRandom } from '../../stages/shared/random.ts';
import { DOME, FLOOR_Y, SUN_DIR } from './layout.ts';
import { LIGHT, fx, limb, merge } from './shading.ts';

// The geodesic dome: a Goldberg shell of big hexagonal (and twelve pentagonal) cushions of
// film held in glossy white tubes, over an inner lattice of thinner triangles, the way Eden's
// biomes are built. The sky and its clouds show through, and the panes nearest the sun glow.

const DETAIL = 7;
const OUTER_TUBE = 0.36;
const INNER_TUBE = 0.15;
const NODE = 0.52;
const INNER_DEPTH = 2.2;
const BULGE = 0.4;

interface Geodesic {
  verts: THREE.Vector3[];
  faces: [number, number, number][];
}

/** A subdivided icosahedron on the unit sphere, indexed, turned so a vertex points straight up. */
function geodesic(detail: number): Geodesic {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  const phi = (1 + Math.sqrt(5)) / 2;
  const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(-1, phi, 0).normalize(), new THREE.Vector3(0, 1, 0));
  const p = ico.attributes.position;
  const verts: THREE.Vector3[] = [];
  const index = new Map<string, number>();
  const faces: [number, number, number][] = [];
  const at = (i: number) => {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).normalize().applyQuaternion(turn);
    const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    let k = index.get(key);
    if (k === undefined) {
      k = verts.length;
      verts.push(v);
      index.set(key, k);
    }
    return k;
  };
  for (let i = 0; i < p.count; i += 3) faces.push([at(i), at(i + 1), at(i + 2)]);
  ico.dispose();
  return { verts, faces };
}

function buildDome() {
  const { verts, faces } = geodesic(DETAIL);
  const C = DOME.center;
  const R = DOME.radius;
  const world = (v: THREE.Vector3, r: number = R) => v.clone().multiplyScalar(r).add(C);
  const low = FLOOR_Y - 3;
  const centroids = faces.map(([a, b, c]) => verts[a].clone().add(verts[b]).add(verts[c]).normalize());
  const edges = new Map<string, number[]>();
  const around: number[][] = verts.map(() => []);
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const list = edges.get(key);
      if (list) list.push(i);
      else edges.set(key, [i]);
      around[a].push(i);
    }
  });

  // The tubes: the outer hexagons (edges of the dual), the inner triangles, and a node at each
  // outer joint.
  const outer: THREE.BufferGeometry[] = [];
  const inner: THREE.BufferGeometry[] = [];
  for (const fs of edges.values()) {
    if (fs.length < 2) continue;
    const p = world(centroids[fs[0]]);
    const q = world(centroids[fs[1]]);
    if (Math.max(p.y, q.y) > low) outer.push(limb(p, q, OUTER_TUBE, OUTER_TUBE, 6));
    // The inner layer: the same hexagons a little further in, in thinner tube.
    const pi = world(centroids[fs[0]], R - INNER_DEPTH);
    const qi = world(centroids[fs[1]], R - INNER_DEPTH);
    if (Math.max(pi.y, qi.y) > low) inner.push(limb(pi, qi, INNER_TUBE, INNER_TUBE, 5));
  }
  // A node at each outer joint, and a strut down from it to the inner layer's.
  for (const c of centroids) {
    const p = world(c);
    if (p.y < low) continue;
    outer.push(new THREE.IcosahedronGeometry(NODE, 0).translate(p.x, p.y, p.z));
    const q = world(c, R - INNER_DEPTH);
    inner.push(limb(p, q, INNER_TUBE * 1.1, INNER_TUBE * 1.1, 5));
    inner.push(new THREE.IcosahedronGeometry(INNER_TUBE * 2.2, 0).translate(q.x, q.y, q.z));
  }

  // The cushions: a fan per hexagon, bulging in towards the forest, its normals tilted out
  // towards the rim so each catches the light like a pillow.
  const rand = makeRandom(41);
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  verts.forEach((v, i) => {
    const centre = world(v);
    if (centre.y < low) return;
    const ring = around[i]
      .map((f) => centroids[f])
      .map((c) => {
        t1.set(0, 0, 1).cross(v).normalize();
        if (t1.lengthSq() < 0.5) t1.set(1, 0, 0);
        t2.copy(v).cross(t1);
        const d = c.clone().sub(v);
        return { c, a: Math.atan2(d.dot(t2), d.dot(t1)) };
      })
      .sort((x, y) => x.a - y.a)
      .map(({ c }) => world(c));
    const tone = rand.next();
    const inward = v.clone().negate();
    const point = (t: number, corner: THREE.Vector3) => {
      const p = centre.clone().lerp(corner, t).addScaledVector(inward, BULGE * (1 - t * t));
      const out = corner.clone().sub(centre).normalize();
      const n = inward.clone().addScaledVector(out, 0.55 * t).normalize();
      return { p, n, t };
    };
    const tri = (...pts: { p: THREE.Vector3; n: THREE.Vector3; t: number }[]) => {
      for (const { p, n, t } of pts) {
        position.push(p.x, p.y, p.z);
        normal.push(n.x, n.y, n.z);
        uv.push(t, tone);
      }
    };
    const mid = 0.62;
    const middle = { p: centre.clone().addScaledVector(inward, BULGE), n: inward, t: 0 };
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const ma = point(mid, a), mb = point(mid, b), ca = point(1, a), cb = point(1, b);
      tri(middle, ma, mb);
      tri(ma, ca, cb);
      tri(ma, cb, mb);
    }
  });
  const panes = new THREE.BufferGeometry();
  panes.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  panes.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  panes.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  panes.computeBoundingSphere();
  return { outer: merge(outer), inner: merge(inner), panes };
}

const paneVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const paneFragment = /* glsl */ `
${LIGHT}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec3 n = normalize(vNormal);
  vec3 dir = normalize(vWorld - cameraPosition);
  if (dot(n, dir) > 0.0) n = -n;
  float ndv = max(dot(n, -dir), 0.0);
  float fres = pow(1.0 - ndv, 3.0);
  float rim = smoothstep(0.72, 0.97, vUv.x);
  float tone = vUv.y;
  // The film reflects the room a little: green forest below, the white frame and bright sky above.
  vec3 r = reflect(dir, n);
  vec3 refl = mix(vec3(0.32, 0.55, 0.4), vec3(0.9, 0.98, 1.0), smoothstep(-0.4, 0.5, r.y));
  // Each cushion milky at its welded rim, clearer in its middle, lit on the side towards the sun.
  float lit = dot(n, -uSunDir) * 0.5 + 0.5;
  vec3 col = mix(refl, vec3(0.92, 0.99, 1.0), 0.4) * (0.75 + 0.35 * lit) + vec3(0.95, 1.0, 1.0) * rim * 0.5;
  float a = 0.09 + 0.06 * tone + fres * 0.5 + rim * 0.3 + (1.0 - lit) * 0.04;
  // A pillow's sheen where it turns towards the light overhead.
  float sheen = pow(max(dot(r, normalize(uSunDir + vec3(0.0, 0.6, 0.0))), 0.0), 18.0);
  // Sun scattered in the film: the panes round the sun glow warm, each a little differently.
  float toSun = max(dot(dir, uSunDir), 0.0);
  vec3 glow = HAZE_SUN * (pow(toSun, 40.0) * 1.4 + pow(toSun, 8.0) * 0.22) * (0.55 + 0.45 * tone) * (0.6 + 0.4 * vUv.x);
  glow += vec3(1.0, 0.98, 0.92) * sheen * 0.3 * (0.4 + 0.6 * vUv.x);
  // The humid air between here and the glass veils the sky behind it.
  float h = hazeAmount(vWorld) * 0.75;
  col = mix(col, hazeColor(vWorld), h);
  a = clamp(a + h * (1.0 - a), 0.0, 0.92);
  gl_FragColor = vec4(col * a + glow, a);
}
`;

// Rolling green hills round the dome, far off and blue with distance: two ridges, the nearer
// greener, seen over the canopy through the glass.
function buildHills(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const segments = 220;
  let base = 0;
  for (const [radius, height, seed] of [[900, 95, 3], [560, 55, 11]] as const) {
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const h = height * (0.45 + 0.35 * Math.sin(t * 3 + seed) * Math.sin(t * 7.3 + seed * 2) + 0.2 * Math.sin(t * 13.1 + seed * 5)) + 10;
      const x = DOME.center.x + Math.sin(t) * radius;
      const z = DOME.center.z + Math.cos(t) * radius;
      positions.push(x, FLOOR_Y - 30, z, x, FLOOR_Y + h, z);
      uvs.push(radius, 0, radius, 1);
      if (i < segments) {
        const a = base + i * 2;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    base += (segments + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

const hillFragment = /* glsl */ `
varying vec2 vUv;
void main() {
  float near = step(vUv.x, 700.0);
  vec3 green = mix(vec3(0.3, 0.62, 0.36), vec3(0.42, 0.74, 0.42), vUv.y);
  vec3 air = vec3(0.72, 0.87, 0.96);
  gl_FragColor = vec4(mix(green, air, mix(0.72, 0.52, near) - vUv.y * 0.1), 1.0);
}
`;

export function Hills() {
  const geometry = useDisposable(buildHills);
  const material = useDisposable(() => shaderMaterial({
    uniforms: {},
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: hillFragment,
    side: THREE.DoubleSide,
  }));
  return <mesh geometry={geometry} material={material} renderOrder={-400} />;
}

export function Dome() {
  const parts = useDisposable(buildDome);
  const materials = useDisposable(() => ({
    outer: new THREE.MeshStandardMaterial({ color: '#f2f7f6', roughness: 0.26, metalness: 0.12, envMapIntensity: 1.1 }),
    inner: new THREE.MeshStandardMaterial({ color: '#e6eeee', roughness: 0.32, metalness: 0.2, envMapIntensity: 1 }),
    panes: shaderMaterial({
      uniforms: { ...fx },
      vertexShader: paneVertex,
      fragmentShader: paneFragment,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
    }),
  }));
  return (
    <>
      <SkyDome top="#2a80dc" horizon="#c6ecff" bottom="#d8f2ff" exponent={0.5} sunDirection={SUN_DIR.toArray()} sunColor="#fff0cf" sunDisc={9} sunGlow={1.3} sunSize={1.4} />
      <CloudField count={34} center={[0, 170, 0]} area={[1700, 1700]} heightJitter={45} size={[150, 320]} speed={2.2} seed={9} shade="#a9c6e6" fogColor="#d6f0ff" fogNear={400} fogFar={1600} />
      <Hills />
      <mesh geometry={parts.outer} material={materials.outer} castShadow />
      <mesh geometry={parts.inner} material={materials.inner} />
      <mesh geometry={parts.panes} material={materials.panes} renderOrder={30} />
    </>
  );
}
