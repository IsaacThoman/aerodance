import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { fx, landGLSL, skyGLSL } from './fx.ts';
import { CAMERA, landHeight, RIVER_HALF_WIDTH, riverDistance } from './terrain.ts';

// Daisy white, buttercup, pink and forget-me-not blue, weighted towards white and yellow.
const COLORS = ['#ffffff', '#ffffff', '#ffffff', '#ffd83a', '#ffd83a', '#ff8cc4', '#a8d8ff'];

/** Scattered wildflowers: glossy little beads of colour in clumps over the near slopes, nodding in the gusts. */
export function Wildflowers({ clumps = 26, seed = 23 }: { clumps?: number; seed?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const roots: number[] = [];
    const looks: number[] = [];
    const [cx, , cz] = CAMERA.position;
    const color = new THREE.Color();
    for (let c = 0; c < clumps; c++) {
      // Patches over the near slope between the menu and the dancers, and along the river's banks.
      const banks = c % 3 === 0;
      const a = THREE.MathUtils.degToRad(banks ? rand.range(-7, 14) : rand.range(-16, 14));
      const r = banks ? rand.range(50, 120) : 20 + Math.pow(rand.next(), 1.2) * 40;
      const x0 = cx + Math.sin(a) * r;
      const z0 = cz - Math.cos(a) * r;
      const main = rand.pick(COLORS);
      const n = banks ? rand.int(10, 18) : rand.int(6, 13);
      const spread = rand.range(0.8, 1.8) * (1 + r / 50);
      for (let i = 0; i < n; i++) {
        const t = rand.range(0, Math.PI * 2);
        const d = Math.pow(rand.next(), 0.8) * spread;
        const x = x0 + Math.cos(t) * d;
        const z = z0 + Math.sin(t) * d;
        const river = riverDistance(x, z);
        if (river < RIVER_HALF_WIDTH * 2.2 || (banks && river > RIVER_HALF_WIDTH * 9)) continue;
        color.set(rand.chance(0.85) ? main : rand.pick(COLORS));
        const dist = Math.hypot(x - cx, z - cz);
        // Grows with distance so far flowers stay a few pixels wide instead of shimmering.
        const size = rand.range(0.16, 0.24) * (1 + dist / 26);
        roots.push(x, landHeight(x, z, river), z);
        looks.push(color.r, color.g, color.b, size, rand.next());
      }
    }
    const count = roots.length / 3;
    // Per flower: colour (rgb), size, sway phase.
    const look = new THREE.InstancedInterleavedBuffer(new Float32Array(looks), 5, 1);
    g.setAttribute('aRoot', new THREE.InstancedBufferAttribute(new Float32Array(roots), 3));
    g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(look, 3, 0));
    g.setAttribute('aSize', new THREE.InterleavedBufferAttribute(look, 2, 3));
    g.instanceCount = count;
    return g;
  }, [clumps, seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...fx },
      vertexShader: /* glsl */ `
        attribute vec3 aRoot;
        attribute vec3 aColor;
        attribute vec2 aSize;
        uniform float uTime;
        uniform sampler2D uNoise;
        uniform vec2 uWindDir;
        varying vec2 vUv;
        varying vec3 vColor;
        varying vec3 vWorld;
        vec4 tnoise(vec2 q) { return texture2D(uNoise, q * 0.125) * 2.0 - 1.0; }
        void main() {
          float size = aSize.x;
          // Nod downwind in the gusts, with a little sway of its own.
          vec2 w = uWindDir;
          vec2 q = vec2(dot(aRoot.xz, w) * 0.016 - uTime * 0.13, dot(aRoot.xz, vec2(-w.y, w.x)) * 0.006);
          float g = smoothstep(-0.2, 0.2, tnoise(q).r);
          float sway = sin(uTime * (1.3 + aSize.y) + aSize.y * 30.0);
          vec3 head = aRoot + vec3(0.0, size * 1.4, 0.0);
          head.xz += w * size * (0.6 * g + 0.25 * sway);
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 p = head + (camR * position.x + camU * position.y * 0.85) * size;
          vUv = uv;
          vColor = aColor;
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${skyGLSL}
        ${landGLSL}
        varying vec2 vUv;
        varying vec3 vColor;
        varying vec3 vWorld;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float d = length(p);
          float a = smoothstep(1.0, 0.55, d);
          if (a < 0.01) discard;
          // A glossy bead: lit from the key side, a white highlight up and to the right.
          vec3 col = vColor * (uKeyColor * (0.55 + 0.35 * p.x) * cloudShadow(vWorld.xz) + uSkyLight * 0.7);
          col += vec3(1.0) * smoothstep(0.45, 0.0, length(p - vec2(0.28, 0.32))) * 0.45;
          col = applyLandHaze(col, vWorld);
          gl_FragColor = vec4(col, a);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}
