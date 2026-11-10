import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { viewPoint } from './palette.ts';
import { airshipGeometry, podDomeGeometry, podGeometry } from './models.ts';
import { glassMaterial, glossMaterial } from './materials.ts';

interface Craft {
  /** Where it hangs, as [x, y] NDC of a 16:9 frame and a distance from the camera. */
  at: readonly [x: number, y: number, distance: number];
  /** Size in world units (an airship's length, a pod's radius). */
  size: number;
  /** Heading, radians about y (0: nose along +x). */
  yaw: number;
  phase: number;
}

// The big airship over the upper left, nose towards the camera's left, and a small one far off
// by the horizon heading the other way; a cluster of garden pods hangs in the upper right.
const AIRSHIPS: readonly Craft[] = [
  { at: [-0.56, 0.64, 185], size: 34, yaw: 3.6, phase: 0 },
  { at: [-0.14, 0.555, 760], size: 30, yaw: 0.3, phase: 2.1 },
];
const PODS: readonly Craft[] = [
  { at: [0.74, 0.7, 240], size: 12, yaw: 0.4, phase: 0.7 },
  { at: [0.95, 0.53, 400], size: 10, yaw: 1.9, phase: 2.6 },
  { at: [0.55, 0.86, 470], size: 7, yaw: 4.1, phase: 4.4 },
];

const bases = (crafts: readonly Craft[]) => crafts.map(({ at }) => viewPoint(...at));
const AIRSHIP_BASES = bases(AIRSHIPS);
const POD_BASES = bases(PODS);

// Soft glows that ride along: [craft index, offset and size (in units of the craft's size),
// colour, whether it blinks]. The far airship's beacon is oversized to stay visible.
type GlowSpec = readonly [index: number, offset: readonly [number, number, number], size: number, color: string, blink: boolean];
const AIRSHIP_GLOWS: readonly GlowSpec[] = [
  [0, [-0.39, 0.17, 0], 0.075, '#fff4e0', true],
  [0, [-0.115, -0.103, 0.157], 0.065, '#7ff0ff', false],
  [0, [-0.115, -0.103, -0.157], 0.065, '#7ff0ff', false],
  [1, [-0.39, 0.17, 0], 0.15, '#fff4e0', true],
];
const POD_GLOWS: readonly GlowSpec[] = [
  [0, [0, -0.62, 0], 0.4, '#6fe6ff', false],
  [1, [0, -0.62, 0], 0.4, '#6fe6ff', false],
  [2, [0, -0.62, 0], 0.4, '#6fe6ff', false],
];
const GLOW_COUNT = AIRSHIP_GLOWS.length + POD_GLOWS.length;

const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
// Pods tilt in the world frame (towards the camera, showing their gardens) and spin about their own axis.
const _podEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const POD_TILT = 0.34;
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _local = new THREE.Vector3();

/** A cruising airship: it bobs, surges a little along its heading and leans with the air. */
function airshipMatrix(i: number, t: number, out: THREE.Matrix4): THREE.Matrix4 {
  const { size, yaw, phase } = AIRSHIPS[i];
  const s = t + phase * 10;
  const heading = yaw + Math.sin(s * 0.061) * 0.05;
  const surge = Math.sin(s * 0.047) * size * 0.18;
  _pos.copy(AIRSHIP_BASES[i]);
  _pos.x += Math.cos(heading) * surge;
  _pos.z -= Math.sin(heading) * surge;
  _pos.y += Math.sin(s * 0.29) * size * 0.035;
  _euler.set(Math.sin(s * 0.23 + 1) * 0.02, heading, Math.sin(s * 0.19) * 0.025);
  return out.compose(_pos, _quat.setFromEuler(_euler), _scale.setScalar(size));
}

/** A floating pod: a slow bob, a slower turn and a gentle wobble, tipped towards the camera. */
function podMatrix(i: number, t: number, out: THREE.Matrix4): THREE.Matrix4 {
  const { size, yaw, phase } = PODS[i];
  _pos.copy(POD_BASES[i]);
  _pos.y += Math.sin(t * 0.37 + phase) * size * 0.09;
  _podEuler.set(POD_TILT + Math.sin(t * 0.21 + phase) * 0.04, yaw + t * 0.04, Math.sin(t * 0.17 + phase * 2) * 0.04);
  return out.compose(_pos, _quat.setFromEuler(_podEuler), _scale.setScalar(size));
}

const airshipMatrices = AIRSHIPS.map(() => new THREE.Matrix4());
const podMatrices = PODS.map(() => new THREE.Matrix4());

// Moves every craft and the glows riding on them to where they are at time t.
function placeFleet(
  t: number,
  airships: THREE.InstancedMesh | null,
  pods: THREE.InstancedMesh | null,
  domes: THREE.InstancedMesh | null,
  glows: THREE.InstancedBufferGeometry,
  glowPhase: { value: THREE.Vector2 },
) {
  for (let i = 0; i < AIRSHIPS.length; i++) airships?.setMatrixAt(i, airshipMatrix(i, t, airshipMatrices[i]));
  for (let i = 0; i < PODS.length; i++) {
    podMatrix(i, t, podMatrices[i]);
    pods?.setMatrixAt(i, podMatrices[i]);
    domes?.setMatrixAt(i, podMatrices[i]);
  }
  const centers = glows.attributes.aCenter as THREE.InstancedBufferAttribute;
  for (let k = 0; k < GLOW_COUNT; k++) {
    const onAirship = k < AIRSHIP_GLOWS.length;
    const spec = onAirship ? AIRSHIP_GLOWS[k] : POD_GLOWS[k - AIRSHIP_GLOWS.length];
    const offset = spec[1];
    _local.set(offset[0], offset[1], offset[2]).applyMatrix4((onAirship ? airshipMatrices : podMatrices)[spec[0]]);
    centers.setXYZ(k, _local.x, _local.y, _local.z);
  }
  centers.needsUpdate = true;
  if (airships) airships.instanceMatrix.needsUpdate = true;
  if (pods) pods.instanceMatrix.needsUpdate = true;
  if (domes) domes.instanceMatrix.needsUpdate = true;
  // Wrapped here, so the shader's sines stay precise however long the menu stays up.
  glowPhase.value.set((t * 1.7) % (Math.PI * 2), (t * 2.3) % (Math.PI * 2));
}

/**
 * The fleet: two glossy white airships cruising in place over the drifting deck (which is what
 * makes them seem to travel) and three glass-domed garden pods turning slowly, with soft glows
 * on their beacons, engines and undersides.
 */
export function Fleet() {
  const airships = useRef<THREE.InstancedMesh>(null);
  const pods = useRef<THREE.InstancedMesh>(null);
  const domes = useRef<THREE.InstancedMesh>(null);
  const airship = useDisposable(airshipGeometry);
  const pod = useDisposable(podGeometry);
  const dome = useDisposable(podDomeGeometry);
  const gloss = useDisposable(() => glossMaterial(0.75));
  const glass = useDisposable(() => glassMaterial(0.75));
  const glows = useDisposable(glowGeometry);
  const glowMaterial = useDisposable(makeGlowMaterial);

  useLayoutEffect(() => placeFleet(0, airships.current, pods.current, domes.current, glows, glowMaterial.uniforms.uPhase), [glows, glowMaterial]);
  useBackdropFrame((_state, _delta, t) => placeFleet(t, airships.current, pods.current, domes.current, glows, glowMaterial.uniforms.uPhase));

  return (
    <>
      <instancedMesh ref={airships} args={[airship, gloss, AIRSHIPS.length]} frustumCulled={false} />
      <instancedMesh ref={pods} args={[pod, gloss, PODS.length]} frustumCulled={false} />
      <instancedMesh ref={domes} args={[dome, glass, PODS.length]} frustumCulled={false} renderOrder={10} />
      <mesh geometry={glows} material={glowMaterial} frustumCulled={false} renderOrder={20} />
    </>
  );
}

function glowGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const plane = new THREE.PlaneGeometry(2, 2);
  g.index = plane.index;
  g.setAttribute('position', plane.attributes.position);
  const specs = [...AIRSHIP_GLOWS, ...POD_GLOWS];
  const colors = new Float32Array(GLOW_COUNT * 3);
  const params = new Float32Array(GLOW_COUNT * 3);
  const c = new THREE.Color();
  specs.forEach(([index, , size, color, blink], i) => {
    c.set(color);
    colors.set([c.r, c.g, c.b], i * 3);
    const craft = i < AIRSHIP_GLOWS.length ? AIRSHIPS[index] : PODS[index];
    params.set([size * craft.size, blink ? 1 : 0, index * 1.7], i * 3);
  });
  g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(GLOW_COUNT * 3), 3));
  g.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
  g.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 3));
  g.instanceCount = GLOW_COUNT;
  return g;
}

// Additive camera-facing glows: a hot point in a soft halo. Beacons blink, slowly.
function makeGlowMaterial() {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uPhase: { value: new THREE.Vector2() } },
    vertexShader: /* glsl */ `
      attribute vec3 aCenter;
      attribute vec3 aColor;
      attribute vec3 aParams;
      uniform vec2 uPhase;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        float blink = aParams.y > 0.5 ? pow(0.5 + 0.5 * sin(uPhase.x + aParams.z), 6.0) : 0.8 + 0.2 * sin(uPhase.y + aParams.z);
        vec4 mv = viewMatrix * vec4(aCenter, 1.0);
        mv.xy += position.xy * aParams.x;
        vUv = position.xy;
        vColor = aColor * blink;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        float r2 = dot(vUv, vUv);
        float a = exp(-r2 * 30.0) * 2.5 + exp(-r2 * 5.0) * 0.35;
        a *= 1.0 - smoothstep(0.7, 1.0, r2);
        gl_FragColor = vec4(vColor * a, 1.0);
      }
    `,
  });
}
