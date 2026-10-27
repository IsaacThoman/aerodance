import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RENDER_HEIGHT, RENDER_WIDTH } from '../shared/post.tsx';
import { CAMERA, PLANET_CENTER, PLANET_RADIUS } from './layout.ts';

// What the stage's moving life (Life.tsx, Orbits.tsx, Craft.tsx, Sparkle.tsx) shares: a calm
// that eases in while the dancers dance, the frame the planet is seen in from the gameplay
// camera, and GLSL for glints and for hiding things behind the planet.

/** Uniforms the life shares, moved on by Life's clock. */
export const life = {
  /** 0 normally, easing to 1 while the dancers dance (stagePlay.dancing): busy things quieten. */
  uCalm: { value: 0 },
};

/** How much wider than tall a buffer pixel shows: the 640x480 buffer is stretched to the canvas. */
export function useStretch(): number {
  const size = useThree((s) => s.size);
  return size.width / Math.max(1, size.height) / (RENDER_WIDTH / RENDER_HEIGHT);
}

/** Where the gameplay camera rests, and the planet seen from it. */
export const EYE = new THREE.Vector3(...CAMERA.position);
/** From the planet's centre towards the camera. */
export const TO_EYE = EYE.clone().sub(PLANET_CENTER).normalize();
/** Across the planet's disc as seen from the camera: towards the top of the limb, and its right. */
export const DISC_UP = new THREE.Vector3(0, 1, 0).addScaledVector(TO_EYE, -TO_EYE.y).normalize();
export const DISC_RIGHT = new THREE.Vector3().crossVectors(TO_EYE.clone().negate(), DISC_UP);
/** Radians round the planet from the camera's direction to its limb, as the camera sees it. */
export const LIMB = Math.acos(PLANET_RADIUS / EYE.distanceTo(PLANET_CENTER));

/** The direction from the planet's centre `azimuth` degrees round its disc from the top (right is +) and `polar` degrees off the camera. */
export function discDirection(azimuth: number, polar: number, out = new THREE.Vector3()): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuth);
  const po = THREE.MathUtils.degToRad(polar);
  out.copy(DISC_UP).multiplyScalar(Math.cos(az)).addScaledVector(DISC_RIGHT, Math.sin(az));
  return out.multiplyScalar(Math.sin(po)).addScaledVector(TO_EYE, Math.cos(po));
}

/** GLSL: how visible a point is past the planet, 1 in clear view, fading to 0 as it slips behind the limb. */
export const visibleGLSL = /* glsl */ `
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

/** GLSL: a glint in a point sprite: a hot core and a four-point sparkle; `p` runs -1..1 across it. */
export const glintGLSL = /* glsl */ `
  float glint(vec2 p) {
    float core = exp(-dot(p, p) * 50.0) * 3.5 + exp(-dot(p, p) * 10.0) * 0.5;
    float spark = exp(-abs(p.x) * 30.0) * max(1.0 - abs(p.y), 0.0) + exp(-abs(p.y) * 30.0) * max(1.0 - abs(p.x), 0.0);
    return core + spark * 0.8;
  }
`;

/** GLSL: a world-sized point's size in buffer pixels: `size` world units across at view depth `depth`. */
export const pointSizeGLSL = /* glsl */ `
  float pointSize(float size, float depth) {
    return size * projectionMatrix[1][1] * ${(RENDER_HEIGHT / 2).toFixed(1)} / max(depth, 0.001);
  }
`;
