import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { HABITAT, SPINE, WINGS, world } from './layout.ts';
import { VERTEX, spaceGLSL, spaceUniforms } from './spaceShading.ts';
import type { OrbitVariant } from './layout.ts';
import {
  WING_MASTS,
  makeBlanketGeometry,
  makeFrameGeometry,
  makeMastGeometry,
  makeRingFrameGeometry,
  makeRingGlassGeometry,
  navLights,
} from './stationGeometry.ts';


// Deep blue solar cells in silver frames, mirror-bright towards the sun. A wing flashes as its
// turning brings its face round to throw the sun at the camera.
function makePanelMaterial() {
  return shaderMaterial({
    side: THREE.DoubleSide,
    uniforms: spaceUniforms(),
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal, vWorld;
      varying vec2 vUv;
      ${spaceGLSL}
      void main() {
        vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 r = reflect(-v, n);
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        // A few big cells: frames that fade out where they would shimmer.
        vec2 grid = vUv * vec2(2.0, 14.0);
        vec2 fw = fwidth(grid);
        vec2 edge = (0.5 - abs(fract(grid) - 0.5)) / max(fw, 1e-4);
        float frame = (1.0 - smoothstep(0.8, 2.2, min(edge.x, edge.y))) * (1.0 - smoothstep(0.12, 0.3, max(fw.x, fw.y)));
        vec3 base = mix(vec3(0.03, 0.13, 0.62), vec3(0.62, 0.74, 0.92), frame * 0.6);
        // A glassy gradient down each cell, as if reflecting a bright horizon.
        float sheen = 0.15 + 0.6 * smoothstep(0.0, 1.0, fract(grid.y));
        vec3 planetGlow = vec3(0.05, 0.16, 0.42) * (0.5 + 0.5 * dot(n, normalize(uCenter - vWorld))) * (1.0 - 0.7 * uNight);
        vec3 col = base * (0.18 + planetGlow * 2.0) + vec3(0.06, 0.22, 0.8) * sheen * 0.22 + environment(r, vWorld) * mix(0.25, 1.0, fresnel) + sunRim(n, v) * 0.5;
        // The flash: when the wing's face, turning about its mast (z), lines up with the
        // half-vector between the sun and the eye seen across that axis.
        vec3 h = normalize(v + uSunDir);
        float flash = pow(max(dot(normalize(n.xy), normalize(h.xy)), 0.0), 260.0) * (0.2 + length(h.xy));
        col += vec3(2.4, 2.6, 3.0) * flash * (0.6 + 0.4 * sheen) * (1.0 - uNight);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Clear aqua glass, nearly invisible face-on and bright at the rims, with the habitat's soft
// lights glowing inside.
function makeRingGlassMaterial() {
  return shaderMaterial({
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: spaceUniforms(),
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal, vWorld;
      varying vec2 vUv;
      ${spaceGLSL}
      void main() {
        vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 r = reflect(-v, n);
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        float rim = pow(1.0 - abs(dot(n, v)), 2.0);
        vec3 inner = mix(vec3(0.08, 0.5, 0.65), vec3(0.15, 0.7, 0.85), uNight);
        vec3 col = environment(r, vWorld) * mix(0.1, 1.0, fresnel) + inner * (0.3 + rim * 0.9) + vec3(0.6, 0.95, 1.0) * pow(rim, 3.0) * 0.9 + sunRim(n, v) * 0.6;
        float alpha = mix(0.18, 0.8, rim);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

// Navigation lights: a soft blink every few seconds.
function makeNavMaterial() {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: world.uTime },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aPhase;
      uniform float uTime;
      varying vec3 vColor;
      void main() {
        float blink = pow(max(cos((uTime / 2.6 + aPhase) * 6.2831853), 0.0), 40.0);
        vColor = aColor * (0.12 + blink * 1.4);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(320.0 / -mv.z, 4.0, 12.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        gl_FragColor = vec4(vColor * exp(-dot(p, p) * 5.0), 1.0);
      }
    `,
  });
}

/** The wing pairs: which side, how far forward they reach, and each wing's mast x and phase. */
const PAIRS = ([-1, 1] as const).map((side) => ({
  side,
  fore: side < 0 ? WINGS.fore.left : WINGS.fore.right,
  wings: WING_MASTS.map((x, i) => ({ x: side * x, phase: i * 1.7 + (side > 0 ? 0.9 : 0) })),
}));

/**
 * The space station around the deck: the white spine running back under the camera to its
 * modules and docking port, a V of trusses carrying two pairs of blue solar wings high over the
 * deck's sides (they turn slowly and flash as they catch the sun), the aqua glass habitat ring
 * turning about the spine, and blinking navigation lights.
 */
export function Station(_props: OrbitVariant) {
  const ring = useRef<THREE.Group>(null);
  const geo = useDisposable(() => ({
    frame: makeFrameGeometry(),
    pairs: PAIRS.map(({ fore }) => ({ mast: makeMastGeometry(fore), blankets: makeBlanketGeometry(fore) })),
    ringFrame: makeRingFrameGeometry(),
    ringGlass: makeRingGlassGeometry(),
    nav: (() => {
      const lights = navLights();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lights.flatMap((l) => l.position.toArray()), 3));
      g.setAttribute('aColor', new THREE.Float32BufferAttribute(lights.flatMap((l) => l.color.toArray()), 3));
      g.setAttribute('aPhase', new THREE.Float32BufferAttribute(lights.map((l) => l.phase), 1));
      return g;
    })(),
  }));
  const mats = useDisposable(() => ({
    white: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 }),
    panel: makePanelMaterial(),
    ringGlass: makeRingGlassMaterial(),
    nav: makeNavMaterial(),
  }));
  // Each pair's masts and blankets, instanced so a pair draws in two calls however it turns.
  const wings = useDisposable(
    () =>
      geo.pairs.map(({ mast, blankets }) => {
        const masts = new THREE.InstancedMesh(mast, mats.white, WING_MASTS.length);
        const panels = new THREE.InstancedMesh(blankets, mats.panel, WING_MASTS.length);
        for (const m of [masts, panels]) {
          m.frustumCulled = false;
          m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        }
        return { masts, panels };
      }),
    [geo, mats],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    const t = world.uTime.value;
    PAIRS.forEach(({ side, wings: pair }, p) => {
      const { masts, panels } = wings[p];
      pair.forEach(({ x, phase }, i) => {
        // Faces tilted in towards the deck, rocking slowly as they track the sun.
        dummy.position.set(x, WINGS.y, 0);
        dummy.rotation.set(0, 0, side * (0.55 + 0.6 * Math.sin(t * 0.045 + phase)));
        dummy.updateMatrix();
        masts.setMatrixAt(i, dummy.matrix);
        panels.setMatrixAt(i, dummy.matrix);
      });
      masts.instanceMatrix.needsUpdate = true;
      panels.instanceMatrix.needsUpdate = true;
    });
    if (ring.current) ring.current.rotation.z = (t * 0.05) % (Math.PI * 2);
  });

  return (
    <group>
      <mesh geometry={geo.frame} material={mats.white} />
      {wings.map(({ masts, panels }, i) => (
        <group key={i}>
          <primitive object={masts} />
          <primitive object={panels} />
        </group>
      ))}
      <group ref={ring} position={[0, SPINE.y, HABITAT.z]}>
        <mesh geometry={geo.ringFrame} material={mats.white} />
        <mesh geometry={geo.ringGlass} material={mats.ringGlass} renderOrder={3} />
      </group>
      <points geometry={geo.nav} material={mats.nav} frustumCulled={false} renderOrder={4} />
    </group>
  );
}
