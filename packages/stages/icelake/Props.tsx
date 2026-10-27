import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { polar } from '../polar/world.ts';
import { HUT, LANTERN_HEIGHT, LANTERNS, WIND } from './layout.ts';

// Things standing on the ice, mirrored in it along with the dancers (Ice.tsx useMirror): glass
// lanterns on stakes round the rink, and a little red ice-fishing hut out on the lake with a warm
// window, smoke from its stovepipe and its own lantern.

/** Non-indexed, with a linear vertex colour, so pieces merge into one draw. */
function painted(geometry: THREE.BufferGeometry, hex: THREE.ColorRepresentation, at: THREE.Matrix4): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  g.applyMatrix4(at);
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const place = (x: number, y: number, z: number, turn = 0, scale: [number, number, number] = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, turn, 0)), new THREE.Vector3(...scale));

const ORB = 0.24;

/** The stakes, caps and the snow heaped at their feet, for every lantern. */
function lanternFrames(): THREE.BufferGeometry {
  const parts = LANTERNS.flatMap(([x, z]) => [
    painted(new THREE.CylinderGeometry(0.045, 0.06, LANTERN_HEIGHT - ORB, 8), '#3a2a24', place(x, (LANTERN_HEIGHT - ORB) / 2, z)),
    painted(new THREE.CylinderGeometry(0.1, 0.12, 0.06, 12), '#2c3440', place(x, LANTERN_HEIGHT - ORB - 0.02, z)),
    painted(new THREE.ConeGeometry(0.17, 0.2, 12), '#2c3440', place(x, LANTERN_HEIGHT + ORB + 0.05, z)),
    painted(new THREE.SphereGeometry(0.5, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#c4d4ee', place(x, -0.02, z, 0, [1, 0.32, 1])),
  ]);
  return mergeGeometries(parts);
}

function orbGeometry(): THREE.BufferGeometry {
  return mergeGeometries(LANTERNS.map(([x, z]) => new THREE.SphereGeometry(ORB, 20, 14).translate(x, LANTERN_HEIGHT, z)));
}

// Glass balls with a warm flame inside: bright in the middle, the glass catching the sky at its rim.
const orbMaterial = () =>
  shaderMaterial({
    uniforms: { uTime: polar.uTime },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 view = normalize(cameraPosition - vWorld);
        float facing = clamp(dot(n, view), 0.0, 1.0);
        float flicker = 0.92 + 0.08 * sin(uTime * 7.0 + vWorld.x * 3.0) * sin(uTime * 3.1 + vWorld.z);
        vec3 col = vec3(2.6, 1.3, 0.5) * pow(facing, 2.5) * flicker + vec3(0.5, 0.2, 0.08) * facing;
        // The glass: a cool rim, and the moon caught near the top.
        col += vec3(0.25, 0.5, 0.6) * pow(1.0 - facing, 3.0);
        vec3 h = normalize(normalize(vec3(-0.8, 0.5, 0.25)) + view);
        col += vec3(1.2, 1.3, 1.5) * pow(max(dot(n, h), 0.0), 60.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

/** The lanterns round the rink and by the hut. */
export function Lanterns() {
  const frames = useDisposable(lanternFrames);
  const orbs = useDisposable(orbGeometry);
  const frame = useDisposable(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, envMapIntensity: 0.4 }));
  const glass = useDisposable(orbMaterial);
  return (
    <>
      <mesh geometry={frames} material={frame} />
      <mesh geometry={orbs} material={glass} />
    </>
  );
}

/** The hut in local space, its door facing +z: red boards, white trim, a snowy roof, a stovepipe. */
function hutGeometry(): THREE.BufferGeometry {
  const W = 3.2;
  const H = 2.5;
  const D = 3.6;
  const roof = new THREE.Shape([new THREE.Vector2(-W / 2 - 0.35, 0), new THREE.Vector2(W / 2 + 0.35, 0), new THREE.Vector2(0, 1.25)]);
  const gable = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(0, 1.05)]);
  const parts = [
    painted(new THREE.BoxGeometry(W, H, D), '#c63a32', place(0, H / 2, 0)),
    // Gable ends under the roof.
    painted(new THREE.ExtrudeGeometry(gable, { depth: D, bevelEnabled: false }), '#b8332c', place(0, H, -D / 2)),
    // The snowy roof, overhanging.
    painted(new THREE.ExtrudeGeometry(roof, { depth: D + 0.5, bevelEnabled: false }), '#dbe6f8', place(0, H - 0.08, -D / 2 - 0.25)),
    // Door and white trim on the corners.
    painted(new THREE.BoxGeometry(0.95, 1.85, 0.08), '#7c211d', place(-0.6, 0.95, D / 2 + 0.02)),
    painted(new THREE.BoxGeometry(0.14, H, 0.14), '#eef2f8', place(-W / 2, H / 2, D / 2)),
    painted(new THREE.BoxGeometry(0.14, H, 0.14), '#eef2f8', place(W / 2, H / 2, D / 2)),
    painted(new THREE.BoxGeometry(0.14, H, 0.14), '#eef2f8', place(-W / 2, H / 2, -D / 2)),
    painted(new THREE.BoxGeometry(0.14, H, 0.14), '#eef2f8', place(W / 2, H / 2, -D / 2)),
    painted(new THREE.BoxGeometry(0.9, 0.1, 0.12), '#eef2f8', place(0.85, 1.3, D / 2 + 0.03)),
    painted(new THREE.BoxGeometry(0.9, 0.1, 0.12), '#eef2f8', place(0.85, 2.05, D / 2 + 0.03)),
    // The stovepipe through the roof.
    painted(new THREE.CylinderGeometry(0.12, 0.12, 1.5, 10), '#2a2e36', place(W / 4, H + 0.9, -D / 4)),
    painted(new THREE.CylinderGeometry(0.22, 0.16, 0.14, 10), '#2a2e36', place(W / 4, H + 1.68, -D / 4)),
    // Snow drifted against its walls.
    painted(new THREE.SphereGeometry(1, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#c4d4ee', place(0, -0.05, 0, 0, [W * 0.75, 0.45, D * 0.72])),
  ];
  return mergeGeometries(parts);
}

/** The hut's window, glowing warm, beside the door. */
function windowGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(0.76, 0.62).translate(0.85, 1.67, 3.6 / 2 + 0.04);
}

const PUFFS = 12;

/** Smoke from the stovepipe: soft puffs rising and drifting off with the wind, one draw. */
function smokeGeometry(): THREE.InstancedBufferGeometry {
  const plane = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.getAttribute('position'));
  g.setAttribute('uv', plane.getAttribute('uv'));
  g.setAttribute('aPuff', new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: PUFFS }, (_, i) => i / PUFFS)), 1));
  g.instanceCount = PUFFS;
  return g;
}

const smokeMaterial = () =>
  shaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: polar.uTime },
    vertexShader: /* glsl */ `
      attribute float aPuff;
      uniform float uTime;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float t = fract(uTime * 0.07 + aPuff);
        // From the pipe's top (local), up and away downwind, spreading as it goes.
        vec3 p = (modelMatrix * vec4(0.8, 4.3, -0.9, 1.0)).xyz;
        p += vec3(${WIND[0].toFixed(2)}, 0.0, ${WIND[1].toFixed(2)}) * (t * t * 7.0) + vec3(0.0, t * 6.0, 0.0);
        p.x += sin(uTime * 0.6 + aPuff * 9.0) * 0.4 * t;
        float size = 0.5 + t * 3.2;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        mv.xy += position.xy * size;
        vUv = uv;
        vAlpha = smoothstep(0.0, 0.08, t) * (1.0 - t) * 0.32;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec2 d = vUv - 0.5;
        float a = exp(-dot(d, d) * 14.0) * vAlpha;
        gl_FragColor = vec4(vec3(0.2, 0.27, 0.36), a);
      }
    `,
  });

export function Hut() {
  const geometry = useDisposable(hutGeometry);
  const pane = useDisposable(windowGeometry);
  const puffs = useDisposable(smokeGeometry);
  const material = useDisposable(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, envMapIntensity: 0.5 }));
  const glow = useDisposable(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.15, 0.45) }));
  const smoke = useDisposable(smokeMaterial);
  const [x, z] = HUT.position;
  return (
    <group position={[x, 0, z]} rotation={[0, HUT.heading, 0]}>
      <mesh geometry={geometry} material={material} />
      <mesh geometry={pane} material={glow} />
      <mesh geometry={puffs} material={smoke} frustumCulled={false} renderOrder={-10} />
    </group>
  );
}
