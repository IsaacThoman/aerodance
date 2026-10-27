/**
 * GLSL: the aurora over the night side, `aurora(rd, oc, t)`: the light it adds along the view ray
 * `rd`, with `oc` the camera's offset from the planet's centre in planet radii.
 *
 * It's drawn in the planet's limb coordinates, round the disc and up from the limb in radians, so
 * it stays put in the world as the camera moves: two rippling curtains, one standing just beyond
 * the limb against space and a nearer one rising off the night face across it. Each has a crisp
 * green lower edge with a rose fringe, fading up through cyan to violet, combed into slow vertical
 * rays. Every feature spans several pixels at 640x480, so nothing flickers. Needs the simplex chunk
 * (shared/glsl.ts).
 */
export const AURORA = /* glsl */ `
  vec3 aurora(vec3 rd, vec3 oc, float t) {
    float dist = length(oc);
    vec3 c = -oc / dist;
    float v = acos(clamp(dot(rd, c), -1.0, 1.0)) - asin(1.0 / dist);
    if (v < -0.07 || v > 0.32) return vec3(0.0);
    vec3 up = normalize(vec3(0.0, 1.0, 0.0) - c * c.y);
    float u = atan(dot(rd, cross(c, up)), dot(rd, up));

    vec3 sum = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      // The curtain's lower edge, wandering and rippling along the limb.
      float wander = snoise(vec2(u * 2.4 + fi * 7.1, t * 0.035 + fi * 3.0));
      float ripple = sin(u * mix(17.0, 23.0, fi) - t * mix(0.55, -0.42, fi) + wander * 2.5);
      float base = mix(0.006, -0.026, fi) + 0.008 * wander + 0.004 * ripple;
      float h = v - base;
      float edge = smoothstep(-0.0035, 0.0025, h);
      // Taller in places, and fading up into space.
      float tall = 0.03 + 0.04 * (0.5 + 0.5 * snoise(vec2(u * 1.6 + 3.0 + fi * 5.0, t * 0.03)));
      float fall = exp(-max(h, 0.0) / tall) * (1.0 + 1.4 * exp(-max(h, 0.0) / 0.006)) * (1.0 - smoothstep(0.1, 0.24, h));
      // Rays combed up the curtain, drifting along it, brightest where it folds.
      float rays = 0.5 + 0.5 * snoise(vec2(u * 64.0 + t * mix(0.2, -0.15, fi), h * 5.0 + fi * 9.0 - t * 0.04));
      float folds = 0.55 + 0.45 * ripple * ripple;
      float glow = edge * fall * (0.3 + 0.7 * rays) * folds;
      // Where along the limb it burns, waxing and waning slowly.
      float env = smoothstep(0.2, 0.75, 0.5 + 0.5 * snoise(vec2(u * 1.25 + fi * 11.0, t * 0.022 + fi)));
      env *= 1.0 - smoothstep(0.85, 1.4, abs(u - mix(-0.05, 0.12, fi)));
      // Green low down, cyan, then violet high up, over a thin rose fringe at the very bottom.
      vec3 col = mix(vec3(0.12, 1.0, 0.42), vec3(0.05, 0.78, 1.0), smoothstep(0.006, 0.04, h));
      col = mix(col, vec3(0.5, 0.22, 1.0), smoothstep(0.035, 0.11, h));
      col = mix(vec3(1.0, 0.3, 0.7), col, 0.35 + 0.65 * smoothstep(-0.003, 0.003, h));
      sum += col * glow * env * mix(0.75, 0.55, fi);
    }
    return sum;
  }
`;
