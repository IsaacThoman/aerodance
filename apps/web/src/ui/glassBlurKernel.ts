// The same 40-tap Vogel disk, evaluated once instead of per fragment. Keep float
// intermediates like GLSL highp so the sample positions and weights stay aligned.
export const GLASS_BLUR_TAPS = 40;
const f32 = Math.fround;
const glsl = (n: number) => n.toExponential(9);
export const GLASS_BLUR_SAMPLES = Array.from({ length: GLASS_BLUR_TAPS }, (_, i) => {
  const f = f32((i + 0.5) / GLASS_BLUR_TAPS);
  const angle = f32(i * f32(2.39996323));
  const r = f32(Math.sqrt(f));
  return [f32(f32(Math.cos(angle)) * r), f32(f32(Math.sin(angle)) * r), f32(Math.exp(f32(-2 * f)))] as const;
});

export const glassBlurSamplingGLSL = GLASS_BLUR_SAMPLES.map(([x, y, weight]) => `
  sum += texture2D(map, clamp(uv + vec2(${glsl(x)}, ${glsl(y)}) * radius / size, lo, 1.0 - lo)).rgb * ${glsl(weight)};
  wsum += ${glsl(weight)};
`).join('\n');
