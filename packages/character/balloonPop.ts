import { DoubleSide, Vector3 } from "three";
import type { Material } from "three";

/**
 * The dancer popping like a balloon, drawn by its own gel and ink: a puncture on its chest
 * tears open, cracks race across the skin with the hole spreading after them, the torn edge
 * curls back, and the scraps torn off fly out, fall and shrivel away. `Character` plays it
 * from `popRef`, the seconds since the puncture.
 *
 * Everything is measured on the model at rest, so the tear stays put on the skin while the
 * dancer keeps moving.
 */

// Seconds for the hole to spread over the whole dancer, and for a scrap to shrivel away once
// the tear has passed it.
const TEAR = 0.14;
const SCRAP_LIFE = 0.34;
// How far the hole spreads (model units): past the farthest skin from any puncture.
const REACH = 2.4;
/** Seconds from the puncture until the last scrap has gone. */
export const POP_DURATION = TEAR + SCRAP_LIFE;

const f = (x: number) => x.toFixed(4);
const glsl = /* glsl */ `
uniform float popTime;
uniform vec3 popOrigin;
uniform vec3 popSeed;
varying vec3 vPopPos;

vec3 popHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float popGrad(vec3 i, vec3 f, vec3 o) { return dot(popHash(i + o), f - o); }
// Gradient noise, roughly -1 to 1.
float popNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return 1.6 * mix(
    mix(mix(popGrad(i, f, vec3(0.0, 0.0, 0.0)), popGrad(i, f, vec3(1.0, 0.0, 0.0)), u.x),
        mix(popGrad(i, f, vec3(0.0, 1.0, 0.0)), popGrad(i, f, vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(popGrad(i, f, vec3(0.0, 0.0, 1.0)), popGrad(i, f, vec3(1.0, 0.0, 1.0)), u.x),
        mix(popGrad(i, f, vec3(0.0, 1.0, 1.0)), popGrad(i, f, vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

// How far the hole has spread from the puncture (model units), speeding up as it rips; it
// covers the whole dancer by the end of the tear.
float popReach() {
  return popTime < 0.0 ? -1.0 : ${f(REACH)} * pow(min(popTime / ${f(TEAR)}, 1.0), 1.3);
}
// How far a point on the skin is from the tear's edge: positive while it's whole, negative
// once it's torn. Cracks shoot out from the puncture ahead of the hole, along ridges of noise
// over the directions away from it, and the edge is ragged.
float popEdge(vec3 p, float reach) {
  vec3 v = p - popOrigin;
  float d = length(v);
  float crack = pow(1.0 - abs(popNoise(v / max(d, 1e-4) * 1.6 + popSeed)), 10.0);
  return d * (1.0 - 0.45 * crack) + popNoise(p * 6.0 + popSeed) * 0.07 - reach;
}
// Seconds since the tear passed a torn point.
float popAge(float edge, float reach) {
  return popTime - ${f(TEAR)} * pow(max(edge + reach, 0.0) / ${f(REACH)}, 1.0 / 1.3);
}
`;

const vertex = /* glsl */ `
// The skin peels back along the tear's edge, outwards and away from the hole, and the torn
// scraps fly on out and fall.
vec3 popOffset(vec3 p) {
  if (popTime < 0.0) return vec3(0.0);
  float reach = popReach();
  float edge = popEdge(p, reach);
  // Out from a line up the middle of the body and head, and along the skin from the puncture.
  vec3 away = p - vec3(0.0, clamp(p.y, 0.9, 2.7), 0.0);
  away = dot(away, away) > 1e-8 ? normalize(away) : vec3(0.0, 0.0, 1.0);
  vec3 back = p - popOrigin;
  back -= away * dot(back, away);
  back = dot(back, back) > 1e-8 ? normalize(back) : vec3(0.0);
  vec3 peel = away * 0.2 + back * 0.12;
  if (edge >= 0.0) {
    float curl = max(0.0, 1.0 - edge / 0.3);
    return peel * curl * curl;
  }
  float age = popAge(edge, reach);
  return peel + (away * 4.8 + back * 1.8) * age - vec3(0.0, 4.5 * age * age, 0.0);
}
`;

// Torn skin is gone but for scraps of the gel, islands of noise that shrink as they age (the
// eyes just go). The skin's inside shows through the hole; while whole, the gel draws only its
// outside.
const fragment = (skin: boolean) => /* glsl */ `
float popRim = 0.0;
if (popTime < 0.0) {
  #ifdef DOUBLE_SIDED
    if (!gl_FrontFacing) discard;
  #endif
} else {
  float reach = popReach();
  float edge = popEdge(vPopPos, reach);
  if (edge < 0.0) {
    ${skin ? `float age = popAge(edge, reach);
    if (popNoise(vPopPos * 1.8 + popSeed.zxy) < mix(0.3, 1.0, age / ${f(SCRAP_LIFE)})) discard;` : 'discard;'}
  } else {
    popRim = 1.0 - smoothstep(0.02, 0.05, edge);
  }
}
`;

/** A dancer's pop: plays it in the materials `extend` patched, from `update`'s time. */
export class BalloonPop {
  private readonly uniforms = {
    popTime: { value: -1 },
    popOrigin: { value: new Vector3() },
    popSeed: { value: new Vector3() },
  };

  /** Seconds since the puncture; negative while whole. Each new pop tears from a fresh spot. */
  update(t: number) {
    const time = this.uniforms.popTime;
    if (t >= 0 && time.value < 0) {
      // Somewhere on the front of the chest.
      this.uniforms.popOrigin.value.set((Math.random() - 0.5) * 0.4, 1.3 + Math.random() * 0.4, 0.38);
      this.uniforms.popSeed.value.set(Math.random(), Math.random(), Math.random()).multiplyScalar(20);
    }
    time.value = t;
  }

  /** Patches a material of the dancer to tear; the gel (`skin`) also shows its inside. */
  extend(material: Material, skin: boolean) {
    // Programs are cached by this key, so a popping dancer's must not match anyone else's.
    const key = `${material.customProgramCacheKey()}|balloon-pop`;
    const base = material.onBeforeCompile.bind(material);
    if (skin) material.side = DoubleSide;
    material.onBeforeCompile = (shader, renderer) => {
      base(shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = glsl + vertex + shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvPopPos = position;\ntransformed += popOffset(position);",
      );
      shader.fragmentShader = glsl + shader.fragmentShader
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${fragment(skin)}`);
      // The inside of the skin is darker, and the torn edge pale, stretched thin.
      if (skin) shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        "#include <color_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb *= 0.55;\ndiffuseColor = mix(diffuseColor, vec4(1.0), popRim * 0.6);",
      );
    };
    material.customProgramCacheKey = () => key;
  }
}
