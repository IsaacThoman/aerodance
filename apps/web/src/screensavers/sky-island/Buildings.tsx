import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { hash, shaderMaterial } from '../../../../../packages/stages/shared/glsl.ts';
import { GREENHOUSE, LAMPS, TOWER, TURBINES, groundHeight } from './layout.ts';
import { W, commonGLSL } from './world.ts';

/*
 * What's built on the island, in glossy white enamel and aqua glass: the clock tower (its four
 * faces telling the time, lit from inside at night), the greenhouse, the wind turbines, the lamps.
 */

const WHITE = new THREE.Color('#eef4f8');
const AQUA = new THREE.Color('#38c8d8');
const CHROME = new THREE.Color('#c8d6e0');

// Tags a part with its colour and glow, keeping only what the enamel shader reads.
// (Unindexed, as some of three's shapes come: mergeGeometries wants them all one way.)
function part(g: THREE.BufferGeometry, tint: THREE.Color, emit = 0) {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute('uv');
  const n = geo.attributes.position.count;
  const tints = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) tints.set([tint.r, tint.g, tint.b], i * 3);
  geo.setAttribute('aTint', new THREE.BufferAttribute(tints, 3));
  geo.setAttribute('aEmit', new THREE.BufferAttribute(new Float32Array(n).fill(emit), 1));
  return geo;
}
const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => { g.translate(x, y, z); return g; };

/** The clock tower's height above the ground where it stands. */
export const towerBase = () => groundHeight(TOWER.x, TOWER.z);

function towerParts(): THREE.BufferGeometry[] {
  const { x, z } = TOWER, g = towerBase() - 0.15;
  const ring = (r: number, tube: number, y: number) => { const t = new THREE.TorusGeometry(r, tube, 8, 36); t.rotateX(Math.PI / 2); return at(t, x, g + y, z); };
  return [
    part(at(new THREE.CylinderGeometry(2.6, 2.9, 1.0, 32), x, g + 0.5, z), WHITE),
    part(at(new THREE.CylinderGeometry(2.1, 2.3, 0.5, 32), x, g + 1.2, z), WHITE),
    part(at(new THREE.CylinderGeometry(1.45, 1.7, 8.6, 32, 1, true), x, g + 5.6, z), WHITE),
    part(ring(1.62, 0.17, 4.2), AQUA),
    part(ring(1.52, 0.17, 7.8), AQUA),
    part(at(new THREE.CylinderGeometry(2.55, 1.5, 1.1, 32), x, g + 10.3 - 0.2, z), WHITE),
    part(at(new RoundedBoxGeometry(TOWER.half * 2, TOWER.half * 2, TOWER.half * 2, 3, 0.62), x, g + TOWER.clockY, z), WHITE),
    part(at(new RoundedBoxGeometry(TOWER.half * 2 + 0.5, 0.42, TOWER.half * 2 + 0.5, 2, 0.18), x, g + TOWER.top, z), AQUA),
    part(at(new THREE.SphereGeometry(0.34, 16, 10), x, g + TOWER.top + TOWER.cupola + 0.25, z), CHROME),
  ];
}

// A turbine's hub, in its own units (its tower is 13 tall).
const HUB = new THREE.Vector3(0, 13.2, 1.1);

function turbineParts(): THREE.BufferGeometry[] {
  return TURBINES.flatMap(({ x, z, s }) => {
    const g = groundHeight(x, z) - 0.2;
    const tower = new THREE.CylinderGeometry(0.34, 0.62, 13, 16, 1, true);
    tower.translate(0, 6.5, 0);
    const foot = new THREE.CylinderGeometry(0.9, 1.0, 0.4, 16);
    foot.translate(0, 0.2, 0);
    const nacelle = new THREE.CapsuleGeometry(0.55, 1.7, 5, 14);
    nacelle.rotateX(Math.PI / 2);
    nacelle.translate(0, HUB.y, -0.2);
    return [tower, foot, nacelle].map((p) => { p.rotateY(TURBINE_YAW); p.scale(s, s, s); return part(at(p, x, g, z), WHITE); });
  });
}

/** Which way the turbines face: into the wind (uWindDir comes from behind the hero view's right). */
export const TURBINE_YAW = 0.55;

function greenhouseParts(): THREE.BufferGeometry[] {
  const { x, z, r } = GREENHOUSE, g = groundHeight(x, z);
  const base = new THREE.CylinderGeometry(r + 0.18, r + 0.32, 0.55, 64, 1, true);
  // The door, in a white frame, on the side facing the hero view and the pond.
  const door = new RoundedBoxGeometry(1.9, 2.8, 1.6, 2, 0.35);
  const doorAngle = Math.atan2(0.9, 0.45);
  door.rotateY(-doorAngle + Math.PI / 2);
  return [
    part(at(base, x, g + 0.2, z), WHITE),
    part(at(door, x + Math.cos(doorAngle) * (r - 0.35), g + 1.3, z + Math.sin(doorAngle) * (r - 0.35)), WHITE),
  ];
}

function lampParts(): THREE.BufferGeometry[] {
  return LAMPS.flatMap(([x, z]) => {
    const g = groundHeight(x, z);
    return [
      part(at(new THREE.CylinderGeometry(0.07, 0.11, 2.2, 8), x, g + 1.1, z), CHROME),
      part(at(new THREE.SphereGeometry(0.3, 16, 10), x, g + 2.45, z), new THREE.Color('#fff6e8'), 1),
    ];
  });
}

const enamelVertex = /* glsl */ `
  attribute vec3 aTint;
  attribute float aEmit;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vTint;
  varying float vEmit;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vTint = aTint;
    vEmit = aEmit;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const enamelFragment = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vTint;
  varying float vEmit;
  ${commonGLSL}
  void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(cameraPosition - vWorld);
    float snow = uSnowCover * smoothstep(0.55, 0.85, n.y);
    vec3 base = mix(vTint, vec3(0.9, 0.93, 0.97), snow);
    float dif = clamp((dot(n, uKeyDir) + 0.25) / 1.25, 0.0, 1.0);
    // (Kept under the bloom's threshold in full sun: only the glints glow.)
    vec3 col = base * (uKeyColor * dif * 0.62 + ambient(n) * 0.95 + flashLight(n));
    // Glossy enamel: the sky in it at grazing angles, a crisp highlight, glossier when wet.
    float nv = max(dot(n, v), 0.0);
    float gloss = mix(0.5, 0.85, uWet) * (1.0 - snow) * (1.0 - vEmit);
    col = mix(col, envColor(reflect(-v, n)) * 1.05, (0.04 + 0.96 * pow(max(1.0 - nv, 0.0), 4.0)) * gloss);
    col += uKeyColor * (keyGlint(n, v, 90.0) * 0.9 + keyGlint(n, v, 10.0) * 0.06) * gloss;
    // The Aero stripe: a soft bright band along the curves, from high behind the camera.
    vec3 hs = normalize(normalize(vec3(-0.3, 1.0, 0.6)) + v);
    col += ambient(n) * pow(max(dot(n, hs), 0.0), 40.0) * 0.6 * gloss;
    // The lamps' globes glow warm at night (and faintly by day).
    col += vEmit * vec3(1.0, 0.72, 0.38) * (0.25 + uLamps * 6.0);
    col = applyFog(col, vWorld);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Everything white that doesn't move, in one draw: the tower, the turbines' towers, the greenhouse's base and door, the lamps. */
export function Enamel() {
  const geometry = useDisposable(() => mergeGeometries([...towerParts(), ...turbineParts(), ...greenhouseParts(), ...lampParts()]));
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...W }, vertexShader: enamelVertex, fragmentShader: enamelFragment }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// One rotor: a spinner and three chunky rounded blades round the z axis (the buffer is 640x480: thin tips would shimmer).
function rotorGeometry() {
  const spinner = new THREE.SphereGeometry(0.5, 16, 10);
  spinner.scale(1, 1, 1.5);
  const parts: THREE.BufferGeometry[] = [part(spinner, WHITE)];
  for (let i = 0; i < 3; i++) {
    const shape = new THREE.Shape();
    shape.moveTo(-0.32, 0.25);
    shape.quadraticCurveTo(-0.85, 1.3, -0.6, 2.8);
    shape.lineTo(-0.28, 6.4);
    shape.quadraticCurveTo(0.02, 7.2, 0.24, 6.4);
    shape.lineTo(0.36, 2.8);
    shape.quadraticCurveTo(0.48, 1.2, 0.32, 0.25);
    shape.lineTo(-0.32, 0.25);
    const b = new THREE.ShapeGeometry(shape, 5);
    b.rotateY(0.32);
    b.rotateZ((i / 3) * Math.PI * 2);
    parts.push(part(b, WHITE));
  }
  return mergeGeometries(parts);
}

/** How far the rotors have turned: the driver winds it on with the wind. */
export const ROTOR = { value: 0 };

/** The turbines' rotors, spinning with the wind. */
export function Rotors() {
  const geometry = useDisposable(() => {
    const base = rotorGeometry();
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
    const hubs = new Float32Array(TURBINES.length * 3), params = new Float32Array(TURBINES.length * 4);
    TURBINES.forEach(({ x, z, s }, i) => {
      const hub = HUB.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), TURBINE_YAW).multiplyScalar(s);
      hubs.set([x + hub.x, groundHeight(x, z) - 0.2 + hub.y, z + hub.z], i * 3);
      // (Speeds in eighths, so the rotors' wound angle wraps without a jump: Saver.tsx.)
      params.set([TURBINE_YAW, s, i * 2.1, 1 - i * 0.125], i * 4);
    });
    g.setAttribute('aHub', new THREE.InstancedBufferAttribute(hubs, 3));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    g.instanceCount = TURBINES.length;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...W, uRotor: ROTOR },
    vertexShader: /* glsl */ `
      attribute vec3 aTint;
      attribute float aEmit;
      attribute vec3 aHub;
      attribute vec4 aParams;
      uniform float uRotor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vTint;
      varying float vEmit;
      vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
      void main() {
        float a = aParams.z - uRotor * aParams.w;
        vec3 p = position, n = normal;
        p.xy = rot(p.xy, a); n.xy = rot(n.xy, a);
        p.zx = rot(p.zx, aParams.x); n.zx = rot(n.zx, aParams.x);
        vWorld = aHub + p * aParams.y;
        vNormal = n;
        vTint = aTint;
        vEmit = aEmit;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: enamelFragment,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

/**
 * The glass: the greenhouse's dome and the tower's cupola, ribbed in white, mirroring the sky,
 * glowing warm from inside at night, beaded with drops when wet and capped with snow.
 */
export function Glass() {
  const geometry = useDisposable(() => {
    const dome = new THREE.SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = dome.index;
    g.setAttribute('position', dome.attributes.position);
    g.setAttribute('normal', dome.attributes.normal);
    const { x, z, r } = GREENHOUSE;
    // [x, y, z, radius], [ribs round, rings up, glow]
    const sites = [[x, groundHeight(x, z) + 0.35, z, r, 12, 3, 1], [TOWER.x, towerBase() - 0.15 + TOWER.top + 0.18, TOWER.z, TOWER.cupola, 8, 2, 0.55]];
    g.setAttribute('aSite', new THREE.InstancedBufferAttribute(new Float32Array(sites.flatMap((s) => s.slice(0, 4))), 4));
    g.setAttribute('aStyle', new THREE.InstancedBufferAttribute(new Float32Array(sites.flatMap((s) => s.slice(4))), 3));
    g.instanceCount = sites.length;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      attribute vec4 aSite;
      attribute vec3 aStyle;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      varying vec3 vStyle;
      void main() {
        vWorld = aSite.xyz + position * aSite.w;
        vNormal = normal;
        vLocal = position;
        vStyle = aStyle;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      varying vec3 vStyle;
      ${commonGLSL}
      ${hash}
      float lines(float x) {
        float w = fwidth(x) * 1.3;
        float d = abs(fract(x + 0.5) - 0.5);
        return 1.0 - smoothstep(w * 0.5, w, d);
      }
      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(cameraPosition - vWorld);
        float nv = max(dot(n, v), 0.0);
        float fres = 0.22 + 0.78 * pow(max(1.0 - nv, 0.0), 3.0);
        vec3 col = mix(vec3(0.2, 0.6, 0.6) * ambient(n) * 0.7, envColor(reflect(-v, n)) * 1.2, fres);
        // Lit from inside at night: the warm glow of the lamps among the plants.
        vec3 warm = vec3(1.0, 0.66, 0.3);
        float inner = (1.0 - fres) * smoothstep(0.95, 0.0, vLocal.y);
        col += warm * uLamps * inner * 0.6 * vStyle.z;
        float key = keyGlint(n, v, 24.0), glint = keyGlint(n, v, 180.0);
        col += uKeyColor * (key * 0.22 + glint * 1.4);
        // White ribs: meridians and rings, and the footing.
        float ang = atan(vLocal.z, vLocal.x + 1e-5) / 6.2831853 * vStyle.x;
        float lat = asin(clamp(vLocal.y, 0.0, 1.0)) / 1.5707963 * vStyle.y;
        float ribs = max(lines(ang) * smoothstep(0.97, 0.86, vLocal.y), lines(lat));
        ribs = max(ribs, smoothstep(0.08, 0.02, vLocal.y));
        vec3 ribCol = vec3(0.95) * (ambient(n) * 1.1 + uKeyColor * max(dot(n, uKeyDir), 0.0) * 0.8 + flashLight(n)) + warm * uLamps * 0.35 * vStyle.z;
        col = mix(col, ribCol, ribs * 0.8);
        // Drops beading on the glass when it's wet.
        vec3 q = vLocal * 15.0;
        vec3 cell = floor(q);
        float rnd = hash12(cell.xy + cell.z * 7.31);
        vec3 f = fract(q) - 0.5 - (vec3(hash12(cell.yz), hash12(cell.zx + 1.7), rnd) - 0.5) * 0.4;
        float drop = smoothstep(0.24, 0.12, length(f)) * step(0.5, rnd) * uWet;
        col += (envColor(n) * 0.6 + uKeyColor * 0.4) * drop * 0.8;
        // Snow on top.
        float snow = uSnowCover * smoothstep(0.5, 0.85, vLocal.y + tnoise(vLocal.xz * 1.3).r * 0.12);
        col = mix(col, vec3(0.9, 0.93, 0.98) * (ambient(n) + uKeyColor * max(dot(n, uKeyDir), 0.0) + flashLight(n)), snow);
        col = applyFog(col, vWorld);
        float a = clamp(0.3 + fres * 0.5 + key * 0.3 + glint + ribs * 0.75 + drop * 0.4 + snow + uLamps * 0.1 * vStyle.z, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={5} />;
}

/** The clock's hands (radians clockwise from 12), whether the second hand shows, and how brightly the faces are lit from inside. */
export const CLOCK = { hands: new THREE.Vector3(), second: { value: 0 }, light: { value: 0 } };

/**
 * The clock tower's four faces: pale glass dials with bold navy hands and hour marks in a chrome
 * bezel, drawn in the shader (crisp at any size), lit from inside at night.
 */
export function ClockFaces() {
  const geometry = useDisposable(() => {
    const g = towerBase() - 0.15 + TOWER.clockY;
    const faces = [0, 1, 2, 3].map((k) => {
      const face = new THREE.CircleGeometry(TOWER.faceR, 64);
      face.deleteAttribute('normal');
      const a = (k * Math.PI) / 2;
      face.translate(0, 0, TOWER.half + 0.04);
      face.rotateY(a);
      face.translate(TOWER.x, g, TOWER.z);
      const normals = new Float32Array(face.attributes.position.count * 3);
      for (let i = 0; i < face.attributes.position.count; i++) normals.set([Math.sin(a), 0, Math.cos(a)], i * 3);
      face.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      return face;
    });
    return mergeGeometries(faces);
  });
  const material = useDisposable(() => shaderMaterial({
    uniforms: { ...W, uHands: { value: CLOCK.hands }, uSecond: CLOCK.second, uFaceLight: CLOCK.light },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vWorld = position;
        vNormal = normal;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHands;
      uniform float uSecond, uFaceLight;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormal;
      ${commonGLSL}
      float segment(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
      float fill(float d) { float aa = max(fwidth(d), 1e-4); return 1.0 - smoothstep(-aa, aa, d); }
      float hand(vec2 p, float angle, float back, float len, float w) {
        vec2 dir = vec2(sin(angle), cos(angle));
        return fill(segment(p, -dir * back, dir * len) - w);
      }
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        vec3 n = normalize(vNormal);
        vec3 v = normalize(cameraPosition - vWorld);
        // The dial: pale glass, cooler towards its rim.
        vec3 dial = mix(vec3(0.95, 0.98, 1.0), vec3(0.66, 0.88, 0.97), smoothstep(0.25, 0.86, r));
        // Hour marks: bold bars at the quarters, dots between.
        float seg = 6.2831853 / 12.0;
        float a = atan(p.x, p.y + 1e-5);
        float k = floor(a / seg + 0.5);
        vec2 td = vec2(sin(k * seg), cos(k * seg));
        float quarter = step(mod(k + 12.0, 3.0), 0.5);
        float ticks = fill(mix(length(p - td * 0.72) - 0.055, segment(p, td * 0.6, td * 0.76) - 0.06, quarter));
        float ink = max(ticks, max(hand(p, uHands.x, 0.12, 0.47, 0.072), hand(p, uHands.y, 0.14, 0.7, 0.05)));
        ink = max(ink, fill(r - 0.09));
        float sec = max(hand(p, uHands.z, 0.2, 0.76, 0.017), fill(r - 0.045)) * uSecond;
        // Lit by the day, and from inside: a warm glow that makes it read at night.
        float dif = clamp((dot(n, uKeyDir) + 0.3) / 1.3, 0.0, 1.0);
        vec3 lit = dial * (ambient(n) * 1.1 + uKeyColor * dif * 0.75 + flashLight(n)) + dial * vec3(1.0, 0.9, 0.72) * uFaceLight * 1.5;
        vec3 inkCol = vec3(0.02, 0.07, 0.17) * (ambient(n) + uKeyColor * dif * 0.4 + 0.02);
        vec3 col = mix(lit, inkCol, ink);
        col = mix(col, vec3(1.0, 0.38, 0.12) * (ambient(n) + uKeyColor * dif * 0.6 + uFaceLight * 0.9), sec);
        // The chrome bezel, mirroring the sky.
        float bezel = smoothstep(0.86, 0.885, r);
        vec3 r3 = reflect(-v, n);
        vec3 chrome = envColor(vec3(r3.x, abs(r3.y) * 0.6 + 0.2 * (1.0 - r), r3.z)) * 1.1 * (0.7 + 0.5 * smoothstep(0.9, 0.97, r)) + uKeyColor * keyGlint(n, v, 30.0) * 0.8;
        col = mix(col, chrome, bezel);
        // Its glass: a soft reflection of the sky, and a glossy highlight across its top.
        float nv = max(dot(n, v), 0.0);
        col += envColor(r3) * (0.04 + 0.4 * pow(max(1.0 - nv, 0.0), 4.0)) * (1.0 - bezel);
        float gloss = smoothstep(0.2, 0.75, p.y) * (1.0 - smoothstep(0.55, 0.8, length(p - vec2(-0.05, 0.25)))) * (1.0 - bezel);
        col += vec3(1.0) * gloss * 0.18 * (ambient(n).g + 0.3);
        col += uKeyColor * keyGlint(n, v, 200.0) * 2.0 * (1.0 - bezel);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
