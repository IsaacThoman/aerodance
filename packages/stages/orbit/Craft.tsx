import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { beat, reducedMotion, useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { damp } from '../shared/random.ts';
import { DECK_Y, world } from './layout.ts';
import type { OrbitVariant } from './layout.ts';
import { craftMaterial, droneGeometry, shuttleGeometry } from './craft.ts';
import { glintGLSL, pointSizeGLSL, useStretch } from './glints.ts';

// The craft round the deck: a shuttle gliding past high behind the dancers now and then, and two
// camera drones hovering at the deck's edge either side of them, filming them and nodding to the
// beat. Their lights are one set of glow sprites placed each frame.

/** Seconds between the shuttle's passes, and how long each takes. */
const SHUTTLE_CYCLE = 64;
const SHUTTLE_FLIGHT = 36;
/** How much the shuttle slows mid-pass (0 steady, towards 1 nearly stopping) to show itself off. */
const SHUTTLE_LINGER = 0.6;
// Its path, left to right: in from far out on the left, gliding over the sunrise and high
// over the dancers' heads, and away to the right. Every other pass runs it back the other way.
const SHUTTLE_PATH = new THREE.CatmullRomCurve3(
  [
    [-130, 30, -110],
    [-48, 17, -66],
    [6, 14.5, -52],
    [52, 17.5, -60],
    [135, 28, -115],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
);

/**
 * Where the drones hover: radians either side of the camera round the dancers, out from them, and
 * up (under the dome nearer and higher, over the planters' trees); and their size.
 */
const DRONE = { spread: 1.2, radius: 6.4, y: DECK_Y + 2.9, domeRadius: 4.4, domeY: DECK_Y + 4.1, scale: 1.3 };
/** The drones' glow tints. */
const DRONE_ACCENTS = ['#4fe3ff', '#b6ff6a'];
/** What the drones look at: the dancers' chests. */
const DANCERS = new THREE.Vector3(0, DECK_Y + 1.4, 0);

/** A light on a craft: where it sits on it, its tint and world size, and how it blinks (0 steady, 1 beat, 2 strobe; then a phase). */
interface Light {
  at: readonly [number, number, number];
  color: string;
  size: number;
  blink: number;
  phase?: number;
}

const SHUTTLE_LIGHTS: readonly Light[] = [
  { at: [-2.2, -0.22, -1.62], color: '#ff4d6a', size: 1.6, blink: 2 },
  { at: [2.2, -0.22, -1.62], color: '#5dff9a', size: 1.6, blink: 2 },
  { at: [0, 1.32, -2.1], color: '#ffffff', size: 2, blink: 2, phase: 0.5 },
  { at: [0, -0.05, -2.45], color: '#5fd8ff', size: 3.4, blink: 1 },
];
const DRONE_LIGHTS: readonly Light[] = [
  { at: [0, 0.01, 0.3], color: '#7fe9ff', size: 0.7, blink: 1 },
  { at: [-0.083, 0.43, -0.06], color: '#ff7aa8', size: 0.3, blink: 2 },
];

const tmp = new THREE.Vector3();
const ahead = new THREE.Vector3();
const look = new THREE.Vector3();
const color = new THREE.Color();

/** The shuttle's place at `time`: where along its path (0..1) and which way, or null between passes. */
function shuttleAt(time: number): { u: number; back: boolean } | null {
  const pass = Math.floor(time / SHUTTLE_CYCLE);
  const f = (time - pass * SHUTTLE_CYCLE) / SHUTTLE_FLIGHT;
  if (f >= 1) return null;
  // Fast at either end, lingering in the middle.
  const s = f - (SHUTTLE_LINGER * Math.sin(f * Math.PI * 2)) / (Math.PI * 2);
  const back = pass % 2 === 1;
  return { u: back ? 1 - s : s, back };
}

/** The shuttle's path point at `u`, mirrored left-right (and a little higher) on its way back. */
function shuttlePoint(u: number, back: boolean, out: THREE.Vector3): THREE.Vector3 {
  SHUTTLE_PATH.getPoint(THREE.MathUtils.clamp(u, 0, 1), out);
  if (back) out.set(-out.x, out.y + 3, out.z - 6);
  return out;
}

/**
 * The craft: the shuttle, the two drones, and their lights. The drones keep to either side of
 * the camera as it swings round (lagging a little), so they never hover between it and the
 * dancers.
 */
export function Craft({ dome }: OrbitVariant) {
  const shuttle = useRef<THREE.Mesh>(null);
  const drones = useRef<THREE.InstancedMesh>(null);
  const stretch = useStretch();

  const shuttleGeo = useDisposable(() => shuttleGeometry());
  const shuttleMat = useDisposable(() => craftMaterial());
  const droneGeo = useDisposable(() => {
    const g = droneGeometry();
    const accents = new Float32Array(DRONE_ACCENTS.length * 3);
    DRONE_ACCENTS.forEach((c, i) => accents.set(color.set(c).toArray(), i * 3));
    g.setAttribute('aAccent', new THREE.InstancedBufferAttribute(accents, 3));
    return g;
  });
  const droneMat = useDisposable(() => craftMaterial(true));

  const lightCount = SHUTTLE_LIGHTS.length + DRONE_LIGHTS.length * DRONE_ACCENTS.length;
  const lightGeo = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    const colors = new Float32Array(lightCount * 3);
    const blink = new Float32Array(lightCount * 2);
    let i = 0;
    const add = (light: Light, tint?: string) => {
      color.set(light.color);
      if (tint) color.lerp(new THREE.Color(tint), 0.5);
      colors.set(color.toArray(), i * 3);
      blink.set([light.blink, light.phase ?? i * 0.37], i * 2);
      i++;
    };
    SHUTTLE_LIGHTS.forEach((light) => add(light));
    DRONE_ACCENTS.forEach((tint) => DRONE_LIGHTS.forEach((light) => add(light, tint)));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lightCount * 3), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(lightCount), 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aBlink', new THREE.BufferAttribute(blink, 2));
    return g;
  });

  const lightMat = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: world.uTime, uBeat: world.uBeat, uNight: world.uNight, uStretch: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec3 aColor;
        attribute vec2 aBlink;
        uniform float uTime, uBeat, uNight;
        varying vec3 vColor;
        varying float vSpark;
        ${pointSizeGLSL}
        void main() {
          // Steady, with the beat, or a quick double strobe.
          float strobe = fract(uTime * 0.7 + aBlink.y);
          float on = aBlink.x < 0.5 ? 1.0
            : aBlink.x < 1.5 ? 0.6 + 0.8 * uBeat
            : step(strobe, 0.06) + step(0.14, strobe) * step(strobe, 0.2);
          vColor = aColor * on * (1.0 + 0.4 * uNight);
          vSpark = step(1.5, aBlink.x);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize > 0.0 ? clamp(pointSize(aSize, -mv.z), 3.0, 40.0) : 0.0;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStretch;
        varying vec3 vColor;
        varying float vSpark;
        ${glintGLSL}
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          p.x *= uStretch;
          float halo = exp(-dot(p, p) * 7.0);
          gl_FragColor = vec4(vColor * mix(halo * 1.3, glint(p) * 0.7 + halo * 0.4, vSpark), 1.0);
        }
      `,
    }),
  );
  lightMat.uniforms.uStretch.value = stretch;

  const state = useMemo(() => ({ azimuth: 0, ready: false }), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const sizes = useMemo(() => Float32Array.from([...SHUTTLE_LIGHTS, ...DRONE_ACCENTS.flatMap(() => DRONE_LIGHTS)].map((l) => l.size)), []);

  useFrame(({ camera }, delta) => {
    const t = world.uTime.value;
    const positions = lightGeo.attributes.position as THREE.BufferAttribute;
    const size = lightGeo.attributes.aSize as THREE.BufferAttribute;
    let light = 0;

    // The shuttle along its path, nose ahead, banking into its turns.
    const s = shuttle.current;
    const at = shuttleAt(t);
    if (s) {
      s.visible = !!at;
      if (at) {
        shuttlePoint(at.u, at.back, s.position);
        shuttlePoint(at.u + (at.back ? -0.01 : 0.01), at.back, ahead);
        s.lookAt(ahead);
        s.rotateZ(Math.sin(at.u * Math.PI * 2) * 0.22 * (at.back ? -1 : 1));
        s.updateMatrixWorld();
      }
      for (const l of SHUTTLE_LIGHTS) {
        tmp.set(...l.at).applyMatrix4(s.matrixWorld);
        positions.setXYZ(light, tmp.x, tmp.y, tmp.z);
        size.setX(light, at ? sizes[light] : 0);
        light++;
      }
    }

    // The drones keep either side of the camera round the dancers, lagging behind its swing.
    const m = drones.current;
    if (m) {
      const camAz = Math.atan2(camera.position.x, camera.position.z);
      if (!state.ready) state.azimuth = camAz;
      state.ready = true;
      const turn = Math.atan2(Math.sin(camAz - state.azimuth), Math.cos(camAz - state.azimuth));
      state.azimuth = damp(state.azimuth, state.azimuth + turn, 1.6, Math.min(delta, 0.1));
      const nod = reducedMotion ? 0 : beat.pulse;
      for (let i = 0; i < DRONE_ACCENTS.length; i++) {
        const side = i === 0 ? -1 : 1;
        const az = state.azimuth + side * DRONE.spread + 0.1 * Math.sin(t * 0.23 + i * 2.1);
        const r = (dome ? DRONE.domeRadius : DRONE.radius) + 0.3 * Math.sin(t * 0.31 + i * 1.3);
        dummy.position.set(Math.sin(az) * r, (dome ? DRONE.domeY : DRONE.y) + 0.14 * Math.sin(t * 1.1 + i * 1.7) + 0.06 * nod, Math.cos(az) * r);
        // Filming the dancers from a three-quarter view, now and then turning to the camera.
        const glance = THREE.MathUtils.smoothstep(Math.sin(t * 0.19 + i * 2.5), 0.55, 0.9);
        dummy.lookAt(look.lerpVectors(DANCERS, camera.position, 0.3 + 0.6 * glance));
        dummy.scale.setScalar(DRONE.scale);
        // A nod to the beat and a little sway as they drift.
        dummy.rotateX(0.14 * nod);
        dummy.rotateZ(0.08 * Math.sin(t * 0.7 + i * 2.4));
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
        for (const l of DRONE_LIGHTS) {
          tmp.set(...l.at).applyMatrix4(dummy.matrix);
          positions.setXYZ(light, tmp.x, tmp.y, tmp.z);
          size.setX(light, sizes[light] * DRONE.scale);
          light++;
        }
      }
      m.instanceMatrix.needsUpdate = true;
    }
    positions.needsUpdate = true;
    size.needsUpdate = true;
  });

  return (
    <>
      <mesh ref={shuttle} geometry={shuttleGeo} material={shuttleMat} visible={false} frustumCulled={false} />
      <instancedMesh ref={drones} args={[droneGeo, droneMat, DRONE_ACCENTS.length]} frustumCulled={false} />
      <points geometry={lightGeo} material={lightMat} renderOrder={2} frustumCulled={false} />
    </>
  );
}
