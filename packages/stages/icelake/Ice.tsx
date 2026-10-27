import { useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { nightSky, noiseTexture, palette, polar } from '../polar/world.ts';
import { CABIN, LANTERN_HEIGHT, LANTERNS, RINK, SKATE_LOOPS, WIND } from './layout.ts';

// The frozen lake, in two layers either side of the reflections the polar kit draws below
// y = 0 (curtains, peaks, pines, the cabin):
//   - the mirror: black ice reflecting the sky along each pixel's reflection ray, and the
//     cabin's warm path. It writes no depth, so the mirrored land drawn after shows through.
//   - over those, what's on and in the ice: the dancers' reflection, the ice's own dark depth,
//     stacked frozen bubbles and pale cracks under the surface, frost and skate marks on the
//     cleared rink, wind-swept snow, the dancers' shadows and the lanterns' light.
// The dancers aren't the stage's to mirror, so they're drawn a second time from below the ice
// into a small target (useMirror) that the top layer reads.

const fixed = (v: number) => v.toFixed(2);

const ice = /* glsl */ `
const vec3 ICE_DEEP = vec3(0.003, 0.016, 0.022);
const vec3 ICE_NEAR = vec3(0.006, 0.034, 0.040);
const vec3 SNOW_LIT = vec3(0.34, 0.47, 0.70);
const vec3 SNOW_SHADE = vec3(0.05, 0.10, 0.20);
const vec3 MOON = normalize(vec3(-0.8, 0.5, 0.25));

// Ice is still: a faint frozen-in unevenness instead of the kit's moving ripples, fading out
// where it would pack into a few pixels (foot: the ground a pixel spans). Both layers read it,
// so they bend the reflections together.
vec2 iceSlope(vec2 p, float foot) {
  vec2 s = noise4(p * 0.18).rg * 0.006 * (1.0 - smoothstep(0.4, 2.0, foot));
  s += noise4(p * 0.9 + 21.0).ba * 0.004 * (1.0 - smoothstep(0.1, 0.5, foot));
  return s;
}

// How much of the mirrored world shows: as much as the kit's mirrored layers show (they darken
// themselves to 0.62), so a mirror even looking down at the near ice; the reflections are the point.
float iceReflect(float cosView) {
  float f = 0.02 + 0.98 * pow(1.0 - clamp(cosView, 0.0, 1.0), 5.0);
  return mix(0.62, 1.0, f);
}
`;

function mirrorMaterial() {
  return shaderMaterial({
    depthWrite: false,
    uniforms: { uTime: polar.uTime, uNoise: polar.uNoise, uLight: { value: new THREE.Vector3(...CABIN.light) } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uLight;
      varying vec3 vWorld;
      ${hash}
      ${noiseTexture}
      ${palette}
      ${nightSky}
      ${ice}
      void main() {
        vec3 view = normalize(cameraPosition - vWorld);
        float foot = max(fwidth(vWorld.x), fwidth(vWorld.z));
        vec2 slope = iceSlope(vWorld.xz, foot);
        vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
        vec3 r = reflect(-view, n);
        r.y = abs(r.y);
        // A little wider than a pixel: the stars blur a touch in the ice.
        float pixel = max(max(length(dFdx(r)), length(dFdy(r))), 0.003);
        vec3 col = mix(WATER, nightSky(r, pixel), iceReflect(dot(n, view)));
        // The cabin's windows, drawn out into a soft warm path across the ice towards us.
        vec3 toLight = normalize(uLight - vWorld);
        vec3 off = r - toLight;
        float across = dot(off, normalize(vec3(-toLight.z, 0.0, toLight.x) + vec3(1e-6, 0.0, 0.0)));
        col += WARM * (exp(-across * across / 0.00008 - off.y * off.y / 0.006) * 1.1 + exp(-across * across / 0.0012 - off.y * off.y / 0.03) * 0.12);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

const lanterns = LANTERNS.map(([x, z]) => new THREE.Vector3(x, LANTERN_HEIGHT, z));
const loops = SKATE_LOOPS.map((l) => new THREE.Vector4(...l));

function surfaceMaterial(mirror: THREE.Texture) {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    // For the shadow map.
    lights: true,
    // Premultiplied: the shader both covers what's beneath (snow) and adds light (lanterns).
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      uTime: polar.uTime,
      uNoise: polar.uNoise,
      uMirror: { value: mirror },
      uLanterns: { value: lanterns },
      uLoops: { value: loops },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <shadowmap_pars_vertex>
      varying vec3 vWorld;
      varying vec4 vClip;
      void main() {
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <project_vertex>
        #include <worldpos_vertex>
        #include <shadowmap_vertex>
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vClip = gl_Position;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <bsdfs>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      uniform float uTime;
      uniform sampler2D uMirror;
      uniform vec3 uLanterns[${lanterns.length}];
      uniform vec4 uLoops[${loops.length}];
      varying vec3 vWorld;
      varying vec4 vClip;
      ${hash}
      ${noiseTexture}
      ${palette}
      ${ice}
      const vec2 WIND = vec2(${fixed(WIND[0])}, ${fixed(WIND[1])});

      // Layers composited bottom to top, premultiplied.
      void over(inout vec4 acc, vec3 c, float a) {
        acc = vec4(c * a, a) + acc * (1.0 - a);
      }

      // One layer of frozen bubbles, Abraham Lake's: in some cells of a grid, in patches, a column
      // of flattened white discs stacked down through the ice, each smaller than the one above.
      // Every layer shares the grid, so a column's discs line up.
      float bubbles(vec2 q, float layer, out float rim) {
        vec2 g = q / 1.2;
        vec2 id = floor(g);
        vec4 h = vec4(hash22(id), hash22(id * 1.31 + 17.0));
        float patches = smoothstep(-0.3, 0.4, noise4(id * 0.13 + 40.0).g);
        rim = 0.0;
        // Some columns are a single disc, some four deep.
        if (h.x > patches * 0.8 || layer > h.w * 4.0) return 0.0;
        float r = (0.08 + 0.24 * h.y * h.y) * (1.0 - 0.16 * layer) * (0.85 + 0.15 * hash12(id + layer));
        vec2 c = 0.5 + (hash22(id + 5.0) - 0.5) * (1.0 - 2.0 * r) * 0.8 + (hash22(id + layer * 7.0) - 0.5) * 0.08 * layer;
        float d = length(fract(g) - c) / r;
        // Softened by the grid's own slope, not d's (which jumps at cell edges).
        float aa = max(fwidth(g.x), fwidth(g.y)) / r * 1.2 + 0.1 + 0.1 * layer;
        float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa * 0.5, d);
        rim = smoothstep(0.55, 0.95, d) * disc;
        return disc;
      }

      // Cracks: some of the edges of a network of wobbly plates about 9 units across, pale lines
      // a pixel or two wide that keep their light as they thin with distance.
      float cracks(vec2 q, float foot) {
        vec2 g = (q + noise4(q * 0.09 + 60.0).rg * 1.6) / 9.0;
        vec2 id = floor(g);
        vec2 f = fract(g);
        float d1 = 9.0;
        float d2 = 9.0;
        vec2 m1 = vec2(0.0);
        vec2 m2 = vec2(1.0);
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            vec2 r = o + 0.1 + 0.8 * hash22(id + o) - f;
            float d = dot(r, r);
            if (d < d1) {
              d2 = d1;
              m2 = m1;
              d1 = d;
              m1 = r;
            } else if (d < d2) {
              d2 = d;
              m2 = r;
            }
          }
        }
        // Distance (world units) to the edge between the two nearest plates.
        vec2 across = m2 - m1;
        float edge = dot(0.5 * (m1 + m2), across / max(length(across), 1e-4)) * 9.0;
        float width = 0.04;
        float line = (1.0 - smoothstep(width, width + foot * 1.2, edge)) * min(1.0, (width + foot * 0.6) / max(foot * 1.5, 1e-4));
        // Only some edges have cracked.
        return line * smoothstep(0.0, 0.35, noise4(q * 0.03 + 3.0).b);
      }

      // Skates' loops round the dancers, broken where a blade lifted.
      float skates(vec2 p) {
        float s = 0.0;
        for (int i = 0; i < ${loops.length}; i++) {
          vec4 l = uLoops[i];
          vec2 d = (p - l.xy) / l.zw;
          float e = (length(d) - 1.0) * min(l.z, l.w);
          float w = fwidth(e);
          float line = (1.0 - smoothstep(0.0, 0.018 + w, abs(e))) * min(1.0, 0.03 / max(w, 1e-4));
          float lifted = smoothstep(-0.3, 0.5, sin(d.x * 4.0 + d.y * 3.0 + float(i) * 2.3) + 0.4 * sin(d.y * 9.0 - float(i)));
          s = max(s, line * lifted);
        }
        return s;
      }

      // Along and across the wind.
      vec2 windward(vec2 p) {
        return vec2(dot(p, WIND), dot(p, vec2(-WIND.y, WIND.x)));
      }

      // Long drifts lying along the wind: smooth enough to shade by.
      float driftAt(vec2 p) {
        vec2 q = windward(p);
        return noise4(q * vec2(0.022, 0.1)).r * 0.65 + noise4(q * vec2(0.055, 0.28) + 5.0).g * 0.35;
      }

      // How deep the snow lies at p: the drifts and finer powder streaks, cleared off the rink and
      // piled round its edge, and more of it towards the shore.
      float snowDepth(vec2 p, float drift) {
        float streaks = noise4(windward(p) * vec2(0.07, 0.8) + 11.0).b;
        float r = length(p);
        // Heaps shovelled up round the rink, with gaps between them.
        float heaps = smoothstep(-0.2, 0.35, noise4(p * 0.16 + 9.0).a);
        float rim = smoothstep(${fixed(RINK.radius - 0.8)}, ${fixed(RINK.radius + 0.6)}, r + noise4(p * 0.6).a * 0.6)
          * (1.0 - smoothstep(${fixed(RINK.radius + 1.0)}, ${fixed(RINK.radius + 3.5)}, r + drift * 2.0)) * heaps;
        // Out on the lake, bare ice between the drifts, more snow towards the shore.
        float open = smoothstep(${fixed(RINK.radius + 0.5)}, ${fixed(RINK.radius + 4)}, r);
        float shore = smoothstep(140.0, 260.0, r);
        float depth = smoothstep(0.3 - 0.2 * shore, 0.62 - 0.2 * shore, drift) * open * 0.9 + smoothstep(0.35, 0.8, streaks) * open * 0.3;
        return max(depth, rim * (0.75 + 0.25 * drift));
      }

      void main() {
        vec3 view = normalize(cameraPosition - vWorld);
        float dist = length(cameraPosition - vWorld);
        vec2 p = vWorld.xz;
        float r = length(p);
        float foot = max(fwidth(p.x), fwidth(p.y));
        float detail = 1.0 - smoothstep(0.08, 0.25, foot);
        vec2 slope = iceSlope(p, foot);
        float k = iceReflect(dot(normalize(vec3(-slope.x, 1.0, -slope.y)), view));
        float rink = 1.0 - smoothstep(${fixed(RINK.radius - 1.0)}, ${fixed(RINK.radius + 0.5)}, r);

        // The dancers' reflection (premultiplied in its target), smeared a little down the ice.
        vec2 ndc = vClip.xy / vClip.w;
        vec2 uv = vec2(0.5 - 0.5 * ndc.x, 0.5 + 0.5 * ndc.y) + slope * vec2(-0.6, 1.2);
        vec4 m = texture2D(uMirror, uv) * 0.5 + texture2D(uMirror, uv + vec2(0.0, 0.006)) * 0.25 + texture2D(uMirror, uv - vec2(0.0, 0.009)) * 0.25;
        vec4 acc = m * k * 0.85;

        // The ice itself, dark green-teal, over every reflection where we look down into it.
        over(acc, mix(ICE_NEAR, ICE_DEEP, smoothstep(4.0, 40.0, dist)), (1.0 - k) * 0.7);

        // Into the ice, bent down towards the normal as it enters: stacked bubbles, deepest
        // first, and cracks reaching down from the surface.
        vec3 t = refract(-view, vec3(0.0, 1.0, 0.0), 0.76);
        vec2 sink = t.xz / max(-t.y, 0.2);
        // Fainter right under the lens, where they'd be big white blots at the frame's foot.
        float seen = clamp((1.0 - k) * 2.4, 0.0, 1.0) * mix(0.35, 1.0, smoothstep(4.0, 10.0, dist));
        if (detail > 0.0) {
          for (int i = 3; i >= 0; i--) {
            float layer = float(i);
            float rim;
            float b = bubbles(p + sink * (0.1 + 0.28 * layer), layer, rim);
            // Milky white, brightest at a crisp rim; deeper ones dimmer and greener.
            vec3 c = mix(vec3(0.7, 0.84, 0.9), vec3(0.95, 1.05, 1.1), rim) * mix(vec3(1.0), vec3(0.4, 0.72, 0.72), layer / 3.0);
            over(acc, c, b * (0.62 + 0.3 * rim) * (1.0 - 0.2 * layer) * seen * detail);
          }
        }
        float crack = max(cracks(p, foot), cracks(p + sink * 0.35, foot * 3.0) * 0.3);
        over(acc, vec3(0.7, 0.88, 0.92), crack * seen * 0.8 * (1.0 - smoothstep(0.15, 0.6, foot)));

        // Frost dusting and skate marks on the rink, a milky veil the moon and shadows show on.
        float frost = rink * (0.12 + 0.1 * noise4(p * 0.5).r);
        if (r < 10.0) frost += skates(p) * 0.24 * detail;
        over(acc, mix(SNOW_SHADE, SNOW_LIT, 0.6), clamp(frost, 0.0, 1.0));

        // Snow, shaded by the moon on its drifted slopes, with glints.
        float drift = driftAt(p);
        float cover = smoothstep(0.02, 0.5, snowDepth(p, drift));
        if (cover > 0.0) {
          vec2 grad = vec2(driftAt(p + vec2(0.35, 0.0)) - drift, driftAt(p + vec2(0.0, 0.35)) - drift) / 0.35;
          vec3 sn = normalize(vec3(-grad.x * 0.9, 1.0, -grad.y * 0.9));
          float lit = clamp(dot(sn, MOON) * 1.4, 0.0, 1.0);
          vec3 snow = mix(SNOW_SHADE, SNOW_LIT, lit) + vec3(0.0, 0.05, 0.035) * (1.0 - lit);
          // Glints: a pixel-sized point in the odd cell, twinkling.
          vec2 cell = floor(p * 5.0);
          float pick = hash12(cell);
          vec2 spot = (fract(p * 5.0) - hash22(cell + 3.0)) / 5.0;
          float on = step(0.9, pick) * step(0.6, fract(uTime * (0.3 + pick) + pick * 7.0));
          float glint = on * (1.0 - smoothstep(0.0, foot * 1.3, length(spot)));
          snow += vec3(1.4, 1.6, 1.9) * glint * lit * (1.0 - smoothstep(0.03, 0.08, foot));
          over(acc, snow, cover);
        }

        // Powder blowing across the ice, low and fast along the wind.
        if (dist < 60.0) {
          vec2 q = windward(p);
          float blow = smoothstep(0.2, 0.75, noise4(q * vec2(0.09, 0.55) - vec2(uTime * 0.55, 0.0)).a) * smoothstep(-0.1, 0.5, noise4(q * 0.02 - vec2(uTime * 0.05, 0.0)).r);
          over(acc, SNOW_LIT * 0.8, blow * 0.22 * (1.0 - smoothstep(20.0, 60.0, dist)));
        }

        // The dancers' shadows, only near them where the shadow map reaches: plain on snow and
        // frost, fainter on the mirror.
        if (r < 16.0) {
          float diffuse = clamp(acc.a * 1.5, 0.0, 1.0);
          float s = mix(1.0, getShadowMask(), 0.4 + 0.5 * diffuse);
          acc.rgb *= s;
          acc.a = 1.0 - (1.0 - acc.a) * s;
        }

        // Warm pools of light round the lanterns, strongest on the snow.
        vec3 warm = vec3(0.0);
        for (int i = 0; i < ${lanterns.length}; i++) {
          vec3 d = vec3(p.x, 0.0, p.y) - uLanterns[i];
          warm += WARM / (1.0 + dot(d, d) * 0.9);
        }
        acc.rgb += warm * (0.05 + 0.45 * clamp(acc.a, 0.0, 1.0));

        gl_FragColor = acc;
      }
    `,
  });
}

// The mirror camera's view is the eye's reflected through y = 0 (which turns triangles inside
// out), and its projection flipped left to right (which turns them back).
const FLIP_Y = new THREE.Matrix4().makeScale(1, -1, 1);
const FLIP_X = new THREE.Matrix4().makeScale(-1, 1, 1);

/**
 * Draws the scene's dancers a second time, mirrored below the ice, into a small target for the
 * ice to read: everything of the stage's own in `world` is hidden for it (the props outside it,
 * standing on the ice, are drawn too). A point on the ice lands in the same place in the target
 * as on screen, mirrored left to right, whatever the camera's view offset.
 */
function useMirror(world: RefObject<THREE.Group | null>, ice: RefObject<THREE.Mesh | null>) {
  const target = useDisposable(() => new THREE.WebGLRenderTarget(320, 240, { type: THREE.HalfFloatType }));
  const camera = useMemo(() => {
    const c = new THREE.PerspectiveCamera();
    c.matrixAutoUpdate = false;
    c.matrixWorldAutoUpdate = false;
    return c;
  }, []);
  const state = useRef({ drawn: -1, frame: 0, clear: new THREE.Color() });
  // After the dancers have moved and the camera has, before the stage is drawn.
  useFrame(({ gl, scene, camera: eye }) => {
    const s = state.current;
    s.frame++;
    // Only while the ice is being drawn, not while the stage is out of sight.
    if (!world.current || !ice.current || s.frame - s.drawn > 2) return;
    eye.updateMatrixWorld();
    camera.matrixWorld.multiplyMatrices(FLIP_Y, eye.matrixWorld);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.projectionMatrix.multiplyMatrices(FLIP_X, eye.projectionMatrix);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    const saved = { target: gl.getRenderTarget(), alpha: gl.getClearAlpha(), shadows: gl.shadowMap.needsUpdate };
    gl.getClearColor(s.clear);
    world.current.visible = false;
    try {
      // The stage's own draw updates the shadows.
      gl.shadowMap.needsUpdate = false;
      gl.setRenderTarget(target);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(scene, camera);
    } finally {
      world.current.visible = true;
      gl.setRenderTarget(saved.target);
      gl.setClearColor(s.clear, saved.alpha);
      gl.shadowMap.needsUpdate = saved.shadows;
    }
  }, 0.95);
  const onDrawn = () => {
    state.current.drawn = state.current.frame;
  };
  return { texture: target.texture, onDrawn };
}

// Out past the shore all round, under the land.
const SIZE = 1000;

/** The lake's ice and what's in and on it; `world` holds everything the dancers' reflection leaves out. */
export function Ice({ world }: { world: RefObject<THREE.Group | null> }) {
  const base = useRef<THREE.Mesh>(null);
  const { texture, onDrawn } = useMirror(world, base);
  const mirror = useDisposable(mirrorMaterial);
  const surface = useDisposable(() => surfaceMaterial(texture), [texture]);
  const plane = useDisposable(() => new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2));
  return (
    <>
      <mesh ref={base} geometry={plane} material={mirror} renderOrder={-900} frustumCulled={false} onBeforeRender={onDrawn} />
      <mesh geometry={plane} material={surface} renderOrder={-30} frustumCulled={false} receiveShadow />
    </>
  );
}
