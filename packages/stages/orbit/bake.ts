import * as THREE from 'three';
import { noise } from '../shared/glsl.ts';

// The planet's maps and the nebula are fractal noise far too heavy to run every frame, so each is
// drawn once, when the stage mounts, into a mipmapped cube map: no seams or pinched poles, and the
// mipmaps keep coastlines and city lights from shimmering as the planet turns.

/** A cube render target ready for bakeCube, mipmapped, holding plain data (no colour space). */
export function makeCubeTarget(size: number): THREE.WebGLCubeRenderTarget {
  return new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

const BAKE_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Draws `fragmentShader` into all six faces of `target`. The shader gets `varying vec3 vDir`, the
 * direction of the texel from the cube's centre (unnormalised), and writes gl_FragColor.
 */
export function bakeCube(gl: THREE.WebGLRenderer, target: THREE.WebGLCubeRenderTarget, fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}): void {
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.ShaderMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false, uniforms, vertexShader: BAKE_VERTEX, fragmentShader });
  const scene = new THREE.Scene().add(new THREE.Mesh(geometry, material));
  const camera = new THREE.CubeCamera(0.1, 10, target);
  camera.update(gl, scene);
  geometry.dispose();
  material.dispose();
}

/**
 * The planet, per direction in its own frame (y up its spin axis):
 *   r: height, with sea level at 0.5 (h = (r - 0.5) / 1.6)
 *   g: cloud cover
 *   b: city lights
 *   a: moisture (0 desert, 1 forest)
 */
export const SURFACE_BAKE = /* glsl */ `
  varying vec3 vDir;
  ${noise}

  vec3 rotateAbout(vec3 p, vec3 axis, float angle) {
    float c = cos(angle), s = sin(angle);
    return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
  }

  // A storm: directions wound round its eye, the most near the middle.
  vec3 cyclone(vec3 p, vec3 eye, float turns, float size) {
    return rotateAbout(p, eye, turns * exp(-(1.0 - dot(p, eye)) / size));
  }

  void main() {
    vec3 p = normalize(vDir);

    // Continents: domain-warped fractal noise cut at sea level, a few big landmasses.
    vec3 q = p * 1.15 + 3.0;
    vec3 warp = vec3(fbm(q * 1.3), fbm(q * 1.3 + 7.3), fbm(q * 1.3 + 13.7));
    float h = fbm(q * 1.5 + warp * 0.95);
    h += 0.24 * fbm(p * 5.5 + 21.0);
    h += 0.07 * snoise(p * 19.0) + 0.03 * snoise(p * 47.0);
    h -= 0.1;
    float land = smoothstep(0.0, 0.02, h);

    float moist = 0.5 + 0.6 * fbm(p * 2.3 + 41.0);

    // City lights: towns along the coasts and in clumps inland, strung along a few highways, none
    // on the ice.
    float region = smoothstep(0.0, 0.4, fbm(p * 3.2 + 63.0));
    float coast = exp(-abs(h - 0.03) * 16.0);
    float towns = smoothstep(0.62, 0.95, 0.5 + 0.5 * snoise(p * 64.0)) + 0.7 * smoothstep(0.66, 0.95, 0.5 + 0.5 * snoise(p * 150.0 + 5.0));
    float roads = exp(-abs(snoise(p * 22.0 + 77.0)) * 40.0) * 0.35 * region;
    float lights = (towns + roads) * clamp(region + coast * 0.8, 0.0, 1.0) * land * (1.0 - smoothstep(0.55, 0.7, abs(p.y)));

    // Clouds: east-west streaks wound into a few storms.
    vec3 c = p;
    c = cyclone(c, normalize(vec3(0.55, 0.42, 0.72)), 3.2, 0.02);
    c = cyclone(c, normalize(vec3(-0.62, -0.38, 0.69)), -3.0, 0.018);
    c = cyclone(c, normalize(vec3(0.22, 0.36, -0.9)), 3.0, 0.02);
    c = cyclone(c, normalize(vec3(-0.8, 0.28, -0.53)), -2.6, 0.022);
    c = cyclone(c, normalize(vec3(0.9, -0.3, 0.3)), -2.8, 0.018);
    c = cyclone(c, normalize(vec3(0.1, 0.25, 0.96)), 2.9, 0.016);
    vec3 cw = vec3(fbm(c * 1.8 + 5.0), fbm(c * 1.8 + 11.0), fbm(c * 1.8 + 17.0));
    float cl = fbm(c * vec3(2.4, 3.2, 2.4) + cw * 1.1) + 0.35 * fbm(c * 7.5 + cw * 1.5) + 0.12 * snoise(c * 24.0 + cw * 2.0);
    // Cloudy belts at the equator and mid-latitudes, clearer skies between.
    float belt = 0.8 + 0.28 * cos(abs(p.y) * 8.5);
    float cloud = smoothstep(0.07, 0.46, cl * belt);

    gl_FragColor = vec4(clamp(h * 1.6 + 0.5, 0.0, 1.0), cloud, clamp(lights, 0.0, 1.0), clamp(moist, 0.0, 1.0));
  }
`;

/**
 * The nebula's colour per direction of the sky (scaled into 0-1: the sky multiplies it back up).
 * uBand is the pole of the great circle the glow gathers along, like a Milky Way.
 */
export const NEBULA_BAKE = /* glsl */ `
  uniform vec3 uBand;
  varying vec3 vDir;
  ${noise}

  void main() {
    vec3 d = normalize(vDir);
    vec3 w = vec3(fbm(d * 1.6 + 1.0), fbm(d * 1.6 + 6.0), fbm(d * 1.6 + 11.0));
    float a = fbm(d * 2.2 + w * 1.4);
    float b = fbm(d * 3.0 - w * 1.2 + 19.0);
    float band = exp(-pow(dot(d, uBand) / 0.4, 2.0));
    float dust = smoothstep(0.0, 0.45, fbm(d * 5.0 + w * 2.0 + 33.0));
    vec3 cyan = vec3(0.12, 0.7, 1.0);
    vec3 violet = vec3(0.42, 0.26, 1.0);
    vec3 rose = vec3(1.0, 0.3, 0.72);
    vec3 col = cyan * smoothstep(-0.15, 0.6, a) + violet * smoothstep(-0.25, 0.5, b) * 0.85;
    col += rose * smoothstep(0.15, 0.6, a * 0.5 + b * 0.7) * 0.55;
    col *= (0.2 + 0.8 * band) * (1.0 - dust * 0.55);
    gl_FragColor = vec4(clamp(col * 0.5, 0.0, 1.0), 1.0);
  }
`;
