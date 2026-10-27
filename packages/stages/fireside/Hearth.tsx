// The hearth: a round, glossy hanging fireplace on a long flue, open towards the room, with
// a fire flickering on glowing logs inside, sparks rising out of it and its warm light on the
// room. It hangs off to the left, clear of the dancers from every angle the preview swings to.
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { makeRandom } from '../shared/random.ts';
import { RENDER_HEIGHT } from '../shared/post.tsx';
import { noiseTexture, polar } from '../polar/world.ts';
import { FIRE, FIRE_LIGHT, FLOOR, HALF, RIDGE } from './layout.ts';
import { lathe, merge, paint, place } from './geometry.ts';
import { patchRoom, room, roomPalette } from './room.ts';

// The bowl's profile ([radius, height] about its middle) and its opening, which faces the
// camera's side of the room (lathe angles: 0 is +z).
const LOWER: [number, number][] = [[0.001, -0.98], [0.42, -0.94], [0.76, -0.8], [0.96, -0.6], [1.04, -0.42]];
const BAND: [number, number][] = [[1.04, -0.42], [1.07, 0.0], [1.03, 0.36]];
const UPPER: [number, number][] = [[1.03, 0.36], [0.94, 0.62], [0.68, 0.86], [0.34, 1.03], [0.2, 1.12], [0.19, 1.2]];
const OPENING = { centre: 0.42, width: 1.55 };
const FLUE_R = 0.19;

const fireAt = `vec3(${FIRE.x.toFixed(2)}, ${FIRE.y.toFixed(2)}, ${FIRE.z.toFixed(2)})`;

// The shell is drawn both sides: outside glossy black enamel, inside sooty and lit by the fire.
const shellEmissive = /* glsl */ `
  vec3 local = vRoomWorld - ${fireAt};
  if (!gl_FrontFacing) {
    // Sooty inside, glowing hot round the fire bed and dimming up the walls.
    float heat = exp(-max(local.y + 0.6, 0.0) * 2.6);
    totalEmissiveRadiance += (EMBER * heat * 0.9 + FIRELIGHT * 0.03) * uFlicker;
  } else {
    // The shell round the mouth catches the fire, fading with distance from the mouth's edge
    // (measured by angle round the bowl; the shell never reaches its axis, where atan would be
    // undefined).
    float angle = abs(mod(atan(local.x, local.z + 1e-4) - ${OPENING.centre.toFixed(3)} + PI, 2.0 * PI) - PI);
    float fromSide = max(angle - ${(OPENING.width / 2).toFixed(3)}, 0.0) * 1.05;
    float fromEnds = max(max(local.y - ${BAND[BAND.length - 1][1].toFixed(2)}, ${BAND[0][1].toFixed(2)} - local.y), 0.0);
    float rim = exp(-length(vec2(fromSide, fromEnds)) * 10.0);
    totalEmissiveRadiance += FIRELIGHT * rim * 0.3 * uFlicker;
  }
`;

/** The bowl and its flue up through the roof, and the round hearth slab on the floor below. */
function Fireplace() {
  const material = useDisposable(() =>
    patchRoom(
      new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide }),
      // The slab on the floor takes none of the environment, or its gloss mirrors the cool window.
      { key: 'fireplace', color: 'if (!gl_FrontFacing) diffuseColor.rgb *= 0.15;', emissive: shellEmissive, ibl: `vRoomWorld.y < ${(FLOOR + 0.2).toFixed(2)} ? 0.0 : 0.18` },
    ),
  );
  const geometry = useDisposable(() => {
    const black = '#17110f';
    const band = new THREE.LatheGeometry(BAND.map(([r, y]) => new THREE.Vector2(r, y)), 40, OPENING.centre + OPENING.width / 2, 2 * Math.PI - OPENING.width);
    // The flue rises to where the roof slopes over it.
    const top = 1.15;
    const flue = FLOOR + RIDGE * (1 - Math.abs(FIRE.x) / HALF) + 0.3 - (FIRE.y + top);
    const parts = [
      paint(lathe(LOWER, 40), black),
      paint(band, black),
      paint(lathe(UPPER, 40), black),
      paint(new THREE.CylinderGeometry(FLUE_R, FLUE_R, flue, 20, 1, true).translate(0, top + flue / 2, 0), '#1c1512'),
      // A copper collar where the flue meets the bowl.
      paint(new THREE.CylinderGeometry(FLUE_R + 0.05, FLUE_R + 0.05, 0.12, 20).translate(0, 1.2, 0), '#b8673a'),
    ].map((g) => place(g, { position: [FIRE.x, FIRE.y, FIRE.z] }));
    // The hearth slab: dark polished stone, rounded at the edge.
    parts.push(paint(lathe([[1.6, 0], [1.55, 0.06], [1.45, 0.09], [0.001, 0.09]], 48).translate(FIRE.x, FLOOR, FIRE.z), '#4a423c'));
    return merge(parts);
  });
  return <mesh geometry={geometry} material={material} />;
}

/** Logs in the bowl: charred, with cracks glowing and breathing. */
function Logs() {
  const geometry = useDisposable(() => {
    const log = (angle: number, tilt: number, length: number, r: number, y: number) =>
      place(new THREE.CylinderGeometry(r, r * 0.9, length, 10).rotateZ(Math.PI / 2), { position: [FIRE.x, FIRE.y + y, FIRE.z], rotation: [0, angle, tilt] });
    return merge([log(0.42, 0.1, 1.15, 0.13, -0.62), log(-0.5, -0.12, 1.05, 0.12, -0.62), log(1.4, 0.0, 0.9, 0.11, -0.5)].map((g) => paint(g, '#ffffff')));
  });
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise, uFlicker: room.uFlicker },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          vNormal = normal;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uFlicker;
        varying vec3 vWorld;
        varying vec3 vNormal;
        ${noiseTexture}
        ${roomPalette}
        void main() {
          vec3 p = vWorld * 7.0;
          float crack = abs(noise4(p.xz + p.y).r);
          float glow = (1.0 - smoothstep(0.02, 0.16, crack)) * (0.6 + 0.4 * noise4(p.xz * 0.3 + uTime * 0.4).g);
          vec3 col = vec3(0.025, 0.015, 0.012) + EMBER * glow * 2.2 * uFlicker;
          // Hotter underneath, where the embers bed.
          col += EMBER * 0.5 * smoothstep(0.2, -0.8, normalize(vNormal).y);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} />;
}

// Tongues of flame: [x, z offset in the bowl, width, height, seed].
const TONGUES: readonly [number, number, number, number, number][] = [
  [0.0, 0.0, 0.62, 1.0, 0.1],
  [-0.3, -0.1, 0.46, 0.78, 1.3],
  [0.32, -0.05, 0.5, 0.82, 2.7],
  [-0.12, 0.18, 0.4, 0.62, 3.9],
  [0.2, 0.2, 0.38, 0.56, 5.2],
  [-0.42, 0.12, 0.32, 0.5, 6.6],
];

/** The flames: camera-facing tongues with a hot core licking up from the logs, additive, moved in their shaders. */
function Flames() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('uv', plane.getAttribute('uv'));
    const spots = TONGUES.map(([x, z, , , seed]) => [FIRE.x + x, FIRE.y - 0.66, FIRE.z + z, seed]);
    const sizes = TONGUES.map(([, , w, h]) => [w, h]);
    g.setAttribute('aSpot', new THREE.InstancedBufferAttribute(new Float32Array(spots.flat()), 4));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(sizes.flat()), 2));
    g.instanceCount = spots.length;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: polar.uTime, uNoise: polar.uNoise, uFlicker: room.uFlicker },
      vertexShader: /* glsl */ `
        attribute vec4 aSpot;
        attribute vec2 aSize;
        uniform float uTime;
        varying vec2 vUv;
        varying float vSeed;
        void main() {
          vUv = uv;
          vSeed = aSpot.w;
          vec4 mv = viewMatrix * vec4(aSpot.xyz, 1.0);
          float leap = 0.9 + 0.12 * sin(uTime * 8.0 + aSpot.w * 3.0) + 0.06 * sin(uTime * 14.0 + aSpot.w);
          mv.xy += position.xy * aSize * vec2(1.0, leap);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uFlicker;
        varying vec2 vUv;
        varying float vSeed;
        ${noiseTexture}
        ${roomPalette}
        void main() {
          float y = vUv.y;
          float t = uTime * 2.4 + vSeed;
          float wob = noise4(vec2(y * 2.0 - t * 0.9, vSeed * 3.0)).r * 0.22 * y;
          float x = (vUv.x - 0.5 + wob) * 2.0;
          float width = pow(max(1.0 - y, 0.0), 0.8) * smoothstep(0.0, 0.2, y) * 0.95 + 0.001;
          float d = abs(x) / width;
          float body = 1.0 - smoothstep(0.5, 1.0, d);
          float tongue = smoothstep(0.25, 0.75, noise4(vec2(x * 1.5 + vSeed * 4.0, y * 2.5 - t * 1.3)).g * 0.5 + 0.5 + (1.0 - y) * 0.55);
          float a = body * tongue * (1.0 - smoothstep(0.55, 1.0, y));
          float core = (1.0 - smoothstep(0.0, 0.5, d)) * (1.0 - smoothstep(0.05, 0.5, y));
          vec3 col = mix(vec3(1.5, 0.32, 0.06), vec3(2.6, 1.2, 0.3), smoothstep(0.0, 0.7, 1.0 - d));
          col = mix(col, vec3(4.0, 3.0, 1.6), core);
          gl_FragColor = vec4(col * a * uFlicker, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-500} />;
}

const SPARKS = 28;

/** Sparks: rising from the logs, drifting out of the bowl's mouth and up, fading as they cool. */
function Sparks() {
  const geometry = useDisposable(() => {
    const rand = makeRandom(13);
    const look = new Float32Array(SPARKS * 4);
    for (let i = 0; i < SPARKS; i++) look.set([rand.next(), rand.range(0.25, 0.5), rand.range(-1, 1), rand.range(-1, 1)], i * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    g.setAttribute('aLook', new THREE.BufferAttribute(look, 4));
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: polar.uTime, uOrigin: { value: new THREE.Vector3(FIRE.x, FIRE.y - 0.5, FIRE.z) }, uOut: { value: new THREE.Vector2(Math.sin(OPENING.centre), Math.cos(OPENING.centre)) } },
      vertexShader: /* glsl */ `
        attribute vec4 aLook;
        uniform float uTime;
        uniform vec3 uOrigin;
        uniform vec2 uOut;
        varying float vHeat;
        void main() {
          float life = fract(uTime * aLook.y + aLook.x * 7.0);
          // Up and out of the mouth, curling as they go.
          vec3 p = uOrigin;
          p.y += life * 2.4;
          p.xz += uOut * smoothstep(0.1, 0.6, life) * (0.9 + 0.3 * aLook.z);
          p.x += sin(life * 9.0 + aLook.w * 6.0) * 0.18 * life;
          p.z += cos(life * 7.0 + aLook.z * 6.0) * 0.18 * life;
          vHeat = (1.0 - life) * smoothstep(0.0, 0.08, life);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(0.05 * projectionMatrix[1][1] * ${(RENDER_HEIGHT / 2).toFixed(1)} / max(-mv.z, 0.1), 1.5, 4.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vHeat;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = exp(-dot(d, d) * 14.0) * vHeat;
          gl_FragColor = vec4(vec3(3.0, 1.3, 0.35) * a, 1.0);
        }
      `,
    }),
  );
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={-480} />;
}

/** The fire's light on the room (no shadows: the dancers' come from the key light), flickering. */
function FireLight() {
  const light = useRef<THREE.PointLight>(null);
  useFrame(() => {
    if (light.current) light.current.intensity = 8 * room.uFlicker.value;
  });
  return <pointLight ref={light} position={FIRE_LIGHT} color="#ff8a3c" distance={22} decay={1.5} />;
}

export function Hearth() {
  return (
    <>
      <Fireplace />
      <Logs />
      <Flames />
      <Sparks />
      <FireLight />
    </>
  );
}
