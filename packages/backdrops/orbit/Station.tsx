import { useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { frameDirection, world } from './layout.ts';
import { useStretch } from './Space.tsx';

/** Where the station drifts: a point of the 16:9 frame, and how far from the camera. */
const STATION_AT = frameDirection(0.41, 0.16);
const STATION_DISTANCE = 52;

// Station parts, in its own frame: the spine runs along x, the habitat ring turns about it.
function bodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.24, 0.24, 8.6, 16, 1).rotateZ(Math.PI / 2), new THREE.SphereGeometry(0.85, 32, 16)];
  for (const x of [-1.9, 1.9]) parts.push(new THREE.CapsuleGeometry(0.5, 1.3, 8, 20).rotateZ(Math.PI / 2).translate(x, 0, 0));
  for (const x of [-4.3, 4.3]) parts.push(new THREE.SphereGeometry(0.34, 20, 12).translate(x, 0, 0));
  // Trusses carrying the solar wings.
  for (const x of [-3.5, 3.5]) parts.push(new THREE.CylinderGeometry(0.1, 0.1, 7.4, 8, 1).rotateX(Math.PI / 2).translate(x, 0, 0));
  return mergeParts(parts);
}

function spokeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(new THREE.CylinderGeometry(0.11, 0.11, 2.0, 8, 1).translate(0, 1.75, 0).rotateX((i / 4) * Math.PI * 2 + Math.PI / 4));
  }
  return mergeParts(parts);
}

// The habitat ring, round the spine.
const glassGeometry = (): THREE.BufferGeometry => new THREE.TorusGeometry(2.75, 0.34, 20, 96).rotateY(Math.PI / 2);

function panelGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [-3.5, 3.5]) {
    for (const z of [-2.35, 2.35]) parts.push(new THREE.BoxGeometry(1.5, 0.04, 2.9).translate(x, 0, z));
  }
  return mergeParts(parts);
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  if (!merged) throw new Error('Station parts would not merge');
  return merged;
}

// Lit like the planet: by a key light (the sun swung round towards the camera, so we see the
// station's sunny side), blue light off the planet, warm rims from the real sun behind, and
// reflections of an environment worked out on the spot (space, the planet's disc, the sun).
const lightingGLSL = /* glsl */ `
  uniform vec3 uSunDir, uCenter;
  uniform float uRadius;

  vec3 environment(vec3 r, vec3 at) {
    vec3 toPlanet = uCenter - at;
    float dist = length(toPlanet);
    toPlanet /= dist;
    float limb = sqrt(max(1.0 - uRadius * uRadius / (dist * dist), 0.0));
    float k = dot(r, toPlanet);
    float onPlanet = smoothstep(limb - 0.03, limb + 0.03, k);
    vec3 space = vec3(0.004, 0.01, 0.03) + vec3(0.05, 0.2, 0.5) * exp(-abs(k - limb) * 14.0);
    vec3 planet = mix(vec3(0.06, 0.24, 0.6), vec3(0.4, 0.75, 1.0), exp(-(k - limb) * 6.0));
    vec3 c = mix(space, planet, onPlanet);
    float s = max(dot(r, uSunDir), 0.0);
    return c + vec3(1.0, 0.92, 0.8) * (pow(s, 500.0) * 30.0 + pow(s, 24.0) * 0.6);
  }

  // Diffuse light: the key, wrapped a little, and the planet's blue glow from below.
  vec3 irradiance(vec3 n, vec3 at) {
    vec3 toPlanet = normalize(uCenter - at);
    vec3 toKey = normalize(uSunDir + normalize(cameraPosition - at) * 1.2);
    vec3 key = vec3(1.0, 0.95, 0.88) * 2.0 * max(dot(n, toKey) * 0.75 + 0.25, 0.0);
    vec3 earth = vec3(0.12, 0.32, 0.7) * (0.5 + 0.5 * dot(n, toPlanet));
    return key + earth + vec3(0.03, 0.04, 0.06);
  }

  // The sunrise behind catching the edges.
  vec3 sunRim(vec3 n, vec3 v) {
    return vec3(1.6, 1.15, 0.7) * pow(1.0 - max(dot(n, v), 0.0), 3.0) * max(dot(n, uSunDir), 0.0);
  }
`;

const VERTEX = /* glsl */ `
  varying vec3 vNormal, vWorld;
  varying vec2 vUv;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

type Finish = 'white' | 'panel' | 'glass';

function stationMaterial(finish: Finish) {
  const glass = finish === 'glass';
  return shaderMaterial({
    transparent: glass,
    premultipliedAlpha: glass,
    depthWrite: !glass,
    side: glass ? THREE.DoubleSide : THREE.FrontSide,
    defines: { [finish.toUpperCase()]: '' },
    uniforms: { uSunDir: world.uSunDir, uCenter: world.uCenter, uRadius: world.uRadius },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal, vWorld;
      varying vec2 vUv;
      ${lightingGLSL}
      void main() {
        vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 r = reflect(-v, n);
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        #ifdef WHITE
          // Glossy white enamel.
          vec3 col = vec3(0.86, 0.9, 0.96) * irradiance(n, vWorld) * 0.6 + environment(r, vWorld) * mix(0.06, 0.9, fresnel) + sunRim(n, v);
          gl_FragColor = vec4(col, 1.0);
        #endif
        #ifdef PANEL
          // Deep blue solar glass in a few silver-framed cells, mirror-bright when it faces the sun.
          vec2 grid = vUv * vec2(2.0, 3.0);
          vec2 edge = (0.5 - abs(fract(grid) - 0.5)) / fwidth(grid);
          float frame = 1.0 - smoothstep(0.8, 2.2, min(edge.x, edge.y));
          vec3 base = mix(vec3(0.04, 0.16, 0.7), vec3(0.6, 0.72, 0.9), frame * 0.5);
          // A glassy gradient down each cell, as if reflecting a bright horizon.
          vec3 sheen = vec3(0.08, 0.3, 0.9) * (0.15 + 0.6 * smoothstep(0.0, 1.0, fract(grid.y))) * 0.35;
          vec3 col = base * irradiance(n, vWorld) * 0.5 + sheen + environment(r, vWorld) * mix(0.3, 1.0, fresnel) + sunRim(n, v) * 0.5;
          gl_FragColor = vec4(col, 1.0);
        #endif
        #ifdef GLASS
          // Clear aqua glass, nearly invisible face-on and bright at the rims, with a soft glow inside.
          float rim = pow(1.0 - abs(dot(n, v)), 2.0);
          vec3 col = environment(r, vWorld) * mix(0.1, 1.0, fresnel) + vec3(0.05, 0.32, 0.5) * (0.05 + rim * 0.5) + vec3(0.6, 0.9, 1.0) * pow(rim, 3.0) * 0.6 + sunRim(n, v) * 0.6;
          float alpha = mix(0.06, 0.7, rim);
          gl_FragColor = vec4(col, alpha);
        #endif
      }
    `,
  });
}

/**
 * A sleek white-and-glass space station drifting through the top of the frame above the title:
 * a white spine with modules, a turning aqua glass habitat ring on spokes, blue solar wings that
 * flash as they catch the sun, and blinking navigation lights. It sways and turns very slowly.
 */
export function Station() {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Group>(null);
  const stretch = useStretch();
  const geometries = useDisposable(() => ({ body: bodyGeometry(), spokes: spokeGeometry(), glass: glassGeometry(), panels: panelGeometry() }));
  const materials = useDisposable(() => ({ white: stationMaterial('white'), panel: stationMaterial('panel'), glass: stationMaterial('glass') }));

  // Navigation lights at the wing tips and a white strobe on the spine.
  const lights = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-3.5, 0.1, -3.85, 3.5, 0.1, 3.85, 4.65, 0, 0]), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array([3, 0.25, 0.2, 0.3, 3, 0.6, 2.5, 2.8, 3]), 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array([0, 0.5, 0.25]), 1));
    return g;
  });
  const lightMaterial = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: world.uTime, uStretch: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aPhase;
        uniform float uTime;
        varying vec3 vColor;
        void main() {
          // A soft blink every few seconds.
          float blink = pow(max(cos((uTime / 2.6 + aPhase) * 6.2831853), 0.0), 60.0);
          vColor = aColor * (0.08 + blink);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 9.0;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStretch;
        varying vec3 vColor;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          p.x *= uStretch;
          gl_FragColor = vec4(vColor * exp(-dot(p, p) * 7.0), 1.0);
        }
      `,
    }),
  );
  lightMaterial.uniforms.uStretch.value = stretch;

  useBackdropFrame((_state, _delta, t) => {
    const g = group.current;
    if (g) {
      g.position.copy(STATION_AT).multiplyScalar(STATION_DISTANCE);
      g.position.x += Math.sin(t * 0.045) * 1.6;
      g.position.y += Math.sin(t * 0.06 + 1.1) * 0.6;
      g.position.z += Math.sin(t * 0.035 + 2.0) * 1.2;
      // Wings turned to the camera, the ring seen at a slant, swaying slowly.
      g.rotation.set(1.1 + Math.sin(t * 0.05) * 0.08, -0.6 + Math.sin(t * 0.03 + 0.7) * 0.25, 0.3 + Math.sin(t * 0.04 + 1.9) * 0.08, 'YXZ');
    }
    if (ring.current) ring.current.rotation.x = (t * 0.12) % (Math.PI * 2);
  });

  return (
    <group ref={group}>
      <mesh geometry={geometries.body} material={materials.white} renderOrder={30} />
      <mesh geometry={geometries.panels} material={materials.panel} renderOrder={30} />
      <group ref={ring}>
        <mesh geometry={geometries.spokes} material={materials.white} renderOrder={30} />
        <mesh geometry={geometries.glass} material={materials.glass} renderOrder={31} />
      </group>
      <points geometry={lights} material={lightMaterial} renderOrder={32} frustumCulled={false} />
    </group>
  );
}
