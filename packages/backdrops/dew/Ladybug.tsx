import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { leafShapeGLSL } from './leafShader.ts';
import { lightGLSL } from './light.ts';

export interface LadybugSpec {
  /** The middle of the loop it wanders, in leaf coordinates: u along, s across (half widths). */
  centre: [u: number, s: number];
  /** Half the loop's extent in u and s. */
  reach: [u: number, s: number];
  /** Body length, world units. */
  size: number;
  /** Laps a second (radians of the loop). */
  speed: number;
}

// The ladybug's walk around its loop, shared by its shaders: it ambles in spurts, slowing almost
// to a stop between them. Returns (u, s) on the leaf.
const bugGLSL = /* glsl */ `
uniform vec4 uBug;   // centre u, centre s, reach u, reach s
uniform vec2 uBug2;  // size, speed
float bugAngle(float t) {
  float a = t * uBug2.y;
  return a - 0.85 * sin(a * 4.0) / 4.0;
}
vec2 bugPath(float a) {
  return uBug.xy + uBug.zw * vec2(cos(a), sin(a) * (0.8 + 0.2 * cos(a * 2.0)));
}
`;

const vertexShader = /* glsl */ `
${lightGLSL}
${leafShapeGLSL}
${bugGLSL}
varying vec2 vQ;   // body lengths: x forward, y to the left
varying vec3 vWorld;
varying vec3 vN, vT, vB;
void main() {
  float sway = leafSway();
  float a = bugAngle(uTime);
  vec2 here = bugPath(a);
  vec2 ahead = bugPath(a + 0.01);
  float u = here.x;
  float z = here.y * leafHalfWidth(u);
  vec3 P, N, T, B;
  leafFrame(u, z, sway, P, N, T, B);
  // Heading along the path, in the leaf's (T, B) plane.
  vec2 d = vec2((ahead.x - here.x) * uShape.x, ahead.y * leafHalfWidth(ahead.x) - z);
  d = normalize(d + vec2(1e-6, 0.0));
  vec3 fwd = T * d.x + B * d.y;
  vec3 left = cross(N, fwd);
  vec2 corner = position.xy * 1.5;
  vec3 local = P + (fwd * corner.x + left * corner.y) * uBug2.x + N * uBug2.x * 0.08;
  vec4 world = modelMatrix * vec4(local, 1.0);
  vQ = corner;
  vWorld = world.xyz;
  mat3 m = mat3(modelMatrix);
  vN = normalize(m * N);
  vT = normalize(m * fwd);
  vB = normalize(m * left);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
${lightGLSL}
varying vec2 vQ;
varying vec3 vWorld;
varying vec3 vN, vT, vB;

float ellipse(vec2 p, vec2 c, vec2 r) { return length((p - c) / r) - 1.0; }

void main() {
  vec2 q = vQ;
  // A domed oval shell with a black head in front.
  float shell = ellipse(q, vec2(-0.06, 0.0), vec2(0.42, 0.36));
  float head = ellipse(q, vec2(0.3, 0.0), vec2(0.17, 0.24));
  float body = min(shell, head);
  float fw = fwidth(body) * 0.9;
  float inside = 1.0 - smoothstep(-fw, fw, body);

  // Shading as a dome over the whole body.
  vec2 e = (q - vec2(-0.02, 0.0)) / vec2(0.48, 0.38);
  float r2 = clamp(dot(e, e), 0.0, 1.0);
  vec3 nl = normalize(vec3(e * 0.9, sqrt(1.0 - r2) * 0.9 + 0.1));
  vec3 N = normalize(vT * nl.x + vB * nl.y + vN * nl.z);
  vec3 V = normalize(cameraPosition - vWorld);

  // Red wing cases, a black seam down the middle and bold spots (small ones would shimmer).
  vec3 col = vec3(0.75, 0.018, 0.006);
  float seam = 1.0 - smoothstep(0.025, 0.025 + fwidth(q.y) * 1.5, abs(q.y));
  seam *= step(q.x, 0.16);
  vec2 sq = vec2(q.x, abs(q.y));
  float spots = min(min(length(sq - vec2(-0.02, 0.19)), length(sq - vec2(-0.27, 0.13))), length(q - vec2(0.04, 0.0)) * 1.1);
  float spot = 1.0 - smoothstep(0.09, 0.09 + fwidth(spots) * 1.5, spots);
  col = mix(col, vec3(0.012), max(seam, spot));
  // The head: black with two cream cheek spots.
  float onHead = 1.0 - smoothstep(-fw, fw, head);
  float cheeks = 1.0 - smoothstep(0.06, 0.06 + fwidth(q.y) * 2.0, length(vec2(q.x - 0.33, abs(q.y) - 0.12)));
  col = mix(col, mix(vec3(0.012), vec3(0.75, 0.72, 0.55), cheeks * 0.8), onHead);

  float key = max(dot(N, uKeyDir), 0.0);
  vec3 lit = col * (uKeyColor * (0.25 + 0.9 * key) + uEnvLow);
  vec3 R = reflect(-V, N);
  float F = 0.04 + 0.96 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  lit += envColor(R) * (F * 0.6 + 0.015);
  vec3 H = normalize(uKeyDir + V);
  lit += uKeyColor * (pow(max(dot(N, H), 0.0), 400.0) * 9.0 + pow(max(dot(N, H), 0.0), 40.0) * 0.25);

  // A soft shadow under it on the leaf.
  float shade = (1.0 - smoothstep(-0.1, 0.35, ellipse(q, vec2(-0.12, -0.06), vec2(0.5, 0.42)))) * 0.45;
  vec4 shadow = vec4(0.0, 0.0, 0.0, shade);
  gl_FragColor = mix(shadow, vec4(lit, 1.0), inside);
}
`;

/** A glossy ladybug ambling about on a leaf. Takes the leaf's uniforms, so it rides its sway. */
export function Ladybug({ uniforms, spec, renderOrder }: { uniforms: Record<string, THREE.IUniform>; spec: LadybugSpec; renderOrder: number }) {
  const material = useDisposable(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...uniforms,
          uBug: { value: new THREE.Vector4(spec.centre[0], spec.centre[1], spec.reach[0], spec.reach[1]) },
          uBug2: { value: new THREE.Vector2(spec.size, spec.speed) },
        },
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        depthTest: false,
      }),
  );
  return (
    <mesh material={material} frustumCulled={false} renderOrder={renderOrder}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}
