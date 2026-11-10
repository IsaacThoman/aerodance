import { useMemo } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { PLANET_CENTER, PLANET_RADIUS, world } from './layout.ts';
import { useStretch } from './Space.tsx';

interface Orbit {
  /** Degrees the orbit leans from square-on to the camera: more brings its near side further in. */
  tilt: number;
  /** Degrees the lean turns away from the middle of the frame. */
  turn: number;
  /** Orbit radius, in planet radii. */
  radius: number;
  /** Radians per second; negative runs the other way round. */
  speed: number;
  /** Where the satellite starts, radians from the front of the orbit. */
  phase: number;
  /** Radians of orbit the trail fades over. */
  trail: number;
  color: string;
}

// Three satellites on leaning orbits low over the planet. Each orbit's near side sweeps across the
// planet's face in an arc echoing the limb, behind the dancers, before running out past the limb
// and round behind: a "connected world" of light.
const ORBITS: readonly Orbit[] = [
  { tilt: 66, turn: 8, radius: 1.06, speed: 0.03, phase: -0.35, trail: 0.42, color: '#8ae9ff' },
  { tilt: 60, turn: -16, radius: 1.1, speed: -0.026, phase: 1.5, trail: 0.36, color: '#e6f6ff' },
  { tilt: 74, turn: 26, radius: 1.04, speed: 0.036, phase: -2.2, trail: 0.3, color: '#a8ffd8' },
];
const SEGMENTS = 320;
/** Half the trails' width, world units. */
const TRAIL_WIDTH = 1.1;

// Is a point hidden behind the planet? 1 in clear view, fading to 0 as it slips behind the limb.
const visibleGLSL = /* glsl */ `
  float visible(vec3 p, vec3 center, float radius) {
    vec3 d = p - cameraPosition;
    float len = length(d);
    vec3 rd = d / len;
    vec3 oc = cameraPosition - center;
    float tca = -dot(oc, rd);
    float b = length(oc + rd * tca);
    float behind = step(tca, len);
    return 1.0 - behind * (1.0 - smoothstep(radius * 0.995, radius * 1.03, b));
  }
`;

const orbitAngle = (orbit: Orbit, time: number): number => (orbit.phase + orbit.speed * time) % (Math.PI * 2);

// The orbit's frame: two axes across its plane, the first towards its front (where phase 0 is,
// nearest the camera), the second across it.
function orbitAxes(orbit: Orbit): [THREE.Vector3, THREE.Vector3] {
  const toCamera = PLANET_CENTER.clone().negate().normalize();
  // From the planet's centre towards the middle of the frame, square to the view.
  const inward = new THREE.Vector3(0, 0, -PLANET_CENTER.length()).sub(PLANET_CENTER);
  inward.addScaledVector(toCamera, -inward.dot(toCamera)).normalize();
  const side = new THREE.Vector3().crossVectors(toCamera, inward);
  const tilt = THREE.MathUtils.degToRad(orbit.tilt);
  const turn = THREE.MathUtils.degToRad(orbit.turn);
  const lean = inward.multiplyScalar(Math.cos(turn)).addScaledVector(side, Math.sin(turn));
  const normal = toCamera.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(lean, -Math.sin(tilt));
  const across = new THREE.Vector3().crossVectors(normal, toCamera).normalize();
  const front = new THREE.Vector3().crossVectors(normal, across);
  if (front.dot(lean) < 0) front.negate();
  return [front, across];
}

/**
 * The satellites: bright glints with four-point sparkles, each trailing a fading ribbon of light
 * along its orbit. Ribbons face the camera and fade out softly behind the limb.
 */
export function Orbits() {
  const stretch = useStretch();
  const angles = useMemo(() => ({ value: new THREE.Vector3() }), []);

  const trailGeometry = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    const perOrbit = (SEGMENTS + 1) * 2;
    const count = perOrbit * ORBITS.length;
    const position = new Float32Array(count * 3);
    const angle = new Float32Array(count * 2);
    const axisU = new Float32Array(count * 3);
    const axisW = new Float32Array(count * 3);
    const params = new Float32Array(count * 4);
    const color = new Float32Array(count * 3);
    const index: number[] = [];
    const tint = new THREE.Color();
    ORBITS.forEach((orbit, o) => {
      const [u, w] = orbitAxes(orbit);
      tint.set(orbit.color);
      for (let s = 0; s <= SEGMENTS; s++) {
        for (let side = 0; side < 2; side++) {
          const i = o * perOrbit + s * 2 + side;
          angle.set([(s / SEGMENTS) * Math.PI * 2, side * 2 - 1], i * 2);
          axisU.set([u.x, u.y, u.z], i * 3);
          axisW.set([w.x, w.y, w.z], i * 3);
          params.set([orbit.radius * PLANET_RADIUS, Math.sign(orbit.speed), orbit.trail, o], i * 4);
          color.set([tint.r, tint.g, tint.b], i * 3);
        }
        if (s < SEGMENTS) {
          const a = o * perOrbit + s * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aAngle', new THREE.BufferAttribute(angle, 2));
    g.setAttribute('aU', new THREE.BufferAttribute(axisU, 3));
    g.setAttribute('aW', new THREE.BufferAttribute(axisW, 3));
    g.setAttribute('aOrbit', new THREE.BufferAttribute(params, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    g.setIndex(index);
    return g;
  });

  const headGeometry = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    const n = ORBITS.length;
    const axisU = new Float32Array(n * 3);
    const axisW = new Float32Array(n * 3);
    const params = new Float32Array(n * 4);
    const color = new Float32Array(n * 3);
    const tint = new THREE.Color();
    ORBITS.forEach((orbit, o) => {
      const [u, w] = orbitAxes(orbit);
      axisU.set([u.x, u.y, u.z], o * 3);
      axisW.set([w.x, w.y, w.z], o * 3);
      params.set([orbit.radius * PLANET_RADIUS, Math.sign(orbit.speed), orbit.trail, o], o * 4);
      color.set(tint.set(orbit.color).toArray(), o * 3);
    });
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aU', new THREE.BufferAttribute(axisU, 3));
    g.setAttribute('aW', new THREE.BufferAttribute(axisW, 3));
    g.setAttribute('aOrbit', new THREE.BufferAttribute(params, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    return g;
  });

  // Where each satellite is: angle round its orbit, from the clock, kept within a turn.
  useBackdropFrame((_state, _delta, time) => {
    angles.value.set(orbitAngle(ORBITS[0], time), orbitAngle(ORBITS[1], time), orbitAngle(ORBITS[2], time));
  });

  const trailMaterial = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uCenter: world.uCenter, uRadius: world.uRadius, uSat: angles, uWidth: { value: TRAIL_WIDTH } },
      vertexShader: /* glsl */ `
        attribute vec2 aAngle;
        attribute vec3 aU, aW, aColor;
        attribute vec4 aOrbit;
        uniform vec3 uCenter, uSat;
        uniform float uWidth;
        varying vec3 vWorld, vColor;
        varying float vSide, vTrail;
        void main() {
          float th = aAngle.x;
          vec3 p = uCenter + aOrbit.x * (aU * cos(th) + aW * sin(th));
          vec3 tangent = -aU * sin(th) + aW * cos(th);
          vec3 across = normalize(cross(tangent, cameraPosition - p));
          p += across * aAngle.y * uWidth;
          float sat = aOrbit.w < 0.5 ? uSat.x : aOrbit.w < 1.5 ? uSat.y : uSat.z;
          // Radians behind the satellite, the way it travels.
          float behind = mod(aOrbit.y * (sat - th), 6.2831853);
          // A bright trail fading behind the satellite, along a faint line of the whole orbit.
          vTrail = exp(-behind / aOrbit.z) * smoothstep(0.0, 0.02, behind) + 0.03;
          vSide = aAngle.y;
          vColor = aColor;
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCenter;
        uniform float uRadius;
        varying vec3 vWorld, vColor;
        varying float vSide, vTrail;
        ${visibleGLSL}
        void main() {
          float across = exp(-vSide * vSide * 3.0) * 0.6 + exp(-vSide * vSide * 12.0) * vTrail * 0.8;
          float a = across * vTrail * visible(vWorld, uCenter, uRadius);
          gl_FragColor = vec4(vColor * a * 0.4, 1.0);
        }
      `,
    }),
  );

  const headMaterial = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uCenter: world.uCenter, uRadius: world.uRadius, uSat: angles, uTime: world.uTime, uStretch: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aU, aW, aColor;
        attribute vec4 aOrbit;
        uniform vec3 uCenter, uSat;
        uniform float uRadius, uTime;
        varying vec3 vColor;
        ${visibleGLSL}
        void main() {
          float th = aOrbit.w < 0.5 ? uSat.x : aOrbit.w < 1.5 ? uSat.y : uSat.z;
          vec3 p = uCenter + aOrbit.x * (aU * cos(th) + aW * sin(th));
          // Solar panels catching the sun now and then.
          float glint = 0.75 + 0.25 * sin(uTime * 1.3 + aOrbit.w * 2.1);
          vColor = aColor * glint * visible(p, uCenter, uRadius);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          gl_PointSize = 22.0;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStretch;
        varying vec3 vColor;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          p.x *= uStretch;
          float core = exp(-dot(p, p) * 50.0) * 3.5 + exp(-dot(p, p) * 10.0) * 0.5;
          float spark = exp(-abs(p.x) * 30.0) * (1.0 - abs(p.y)) + exp(-abs(p.y) * 30.0) * (1.0 - abs(p.x));
          gl_FragColor = vec4(vColor * (core + spark * 0.8), 1.0);
        }
      `,
    }),
  );
  headMaterial.uniforms.uStretch.value = stretch;

  return (
    <>
      <mesh geometry={trailGeometry} material={trailMaterial} renderOrder={20} frustumCulled={false} />
      <points geometry={headGeometry} material={headMaterial} renderOrder={21} frustumCulled={false} />
    </>
  );
}
