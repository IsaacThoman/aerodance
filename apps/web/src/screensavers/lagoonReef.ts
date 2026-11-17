import * as THREE from 'three';
import { mulberry32 } from '../aero/random.ts';

export const waterVertex = /* glsl */ `
  varying vec3 world;
  void main() {
    vec4 p = modelMatrix * vec4(position, 1.);
    world = p.xyz;
    gl_Position = projectionMatrix * viewMatrix * p;
  }
`;

// Used at the far end of the sand as well as in the open water so the sea
// floor disappears into exactly the same column of water at the horizon.
const scattering = /* glsl */ `
  vec3 waterColor(vec3 ray) {
    float sunHeight = smoothstep(-0.29, 0.42, ray.y);
    float bearing = atan(ray.x, -ray.z);
    float shafts = bearing + ray.y * 0.42;
    float broad = 0.5 + 0.5 * sin(shafts * 16. + 1.8 * cos(shafts * 9. + time * 0.073));
    float fine = 0.5 + 0.5 * sin(shafts * 59. + 2.7 * sin(shafts * 23. - time * 0.11));
    vec3 depths = mix(vec3(0.002, 0.012, 0.081), vec3(0.001, 0.046, 0.13), daylight);
    vec3 surface = mix(vec3(0.019, 0.29, 0.58), vec3(0.018, 0.66, 0.59), daylight);
    vec3 water = mix(depths, surface, pow(sunHeight, 1.32));
    vec3 lightDir = normalize(vec3(-0.35, 0.64, -1.));
    float glow = pow(max(0., dot(lightDir, ray)), 8.);
    float light = (broad * 0.73 + fine * 0.27) * glow * smoothstep(-0.43, 0.47, ray.y);
    water += mix(vec3(0.04, 0.13, 0.2), vec3(0.36, 0.39, 0.19), daylight) * light;
    // Viewed obliquely from below, the ceiling of the lagoon compresses the
    // moving surface ripples toward the horizon.
    if (ray.y > 0.11) {
      vec2 surfacePoint = 1.75 * ray.xz / ray.y;
      surfacePoint += 0.29 * sin(surfacePoint.yx * 2.3 + time * 0.17);
      float wave = sin(surfacePoint.x * 4. + cos(surfacePoint.y * 3.1 + time * 0.28))
                 + sin(surfacePoint.y * 9.2 + surfacePoint.x * 1.4 - time * 0.37);
      float crest = pow(clamp(1. - abs(wave) * 0.71, 0., 1.), 3.);
      water += vec3(0.31, 0.36, 0.29) * crest * smoothstep(0.11, 0.45, ray.y) * (0.24 + daylight * 0.76);
    }
    return water;
  }
`;

export const waterFragment = /* glsl */ `
  uniform vec2 timeAndDay;
  #define time timeAndDay.x
  #define daylight timeAndDay.y
  varying vec3 world;
  ${scattering}
  void main() {
    gl_FragColor = vec4(waterColor(normalize(world - cameraPosition)), 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function floorHeight(x: number, z: number) {
  return -3.53 + 0.18 * Math.sin(z * 0.46 + x * 0.38) + 0.17 * Math.cos(x * 0.71 - z * 0.27);
}

export function seabed() {
  const g = new THREE.PlaneGeometry(100, 94, 100, 90).rotateX(-Math.PI / 2).translate(0, 0, -25);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, floorHeight(pos.getX(i), pos.getZ(i)));
  return g;
}

export const sandFragment = /* glsl */ `
  uniform vec2 timeAndDay;
  #define time timeAndDay.x
  #define daylight timeAndDay.y
  varying vec3 world;
  ${scattering}
  void main() {
    vec2 p = world.xz;
    float a = sin(p.x * 1.8 + p.y * 0.9 + 1.4 * sin(p.y * 1.1 + time * 0.31));
    float b = sin(p.y * 2.4 + cos(p.x * 0.95 - time * 0.27) + time * 0.22);
    float caustic = pow(clamp(1. - abs(a + b * 0.86) * 0.9, 0., 1.), 8.);
    float ripple = sin(p.y * 10.4 + 3. * sin(p.x * 0.85) + p.x * 3.8) * 0.5 + 0.5;
    vec3 sand = mix(vec3(0.022, 0.091, 0.14), vec3(0.31, 0.54, 0.31), daylight);
    sand += (caustic * 0.93 + ripple * 0.12) * sand;
    float fog = exp(-pow(length(cameraPosition - world) * 0.051, 1.28));
    vec3 horizon = waterColor(normalize(world - cameraPosition));
    gl_FragColor = vec4(mix(horizon, sand, fog), 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Kelp blades from each holdfast share a base, but differ in height, twist
// and curve. A single indexed mesh keeps the whole garden to one draw call.
export function kelpGarden() {
  const rnd = mulberry32(723);
  const pos: number[] = [], colors: number[] = [], flex: number[] = [], idx: number[] = [];
  const kelps = [
    [-6.4, 1, 3.3], [-5.7, -1, 1.9], [5.6, 1.3, 2.7], [6.4, -0.6, 3.6],
    [-3.5, -4.5, 1.4], [2.6, -4.4, 1.7], [-8.1, -8.4, 3.5], [6, -9, 3.2],
    [-6.9, 3.5, 4.7], [6.8, 3.6, 4.4], [-10.8, -12.3, 3.], [9.2, -16., 3.4],
    [-0.2, -8.2, 0.9], [-3.6, -11, 2.8], [9.5, -7, 2.6], [4.6, -13, 2.4],
  ];
  for (const [cx, cz, h] of kelps) {
    for (let n = 0; n < 26; n++) {
      const x = cx + (rnd() - 0.5) * 1.7, z = cz + (rnd() - 0.5) * 1.26, y = floorHeight(x,z) - 0.1;
      const height = (0.3 + rnd() * 0.8) * h, direction = rnd() * Math.PI * 2, width = 0.045 + rnd() * 0.085;
      const tint = rnd();
      const base = pos.length / 3;
      for (let i = 0; i <= 14; i++) {
        const v = i / 14, bend = height * v * v * 0.53 + height * 0.14 * Math.sin(v * Math.PI * 1.7);
        const a = direction + v * 3.6;
        const w = width * (0.31 + 0.99 * Math.sin(Math.PI * v) ** 0.74) * (1 - v ** 13);
        for (const side of [-1, 0, 1]) {
          pos.push(x + bend * Math.cos(direction) + w * side * Math.cos(a), y + height * v, z + bend * Math.sin(direction) + w * side * Math.sin(a));
          const light = (0.44 + v * 0.56) * (1 + (side === 0 ? 0.36 : 0)) * (1 - Math.min(0.6, -z / 27));
          colors.push((0.018 + tint * 0.13) * light,(0.10 + tint * 0.32) * light,(0.08 + 0.06 * tint) * light);
          flex.push(v * v * height);
        }
        if (i === 14) continue;
        const k = base + i * 3;
        idx.push(k, k + 1, k + 3, k + 1, k + 4, k + 3, k + 1, k + 2, k + 4, k + 2, k + 5, k + 4);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('flex', new THREE.Float32BufferAttribute(flex, 1));
  g.setIndex(idx);
  return g;
}

export const kelpVertex = /* glsl */ `
  uniform vec2 timeAndDay;
  #define time timeAndDay.x
  #define daylight timeAndDay.y
  attribute float flex;
  varying vec3 tint;
  void main() {
    vec3 p = position;
    p.x += flex * (0.13 + 0.14 * sin(p.z + p.y * 1.1 + time * 0.58));
    p.z += flex * 0.10 * cos(p.x * 2. + p.y + time * 0.37);
    tint = color * mix(vec3(0.45, 0.58, 0.87), vec3(1.), daylight);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
  }
`;

export const kelpFragment = /* glsl */ `
  varying vec3 tint;
  void main() {
    gl_FragColor = vec4(tint, 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
