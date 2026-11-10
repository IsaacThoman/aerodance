import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { hash, shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { CAMERA_POSITION, atmos } from './palette.ts';
import { atmosGLSL } from './shaders.ts';

/** The deck's broad shape repeats every PERIOD world units, so its drift can wrap without a seam. */
const PERIOD = 2520;

// Drift of the deck, world units per second: towards the camera and a little to the right, so
// it feels like gliding forward over it.
const DRIFT: readonly [number, number] = [0.35, 1.25];

// The puffs are one baked tile of TILE_CELLS × TILE_CELLS cells, TEXELS across, repeated at
// four scales. Each octave: cells per PERIOD (whole tiles fit a period, so every drift wraps),
// height as a fraction of its cell size (on flat ground, and added where the deck heaps up), its
// share of the creases, and how much faster than the deck it drifts: the small puffs churning
// over the big mounds are what make it roll.
const TILE_CELLS = 8;
const TEXELS = 512;
const OCTAVES = [
  { cells: 16, height: 0.05, heaped: 0.15, crease: 0.4, drift: 1 },
  { cells: 48, height: 0.1, heaped: 0.28, crease: 0.55, drift: 1.14 },
  { cells: 120, height: 0.16, heaped: 0.2, crease: 0.45, drift: 1.3 },
  { cells: 280, height: 0.18, heaped: 0, crease: 0, drift: 1.45 },
] as const;
const tileOf = (cells: number) => (PERIOD / cells) * TILE_CELLS;
const TILES = OCTAVES.map((o) => tileOf(o.cells));

// Rows run from the horizon to under the camera, evenly spaced on screen rather than in depth
// (θ is the angle below the horizon of the flat deck); columns fan out with the view.
const ROWS = 280;
const COLUMNS = 224;
const THETA_FAR = Math.atan(CAMERA_POSITION[1] / 6000);
const THETA_NEAR = THREE.MathUtils.degToRad(64);
const FAN = Math.tan(THREE.MathUtils.degToRad(50));

function deckGeometry(): THREE.BufferGeometry {
  const [cx, cy, cz] = CAMERA_POSITION;
  const depth = (v: number) => cy / Math.tan(THETA_FAR + (THETA_NEAR - THETA_FAR) * Math.pow(v, 1.12));
  const positions = new Float32Array(ROWS * COLUMNS * 3);
  const spacing = new Float32Array(ROWS * COLUMNS);
  for (let j = 0; j < ROWS; j++) {
    const d = depth(j / (ROWS - 1));
    // World units between this row and its neighbours: the finest detail the row can carry.
    const step = Math.abs(depth(Math.max(0, j - 0.5) / (ROWS - 1)) - depth(Math.min(ROWS - 1, j + 0.5) / (ROWS - 1)));
    for (let i = 0; i < COLUMNS; i++) {
      const u = (i / (COLUMNS - 1)) * 2 - 1;
      const k = j * COLUMNS + i;
      positions.set([cx + u * FAN * (d + 24), 0, cz - d], k * 3);
      spacing[k] = Math.max(step, ((d + 24) * FAN * 2) / (COLUMNS - 1));
    }
  }
  const index: number[] = [];
  for (let j = 0; j < ROWS - 1; j++) {
    for (let i = 0; i < COLUMNS - 1; i++) {
      const a = j * COLUMNS + i;
      const b = a + COLUMNS;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('aSpacing', new THREE.BufferAttribute(spacing, 1));
  g.setIndex(index);
  return g;
}

// Slopes are stored as 0.5 + slope / SLOPE_RANGE.
const SLOPE_RANGE = 6.4;

/**
 * The puff tile: a seamless TILE_CELLS² grid of round caps on jittered cells, smoothly unioned,
 * baked once into a mipmapped texture. rg: the slope (d/dx, d/dz in cell units), b: the height.
 * Mipmapping does the deck's level of detail: far off, the slopes average out to smooth cloud.
 */
function puffTile(seed: number): THREE.DataTexture {
  const rand = makeRandom(seed);
  const cell = TEXELS / TILE_CELLS;
  const h = new Float32Array(TEXELS * TEXELS);
  const gx = new Float32Array(TEXELS * TEXELS);
  const gy = new Float32Array(TEXELS * TEXELS);
  const k = 0.34;
  for (let cy = 0; cy < TILE_CELLS; cy++) {
    for (let cx = 0; cx < TILE_CELLS; cx++) {
      const x = cx + rand.range(0.2, 0.8);
      const y = cy + rand.range(0.2, 0.8);
      const rad = rand.range(0.55, 0.95);
      // Over the puff's square, wrapping round the tile's edges.
      for (let py = Math.floor((y - rad) * cell); py <= Math.ceil((y + rad) * cell); py++) {
        const oy = y - (py + 0.5) / cell;
        const row = ((py % TEXELS) + TEXELS) % TEXELS;
        for (let px = Math.floor((x - rad) * cell); px <= Math.ceil((x + rad) * cell); px++) {
          const ox = x - (px + 0.5) / cell;
          const s = 1 - (ox * ox + oy * oy) / (rad * rad);
          if (s <= 0) continue;
          const j = row * TEXELS + (((px % TEXELS) + TEXELS) % TEXELS);
          // A round cap, its slope capped at the rim (where the smooth union hides it anyway).
          const q = Math.sqrt(s);
          const cap = rad * q;
          const inv = 1 / (rad * Math.max(q, 0.32));
          const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (cap - h[j])) / k));
          h[j] += (cap - h[j]) * t + k * t * (1 - t);
          gx[j] += (ox * inv - gx[j]) * t;
          gy[j] += (oy * inv - gy[j]) * t;
        }
      }
    }
  }
  const data = new Uint8Array(TEXELS * TEXELS * 4);
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  let sum = 0;
  for (let j = 0; j < TEXELS * TEXELS; j++) sum += Math.min(1, h[j]);
  for (let j = 0; j < TEXELS * TEXELS; j++) {
    data[j * 4] = byte(0.5 + gx[j] / SLOPE_RANGE);
    data[j * 4 + 1] = byte(0.5 + gy[j] / SLOPE_RANGE);
    data[j * 4 + 2] = byte(h[j]);
    data[j * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, TEXELS, TEXELS, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  // Its mean height, which the octaves are measured from, so distance (coarse mips) averages flat.
  texture.userData.mean = sum / (TEXELS * TEXELS);
  return texture;
}

const glslFloat = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// The deck's height field, shared by both stages: the vertices take its heights (at a mip
// level their spacing can carry), the pixels its slopes (so the shading stays smooth whatever
// the grid does at a silhouette) and its creases.
const deckGLSL = /* glsl */ `
uniform sampler2D uPuffs;
uniform float uPuffMean;
uniform vec2 uDeckOffset;
uniform vec4 uOffsetA;
uniform vec4 uOffsetB;
${hash}
const float PERIOD = ${glslFloat(PERIOD)};
${OCTAVES.map((o, i) => `const float TILE${i} = ${glslFloat(TILES[i])};\nconst float SIZE${i} = ${glslFloat(PERIOD / o.cells)};`).join('\n')}

// Smooth value noise repeating every \`cells\` cells per period (0..1) with its gradient in cell units.
vec3 vnoise(vec2 w, float cells, float seed) {
  vec2 p = w * (cells / PERIOD);
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(mod(i, cells) + seed);
  float b = hash12(mod(i + vec2(1.0, 0.0), cells) + seed);
  float c = hash12(mod(i + vec2(0.0, 1.0), cells) + seed);
  float d = hash12(mod(i + vec2(1.0, 1.0), cells) + seed);
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * vec2(b - a + k * u.y, c - a + k * u.x));
}

// Weight for detail \`size\` world units across, sampled every \`spacing\`: none once too few samples span it.
float lod(float size, float spacing) { return smoothstep(2.5, 7.0, size / spacing); }

// One octave of puffs from a sample of the tile: (height in cell units, slope).
vec3 octave(vec4 t) { return vec3(t.b, (t.rg - 0.5) * ${glslFloat(SLOPE_RANGE)}); }
`;

/**
 * The sea of clouds: one big grid displaced into heaped puffs, octaves of round domes (big mounds
 * carrying smaller and smaller puffs, like cauliflower cumulus) over a long, low swell. The
 * pattern drifts across the fixed grid, the finer octaves a little faster so the small puffs
 * churn over the mounds, and detail too fine for the grid (or a pixel) fades with distance so
 * nothing shimmers. Lit by the low sun ahead: lavender faces, peach tops and gold silver linings,
 * hazing into the sunrise towards the horizon.
 */
export function CloudSea() {
  const geometry = useDisposable(deckGeometry);
  const puffs = useDisposable(() => puffTile(5));
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: {
        ...atmos,
        uPuffs: { value: puffs },
        uPuffMean: { value: Number(puffs.userData.mean) },
        uDeckOffset: { value: new THREE.Vector2() },
        uOffsetA: { value: new THREE.Vector4() },
        uOffsetB: { value: new THREE.Vector4() },
      },
      vertexShader: /* glsl */ `
        attribute float aSpacing;
        varying vec3 vWorld;
        varying vec2 vSwell;
        varying float vHeap;
        ${deckGLSL}
        // An octave's height in world units about its mean, from the mip level this vertex's
        // spacing can carry (so far off it averages out flat).
        float heightOf(vec2 w, vec2 offset, float tile, float size, float ratio) {
          float level = max(0.0, log2(aSpacing * ${glslFloat(TEXELS)} / tile) + 1.0);
          return (textureLod(uPuffs, (w - offset) / tile, level).b - uPuffMean) * size * ratio;
        }
        void main() {
          vec2 w = position.xz;
          vec2 p = w - uDeckOffset;
          // The long swell, and where the deck heaps up into billows or lies flatter.
          vec3 sw = vnoise(p, 9.0, 3.0);
          float swell = 13.0 * lod(PERIOD / 9.0, aSpacing);
          vSwell = sw.yz * (9.0 / PERIOD) * swell;
          float heap = smoothstep(0.2, 0.8, vnoise(p, 10.0, 9.0).x);
          vHeap = heap;
          float h = (sw.x - 0.5) * swell;
          ${OCTAVES.slice(0, 3).map((o, i) => `h += heightOf(w, ${i === 0 ? 'uOffsetA.xy' : i === 1 ? 'uOffsetA.zw' : 'uOffsetB.xy'}, TILE${i}, SIZE${i}, ${glslFloat(o.height)} + ${glslFloat(o.heaped)} * heap);`).join('\n          ')}
          // Towards the horizon the deck settles flat, as real ones look, and its edge stays clean.
          float settle = 1.0 - smoothstep(450.0, 1500.0, distance(w, vec2(${glslFloat(CAMERA_POSITION[0])}, ${glslFloat(CAMERA_POSITION[2])})));
          vWorld = vec3(w.x, h * settle + 8.0, w.y);
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec2 vSwell;
        varying float vHeap;
        ${deckGLSL}
        ${atmosGLSL}
        void main() {
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 v = toCam / dist;
          vec2 w = vWorld.xz;
          vec3 o0 = octave(texture2D(uPuffs, (w - uOffsetA.xy) / TILE0));
          vec3 o1 = octave(texture2D(uPuffs, (w - uOffsetA.zw) / TILE1));
          vec3 o2 = octave(texture2D(uPuffs, (w - uOffsetB.xy) / TILE2));
          vec3 o3 = octave(texture2D(uPuffs, (w - uOffsetB.zw) / TILE3));
          ${OCTAVES.map((o, i) => `float r${i} = ${glslFloat(o.height)} + ${glslFloat(o.heaped)} * vHeap;`).join('\n          ')}
          vec2 slope = vSwell + r0 * o0.yz + r1 * o1.yz + r2 * o2.yz + r3 * o3.yz;
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
          // 0 deep between puffs, 1 on top.
          float c = (o0.x * ${glslFloat(OCTAVES[0].crease)} + o1.x * ${glslFloat(OCTAVES[1].crease)} + o2.x * ${glslFloat(OCTAVES[2].crease)}) / ${glslFloat(OCTAVES[0].crease + OCTAVES[1].crease + OCTAVES[2].crease)};
          vec3 col = cloudShade(n, v, clamp(0.25 + c * 1.1, 0.0, 1.0), 0.0);
          // The foreground, looked down into, sits a little deeper in the lavender.
          col *= mix(vec3(0.84, 0.82, 0.92), vec3(1.0), smoothstep(45.0, 260.0, dist));
          // Light scattered forward through the deck towards the sun.
          float x = max(1.0 - dot(-v, uSunDir), 0.0);
          col += uSunCol * (exp(-x * 60.0) * 0.5 + exp(-x * 12.0) * 0.12);
          col = mix(col, hazeColor(-v), fogAmount(dist));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );

  // Each octave's drift wraps at its own tile, the broad shape's at the period: no seams, ever.
  useBackdropFrame((_state, _delta, t) => {
    const u = material.uniforms;
    const x = t * DRIFT[0];
    const z = t * DRIFT[1];
    u.uDeckOffset.value.set(x % PERIOD, z % PERIOD);
    u.uOffsetA.value.set((x * OCTAVES[0].drift) % TILES[0], (z * OCTAVES[0].drift) % TILES[0], (x * OCTAVES[1].drift) % TILES[1], (z * OCTAVES[1].drift) % TILES[1]);
    u.uOffsetB.value.set((x * OCTAVES[2].drift) % TILES[2], (z * OCTAVES[2].drift) % TILES[2], (x * OCTAVES[3].drift) % TILES[3], (z * OCTAVES[3].drift) % TILES[3]);
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
