import { RENDER_HEIGHT } from '../../stages/shared/post.tsx';

// The scene's shaders: the ribbons, the glints that ride them, the sky and the bokeh.

/**
 * A ribbon's shape, from its per-instance attributes: a cubic Bézier centreline that ripples
 * with travelling waves, twisting about itself as it goes. `ribbonFrame(s)` gives the point
 * `s` (0..1) along it, the direction across it (W), its surface normal (N) and its half-width.
 */
export const ribbonPath = /* glsl */ `
  attribute vec4 aP0;    // xyz: start; w: half-width
  attribute vec4 aP1;    // xyz: control; w: brightness
  attribute vec4 aP2;    // xyz: control; w: phase
  attribute vec4 aP3;    // xyz: end; w: flow speed
  attribute vec4 aWave;  // sideways amplitude, its cycles along the length, depth amplitude, its cycles
  attribute vec4 aTwist; // starting angle, turns along the length, wobble (radians), wobble cycles

  uniform float uTime;

  const float TAU = 6.2831853;

  vec3 bezier(float s) {
    float u = 1.0 - s;
    return u * u * u * aP0.xyz + 3.0 * u * u * s * aP1.xyz + 3.0 * u * s * s * aP2.xyz + s * s * s * aP3.xyz;
  }

  vec3 bezierTangent(float s) {
    float u = 1.0 - s;
    return 3.0 * u * u * (aP1.xyz - aP0.xyz) + 6.0 * u * s * (aP2.xyz - aP1.xyz) + 3.0 * s * s * (aP3.xyz - aP2.xyz);
  }

  // The centreline, rippled sideways and in depth by two waves running along it.
  vec3 ribbonCentre(float s) {
    vec3 t = normalize(bezierTangent(s));
    vec3 side = normalize(cross(t, vec3(0.0, 0.0, 1.0)));
    float time = uTime * aP3.w;
    float ph = aP2.w;
    float sway = sin(s * aWave.y * TAU - time + ph) * 0.75 + sin(s * aWave.y * 1.73 * TAU + time * 0.61 + ph * 2.3) * 0.25;
    float depth = sin(s * aWave.w * TAU - time * 0.8 + ph * 1.7);
    return bezier(s) + side * sway * aWave.x + vec3(0.0, 0.0, depth * aWave.z);
  }

  float ribbonTwist(float s) {
    return aTwist.x + aTwist.y * s * TAU + aTwist.z * sin(aTwist.w * s * TAU - uTime * aP3.w * 0.6 + aP2.w * 1.3);
  }

  float ribbonHalfWidth(float s) {
    float swell = 0.78 + 0.22 * sin(s * 4.1 - uTime * aP3.w * 0.5 + aP2.w * 2.0);
    // Pinched at both ends, so a strand fans out of nothing.
    float pinch = smoothstep(0.0, 0.35, s) * smoothstep(1.0, 0.65, s);
    return aP0.w * swell * mix(0.25, 1.0, pinch);
  }

  void ribbonFrame(float s, out vec3 centre, out vec3 tangent, out vec3 across, out vec3 normal, out float halfWidth) {
    centre = ribbonCentre(s);
    tangent = normalize(ribbonCentre(s + 0.002) - ribbonCentre(s - 0.002));
    vec3 side = normalize(cross(tangent, vec3(0.0, 0.0, 1.0)));
    vec3 depth = cross(side, tangent);
    float a = ribbonTwist(s);
    across = cos(a) * side + sin(a) * depth;
    normal = cross(tangent, across);
    halfWidth = ribbonHalfWidth(s);
  }

  // Where a strand's edge goes, seen from the camera: across it, without the part of the across
  // direction that runs along the strand on screen (turned edge-on, a strand's depth would
  // otherwise slide its edges along it, and its strip would fold back over itself). Moving along
  // the view ray doesn't move a point on screen, so the strand narrows cleanly instead.
  vec3 seenAcross(vec3 tangent, vec3 across, vec3 view, out vec3 perp) {
    perp = normalize(cross(tangent, view));
    return perp * dot(across, perp) + view * dot(across, view);
  }

  // Fades a strand in and out at its ends (both off screen), where glints wrap round.
  float ribbonEnds(float s) {
    return smoothstep(0.0, 0.12, s) * smoothstep(1.0, 0.88, s);
  }
`;

export const ribbonVertex = /* glsl */ `
  ${ribbonPath}
  attribute vec4 aColA;  // rgb: colour; a: how much it tints what's behind
  attribute vec4 aColB;  // rgb: second colour; a: edge brightness

  uniform float uMinPixels;
  uniform vec3 uLightDir;

  varying vec2 vSV;
  varying float vFacing;
  varying float vThin;
  varying float vHalfPx;
  varying float vSpec;
  varying float vPhase;
  varying float vBright;
  varying vec4 vColA;
  varying vec4 vColB;

  void main() {
    float s = position.x;
    float v = position.y;
    vec3 c, t, w, n;
    float hw;
    ribbonFrame(s, c, t, w, n, hw);
    vec3 toCamera = cameraPosition - c;
    float dist = length(toCamera);
    vec3 view = toCamera / dist;
    vec3 perp;
    vec3 seen = seenAcross(t, w, view, perp);
    // Never thinner than a couple of pixels on screen: an edge-on stretch widens across the
    // screen instead of breaking up into aliased dashes, and dims to match (vThin).
    float along = dot(w, perp);
    float projected = abs(along) * hw;
    float pixel = 2.0 * dist / (projectionMatrix[1][1] * ${RENDER_HEIGHT.toFixed(1)});
    float extra = max(uMinPixels * pixel - projected, 0.0);
    vec3 pos = c + seen * hw * v + perp * (along < 0.0 ? -extra : extra) * v;
    vThin = projected / (projected + extra);
    // Its half-width on screen in the buffer's pixels (a little wider than tall, stretched to 16:9).
    vHalfPx = (projected + extra) / (pixel * 1.15);
    vFacing = abs(dot(n, view));
    vec3 h = normalize(uLightDir + view);
    vSpec = pow(abs(dot(n, h)), 48.0);
    vSV = vec2(s, v);
    vPhase = aP2.w;
    vBright = aP1.w;
    vColA = aColA;
    vColB = aColB;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

export const ribbonFragment = /* glsl */ `
  uniform float uTime;
  uniform float uFibres;
  uniform float uSpecular;
  uniform float uSoftness;

  varying vec2 vSV;
  varying float vFacing;
  varying float vThin;
  varying float vHalfPx;
  varying float vSpec;
  varying float vPhase;
  varying float vBright;
  varying vec4 vColA;
  varying vec4 vColB;

  void main() {
    float s = vSV.x;
    float v = vSV.y;
    float av = abs(v);
    // Soft edges, a few pixels wide whatever the ribbon's size on screen: its light is HDR, and
    // tone mapping would steepen a narrower ramp into a hard, stepped edge.
    // (From the vertex shader's on-screen width rather than fwidth, which jumps between the thin
    // triangles of a strip and would speckle it.)
    float soft = min(max(3.0 / vHalfPx, uSoftness), 1.0);
    float mask = 1.0 - smoothstep(1.0 - soft, 1.0, av);
    // As ribbonEnds in the vertex shader.
    float ends = smoothstep(0.0, 0.12, s) * smoothstep(1.0, 0.88, s);
    // Colour drifts along the length between the strand's two colours; across it, a deeper
    // saturated heart brightens towards pale luminous edges.
    float k = 0.5 + 0.5 * sin(s * 5.0 + vPhase - uTime * 0.12);
    vec3 heart = mix(vColA.rgb, vColB.rgb, k);
    float edgeness = smoothstep(0.5, 1.0, av);
    edgeness *= edgeness;
    vec3 col = mix(heart, mix(heart, vec3(1.0), 0.5), edgeness);
    // A few soft fibres along the length, faded out where they'd crowd into aliasing.
    float f = 0.5 + 0.5 * cos(v * 3.14159 * 3.0 + sin(s * 7.0 + vPhase) * 1.6);
    float fibreFade = smoothstep(8.0, 24.0, vHalfPx);
    float fibres = mix(1.0, 0.45 + 1.1 * f * f, uFibres * fibreFade);
    // Bright edges, like the rim of a glass ribbon, and more light where it turns edge-on.
    float rim = smoothstep(0.78, 1.0, av);
    rim *= rim;
    float boost = clamp(0.6 / max(vFacing, 0.15), 0.6, 3.0);
    // A slow pulse of light running along the strand.
    float p = fract(s * 1.3 - uTime * 0.045 + vPhase * 0.37) - 0.5;
    float pulse = exp(-p * p * 60.0);
    float a = mask * ends;
    vec3 glow = col * (0.14 * fibres + rim * vColB.a + pulse * 0.3) * boost * vThin;
    glow += vec3(1.0, 1.0, 0.96) * vSpec * uSpecular;
    // The light falls off faster at the edges than the tint, for the same reason as soft.
    glow *= mask * a * vBright;
    // Premultiplied: the strand's colour over what's behind (most in its heart), plus its light.
    float tint = vColA.a * a * mix(0.35, 1.0, vFacing) * vThin * mix(1.0, 0.7, edgeness);
    gl_FragColor = vec4(glow + heart * fibres * tint, tint);
  }
`;

/**
 * The sky behind everything, by view direction: a deep azure top easing to a pale aqua floor,
 * deeper behind the title on the left, with a soft white light high on the right that slowly
 * turns a few faint rays, a horizontal flare streak through it and a glossy horizon line.
 */
export const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

export const skyFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uZenith, uUpper, uMiddle, uLow, uFloor, uGlow;
  uniform vec2 uLight;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    // Coordinates on the view plane: the camera looks down -z.
    vec2 p = d.xy / max(-d.z, 0.15);
    float y = p.y;
    vec3 col = mix(uFloor, uLow, smoothstep(-0.55, -0.22, y));
    col = mix(col, uMiddle, smoothstep(-0.25, 0.05, y));
    col = mix(col, uUpper, smoothstep(0.0, 0.3, y));
    col = mix(col, uZenith, smoothstep(0.25, 0.6, y));
    // Deeper and calmer behind the title and buttons.
    col *= mix(0.78, 1.0, smoothstep(-0.7, 0.25, p.x + y * 0.3));
    // The light: a wide luminous haze, a brighter heart and a hot core for bloom.
    vec2 q = p - uLight;
    float r = length(q * vec2(0.85, 1.0));
    col = mix(col, uGlow, 0.32 * exp(-r * r * 9.0));
    col += uGlow * (0.4 * exp(-r * r * 60.0) + 1.6 * exp(-r * r * 1200.0));
    // Slow faint rays turning about it.
    float ang = atan(q.y, q.x);
    float rays = 0.5 + 0.5 * sin(ang * 7.0 + uTime * 0.025) * sin(ang * 11.0 - uTime * 0.017 + 1.7);
    col += uGlow * rays * 0.16 * exp(-r * 2.6) * smoothstep(0.02, 0.15, r);
    // A faint halo ring and one ghost towards the middle, like a lens's.
    col += uGlow * 0.07 * exp(-pow((r - 0.13) * 55.0, 2.0));
    vec2 g = p - uLight * 0.45;
    col += vec3(0.55, 1.0, 0.8) * uGlow * 0.06 * (1.0 - smoothstep(0.035, 0.045, length(g)));
    // A long horizontal flare streak through the light.
    col += uGlow * 0.35 * exp(-q.y * q.y * 9000.0) * exp(-abs(q.x) * 2.2);
    // Glossy horizon: a soft bright band low down, as if over still water.
    float hz = y + 0.27;
    col += uGlow * 0.10 * exp(-hz * hz * 900.0) * smoothstep(-0.7, 0.2, p.x);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Bright star-shaped glints that travel along a ribbon's edge.
export const glintVertex = /* glsl */ `
  ${ribbonPath}
  attribute vec4 aGlint; // across (-1..1), speed (lengths a second), phase, size
  attribute vec3 aGlintColor;

  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float s = fract(aGlint.z + uTime * aGlint.y);
    vec3 c, t, w, n;
    float hw;
    ribbonFrame(s, c, t, w, n, hw);
    vec3 perp;
    vec3 pos = c + seenAcross(t, w, normalize(cameraPosition - c), perp) * hw * aGlint.x;
    float twinkle = 0.65 + 0.35 * sin(uTime * 2.3 + aGlint.z * 40.0) * sin(uTime * 1.7 + aGlint.z * 17.0);
    // Fewer and fainter over the title on the left, where the strands start.
    vAlpha = ribbonEnds(s) * twinkle * mix(0.3, 1.0, smoothstep(0.2, 0.6, s));
    vColor = aGlintColor;
    vUv = position.xy * 2.0;
    vec4 mv = viewMatrix * vec4(pos, 1.0);
    mv.xy += position.xy * aGlint.w * (0.8 + 0.4 * twinkle);
    gl_Position = projectionMatrix * mv;
  }
`;

export const glintFragment = /* glsl */ `
  uniform float uIntensity;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec2 p = vUv;
    float r2 = dot(p, p);
    float core = exp(-r2 * 60.0);
    float halo = exp(-r2 * 9.0) * 0.25;
    // Four soft rays, the long pair horizontal like a lens's.
    float rays = exp(-abs(p.y) * 40.0) * exp(-abs(p.x) * 3.5) + exp(-abs(p.x) * 40.0) * exp(-abs(p.y) * 5.5) * 0.6;
    float edge = 1.0 - smoothstep(0.7, 1.0, max(abs(p.x), abs(p.y)));
    float i = (core * 1.6 + halo + rays) * edge * vAlpha * uIntensity;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core) * i, 0.0);
  }
`;

// Soft out-of-focus discs drifting slowly up through the scene.
export const bokehVertex = /* glsl */ `
  attribute vec4 aBokeh;  // xyz: where it starts; w: radius
  attribute vec4 aDrift;  // rise (units a second), sway, phase, brightness
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uHeight;

  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec3 c = aBokeh.xyz;
    // Rises through a band uHeight tall and wraps round at its ends, faded out there.
    float y = mod(c.y + uTime * aDrift.x + uHeight * 0.5, uHeight);
    c.y = y - uHeight * 0.5;
    c.x += sin(uTime * 0.11 + aDrift.z) * aDrift.y;
    float u = y / uHeight;
    vAlpha = smoothstep(0.0, 0.18, u) * smoothstep(1.0, 0.82, u) * aDrift.w * (0.75 + 0.25 * sin(uTime * 0.4 + aDrift.z * 3.0));
    vColor = aColor;
    vUv = position.xy * 2.0;
    vec4 mv = viewMatrix * vec4(c, 1.0);
    mv.xy += position.xy * aBokeh.w * 2.0;
    gl_Position = projectionMatrix * mv;
    // Fainter on the left, behind the title and buttons.
    vAlpha *= mix(0.3, 1.0, smoothstep(-0.6, 0.2, gl_Position.x / gl_Position.w));
  }
`;

export const bokehFragment = /* glsl */ `
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float r = length(vUv);
    float disc = 1.0 - smoothstep(0.82, 1.0, r);
    // Brighter towards the rim, like a real lens's bokeh.
    float body = 0.5 + 0.5 * smoothstep(0.35, 0.9, r);
    float i = disc * body * vAlpha;
    gl_FragColor = vec4(vColor * i, 0.0);
  }
`;
