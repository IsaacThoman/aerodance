import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { PLANET_RADIUS, world } from './layout.ts';
import { DISC_RIGHT, DISC_UP, LIMB, TO_EYE, discDirection, glintGLSL, life, useStretch, visibleGLSL } from './glints.ts';

// Satellites and meteors: the lights going round the planet, far beyond the deck. They draw
// before the glass dancers (renderOrder 0) and test depth, so the deck and the dancers stand in
// front of them; they fade out behind the planet's limb on their own.
const ORDER = -4;

interface Orbit {
  /** Degrees round the planet's disc, as the gameplay camera sees it, from its top (right is +), where the orbit rises over the limb. */
  roll: number;
  /** Degrees the orbit's plane turns from edge-on to the camera, opening it into an arch over the dancers. */
  open: number;
  /** Orbit radius, in planet radii. */
  radius: number;
  /** Radians per second; negative runs the other way round. */
  speed: number;
  /** Where the first satellite starts, radians round from the top of the arch. */
  phase: number;
  /** Radians of orbit a trail fades over. */
  trail: number;
  /** Satellites spaced evenly round the orbit. */
  count: number;
  color: string;
}

// Two arches of light rising from the limb either side of the dancers and crossing high over
// them, and a low orbit skimming the planet on the left: a "connected world". A satellite climbs
// over the limb, arcs high across the sky and swoops down under the deck towards the camera.
// (th from about 0.3 to 1.5 is in view at gameplay framing.)
const ORBITS: readonly Orbit[] = [
  { roll: -32, open: 15, radius: 1.135, speed: 0.045, phase: 0.45, trail: 0.5, count: 3, color: '#8ae9ff' },
  { roll: 34, open: -14, radius: 1.155, speed: -0.038, phase: 1.5, trail: 0.42, count: 3, color: '#e6f6ff' },
  { roll: -40, open: 4, radius: 1.04, speed: 0.05, phase: 0.9, trail: 0.36, count: 1, color: '#a8ffd8' },
];
const SEGMENTS = 360;
/** Half a trail's width, radians of view: the same thickness near and far. */
const TRAIL_WIDTH = 0.006;

// The orbit's frame: the first axis towards where it rises over the limb, the second turned
// from the camera by its opening.
function orbitAxes(orbit: Orbit): [THREE.Vector3, THREE.Vector3] {
  const u = discDirection(orbit.roll, 90);
  const across = new THREE.Vector3().crossVectors(u, TO_EYE);
  const open = THREE.MathUtils.degToRad(orbit.open);
  const w = TO_EYE.clone().multiplyScalar(Math.cos(open)).addScaledVector(across, Math.sin(open));
  return [u, w];
}

// Each vertex carries its orbit: its axes, [radius, speed, phase, trail] and [r, g, b, count or slot].
function orbitAttributes(g: THREE.BufferGeometry, count: number, each: (set: (i: number, orbit: Orbit, w: number) => void) => void) {
  const axisU = new Float32Array(count * 3);
  const axisW = new Float32Array(count * 3);
  const params = new Float32Array(count * 4);
  const color = new Float32Array(count * 4);
  const tint = new THREE.Color();
  each((i, orbit, w) => {
    const [u, v] = orbitAxes(orbit);
    tint.set(orbit.color);
    axisU.set([u.x, u.y, u.z], i * 3);
    axisW.set([v.x, v.y, v.z], i * 3);
    params.set([orbit.radius * PLANET_RADIUS, orbit.speed, orbit.phase, orbit.trail], i * 4);
    color.set([tint.r, tint.g, tint.b, w], i * 4);
  });
  g.setAttribute('aU', new THREE.BufferAttribute(axisU, 3));
  g.setAttribute('aW', new THREE.BufferAttribute(axisW, 3));
  g.setAttribute('aOrbit', new THREE.BufferAttribute(params, 4));
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 4));
}

/**
 * The satellites: bright glints with four-point sparkles, each trailing a fading ribbon of light
 * along its orbit over a faint line of the whole orbit. Ribbons face the camera and fade out
 * softly behind the limb. Everything moves in the shaders, on the stage clock.
 */
export function Satellites() {
  const stretch = useStretch();

  const trailGeometry = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    const perOrbit = (SEGMENTS + 1) * 2;
    const count = perOrbit * ORBITS.length;
    const angle = new Float32Array(count * 2);
    const index: number[] = [];
    orbitAttributes(g, count, (set) =>
      ORBITS.forEach((orbit, o) => {
        for (let s = 0; s <= SEGMENTS; s++) {
          for (let side = 0; side < 2; side++) {
            const i = o * perOrbit + s * 2 + side;
            angle.set([(s / SEGMENTS) * Math.PI * 2, side * 2 - 1], i * 2);
            set(i, orbit, orbit.count);
          }
          if (s < SEGMENTS) {
            const a = o * perOrbit + s * 2;
            index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
      }),
    );
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aAngle', new THREE.BufferAttribute(angle, 2));
    g.setIndex(index);
    return g;
  });

  const headGeometry = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    const n = ORBITS.reduce((sum, orbit) => sum + orbit.count, 0);
    let i = 0;
    orbitAttributes(g, n, (set) =>
      ORBITS.forEach((orbit) => {
        for (let k = 0; k < orbit.count; k++) set(i++, orbit, (k / orbit.count) * Math.PI * 2);
      }),
    );
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return g;
  });

  const trailMaterial = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uCenter: world.uCenter, uRadius: world.uRadius, uTime: world.uTime, uNight: world.uNight, uCalm: life.uCalm, uWidth: { value: TRAIL_WIDTH } },
      vertexShader: /* glsl */ `
        attribute vec2 aAngle;
        attribute vec3 aU, aW;
        attribute vec4 aOrbit, aColor;
        uniform vec3 uCenter;
        uniform float uTime, uWidth;
        varying vec3 vWorld, vColor;
        varying float vSide, vTrail;
        void main() {
          float th = aAngle.x;
          vec3 p = uCenter + aOrbit.x * (aU * cos(th) + aW * sin(th));
          vec3 tangent = -aU * sin(th) + aW * cos(th);
          vec3 toEye = cameraPosition - p;
          p += normalize(cross(tangent, toEye)) * aAngle.y * uWidth * length(toEye);
          float sat = aOrbit.z + aOrbit.y * uTime;
          // Radians behind the nearest satellite ahead, the way they travel.
          float behind = mod(sign(aOrbit.y) * (sat - th), 6.2831853 / aColor.w);
          // A bright trail fading behind each satellite, along a faint line of the whole orbit.
          vTrail = exp(-behind / aOrbit.w) * smoothstep(0.0, 0.02, behind) + 0.03;
          vSide = aAngle.y;
          vColor = aColor.rgb;
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCenter;
        uniform float uRadius, uNight, uCalm;
        varying vec3 vWorld, vColor;
        varying float vSide, vTrail;
        ${visibleGLSL}
        void main() {
          float across = exp(-vSide * vSide * 3.0) * 0.6 + exp(-vSide * vSide * 12.0) * vTrail * 0.8;
          // Brighter against the night side; a little quieter while the dancers dance.
          float gain = 0.4 * (1.0 + 0.5 * uNight) * (1.0 - 0.3 * uCalm);
          gl_FragColor = vec4(vColor * across * vTrail * visible(vWorld, uCenter, uRadius) * gain, 1.0);
        }
      `,
    }),
  );

  const headMaterial = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uCenter: world.uCenter, uRadius: world.uRadius, uTime: world.uTime, uStretch: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aU, aW;
        attribute vec4 aOrbit, aColor;
        uniform vec3 uCenter;
        uniform float uRadius, uTime;
        varying vec3 vColor;
        ${visibleGLSL}
        void main() {
          float th = aOrbit.z + aOrbit.y * uTime + aColor.w;
          vec3 p = uCenter + aOrbit.x * (aU * cos(th) + aW * sin(th));
          // Solar panels catching the sun now and then.
          float glint = 0.7 + 0.3 * pow(0.5 + 0.5 * sin(uTime * 1.3 + aColor.w * 2.1 + aOrbit.z * 3.0), 3.0);
          vColor = aColor.rgb * glint * visible(p, uCenter, uRadius);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // A little bigger as it swoops nearer.
          gl_PointSize = mix(24.0, 15.0, smoothstep(800.0, 3500.0, -mv.z));
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStretch;
        varying vec3 vColor;
        ${glintGLSL}
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          p.x *= uStretch;
          gl_FragColor = vec4(vColor * glint(p), 1.0);
        }
      `,
    }),
  );
  headMaterial.uniforms.uStretch.value = stretch;

  return (
    <>
      <mesh geometry={trailGeometry} material={trailMaterial} renderOrder={ORDER} frustumCulled={false} />
      <points geometry={headGeometry} material={headMaterial} renderOrder={ORDER} frustumCulled={false} />
    </>
  );
}

/** A meteor slot: one now and then, every `period` seconds from `offset`, unless it skips a turn. */
const METEORS: readonly { period: number; offset: number }[] = [
  { period: 7.5, offset: 5.2 },
  { period: 10.5, offset: 1.4 },
  { period: 13, offset: 9.1 },
];
const METEOR_SEGMENTS = 16;
/** Half a meteor's width, radians of view. */
const METEOR_WIDTH = 0.0045;

/**
 * Meteors burning in over the night side: now and then, either side of the dancers, a streak
 * of white fire with a green tail falls out of the sky towards the limb, brightening as it hits
 * the air, and flares and burns out along the airglow. Each slot picks its meteor from a hash of its turn, in the shader.
 */
export function Meteors() {
  const geometry = useDisposable(() => {
    const strip = new THREE.PlaneGeometry(1, 2, METEOR_SEGMENTS, 1);
    // x: 0 at the tail to 1 at the head; y: -1..1 across.
    strip.translate(0.5, 0, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = strip.index;
    g.attributes.position = strip.attributes.position;
    const slot = new Float32Array(METEORS.length * 3);
    METEORS.forEach(({ period, offset }, i) => slot.set([i, period, offset], i * 3));
    g.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slot, 3));
    g.instanceCount = METEORS.length;
    return g;
  });

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uCenter: world.uCenter,
        uRadius: world.uRadius,
        uTime: world.uTime,
        uCalm: life.uCalm,
        uWidth: { value: METEOR_WIDTH },
        uToEye: { value: TO_EYE },
        uUp: { value: DISC_UP },
        uRight: { value: DISC_RIGHT },
        uLimb: { value: LIMB },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aSlot;
        uniform vec3 uCenter, uToEye, uUp, uRight;
        uniform float uRadius, uTime, uWidth, uLimb;
        varying vec3 vWorld, vColor;
        varying float vSide, vGain;
        ${hash}
        void main() {
          float t = uTime + aSlot.z;
          float turn = floor(t / aSlot.y);
          float h1 = hash12(vec2(turn, aSlot.x * 7.31));
          float h2 = hash12(vec2(turn + 17.0, aSlot.x * 3.17));
          float h3 = hash12(vec2(turn + 31.0, aSlot.x * 5.71));
          float h4 = hash12(vec2(turn + 47.0, aSlot.x * 2.39));
          float duration = mix(0.8, 1.4, h4);
          float age = (t - turn * aSlot.y) / duration;
          // Skips about a turn in four; otherwise burns for its duration.
          if (age > 1.0 || h4 < 0.22 || uTime <= 0.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          // Either side of the dancers, round the planet's disc from its top: each falls out of
          // the sky above the limb and burns in, drifting sideways, at the airglow along it.
          float side = h1 < 0.5 ? -1.0 : 1.0;
          float az = radians(side * mix(18.0, 32.0, fract(h1 * 2.0)));
          float drift = radians(side * mix(-4.0, 9.0, h3));
          vec3 from = (uUp * cos(az) + uRight * sin(az)) * sin(uLimb + radians(mix(3.5, 5.0, h2))) + uToEye * cos(uLimb + radians(mix(3.5, 5.0, h2)));
          vec3 to = (uUp * cos(az + drift) + uRight * sin(az + drift)) * sin(uLimb + radians(0.6)) + uToEye * cos(uLimb + radians(0.6));
          vec3 start = uCenter + from * uRadius * mix(1.08, 1.12, h3);
          vec3 path = uCenter + to * uRadius * 1.012 - start;
          vec3 dir = normalize(path);
          float run = length(path);
          // The head falls at a steady pace; the tail grows behind it.
          float head = run * age;
          float tail = run * 0.45 * min(1.0, age * 2.5);
          float u = position.x;
          vec3 p = start + dir * (head - (1.0 - u) * tail);
          vec3 toEye = cameraPosition - p;
          float width = uWidth * length(toEye) * (0.3 + 0.7 * u);
          p += normalize(cross(dir, toEye)) * position.y * width;
          // Faint out in space, brightening as it falls into the air, flaring once as it burns out.
          float burn = mix(0.25, 1.0, smoothstep(0.1, 0.7, age)) * (1.0 + 1.5 * smoothstep(0.7, 0.88, age)) * (1.0 - smoothstep(0.9, 1.0, age));
          vGain = burn * pow(u, 1.6);
          vColor = mix(vec3(0.25, 1.0, 0.6), vec3(1.2, 1.1, 0.95), smoothstep(0.6, 1.0, u));
          vSide = position.y;
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCenter;
        uniform float uRadius, uCalm;
        varying vec3 vWorld, vColor;
        varying float vSide, vGain;
        ${visibleGLSL}
        void main() {
          float across = exp(-vSide * vSide * 4.0);
          gl_FragColor = vec4(vColor * across * vGain * visible(vWorld, uCenter, uRadius) * (1.0 - 0.3 * uCalm) * 1.4, 1.0);
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} renderOrder={ORDER} frustumCulled={false} />;
}
