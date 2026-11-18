import * as THREE from 'three';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { hash, shaderMaterial } from '../../../../../packages/stages/shared/glsl.ts';
import { makeRandom } from '../../../../../packages/stages/shared/random.ts';
import { FALLS_ANGLE, ISLETS, LIP, LIP_LEVEL, POND, SEA_Y, groundHeight, rimRadius, streamPath, undersideProfile } from './layout.ts';
import { W, commonGLSL, shadowGLSL } from './world.ts';

/*
 * The island itself: its grassy top rolling over the edge into the rock below it, the islets
 * drifting round it, the pond, the stream that runs from it and pours off the edge into the sea of
 * clouds far below, and the mist the falls (and fog) raise.
 */

// The island as one surface: rings from the middle across the top, over the rolled edge, then
// down the rock to its tip. Columns all the way round.
const SEGMENTS = 168;
const TOP_RINGS = 36;
const RIM_RINGS = 6;
const UNDER_RINGS = 44;

interface Surface { positions: number[]; rock: number[]; depth: number[]; islet: number[]; index: number[] }

// One floating landmass: `radius` of its edge at an angle, its ground's height, its underside
// profile; `id` 0 for the island, 1.. for the islets (they bob).
function addLand(out: Surface, segments: number, rings: [top: number, rim: number, under: number], edge: (a: number) => number, height: (x: number, z: number) => number, under: (t: number, a: number) => { radius: number; y: number }, at: [number, number, number], id: number) {
  const [topRings, rimRings, underRings] = rings;
  const start = out.positions.length / 3;
  const rows = 1 + topRings + rimRings + underRings;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), R = edge(a);
      let r: number, y: number, rock: number, depth = 0;
      if (j <= topRings) {
        r = (j / topRings) * R * 0.985;
        y = height(ca * r, sa * r);
        rock = 0;
      } else {
        const edgeY = height(ca * R * 0.985, sa * R * 0.985);
        if (j <= topRings + rimRings) {
          // The turf rolling over the edge.
          const phi = ((j - topRings) / rimRings) * Math.PI * 0.5;
          r = R * (0.985 + 0.024 * Math.sin(phi));
          y = edgeY - 1.3 * (1 - Math.cos(phi));
          rock = 0.5 * ((j - topRings) / rimRings);
        } else {
          const t = (j - topRings - rimRings) / underRings, p = under(t, a);
          r = R * 1.009 * p.radius;
          y = edgeY - 1.3 + (p.y + 1.6);
          rock = 0.5 + 0.5 * Math.min(1, t * 6);
          depth = t;
        }
      }
      out.positions.push(at[0] + ca * r, at[1] + y, at[2] + sa * r);
      out.rock.push(rock);
      out.depth.push(depth);
      out.islet.push(id);
    }
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a = start + j * segments + i, b = start + j * segments + ((i + 1) % segments);
      const c = a + segments, d = b + segments;
      index(out, a, b, c, d);
    }
  }
}
// Facing out (counter-clockwise seen from outside): the rings run outwards and downwards.
function index(out: Surface, a: number, b: number, c: number, d: number) { out.index.push(a, b, c, b, d, c); }

function buildLand() {
  const out: Surface = { positions: [], rock: [], depth: [], islet: [], index: [] };
  addLand(out, SEGMENTS, [TOP_RINGS, RIM_RINGS, UNDER_RINGS], rimRadius, groundHeight, undersideProfile, [0, 0, 0], 0);
  const rand = makeRandom(23);
  ISLETS.forEach(([x, y, z, r], k) => {
    const p1 = rand.range(0, 6), p2 = rand.range(0, 6), deep = rand.range(1.6, 2.4);
    addLand(out, 36, [4, 3, 12],
      (a) => r * (1 + 0.14 * Math.sin(3 * a + p1) + 0.08 * Math.sin(5 * a + p2)),
      (px, pz) => 0.22 * r * (1 - Math.min(1, (px * px + pz * pz) / (r * r))),
      (t, a) => ({ radius: Math.pow(1 - Math.pow(t, 1.6), 0.5) * (1 - 0.3 * t) * (1 + 0.14 * Math.sin(a * 4 + t * 7 + p1) * Math.sin(t * Math.PI)), y: -1.6 - r * deep * Math.pow(t, 1.1) * 0.75 }),
      [x, y, z], k + 1);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
  g.setAttribute('aRock', new THREE.Float32BufferAttribute(out.rock, 1));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(out.depth, 1));
  g.setAttribute('aIslet', new THREE.Float32BufferAttribute(out.islet, 1));
  g.setIndex(out.index);
  g.computeVertexNormals();
  return g;
}

/** How an islet bobs (it's in the shaders too). */
export const isletBob = /* glsl */ `
float isletBob(float id) { return id > 0.5 ? sin(uTime * 0.16 + id * 1.9) * 0.8 : 0.0; }
`;

export function Land() {
  const geometry = useDisposable(buildLand);
  const material = useDisposable(() => shaderMaterial({
    uniforms: {
      ...W,
      uGrassA: { value: new THREE.Color('#25861f') }, uGrassB: { value: new THREE.Color('#4cb52e') }, uLime: { value: new THREE.Color('#9bdc3c') },
      uSheen: { value: new THREE.Color('#d2ff8c') }, uSoil: { value: new THREE.Color('#5d4430') },
      uRockA: { value: new THREE.Color('#c9a47a') }, uRockB: { value: new THREE.Color('#a8744a') }, uRockC: { value: new THREE.Color('#7a4a32') }, uMoss: { value: new THREE.Color('#3f8436') },
      uCrystal: { value: new THREE.Color('#58f2ff') },
    },
    vertexShader: /* glsl */ `
      attribute float aRock;
      attribute float aDepth;
      attribute float aIslet;
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vRock;
      varying float vDepth;
      ${isletBob}
      void main() {
        vec3 p = position;
        p.y += isletBob(aIslet);
        vWorld = p;
        vNormal = normal;
        vRock = aRock;
        vDepth = aDepth;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uGrassA, uGrassB, uLime, uSheen, uSoil, uRockA, uRockB, uRockC, uMoss, uCrystal;
      uniform vec2 uDrift;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vRock;
      varying float vDepth;
      ${commonGLSL}
      ${shadowGLSL}
      ${hash}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / max(dist, 1e-3);
        vec4 nz = tnoise(vWorld.xz * 0.035);
        vec4 nf = tnoise(vWorld.xz * 0.13 + 0.5);
        // The grass: soft patches of deep and bright green, lime where the light falls full on it,
        // meadows of pink and gold flowers, pale fronts of wind running across it.
        vec3 grass = mix(uGrassA, uGrassB, smoothstep(-0.5, 0.5, nz.r * 0.7 + nf.g * 0.3));
        float key = dot(n, uKeyDir);
        grass = mix(grass, uLime, smoothstep(0.55, 1.0, key) * 0.3);
        float flowers = smoothstep(0.38, 0.62, nf.b) * smoothstep(0.1, 0.4, nz.a);
        grass = mix(grass, mix(vec3(1.0, 0.55, 0.75), vec3(1.0, 0.85, 0.3), smoothstep(-0.3, 0.3, nf.r)), flowers * 0.28);
        vec2 w = uWindDir;
        vec2 along = vec2(dot(vWorld.xz, w), dot(vWorld.xz, vec2(-w.y, w.x)));
        float gust = tnoise(vec2(along.x * 0.045 - uGust, along.y * 0.02)).r;
        grass *= 1.0 + smoothstep(0.2, 0.7, gust) * (0.08 + 0.3 * uWind);
        // The rock: layered sandstone, sand, ochre and terracotta, its layers wavering; pitted and
        // weathered (noise on three planes, so nothing stretches down the steep sides); mossy
        // under the turf and on ledges; a dark band of soil just under the edge.
        vec3 bw = abs(n) + 0.001;
        bw /= bw.x + bw.y + bw.z;
        vec4 tri = tnoise(vWorld.yz * 0.07) * bw.x + tnoise(vWorld.xz * 0.07 + 0.31) * bw.y + tnoise(vWorld.xy * 0.07 + 0.63) * bw.z;
        vec4 fine = tnoise(vWorld.yz * 0.31) * bw.x + tnoise(vWorld.xz * 0.31 + 0.31) * bw.y + tnoise(vWorld.xy * 0.31 + 0.63) * bw.z;
        float l1 = sin(vWorld.y * 0.5 + tri.r * 2.4) * 0.5 + 0.5;
        float l2 = sin(vWorld.y * 1.15 + tri.g * 2.0 + fine.r * 0.5 + 1.7) * 0.5 + 0.5;
        vec3 rock = mix(uRockA, uRockB, smoothstep(0.3, 0.75, l1));
        rock = mix(rock, uRockC, smoothstep(0.6, 0.92, l2) * 0.6);
        rock *= 0.88 + 0.2 * fine.b;
        rock *= mix(1.0, 0.84, smoothstep(0.55, 0.9, abs(fine.a)) * 0.6);
        rock = mix(rock, uMoss, max(smoothstep(0.26, 0.02, vDepth) * smoothstep(-0.35, 0.25, tri.a + fine.g * 0.3), smoothstep(0.45, 0.75, n.y) * 0.8) * 0.85);
        rock = mix(rock, uSoil, smoothstep(0.62, 0.5, vRock) * smoothstep(0.45, 0.55, vRock));
        float isRock = smoothstep(0.42, 0.6, vRock);
        vec3 albedo = mix(grass, rock, isRock);
        // Snow lying on what faces up, patchy as it starts.
        float s = uSnowCover * 1.3 - (1.0 - n.y) * 2.2 + nz.g * 0.3;
        float snow = smoothstep(0.32, 0.6, s);
        albedo = mix(albedo, vec3(0.9, 0.93, 0.98), snow);
        // Wet: darker, and glossy.
        float wet = uWet * (1.0 - snow);
        albedo *= 1.0 - 0.28 * wet;
        float shadow = mix(1.0, casterShadow(vWorld), 1.0 - isRock);
        float dif = clamp((key + mix(0.2, 0.5, isRock)) / mix(1.2, 1.5, isRock), 0.0, 1.0) * shadow;
        vec3 col = albedo * (uKeyColor * dif + ambient(n) + flashLight(n));
        // Velvet sheen on the grass at grazing angles, backlit towards the light.
        float graze = pow(max(1.0 - max(dot(n, v), 0.0), 0.0), 3.0);
        col += uSheen * graze * (0.04 + pow(max(dot(-v, uKeyDir) * 0.5 + 0.5, 0.0), 3.0) * 0.25) * (1.0 - isRock) * (1.0 - snow) * length(uKeyColor) * 0.35;
        float nv = max(dot(n, v), 0.0);
        col = mix(col, envColor(reflect(-v, n)), wet * (0.04 + 0.5 * pow(max(1.0 - nv, 0.0), 4.0)));
        col += uKeyColor * keyGlint(n, v, 60.0) * wet * 0.6 * shadow;
        col += vec3(1.0) * snow * keyGlint(n, v, 40.0) * 0.25 * length(uKeyColor);
        // A few aqua crystals set in the rock, glowing softly at night.
        vec3 cq = vWorld * 0.45;
        vec3 cc = floor(cq);
        float crnd = hash12(cc.xy + cc.z * 7.7);
        float crystal = smoothstep(0.3, 0.12, length(fract(cq) - 0.5 - (vec3(hash12(cc.yz), hash12(cc.zx + 3.1), crnd) - 0.5) * 0.5)) * step(0.93, crnd);
        crystal *= isRock * smoothstep(0.12, 0.35, vDepth);
        col += uCrystal * crystal * (0.05 + uNight * 0.7);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// ---- The pond ----

export function Pond() {
  const geometry = useDisposable(() => {
    const g = new THREE.CircleGeometry(POND.r * 0.98, 56);
    g.rotateX(-Math.PI / 2);
    g.translate(POND.x, POND.level, POND.z);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() { vWorld = position; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      ${commonGLSL}
      ${shadowGLSL}
      ${hash}
      // Rings spreading where raindrops land.
      vec2 ripples(vec2 p) {
        vec2 sum = vec2(0.0);
        for (int k = 0; k < 2; k++) {
          vec2 q = p * 0.75 + float(k) * 7.3;
          vec2 cell = floor(q);
          vec2 f = fract(q) - 0.5;
          float rnd = hash12(cell + float(k) * 13.0);
          float ph = fract(uTime * 0.85 + rnd);
          vec2 dv = f - (hash22(cell) - 0.5) * 0.4;
          float d = length(dv);
          float ring = sin((d - ph * 0.45) * 24.0) * smoothstep(0.12, 0.0, abs(d - ph * 0.45)) * (1.0 - ph);
          sum += dv / max(d, 1e-3) * ring * 0.22;
        }
        return sum;
      }
      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / max(dist, 1e-3);
        vec2 p = vWorld.xz;
        vec2 g = vec2(tnoise(p * 0.09 + vec2(uGust, 0.0)).r, tnoise(p * 0.09 + vec2(0.31, 0.17 - uGust)).g) * (0.04 + 0.12 * uWind);
        g += ripples(p) * uRain;
        vec3 n = normalize(vec3(g.x, 1.0, g.y));
        float nv = max(dot(n, v), 0.0);
        float fres = 0.03 + 0.97 * pow(max(1.0 - nv, 0.0), 5.0);
        vec3 refl = envColor(reflect(-v, n));
        float edge = smoothstep(0.5, 1.0, length(p - vec2(${POND.x.toFixed(2)}, ${POND.z.toFixed(2)})) / ${POND.r.toFixed(2)});
        float shadow = casterShadow(vWorld);
        vec3 lightIn = ambient(vec3(0.0, 1.0, 0.0)) + uKeyColor * max(uKeyDir.y, 0.0) * shadow * 0.5;
        vec3 body = mix(vec3(0.0, 0.07, 0.09), vec3(0.04, 0.32, 0.26), edge * 0.7) * lightIn;
        vec3 col = mix(body, refl, clamp(fres + 0.12, 0.0, 1.0));
        col += uKeyColor * keyGlint(n, v, 400.0) * 6.0 * shadow;
        // The greenhouse's and the lamps' warm light on the water at night.
        col += vec3(1.0, 0.65, 0.3) * uLamps * 0.015 * (1.0 - edge);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// ---- The stream and the falls ----

// Across the ribbon: five points, flat in the stream, bowed outwards in the falls.
const ACROSS = 5;

function buildWater() {
  const stream = streamPath(16);
  const out = [Math.cos(FALLS_ANGLE), Math.sin(FALLS_ANGLE)];
  const side = [-out[1], out[0]];
  // The course: the stream's points, then over the lip in an arc, then straight down, spreading.
  const points: { p: [number, number, number]; width: number; fall: number }[] = stream.map((p, i) => ({ p, width: 1.5 + 0.2 * (i / stream.length), fall: 0 }));
  for (let i = 1; i <= 8; i++) {
    const u = i / 8;
    points.push({ p: [LIP[0] + out[0] * 2.4 * u, LIP_LEVEL - 4.2 * u * u, LIP[1] + out[1] * 2.4 * u], width: 1.75 + 0.6 * u, fall: Math.min(1, u * 1.6) });
  }
  const drop = 26;
  for (let i = 1; i <= drop; i++) {
    const u = i / drop, y = LIP_LEVEL - 4.2 + (SEA_Y + 6 - (LIP_LEVEL - 4.2)) * u;
    const o = 2.4 + 2.2 * u;
    points.push({ p: [LIP[0] + out[0] * o, y, LIP[1] + out[1] * o], width: 2.35 + 5 * u * u, fall: 1 });
  }
  const positions: number[] = [], uvs: number[] = [], falls: number[] = [], index: number[] = [];
  let along = 0;
  points.forEach(({ p, width, fall }, i) => {
    if (i > 0) along += Math.hypot(p[0] - points[i - 1].p[0], p[1] - points[i - 1].p[1], p[2] - points[i - 1].p[2]);
    // The stream runs across its own course; the falls across the lip.
    const next = points[Math.min(i + 1, points.length - 1)].p, prev = points[Math.max(i - 1, 0)].p;
    let ax = -(next[2] - prev[2]), az = next[0] - prev[0];
    const len = Math.hypot(ax, az);
    if (fall > 0.5 || len < 1e-4) { ax = side[0]; az = side[1]; } else { ax /= len; az /= len; }
    for (let k = 0; k < ACROSS; k++) {
      const s = (k / (ACROSS - 1)) * 2 - 1;
      const bow = fall * (1 - s * s) * 0.45 * (0.6 + width * 0.12);
      positions.push(p[0] + ax * s * width * 0.5 + out[0] * bow, p[1] + (1 - fall) * 0.03, p[2] + az * s * width * 0.5 + out[1] * bow);
      uvs.push(k / (ACROSS - 1), along);
      falls.push(fall);
    }
    if (i < points.length - 1) {
      for (let k = 0; k < ACROSS - 1; k++) {
        const a = i * ACROSS + k, b = a + ACROSS;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aFall', new THREE.Float32BufferAttribute(falls, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The stream running from the pond, and the falls pouring off the edge into the clouds. */
export function Water() {
  const geometry = useDisposable(buildWater);
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      attribute float aFall;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vUv;
      varying float vFall;
      void main() {
        vWorld = position;
        vNormal = normal;
        vUv = uv;
        vFall = aFall;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uFlow;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec2 vUv;
      varying float vFall;
      ${commonGLSL}
      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / max(dist, 1e-3);
        // Streaks of white water running down (faster as it falls), and along the stream.
        float streak = texture2D(uNoise, vec2(vUv.x * mix(0.6, 1.4, vFall) + 0.13, vUv.y * mix(0.08, 0.03, vFall) - mix(uFlow.x, uFlow.y, vFall))).r;
        float foam = smoothstep(0.35, 0.8, streak);
        float sideFade = 1.0 - pow(abs(vUv.x * 2.0 - 1.0), 3.0);
        // The stream: glossy, mirroring the sky.
        vec3 n = vec3(0.0, 1.0, 0.0);
        float nv = max(dot(n, v), 0.0);
        vec3 stream = mix(vec3(0.02, 0.2, 0.2) * ambient(n), envColor(reflect(-v, n)), 0.15 + 0.85 * pow(max(1.0 - nv, 0.0), 4.0));
        stream += uKeyColor * keyGlint(n, v, 200.0) * 3.0;
        stream = mix(stream, vec3(0.95) * (ambient(n) + uKeyColor * 0.6), foam * 0.25);
        // The falls: white water, lit from above and through, aqua where it's thin.
        vec3 fn = normalize(vNormal);
        if (dot(fn, v) < 0.0) fn = -fn;
        vec3 white = (ambient(fn) * 1.1 + uKeyColor * (0.45 + 0.35 * max(dot(fn, uKeyDir), 0.0)) + flashLight(fn)) * mix(vec3(0.62, 0.92, 0.95), vec3(1.0), foam);
        white += uKeyColor * pow(max(dot(-v, uKeyDir), 0.0), 6.0) * 0.6;
        vec3 col = mix(stream, white, vFall);
        float alpha = mix(0.88, (0.42 + 0.5 * foam) * sideFade, vFall);
        // Lost in the mist long before the clouds.
        alpha *= 1.0 - smoothstep(-34.0, -62.0, vWorld.y);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={4} />;
}

// ---- Mist ----

// [x, y, z, size, kind]: kind 0 the falls' spray and mist (always), 1 fog banks round the island (in fog).
function mistSites() {
  const rand = makeRandom(77);
  const out = [Math.cos(FALLS_ANGLE), Math.sin(FALLS_ANGLE)];
  const sites: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const o = 5 + rand.range(-2, 5), s = rand.range(-6, 6);
    sites.push([LIP[0] + out[0] * o - out[1] * s, SEA_Y + rand.range(3, 12), LIP[1] + out[1] * o + out[0] * s, rand.range(20, 30), 0]);
  }
  for (let i = 0; i < 3; i++) {
    const o = 4 + i * 0.6;
    sites.push([LIP[0] + out[0] * o, -22 - i * 11, LIP[1] + out[1] * o, 9 + i * 4, 0]);
  }
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rand.range(-0.2, 0.2), r = rand.range(30, 44);
    sites.push([Math.cos(a) * r, rand.range(-26, 2), Math.sin(a) * r, rand.range(34, 50), 1]);
  }
  return sites;
}

/** Soft mist: the spray where the falls drop into the clouds, and banks of fog round the island when it's foggy. */
export function Mist() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    g.setAttribute('uv', plane.attributes.uv);
    const sites = mistSites();
    g.setAttribute('aMist', new THREE.InstancedBufferAttribute(new Float32Array(sites.flatMap((s) => s.slice(0, 4))), 4));
    g.setAttribute('aKind', new THREE.InstancedBufferAttribute(new Float32Array(sites.map((s, i) => s[4] + (i % 7) * 0.1)), 1));
    g.instanceCount = sites.length;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      attribute vec4 aMist;
      attribute float aKind;
      uniform float uTime;
      varying vec2 vUv;
      varying float vKind;
      varying float vSeed;
      varying vec3 vWorld;
      void main() {
        vec3 c = aMist.xyz + vec3(sin(uTime * 0.05 + aKind * 9.0), sin(uTime * 0.07 + aKind * 5.0) * 0.3, cos(uTime * 0.04 + aKind * 7.0)) * aMist.w * 0.08;
        vec4 mv = viewMatrix * vec4(c, 1.0);
        mv.xy += position.xy * aMist.w;
        vUv = uv;
        vKind = floor(aKind + 0.01);
        vSeed = fract(aKind) * 10.0;
        vWorld = c;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vKind;
      varying float vSeed;
      varying vec3 vWorld;
      ${commonGLSL}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        float wisp = 0.7 + 0.3 * texture2D(uNoise, vUv * 0.5 + vSeed * 0.13 + uTime * 0.004).r;
        float a = exp(-r2 * 3.2) * wisp * (1.0 - smoothstep(0.75, 1.0, r2));
        float amount = vKind < 0.5 ? 0.5 + uFog * 0.3 : uFog * 0.55;
        vec3 col = mix(uCloudShade, uCloudLit, 0.65) + flashLight(vec3(0.0, 1.0, 0.0)) * 0.5;
        col = mix(col, hazeColor(normalize(vWorld - cameraPosition)), clamp(fogAmount(length(vWorld - cameraPosition)) * 0.6, 0.0, 1.0));
        gl_FragColor = vec4(col, a * amount);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={8} />;
}
