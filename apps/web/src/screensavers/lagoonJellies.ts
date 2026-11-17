import * as THREE from 'three';
import { mulberry32 } from '../aero/random.ts';

// One continuous bell, fluted oral arms and fine trailing tentacles. The body
// coordinates stay in the shader so the bell's contraction travels down each arm.
export function jellyGeometry() {
  const vertices: number[] = [], coords: number[] = [], kinds: number[] = [], indices: number[] = [];
  function sheet(cols: number, rows: number, kind: number, point: (u: number, v: number) => number[]) {
    const start = vertices.length / 3;
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= cols; x++) {
        const u = x / cols, v = y / rows;
        vertices.push(...point(u, v));
        coords.push(u, v);
        kinds.push(kind);
        if (x < cols && y < rows) {
          const i = start + y * (cols + 1) + x;
          indices.push(i, i + 1, i + cols + 1, i + 1, i + cols + 2, i + cols + 1);
        }
      }
    }
  }
  const tau = Math.PI * 2;
  sheet(96, 20, 0, (u, v) => {
    const a = u * tau, arch = v * 1.68;
    const r = Math.sin(arch) * (1 + 0.027 * Math.cos(a * 16) * v ** 4);
    const y = 0.68 * Math.cos(arch) + 0.04 * Math.cos(a * 16) * v ** 5;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
  const rnd = mulberry32(3218);
  for (let i = 0; i < 5; i++) {
    const base = i * tau / 5, length = 1.29 + rnd() * 0.38;
    sheet(8, 36, 1, (u, v) => {
      const a = base + v * 3 + (u - 0.5) * 1.4;
      const fold = Math.cos(u * tau * 0.7 + v * 20) * 0.075;
      const r = 0.16 + 0.11 * Math.sin(v * Math.PI) + fold * Math.sin(Math.PI * v);
      const hem = 0.06 * Math.sin(v * 44 + u * 4);
      return [r * Math.cos(a) + hem, 0.22 - length * v + hem * (u - 0.5), r * Math.sin(a)];
    });
  }
  for (let i = 0; i < 24; i++) {
    const a = i * tau / 24, length = 0.53 + 1.50 * rnd(), curl = rnd() * tau;
    sheet(1, 22, 2, (u, v) => {
      const r = 0.94 - 0.37 * v + v * 0.11 * Math.sin(v * 9 + curl);
      return [r * Math.cos(a) + (u - 0.5) * 0.032 * (1 - v * 0.47), -0.07 - length * v, r * Math.sin(a)];
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(coords, 2));
  geometry.setAttribute('part', new THREE.Float32BufferAttribute(kinds, 1));
  geometry.setIndex(indices);
  return geometry;
}

export const jellyVertex = /* glsl */ `
  uniform vec2 timeAndDay;
  #define time timeAndDay.x
  uniform float phase;
  attribute float part;
  varying vec2 chart;
  varying float bodyPart;
  varying vec3 local;
  varying vec3 world;
  void main() {
    float beat = time * 1.52 + phase;
    vec3 p = position;
    float trail = max(0., -p.y);
    float pulse = sin(beat - trail * 1.8);
    p.xz *= 1.0 + 0.095 * pulse;
    p.y *= 1.0 - 0.07 * pulse;
    p.x += trail * 0.15 * sin(beat * 0.77 - trail * 2.1);
    p.z += trail * 0.13 * cos(beat * 0.53 - trail * 2.5);
    vec4 w = modelMatrix * vec4(p, 1.);
    chart = uv;
    bodyPart = part;
    local = p;
    world = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

export const jellyFragment = /* glsl */ `
  uniform vec3 hue;
  varying vec2 chart;
  varying float bodyPart;
  varying vec3 local;
  varying vec3 world;
  void main() {
    vec3 N = normalize(cross(dFdx(world), dFdy(world)));
    vec3 V = normalize(cameraPosition - world);
    float rim = pow(1. - abs(dot(N, V)), 1.3);
    float dist = length(cameraPosition - world);
    vec3 tint;
    float alpha;
    if (bodyPart < 0.5) {
      float a = chart.x * 6.283185;
      float ribs = pow(0.5 + 0.5 * cos(a * 16. + sin(chart.y * 8.) * 0.4), 15.) * sqrt(chart.y);
      float hem = smoothstep(0.87, 1., chart.y);
      float highlight = pow(max(0., dot(reflect(-normalize(vec3(-0.6, 1., 0.5)), N), V)), 26.);
      // Four horseshoe-shaped gonads show through the crown of a moon jelly.
      vec2 p = local.xz;
      p = abs(p) - vec2(0.22);
      float ring = (1. - smoothstep(0.025, 0.07, abs(length(p) - 0.135))) * smoothstep(-0.23, -0.09, p.x + p.y);
      tint = mix(hue * 0.68, vec3(0.77, 1., 1.), rim * 0.83 + ribs * 0.14);
      tint += hue * (ring * 0.7 + hem * 0.44) + vec3(highlight * 0.74);
      alpha = 0.31 + rim * 0.44 + ribs * 0.18 + hem * 0.29 + ring * 0.25;
    } else {
      float fold = 0.5 + 0.5 * sin(chart.y * 41. + chart.x * 5.);
      tint = mix(hue, vec3(0.83, 0.99, 1.), bodyPart > 1.5 ? 0.6 : fold * 0.66);
      alpha = (bodyPart > 1.5 ? 0.62 : 0.83) * (1. - chart.y * 0.43);
    }
    float clearWater = exp(-max(dist - 10., 0.) * 0.037);
    gl_FragColor = vec4(tint, min(0.97, alpha) * clearWater);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
