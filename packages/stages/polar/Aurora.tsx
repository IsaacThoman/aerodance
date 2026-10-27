import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { noiseTexture, palette, polar, ripple } from './world.ts';

/**
 * One auroral curtain: a vertical sheet hanging from a folding line far beyond the mountains.
 * They're hundreds to thousands of units away and tall to match, so the camera's far plane has
 * to reach them.
 */
export interface Curtain {
  /** [x0, z0, x1, z1]: the line it hangs along, before folding. */
  line: [number, number, number, number];
  /** Height of its lower edge at either end. */
  bottom: [number, number];
  /** How tall it is at either end. */
  height: [number, number];
  /** Fold depth (world units) and a broad bow out of the line. */
  fold: number;
  bow: number;
  /** Brightness at either end. */
  gain: [number, number];
  /** Rays along its length. */
  rays: number;
  seed: number;
  /** Drawn again mirrored below y = 0, for a stage with a mirror: only the bright, low ones, whose reflections show. */
  reflected: boolean;
}

// Steps along each curtain: enough for smooth folds, few enough that its triangles aren't
// slivers a pixel wide, which the GPU shades very wastefully.
const SEGMENTS = 240;

/**
 * Builds every curtain into one strip geometry (a column of two vertices per step along each),
 * each vertex carrying its curtain's shape, so they fold and shimmer in one draw.
 */
function curtainGeometry(curtains: readonly Curtain[]): THREE.BufferGeometry {
  const verts = curtains.length * (SEGMENTS + 1) * 2;
  const uv = new Float32Array(verts * 2);
  const line = new Float32Array(verts * 4);
  const base = new Float32Array(verts * 4);
  const look = new Float32Array(verts * 4);
  const fold = new Float32Array(verts * 2);
  const index: number[] = [];
  let v = 0;
  curtains.forEach((c) => {
    const first = v;
    for (let i = 0; i <= SEGMENTS; i++) {
      for (let j = 0; j < 2; j++) {
        uv.set([i / SEGMENTS, j], v * 2);
        line.set(c.line, v * 4);
        base.set([...c.bottom, ...c.height], v * 4);
        look.set([c.seed, ...c.gain, c.rays], v * 4);
        fold.set([c.fold, c.bow], v * 2);
        v++;
      }
      if (i < SEGMENTS) {
        const a = first + i * 2;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  // Positions are computed in the shader; this only gives three a vertex count and bounds.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aLine', new THREE.BufferAttribute(line, 4));
  g.setAttribute('aBase', new THREE.BufferAttribute(base, 4));
  g.setAttribute('aLook', new THREE.BufferAttribute(look, 4));
  g.setAttribute('aFold', new THREE.BufferAttribute(fold, 2));
  g.setIndex(index);
  return g;
}

function curtainMaterial(mirror: boolean) {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    defines: mirror ? { MIRROR: '' } : {},
    uniforms: { uTime: polar.uTime, uNoise: polar.uNoise },
    vertexShader: /* glsl */ `
      attribute vec4 aLine, aBase, aLook;
      attribute vec2 aFold;
      uniform float uTime;
      varying vec2 vUv;
      varying vec2 vLook;
      varying float vStrength;
      #ifdef MIRROR
      varying vec3 vWorld;
      #endif

      // The hanging line, folded by slow travelling waves and bowed out in the middle.
      vec2 hang(float u) {
        vec2 a = aLine.xy;
        vec2 b = aLine.zw;
        vec2 side = normalize(b - a);
        side = vec2(-side.y, side.x);
        float s = aLook.x;
        // Mostly broad waves: tight ones would fold the sheet back over itself into hard seams.
        float fold = 0.62 * sin(6.2832 * (u * 2.3 + s) + uTime * 0.11)
          + 0.3 * sin(6.2832 * (u * 5.1 + s * 1.7) - uTime * 0.17)
          + 0.1 * sin(6.2832 * (u * 10.3 + s * 2.3) + uTime * 0.23)
          + 0.05 * sin(6.2832 * (u * 17.0 + s) - uTime * 0.55);
        return mix(a, b, u) + side * (fold * aFold.x + sin(3.14159 * u) * aFold.y);
      }

      void main() {
        float u = uv.x;
        vec2 p = hang(u);
        vec2 tangent = normalize(hang(u + 0.002) - p);
        float s = aLook.x;
        // The lower edge waves gently, with small ripples running along it.
        float bottom = mix(aBase.x, aBase.y, u) + 30.0 * sin(6.2832 * (u * 3.1 + s) + uTime * 0.09)
          + 7.0 * sin(6.2832 * (u * 13.0 - s) - uTime * 0.45);
        float height = mix(aBase.z, aBase.w, u) * (0.85 + 0.15 * sin(6.2832 * (u * 1.7 + s * 3.0) - uTime * 0.05));
        vec3 pos = vec3(p.x, bottom + uv.y * height, p.y);
        #ifdef MIRROR
        pos.y = -pos.y;
        vWorld = pos;
        #endif
        // Everything that varies only along the curtain is worked out here, per column, not per
        // pixel. Brighter where the sheet turns edge-on to us, as a real curtain is, but
        // softening right at the fold, where a sheet with no thickness would end in a hard line.
        vec3 normal = vec3(-tangent.y, 0.0, tangent.x);
        float facing = abs(dot(normal, normalize(cameraPosition - pos)));
        float edgeOn = 2.0 / (1.0 + facing) * smoothstep(0.02, 0.5, facing);
        // Slow swells of brightness travelling along it, fading out at its ends.
        float swell = 0.5 + 0.5 * sin(6.2832 * (u * 1.4 + s) - uTime * 0.16);
        swell = 0.45 + 0.55 * swell * (0.7 + 0.3 * sin(6.2832 * (u * 3.3 - s) + uTime * 0.21));
        float ends = smoothstep(0.0, 0.14, u) * (1.0 - smoothstep(0.86, 1.0, u));
        vStrength = mix(aLook.y, aLook.z, u) * edgeOn * swell * ends;
        #ifdef MIRROR
        vStrength *= 0.45;
        #endif
        vUv = uv;
        vLook = aLook.xw;
        gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec2 vLook;
      varying float vStrength;
      #ifdef MIRROR
      varying vec3 vWorld;
      #endif
      ${noiseTexture}
      ${palette}
      ${ripple}

      void main() {
        float u = vUv.x;
        float v = vUv.y;
        float seed = vLook.x;
        float rays = vLook.y;
        #ifdef MIRROR
        // The ripple where this reflection meets the mirror wobbles the curtain up and down. (Not
        // sideways: bending where the rays' noise is read scatters the reads and costs a lot,
        // and ripples stretch reflections vertically anyway.)
        v -= mirrorRipple(waterHit(vWorld).xz).y * 9.0;
        #endif
        // Vertical rays drifting along the curtain. The noise is mipmapped, so where a fold
        // squeezes them into a few pixels they blur instead of shimmering.
        float r1 = noise4(vec2(u * rays * 1.8 + seed * 7.0 + uTime * 0.1, uTime * 0.12 + seed * 13.0 + u * 3.0)).r;
        float r2 = noise4(vec2(u * rays * 0.55 + seed * 3.0, uTime * 0.08 + seed * 5.0)).g;
        float ray = clamp(0.5 + 0.55 * (r2 * 0.7 + r1 * 0.65), 0.0, 1.0);
        // A sharp, bright lower edge, fading upward, with ragged tops where rays are strong.
        float top = 0.35 + 0.65 * smoothstep(0.15, 0.85, ray);
        float profile = smoothstep(0.0, 0.035, v) * (0.22 + 0.78 * exp(-v * 4.0)) * (1.0 - smoothstep(top * 0.45, top, v));
        float glow = profile * (0.3 + 0.7 * ray) * vStrength;
        glow /= 1.0 + glow * 0.3;
        vec3 col = mix(EMERALD, TEAL, smoothstep(0.12, 0.36, v));
        col = mix(col, VIOLET, smoothstep(0.34, 0.75, v));
        col += vec3(0.5, 1.0, 0.75) * exp(-v * 45.0) * 0.8;
        gl_FragColor = vec4(col * glow, 1.0);
      }
    `,
  });
}

/**
 * The curtains, and the reflections of the `reflected` ones below y = 0, if any. They blend
 * before the dancers by default: the dancers' glass writes no depth, so anything drawn after it
 * shows through.
 */
export function AuroraCurtains({ curtains, renderOrder = -50 }: { curtains: readonly Curtain[]; renderOrder?: number }) {
  const geometry = useDisposable(() => curtainGeometry(curtains), [curtains]);
  const mirrored = curtains.filter((c) => c.reflected);
  const reflected = useDisposable(() => (mirrored.length ? curtainGeometry(mirrored) : null), [curtains]);
  const sky = useDisposable(() => curtainMaterial(false));
  const reflection = useDisposable(() => curtainMaterial(true));
  return (
    <>
      {reflected && <mesh geometry={reflected} material={reflection} frustumCulled={false} renderOrder={renderOrder} />}
      <mesh geometry={geometry} material={sky} frustumCulled={false} renderOrder={renderOrder + 1} />
    </>
  );
}
