// GLSL for the leaves and the drops on them. A leaf is a flat grid of (u, s) leaf coordinates
// that the vertex shader bends into shape every frame (leafPoint), so the breeze can flex it;
// its drops evaluate the same function to ride along. The blade's outline, veins and gloss are
// drawn in the fragment shader, which keeps its edge smooth without MSAA and lets a leaf out
// of focus soften its edge instead of growing a blur pass.
import { lightGLSL } from './light.ts';

// Shape uniforms and the leaf's surface, in its own frame: x runs along the midrib (u 0 at the
// stem, 1 at the tip), y out of the top face and z across.
export const leafShapeGLSL = /* glsl */ `
uniform vec4 uShape;   // length, half width at the widest, droop (radians), cup
uniform vec4 uShape2;  // twist (radians), ripple, sway (radians), sway phase
uniform vec4 uShape3;  // sideways curve, mesh margin past the edge, stem half width, cup profile
const float PI = 3.14159265;

// Half the blade's width at u: ovate, widest 40% along, drawn out into a slender drip tip.
float leafHalfWidth(float u) {
  float a = pow(clamp(u, 0.0, 1.0), 0.8);
  float w = sin(PI * a) * (1.0 - 0.55 * smoothstep(0.5, 1.0, u));
  return uShape.y * max(w, 0.0);
}

// The breeze: extra droop in radians, slow and uneven.
float leafSway() {
  float ph = uShape2.w;
  return uShape2.z * (sin(uTime * 0.41 + ph) * 0.6 + sin(uTime * 0.97 + ph * 1.7) * 0.3 + sin(uTime * 2.3 + ph * 0.6) * 0.1);
}

vec3 leafPoint(float u, float z, float sway) {
  float L = uShape.x, W = uShape.y;
  // The midrib arcs away from the top face (gravity), more as the breeze dips the leaf.
  float k = (uShape.z + sway) / L;
  k = abs(k) < 1e-4 ? 1e-4 : k;
  float t = u * L;
  vec2 c = vec2(sin(k * t), cos(k * t) - 1.0) / k;
  vec2 up = vec2(sin(k * t), cos(k * t));
  // The halves rise from the midrib (cup; a sharper fold the lower the profile) and the blade
  // undulates a little.
  float an = min(abs(z) / W, 1.1);
  float lift = uShape.w * W * pow(an, uShape3.w)
    + uShape2.y * W * an * an * sin(u * 11.0 + sign(z) * 1.7 + sway * 3.0);
  float across = z + uShape3.x * u * u * L;
  // Twist the cross-section about the midrib, towards the tip.
  float tw = (uShape2.x + sway * 0.4) * u;
  vec2 cs = vec2(cos(tw) * across - sin(tw) * lift, sin(tw) * across + cos(tw) * lift);
  return vec3(c + up * cs.y, cs.x);
}

// The leaf's point, normal (out of the top face), and tangents along u (t) and across (b).
void leafFrame(float u, float z, float sway, out vec3 p, out vec3 n, out vec3 t, out vec3 b) {
  float eu = 0.004;
  float ez = 0.004 * uShape.y;
  p = leafPoint(u, z, sway);
  vec3 du = leafPoint(u + eu, z, sway) - leafPoint(u - eu, z, sway);
  vec3 dz = leafPoint(u, z + ez, sway) - leafPoint(u, z - ez, sway);
  t = normalize(du);
  n = normalize(cross(dz, du));
  b = cross(t, n);
}
`;

// The drip cycle, shared by the drops and the wet trail on the leaf: a resting drop lets go and
// slides down to the tip (SLIDE_START..SLIDE_END), feeding the drop hanging there, which swells
// and falls at DRIP; then dew gathers into a new resting drop. Phase 0..1, seamless.
export const dripGLSL = /* glsl */ `
uniform vec4 uDrip;   // period (s), phase offset, on (0/1), hanging drop radius
uniform vec4 uSlide;  // resting u, resting s (fraction of the half width), radius, -
const float SLIDE_START = 0.24;
const float SLIDE_END = 0.7;
const float DRIP = 0.8;
float dripPhase() { return fract(uTime / uDrip.x + uDrip.y); }
// 0..1 along the slide path, accelerating as it goes.
float slideQ(float p) {
  float q = clamp((p - SLIDE_START) / (SLIDE_END - SLIDE_START), 0.0, 1.0);
  return q * q * (0.6 + 0.4 * q);
}
float slideU(float q) { return mix(uSlide.x, 0.985, q); }
// Across the leaf it runs into the midrib's groove first, then down it.
float slideZ(float u) {
  return uSlide.y * leafHalfWidth(uSlide.x) * (1.0 - smoothstep(uSlide.x, uSlide.x + 0.28, u));
}
`;

// Veins, colour and light for the blade. Needs leafShapeGLSL and the light chunk.
export const leafSkinGLSL = /* glsl */ `
uniform vec3 uDeep, uFresh, uVeinColor, uUnder, uGlow;
uniform vec4 uVein;   // secondary veins: count, slant, width (fraction of their spacing), strength
uniform vec4 uLook;   // translucency, gloss, haze, blur (edge softness, world units)

// x: midrib, y: secondary veins (both 0..1 coverage), z: the blade's swell between veins.
vec3 leafVeins(float u, float z, float w) {
  float W = uShape.y;
  float az = abs(z);
  float an = clamp(az / max(w, 1e-4), 0.0, 1.0);
  float midW = W * 0.03 * (1.0 - 0.7 * u) + 0.006;
  float mid = 1.0 - smoothstep(midW * 0.25, midW + fwidth(z), az);
  mid *= 1.0 - smoothstep(0.9, 1.0, u);
  float f = u * uVein.x - pow(an, 0.7) * uVein.y;
  float ffw = fwidth(f);
  float fr = fract(f);
  float d = min(fr, 1.0 - fr);
  float vw = uVein.z * (1.0 - 0.55 * an);
  float sec = 1.0 - smoothstep(vw * 0.2, vw + ffw, d);
  sec *= smoothstep(0.03, 0.12, an) * (1.0 - smoothstep(0.75, 0.95, an));
  sec *= smoothstep(0.02, 0.1, u) * (1.0 - smoothstep(0.82, 0.96, u));
  // Veins finer than a few pixels would only shimmer: they fade as they shrink.
  float detail = 1.0 - smoothstep(0.1, 0.28, ffw);
  float swell = sin(PI * fr) * (1.0 - an * an) * detail;
  return vec3(mid, sec * detail, swell);
}

vec3 leafAlbedo(float u, float z, float w, vec3 veins) {
  float an = clamp(abs(z) / max(w, 1e-4), 0.0, 1.0);
  // Fresh along the midrib, deeper towards the margins, with a soft mottle.
  float mottle = sin(u * 7.0 + z * 2.3) * sin(u * 3.1 - z * 4.1);
  vec3 c = mix(uFresh, uDeep, clamp(smoothstep(0.05, 0.95, an) * 0.85 + 0.12 * mottle, 0.0, 1.0));
  return mix(c, uVeinColor, max(veins.x, veins.y * uVein.w));
}

// Diffuse light on the blade plus the sun shining through it, strongest where the viewer looks
// towards the sun through the leaf: the veins and the midrib block it, the thin margins let the
// most through. n is the face's own normal, v towards the viewer.
vec3 leafDiffuse(vec3 albedo, vec3 n, vec3 v, vec3 veins, float u, float an) {
  float key = max(dot(n, uKeyDir), 0.0);
  vec3 c = albedo * (uKeyColor * (0.1 + 0.55 * key) + uEnvLow * 0.8);
  float behind = clamp(0.5 - 0.5 * dot(n, uSunDir), 0.0, 1.0);
  float through = pow(max(dot(-v, uSunDir), 0.0), 1.5);
  float thin = (1.0 - 0.8 * veins.x - 0.5 * veins.y) * (0.8 + 0.4 * smoothstep(0.6, 1.0, an) + 0.6 * smoothstep(0.9, 1.0, an));
  // Thicker and shaded towards the stem, thinnest at the tip.
  thin *= mix(0.6, 1.15, smoothstep(0.0, 0.85, u));
  c += uGlow * uSunColor * (0.04 + behind * through) * thin * uLook.x * 0.8;
  return c;
}

// Three's bump mapping (perturbNormalArb), in world space.
vec3 bumpNormal(vec3 pos, vec3 n, float h, float scale, float face) {
  vec3 sx = normalize(dFdx(pos));
  vec3 sy = normalize(dFdy(pos));
  vec2 dh = vec2(dFdx(h), dFdy(h)) * scale;
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * face;
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

export const leafVertexShader = /* glsl */ `
${lightGLSL}
${leafShapeGLSL}
attribute vec2 aLeaf;  // u along the leaf, s across it (-1..1 edge to edge, a little past)
varying vec3 vLeaf;    // u, z (across, world units), half width at u
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  float sway = leafSway();
  float u = aLeaf.x;
  float w = leafHalfWidth(u);
  float z = aLeaf.y * (max(w, uShape3.z) + uShape3.y);
  vec3 p, n, t, b;
  leafFrame(u, z, sway, p, n, t, b);
  vec4 world = modelMatrix * vec4(p, 1.0);
  vLeaf = vec3(u, z, w);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const leafFragmentShader = /* glsl */ `
${lightGLSL}
${leafShapeGLSL}
${dripGLSL}
${leafSkinGLSL}
varying vec3 vLeaf;
varying vec3 vWorld;
varying vec3 vNormal;

// The glossy streak a sliding drop leaves behind, fading as it dries.
float wetTrail(float u, float z) {
  if (uDrip.z < 0.5) return 0.0;
  float p = dripPhase();
  float span = 0.985 - uSlide.x;
  float k = clamp((u - uSlide.x) / span, 0.0, 1.0);
  // When the drop passed this u: invert slideQ (q^2 (0.6 + 0.4q) ~ q^2.25).
  float q = pow(k, 0.444);
  float passed = SLIDE_START + q * (SLIDE_END - SLIDE_START);
  float age = fract(p - passed);
  float band = uSlide.z * 0.45 * (1.0 - 0.6 * k);
  float on = 1.0 - smoothstep(band * 0.4, band, abs(z - slideZ(u)));
  on *= step(uSlide.x + 0.01, u) * step(u, 0.985);
  return on * exp(-age * 5.0);
}

void main() {
  float u = vLeaf.x, z = vLeaf.y, w = vLeaf.z;
  float blur = uLook.w;
  float stem = uShape3.z * (1.0 - smoothstep(0.0, 0.3, u));
  float edge = max(w, stem) - abs(z);
  float aa = fwidth(edge) * 0.75 + blur;
  float alpha = smoothstep(-aa, aa, edge);
  if (alpha < 0.002) discard;

  float face = gl_FrontFacing ? 1.0 : -1.0;
  float an = clamp(abs(z) / max(w, 1e-4), 0.0, 1.0);
  // Out of focus, the veins melt away.
  float focus = 1.0 - smoothstep(0.0, 0.18 * uShape.y, blur);
  vec3 veins = leafVeins(u, z, w) * focus;
  vec3 albedo = leafAlbedo(u, z, w, veins);
  float wet = wetTrail(u, z);

  vec3 n = normalize(vNormal) * face;
  float h = veins.z * 0.5 - veins.x * 0.6 - veins.y * 0.4;
  vec3 N = bumpNormal(vWorld, n, h, 0.12 * focus, face);
  vec3 V = normalize(cameraPosition - vWorld);
  float gloss = uLook.y;
  if (face < 0.0) {
    // The underside: paler and matte.
    albedo = mix(albedo, uUnder, 0.6);
    gloss *= 0.3;
  }
  vec3 col = leafDiffuse(albedo, n, V, veins, u, an);

  // Waxy gloss: the bright canopy mirrored across the curves, a broad sheen and a crisp glint.
  vec3 R = reflect(-V, N);
  float F = 0.04 + 0.96 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  vec3 H = normalize(uKeyDir + V);
  float nh = max(dot(N, H), 0.0);
  float shine = gloss * (1.0 + 1.5 * wet);
  col += envColor(R) * (F * 0.5 + 0.01) * shine;
  // A softbox of sky mirrored in the wax: the glossy streak along the curves.
  float box = smoothstep(0.88, 0.98, dot(R, normalize(vec3(0.25, 0.8, 0.55))));
  col += uKeyColor * box * 0.3 * shine * focus;
  // Out of focus, highlights spread wide and dim.
  col += uKeyColor * (pow(nh, mix(10.0, 48.0, focus)) * mix(0.08, 0.3, focus) + pow(nh, 280.0) * 1.4 * focus * focus * focus) * shine;

  // The wet streak: a darker film of water with the canopy gleaming in it.
  col = mix(col, col * 0.62 + envColor(R) * 0.1, wet);

  col = mix(col, uHaze, uLook.z);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;
