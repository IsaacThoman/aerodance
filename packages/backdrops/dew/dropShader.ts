// GLSL for the water drops. Each drop is one quad: resting and sliding drops lie on the leaf's
// surface and shade themselves as a dome (with the shadow and caustic they cast around them),
// the hanging and falling drops face the camera. Inside, a drop shows the leaf beneath it
// magnified, so the glowing veins swell through it like through a lens.
import { lightGLSL } from './light.ts';
import { dripGLSL, leafShapeGLSL, leafSkinGLSL } from './leafShader.ts';

// Drop kinds (aDrop.w).
export const DROP_REST = 0;
export const DROP_SLIDE = 1;
export const DROP_HANG = 2;
export const DROP_FALL = 3;

// How far the quad reaches, in drop radii: past the drop for its shadow and caustic.
const REACH = /* glsl */ `1.75`;

export const dropVertexShader = /* glsl */ `
${lightGLSL}
${leafShapeGLSL}
${dripGLSL}
attribute vec4 aDrop;   // u, s (fraction of the half width), radius, kind
varying vec2 vQ;        // position on the quad, in drop radii
varying vec3 vWorld;
varying vec3 vN, vT, vB; // the drop's frame (world): out of the leaf or towards the camera
varying vec4 vDrop;     // u, z, radius, kind
varying vec2 vShape;    // stretch (along the leaf or the fall), neck

// The hanging drop's neck reaches from its centre up to the leaf tip (radii).
float neckHeight(float neck) { return 1.05 + neck * 1.3; }

void main() {
  float sway = leafSway();
  float kind = aDrop.w;
  float r = aDrop.z;
  float u = aDrop.x;
  float z = aDrop.y * leafHalfWidth(u);
  float stretch = 1.0;
  float neck = 0.0;
  float p = dripPhase();
  float period = uDrip.x;

  if (kind > 0.5 && uDrip.z < 0.5) r = 0.0;

  if (kind > 0.5 && kind < 1.5) {
    // Sliding: rests, lets go, runs to the tip and melts into the hanging drop, then dew
    // gathers again where it rested.
    float q = slideQ(p) * step(p, SLIDE_END + 0.04);
    u = slideU(q);
    z = slideZ(u);
    r = uSlide.z * (1.0 - smoothstep(SLIDE_END, SLIDE_END + 0.035, p) + smoothstep(DRIP + 0.02, 1.0, p));
    float speed = q * (1.0 - smoothstep(SLIDE_END, SLIDE_END + 0.03, p));
    stretch = 1.0 + 0.55 * speed;
    u -= speed * r * 0.4 / uShape.x;
  }

  vec3 P, N, T, B;
  if (kind < 1.5) {
    leafFrame(u, z, sway, P, N, T, B);
    vec2 corner = position.xy * 2.0 * ${REACH};
    corner.x *= stretch;
    vec3 local = P + (T * corner.x + B * corner.y) * r + N * r * 0.06;
    vec4 world = modelMatrix * vec4(local, 1.0);
    vQ = corner;
    vWorld = world.xyz;
    mat3 m = mat3(modelMatrix);
    vN = normalize(m * N);
    vT = normalize(m * T);
    vB = normalize(m * B);
    gl_Position = projectionMatrix * viewMatrix * world;
  } else {
    // Hanging from the tip, or falling from it, facing the camera with gravity down the quad.
    vec3 tip = leafPoint(1.0, 0.0, sway);
    vec4 mv = modelViewMatrix * vec4(tip, 1.0);
    vec3 down = normalize(mat3(viewMatrix) * vec3(0.0, -1.0, 0.0));
    vec2 up2 = normalize(-down.xy + vec2(0.0, 1e-4));
    vec3 upV = vec3(up2, 0.0);
    vec3 rightV = vec3(up2.y, -up2.x, 0.0);
    float R = uDrip.w;
    float lo = -1.3, hi = 1.3;
    vec3 centre;
    if (kind < 2.5) {
      // Seeps up slowly, swells as the sliding drop feeds it, stretches and lets go.
      float s = mix(0.55, 0.75, smoothstep(0.0, SLIDE_END, p));
      s = mix(s, 1.0, smoothstep(SLIDE_END - 0.005, SLIDE_END + 0.05, p));
      neck = smoothstep(SLIDE_END + 0.04, DRIP, p);
      if (p >= DRIP) {
        // What stays behind wobbles as it settles.
        float since = (p - DRIP) * period;
        s = 0.55 * (1.0 + 0.16 * exp(-since * 5.0) * sin(since * 26.0));
        neck = 0.0;
      }
      r = R * s;
      float h = neckHeight(neck);
      centre = mv.xyz - upV * h * r;
      hi = h + 0.3;
    } else {
      // Falls from where the hanging drop let go, stretching as it speeds up.
      float since = (p - DRIP) * period;
      float seen = step(DRIP, p) * (1.0 - step(1.6, since));
      r = R * seen;
      float h = neckHeight(1.0);
      float fall = 0.5 * 15.0 * since * since;
      stretch = 1.0 + min(15.0 * since * 0.05, 1.6);
      centre = mv.xyz - upV * (h * R + fall);
      hi = 1.0 + (stretch - 1.0) * 1.6 + 0.3;
    }
    vec2 corner = vec2(position.x * 2.6, mix(lo, hi, position.y + 0.5));
    vec3 v = centre + (rightV * corner.x + upV * corner.y) * r;
    vQ = corner;
    // The frame in world space: right, up and towards the camera.
    vT = normalize((vec4(rightV, 0.0) * viewMatrix).xyz);
    vB = normalize((vec4(upV, 0.0) * viewMatrix).xyz);
    vN = normalize((vec4(0.0, 0.0, 1.0, 0.0) * viewMatrix).xyz);
    vWorld = (inverse(viewMatrix) * vec4(v, 1.0)).xyz;
    gl_Position = projectionMatrix * vec4(v, 1.0);
  }
  vDrop = vec4(u, z, r, kind);
  vShape = vec2(stretch, neck);
}
`;

export const dropFragmentShader = /* glsl */ `
${lightGLSL}
${leafShapeGLSL}
${dripGLSL}
${leafSkinGLSL}
varying vec2 vQ;
varying vec3 vWorld;
varying vec3 vN, vT, vB;
varying vec4 vDrop;
varying vec2 vShape;

// iq's uneven capsule: a ball of radius r1 at the origin tapering to r2 at height h.
float sdTear(vec2 p, float r1, float r2, float h) {
  p.x = abs(p.x);
  float b = (r1 - r2) / h;
  float a = sqrt(max(1.0 - b * b, 0.0));
  float k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r1;
  if (k > a * h) return length(p - vec2(0.0, h)) - r2;
  return dot(p, vec2(a, b)) - r1;
}

float shapeDist(vec2 q, float kind) {
  if (kind < 1.5) return length(vec2(q.x / vShape.x, q.y)) - 1.0;
  if (kind < 2.5) return sdTear(q, 1.0, 0.2, 1.05 + vShape.y * 1.3);
  return sdTear(q, 1.0, 0.75, max((vShape.x - 1.0) * 1.6, 0.01));
}

void main() {
  float kind = vDrop.w;
  float rad = vDrop.z;
  if (rad <= 0.0) discard;
  vec2 q = vQ;

  // The drop's outline and a dome's normal from it, in the drop's frame (T, B, N).
  float d = shapeDist(q, kind);
  float e = 0.02;
  vec2 g = vec2(shapeDist(q + vec2(e, 0.0), kind) - shapeDist(q - vec2(e, 0.0), kind),
                shapeDist(q + vec2(0.0, e), kind) - shapeDist(q - vec2(0.0, e), kind));
  g = normalize(g + 1e-5);
  float depth = clamp(-d, 0.0, 1.0);
  float rim = 1.0 - depth;
  // Resting drops are flattened domes; hanging and falling ones are round.
  float flatness = kind < 1.5 ? 0.6 : 1.0;
  vec3 nl = normalize(vec3(g * rim, sqrt(max(1.0 - rim * rim, 0.0)) / flatness + 0.02));
  float blurQ = uLook.w / max(rad, 1e-3);
  float fw = fwidth(d) * 0.8 + blurQ * 0.6;
  float inside = 1.0 - smoothstep(-fw, fw, d);

  vec3 N = normalize(vT * nl.x + vB * nl.y + vN * nl.z);
  vec3 V = normalize(cameraPosition - vWorld);
  // The key light across the drop, for the caustic and the dark rim.
  vec2 lt = normalize(vec2(dot(uKeyDir, vT), dot(uKeyDir, vB)) + 1e-4);
  float onLeaf = step(kind, 1.5);

  // What the drop magnifies: the leaf beneath at about twice the size.
  float L = uShape.x;
  float um = vDrop.x + q.x * rad * 0.45 / L;
  float zm = vDrop.y + q.y * rad * 0.45;
  float wm = leafHalfWidth(um);
  float focus = 1.0 - smoothstep(0.0, 0.18 * uShape.y, uLook.w);
  vec3 veins = leafVeins(um, zm, wm) * focus;
  vec3 alb = leafAlbedo(um, zm, wm, veins);
  float an = clamp(abs(zm) / max(wm, 1e-4), 0.0, 1.0);
  vec3 under = leafDiffuse(alb, vN, V, veins, um, an) * 1.35;
  // Hanging and falling drops see the scene upside down, like a lens: the sunlit leaves and
  // the bright canopy glow in the bottom of the drop, the shade sits at its top.
  vec3 world = mix(uGlow * uSunColor * 0.6, uEnvLow * 2.2, smoothstep(-0.7, 0.55, nl.y));
  world += uEnvHigh * 0.35 * smoothstep(0.5, 0.0, length(q - vec2(0.1, -0.45)));
  vec3 inner = mix(world, under, onLeaf);

  float lightSide = dot(q / max(length(q), 1e-3), lt) * 0.5 + 0.5;
  inner *= 1.0 - smoothstep(0.3, 0.95, rim) * mix(0.5, 0.92, lightSide);
  // Light focused through the drop pools on the far side from the light.
  float caustic = smoothstep(0.65, 0.0, length(q + lt * 0.45));
  inner += uGlow * uSunColor * caustic * caustic * 0.9;

  vec3 R = reflect(-V, N);
  float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  vec3 col = inner + envColor(R) * F * 1.3;
  vec3 H = normalize(uKeyDir + V);
  float nh = max(dot(N, H), 0.0);
  col += uKeyColor * (pow(nh, 700.0) * 16.0 + pow(nh, 60.0) * 0.45) * focus;
  // A second, smaller window highlight from the left.
  vec3 H2 = normalize(normalize(vec3(-0.6, 0.5, 0.65)) + V);
  col += uKeyColor * pow(max(dot(N, H2), 0.0), 1400.0) * 6.0 * focus;
  // Round drops catch the key light as one crisp window glint high on the bulb.
  col += uKeyColor * smoothstep(0.17, 0.06, length(q - vec2(0.36, 0.34))) * 4.0 * (1.0 - onLeaf);
  col = mix(col, uHaze, uLook.z);

  // Around a resting drop: its soft shadow, a contact ring and a spill of caustic light,
  // kept on the leaf.
  float r = length(vec2(q.x / vShape.x, q.y));
  float shade = smoothstep(1.3, 0.8, length(q + lt * 0.32)) * 0.32 + exp(-pow((r - 1.0) / 0.12, 2.0)) * 0.22;
  float spill = smoothstep(0.6, 0.0, length(q + lt * 1.08)) * 0.55;
  float uf = vDrop.x + q.x * rad / L;
  float zf = vDrop.y + q.y * rad;
  float onBlade = smoothstep(0.0, 0.03 * uShape.y, leafHalfWidth(uf) - abs(zf));
  vec4 bed = vec4(uGlow * uSunColor * spill * 0.6, shade) * onBlade * onLeaf;

  // The falling drop's tail is only a smear.
  float fade = kind > 2.5 ? 1.0 - smoothstep(0.6, 1.0 + (vShape.x - 1.0) * 1.6, q.y) * 0.7 : 1.0;
  vec4 drop = vec4(col, 1.0) * fade;
  gl_FragColor = mix(bed, drop, inside);
}
`;
