// What the glass gable looks out on: the snowy bank the cabin stands on, a frozen lake that
// mirrors the sky, pines along the far shore, snowy peaks and the northern lights folding
// across the sky, with snow falling outside. The far layers come from the polar kit.
//
// Everything out here is drawn before the dancers (negative render orders): the dancers' gel
// doesn't write depth, so anything transparent drawn after them would show through them.
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { smoothstep } from '../shared/random.ts';
import { nightSky, noiseTexture, palette, polar } from '../polar/world.ts';
import { NightSky } from '../polar/Sky.tsx';
import { AuroraCurtains } from '../polar/Aurora.tsx';
import type { Curtain } from '../polar/Aurora.tsx';
import { FarPines, Mountains, landLight, massifHeight, scatterPines } from '../polar/Land.tsx';
import type { LandArea, Peak } from '../polar/Land.tsx';
import { makeNoise2 } from '../polar/noise.ts';
import { Snowfall } from '../polar/Snowfall.tsx';
import { FLOOR, GABLE } from './layout.ts';
import { room } from './room.ts';

// The bright main arc sweeps across the top of the window, lowest and brightest to the right;
// a nearer one hangs just over the peaks. Both show again in the ice.
const CURTAINS: readonly Curtain[] = [
  { line: [-2400, -1500, 2600, -2600], bottom: [340, 230], height: [950, 850], fold: 170, bow: 300, gain: [0.55, 1.0], rays: 90, seed: 0.13, reflected: true },
  { line: [-1200, -1350, 1700, -1650], bottom: [210, 170], height: [700, 620], fold: 120, bow: 140, gain: [0.85, 0.75], rays: 80, seed: 0.57, reflected: true },
];

// Snowy massifs beyond the far shore: the biggest right of centre, as in the menu.
const PEAKS: readonly Peak[] = [
  [330, -1000, 230, 380],
  [-200, -1080, 170, 330],
  [-700, -940, 210, 320],
  [880, -1180, 260, 420],
  [40, -780, 90, 220],
];

// The lake: an ellipse from just below the cabin's bank out to the far shore.
const LAKE = { x: 0, z: -290, rx: 640, rz: 262 };
const lakeDistance = (x: number, z: number) => Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz) - 1;
const hills = makeNoise2(17);

/** The land round the lake: foothills rising off the shore into the massifs. Below 0 under the lake. */
function landHeight(x: number, z: number): number {
  const d = lakeDistance(x, z);
  if (d < 0) return -4;
  const shore = smoothstep(0, 0.12, d) * (16 + 12 * hills(x * 0.01, z * 0.01)) + smoothstep(0.05, 0.6, d) * 30;
  return 0.6 + shore + massifHeight(PEAKS, x, z);
}

const AREA: LandArea = { left: -1700, right: 1700, front: -60, back: -1900 };

// Pines along the far shore and up the foothills, thinning on the slopes.
const PINES = scatterPines({
  count: 520,
  spot: (rand) => {
    const x = rand.range(-900, 900);
    const z = rand.range(-200, -760);
    const d = lakeDistance(x, z);
    return d > 0.015 && d < 0.35 && massifHeight(PEAKS, x, z) < 30 ? [x, z] : null;
  },
  height: landHeight,
  size: (x, z) => 13 - 10 * lakeDistance(x, z),
});

// The bank the cabin stands on: level with its floor at the glass, falling to the ice.
const BANK = { front: GABLE - 0.1, back: -48, half: 90 };
const bankHeight = (x: number, z: number) => {
  // The shore bows out towards the lake in front of the cabin; snow drifts up against the glass.
  const edge = -30 - x * x * 0.004;
  const fall = smoothstep(edge + 14, edge, z);
  const drift = 0.5 * Math.exp((z - GABLE) * 0.9) * (1 - smoothstep(9, 14, Math.abs(x)));
  return FLOOR - 0.25 + drift - fall * (FLOOR + 1) + 0.25 * hills(x * 0.08, z * 0.08);
};

// Big pines on the bank either side of the window, framing the view.
const NEAR_PINES = [
  [-19, -17, 15],
  [-27, -24, 17],
  [-15.5, -29, 11],
  [21, -19, 16],
  [29, -27, 18],
  [17.5, -33, 12],
  [-40, -21, 19],
  [42, -23, 19],
].map(([x, z, tall], i) => ({ x, y: bankHeight(x, z) - 0.5, z, width: tall * 0.42, height: tall, seed: (i * 0.37) % 1 }));

/**
 * The frozen lake: clear black ice that mirrors the sky along its reflection ray, with a faint
 * slow warp in the ice. It writes no depth, so the mirrored land, curtains and pines drawn after
 * it show in it, and then a dusting of wind-blown snow lies over the lot.
 */
function Ice() {
  const ice = useDisposable(() =>
    shaderMaterial({
      depthWrite: false,
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vWorld;
        ${hash}
        ${noiseTexture}
        ${palette}
        ${nightSky}
        void main() {
          vec3 view = normalize(cameraPosition - vWorld);
          vec2 slope = noise4(vWorld.xz * vec2(0.004, 0.01)).rg * 0.004;
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
          vec3 r = reflect(-view, n);
          r.y = abs(r.y);
          float pixel = max(max(length(dFdx(r)), length(dFdy(r))), 0.0018);
          float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
          vec3 col = mix(WATER, nightSky(r, pixel), mix(0.55, 0.92, fresnel));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  const dust = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uNoise: polar.uNoise, uLake: { value: new THREE.Vector4(LAKE.x, LAKE.z, LAKE.rx, LAKE.rz) } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec4 uLake;
        varying vec3 vWorld;
        ${noiseTexture}
        ${palette}
        void main() {
          vec2 p = vWorld.xz;
          // Long drifts across the wind, thicker towards the shores.
          float d = length((p - uLake.xy) / uLake.zw);
          float n = noise4(p * vec2(0.006, 0.022)).r * 0.65 + noise4(p * vec2(0.02, 0.06) + 7.0).g * 0.35;
          float a = smoothstep(0.05, 0.55, n + smoothstep(0.6, 1.0, d) * 0.45) * (1.0 - smoothstep(0.98, 1.0, d));
          float far = length(vWorld - cameraPosition);
          vec3 col = mix(vec3(0.07, 0.13, 0.22), HAZE, clamp(1.0 - exp(-far * 0.0016), 0.0, 0.85));
          gl_FragColor = vec4(col, a * 0.75);
        }
      `,
    }),
  );
  const geometry = useDisposable(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  return (
    <>
      <mesh geometry={geometry} material={ice} position={[0, 0, -1500]} scale={[8000, 1, 3000]} renderOrder={-900} frustumCulled={false} />
      <mesh geometry={geometry} material={dust} position={[LAKE.x, 0.02, LAKE.z]} scale={[LAKE.rx * 2, 1, LAKE.rz * 2]} renderOrder={-795} frustumCulled={false} />
    </>
  );
}

/**
 * The snowy bank outside the glass, moonlit and cool, warmed where the cabin's light spills out
 * onto it, and drifted up against the bottom of the window.
 */
function Bank() {
  const geometry = useDisposable(() => {
    const cols = 90;
    const rows = 40;
    const g = new THREE.PlaneGeometry(1, 1, cols, rows).rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) * 2;
      const v = pos.getZ(i) + 0.5;
      // Denser near the glass and the middle of the view.
      const x = Math.sign(u) * Math.abs(u) ** 1.5 * BANK.half;
      const z = BANK.front + (BANK.back - BANK.front) * v ** 1.4;
      pos.setXYZ(i, x, bankHeight(x, z), z);
    }
    g.computeVertexNormals();
    g.deleteAttribute('uv');
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise, uFlicker: room.uFlicker },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          vWorld = position;
          vNormal = normal;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uFlicker;
        varying vec3 vWorld;
        varying vec3 vNormal;
        ${hash}
        ${noiseTexture}
        ${palette}
        ${landLight}
        void main() {
          // Under the ice (which writes no depth) the bank mustn't show.
          if (vWorld.y < 0.05) discard;
          vec3 n = normalize(vNormal);
          vec3 view = normalize(cameraPosition - vWorld);
          float key = max(dot(n, KEY), 0.0);
          vec3 col = mix(vec3(0.03, 0.06, 0.13), vec3(0.2, 0.3, 0.5), smoothstep(0.05, 0.9, key));
          col += vec3(0.0, 0.05, 0.04) * max(dot(n, FILL), 0.0);
          // The glass gable's light spilling out over the snow, in a warm fan from the window.
          float out_ = max(${GABLE.toFixed(1)} - vWorld.z, 0.0);
          float fan = exp(-out_ * 0.16) * (1.0 - smoothstep(4.0 + out_ * 0.5, 9.0 + out_ * 0.8, abs(vWorld.x)));
          col += vec3(0.5, 0.24, 0.08) * fan * uFlicker * 0.55;
          // A soft sheen on the crust towards the aurora.
          col += vec3(0.05, 0.16, 0.13) * pow(1.0 - max(dot(n, view), 0.0), 3.0) * 0.6;
          col = hazed(col, vWorld, 10.0);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} renderOrder={-850} frustumCulled={false} />;
}

export function Outside() {
  return (
    <>
      <NightSky />
      <Ice />
      <Mountains height={landHeight} area={AREA} grid={[256, 72]} mirrorGrid={[128, 28]} cut={0.3} renderOrder={-880} />
      <Bank />
      <AuroraCurtains curtains={CURTAINS} renderOrder={-800} />
      <FarPines pines={PINES} reflected renderOrder={-790} />
      <FarPines pines={NEAR_PINES} renderOrder={-780} />
      <Snowfall count={900} center={[0, FLOOR + 6, -30]} size={[70, 18, 44]} flake={0.12} fade={70} speed={0.9} renderOrder={-700} />
    </>
  );
}
