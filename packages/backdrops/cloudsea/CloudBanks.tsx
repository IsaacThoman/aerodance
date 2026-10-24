import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom, smoothstep } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { atmos, viewDirection } from './palette.ts';
import { atmosGLSL } from './shaders.ts';

const CELL = 256;

// The atlas's four heaps: how many big puffs sit along the base, how many more stack up on
// them (a tower), and how many times puffs sprout smaller puffs over their tops.
const SHAPES: readonly [base: number, stack: number, sprouts: number][] = [
  [3, 1, 3],
  [5, 0, 3],
  [2, 1, 3],
  [6, 0, 2],
];

interface Puff { x: number; y: number; r: number }

/**
 * A 2×2 atlas of cumulus heaps as relief: each pixel holds the normal of a smooth union of
 * sphere caps (rg), how deep in the cloud it is (b: 0 at a thin edge or a crease, 1 inside) and
 * its coverage (a), so the shader can light them by the same sun as the deck.
 */
function cumulusAtlas(seed: number): THREE.DataTexture {
  const size = CELL * 2;
  const data = new Uint8Array(size * size * 4);
  const rand = makeRandom(seed);
  SHAPES.forEach(([base, stack, sprouts], cell) => {
    const ox = (cell % 2) * CELL;
    const oy = Math.floor(cell / 2) * CELL;
    // Grown in unit space: big puffs along the base and up the stack, each sprouting smaller
    // puffs over its upper side (cauliflower), then fitted to the cell.
    const puffs: Puff[] = [];
    const grow = (x: number, y: number, r: number, depth: number) => {
      puffs.push({ x, y, r });
      if (depth === 0) return;
      const n = rand.int(2, 4);
      for (let i = 0; i < n; i++) {
        const angle = rand.range(-1.25, 1.25);
        const dist = r * rand.range(0.6, 0.85);
        grow(x + Math.sin(angle) * dist, y + Math.cos(angle) * dist * 0.85, r * rand.range(0.42, 0.6), depth - 1);
      }
    };
    for (let i = 0; i < base; i++) {
      const x = (i - (base - 1) / 2) * rand.range(0.9, 1.15);
      const r = rand.range(0.85, 1.1) * (1 - Math.abs(i - (base - 1) / 2) / base * 0.5);
      grow(x, r * 0.5, r, sprouts - 1);
    }
    let sx = rand.range(-0.3, 0.3);
    for (let i = 0; i < stack; i++) {
      sx += rand.range(-0.35, 0.35);
      grow(sx, 1.1 + i * 0.95, 0.95 - i * 0.12, sprouts);
    }
    // Fit to the cell: centred, the base on the bottom margin, the larger side filling it.
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of puffs) {
      x0 = Math.min(x0, p.x - p.r);
      x1 = Math.max(x1, p.x + p.r);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y + p.r);
    }
    const scale = (CELL * 0.92) / Math.max(x1 - x0, (y1 - y0) * 1.04);
    for (const p of puffs) {
      p.x = CELL / 2 + (p.x - (x0 + x1) / 2) * scale;
      p.y = CELL * 0.04 + (p.y - y0) * scale;
      p.r *= scale;
    }
    // Smooth union of the caps, puff by puff over each one's square, as in the deck's shader.
    const k = CELL * 0.035;
    const h = new Float32Array(CELL * CELL);
    const gx = new Float32Array(CELL * CELL);
    const gy = new Float32Array(CELL * CELL);
    for (const p of puffs) {
      const x0 = Math.max(0, Math.floor(p.x - p.r));
      const x1 = Math.min(CELL - 1, Math.ceil(p.x + p.r));
      // Sprite space runs y up from the cell's bottom edge; rows run down.
      const y0 = Math.max(0, Math.floor(CELL - p.y - p.r));
      const y1 = Math.min(CELL - 1, Math.ceil(CELL - p.y + p.r));
      for (let py = y0; py <= y1; py++) {
        const dy = p.y - (CELL - py - 0.5);
        for (let px = x0; px <= x1; px++) {
          const dx = p.x - (px + 0.5);
          const s = p.r * p.r - dx * dx - dy * dy;
          if (s <= 0) continue;
          const j = py * CELL + px;
          const cap = Math.sqrt(s);
          const inv = 1 / Math.max(cap, p.r * 0.2);
          const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (cap - h[j])) / k));
          h[j] += (cap - h[j]) * t + k * t * (1 - t);
          gx[j] += (dx * inv - gx[j]) * t;
          gy[j] += (dy * inv - gy[j]) * t;
        }
      }
    }
    for (let py = 0; py < CELL; py++) {
      const y = CELL - py - 0.5;
      for (let px = 0; px < CELL; px++) {
        const j = py * CELL + px;
        const len = Math.hypot(gx[j], gy[j], 1);
        const depth = Math.min(1, h[j] / (CELL * 0.07));
        const alpha = smoothstep(0, CELL * 0.022, h[j]) * smoothstep(CELL * 0.02, CELL * 0.1, y);
        const i = ((oy + py) * size + ox + px) * 4;
        data[i] = Math.round((-gx[j] / len) * 127.5 + 127.5);
        data[i + 1] = Math.round((-gy[j] / len) * 127.5 + 127.5);
        data[i + 2] = Math.round(depth * 255);
        data[i + 3] = Math.round(alpha * 255);
      }
    }
  });
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  // Rows were written top-down.
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// Heaps along the horizon, kept clear of the sun: [x in NDC of a 16:9 frame, distance, size
// (the sprite is square; each heap keeps its own proportions within it), cell, flip].
const BANKS: readonly [x: number, distance: number, size: number, cell: number, flip: 1 | -1][] = [
  [-0.74, 3000, 640, 1, 1],
  [-0.4, 3500, 560, 2, -1],
  [-1.12, 2600, 560, 3, 1],
  [0.84, 2700, 380, 2, 1],
  [1.02, 3000, 620, 0, -1],
  [0.12, 3700, 620, 3, -1],
];

// Their slow drift to the right and the span they wrap over (out of sight at either end).
const BANK_DRIFT = 1.6;
const BANK_SPAN = 9000;

/**
 * Towering cumulus heaped up along the horizon, rising out of the haze: camera-facing sprites
 * lit like the deck (gold rims towards the sun, lavender away from it) drifting slowly sideways.
 */
export function CloudBanks() {
  const texture = useDisposable(() => cumulusAtlas(11));
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    g.setAttribute('uv', plane.attributes.uv);
    // Far ones first, so nearer heaps blend over them.
    const banks = [...BANKS].sort((a, b) => b[1] - a[1]);
    const centers = new Float32Array(banks.length * 3);
    const sizes = new Float32Array(banks.length * 3);
    banks.forEach(([x, distance, size, cell, flip], i) => {
      const d = viewDirection(x, 0.46);
      d.y = 0;
      d.normalize().multiplyScalar(distance);
      centers.set([d.x, -14, d.z], i * 3);
      sizes.set([size * flip, size, cell], i * 3);
    });
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
    g.instanceCount = banks.length;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: { ...atmos, uMap: { value: texture }, uDrift: { value: BANK_DRIFT }, uSpan: { value: BANK_SPAN } },
      vertexShader: /* glsl */ `
        attribute vec3 aCenter;
        attribute vec3 aSize;
        uniform float uTime, uDrift, uSpan;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vFade;
        varying float vFlip;
        void main() {
          vFlip = sign(aSize.x);
          vec3 c = aCenter;
          float x = mod(c.x + uSpan * 0.5 + uTime * uDrift, uSpan);
          c.x = x - uSpan * 0.5;
          vFade = smoothstep(0.0, 0.1, x / uSpan) * smoothstep(1.0, 0.9, x / uSpan);
          // Upright and turned to face the camera.
          vec3 toCam = cameraPosition - c;
          vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
          vec3 world = c + right * position.x * aSize.x + vec3(0.0, position.y * aSize.y, 0.0);
          vWorld = world;
          vec2 cell = vec2(mod(aSize.z, 2.0), floor(aSize.z / 2.0));
          // DataTexture rows run top-down from v = 0.
          vUv = (vec2(uv.x, 1.0 - uv.y) + cell) * 0.5;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vFade;
        varying float vFlip;
        ${atmosGLSL}
        void main() {
          vec4 t = texture2D(uMap, vUv);
          float a = t.a * vFade;
          if (a < 0.004) discard;
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 v = toCam / dist;
          vec3 right = normalize(vec3(v.z, 0.0, -v.x));
          vec3 up = cross(v, right);
          vec2 nxy = (t.rg * 2.0 - 1.0) * vec2(vFlip, 1.0);
          vec3 n = normalize(right * nxy.x + up * nxy.y + v * sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
          vec3 col = cloudShade(n, v, mix(0.3, 1.0, t.b), 1.0 - t.b);
          float x = max(1.0 - dot(-v, uSunDir), 0.0);
          col += uSunCol * exp(-x * 60.0) * 0.4;
          // Sunward edges catch a gold lining.
          col += uSunCol * pow(1.0 - t.b, 2.0) * max(dot(n, uKeyDir), 0.0) * 1.2;
          // Their feet sink into the haze; their heads rise clear of it.
          float lift = smoothstep(-10.0, 260.0, vWorld.y);
          col = mix(col, hazeColor(-v), fogAmount(dist) * mix(0.7, 0.28, lift));
          gl_FragColor = vec4(col * a, a);
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={5} />;
}
