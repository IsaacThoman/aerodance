import * as THREE from 'three';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { riser } from './layout.ts';
import type { RiserSpec } from './layout.ts';
import { aquaGLSL } from './shaders.ts';
import type { SharedUniforms } from './shaders.ts';

/** One bubble: where it rises and how fast (layout.ts), how it sways and wobbles. */
interface BubbleSpec extends RiserSpec {
  /** Side-to-side drift (world units) and its angular speed. */
  sway?: number;
  swayRate?: number;
  /** How much its outline wobbles. */
  wobble?: number;
  /** Brightness of its reflections and highlights. */
  bright?: number;
}

// The big ones, placed by hand: the showpiece rises through the middle gap and the right, where
// the menus leave room. They share one slow loop, evenly staggered, so they take turns and two or
// three are always in view.
const HERO_LOOP = 180;
const HEROES: readonly BubbleSpec[] = (
  [
    { fx: 0.56, distance: 5.6, size: 0.135, start: 0.02, wobble: 0.035 },
    { fx: 0.83, distance: 6.6, size: 0.16, start: 0.19, wobble: 0.03 },
    { fx: -0.03, distance: 5.2, size: 0.11, start: 0.36, wobble: 0.04 },
    // A giant drifting past just in front of the lens, out of focus, at the right edge.
    { fx: 1.06, distance: 3.4, size: 0.3, start: 0.52, wobble: 0.025, sway: 0.08, swayRate: 0.12 },
    { fx: 0.47, distance: 8.0, size: 0.085, start: 0.69, wobble: 0.045 },
    { fx: 1.03, distance: 4.8, size: 0.12, start: 0.85, wobble: 0.04 },
  ] satisfies BubbleSpec[]
).map((hero) => ({ ...hero, loop: HERO_LOOP }));

// Thin columns of small bubbles, rising quicker and jittering as they go. Each column shares one
// loop (seconds), so its bubbles keep their spacing and never overtake one another.
const STREAMS = [
  { fx: 0.575, distance: 9.5, count: 15, loop: 13 },
  { fx: 0.965, distance: 8.0, count: 12, loop: 11.5 },
  { fx: 0.035, distance: 12.5, count: 13, loop: 15 },
] as const;

// The title and its buttons sit over this band of the frame; only small, far bubbles cross it.
const TITLE_BAND: readonly [number, number] = [0.08, 0.45];

function layout(): BubbleSpec[] {
  const rand = makeRandom(4207);
  const specs: BubbleSpec[] = [...HEROES];
  // Middle distance: medium bubbles, kept off the title band where they would be big.
  for (let i = 0; i < 12; i++) {
    let fx = rand.range(-0.02, 1.02);
    for (let tries = 0; tries < 4 && fx > TITLE_BAND[0] && fx < TITLE_BAND[1]; tries++) fx = rand.range(-0.02, 1.02);
    specs.push({
      fx,
      distance: rand.range(8.5, 18),
      size: rand.range(0.018, 0.075),
      seconds: rand.range(38, 62),
      start: (i + rand.range(0, 0.6)) / 12,
      sway: rand.range(0.12, 0.3),
      swayRate: rand.range(0.18, 0.4),
      wobble: rand.range(0.02, 0.05),
    });
  }
  // Far away: small soft bubbles everywhere, hazed into the blue.
  for (let i = 0; i < 28; i++) {
    specs.push({
      fx: rand.range(-0.02, 1.02),
      distance: rand.range(17, 40),
      size: rand.range(0.011, 0.028),
      seconds: rand.range(48, 85),
      start: rand.next(),
      sway: rand.range(0.2, 0.5),
      swayRate: rand.range(0.15, 0.35),
      wobble: 0.02,
      bright: 0.8,
    });
  }
  for (const stream of STREAMS) {
    for (let i = 0; i < stream.count; i++) {
      specs.push({
        fx: stream.fx + rand.range(-0.004, 0.004),
        distance: stream.distance,
        size: rand.range(0.006, 0.015),
        loop: stream.loop,
        start: (i + rand.range(-0.2, 0.2)) / stream.count,
        sway: rand.range(0.03, 0.08),
        swayRate: rand.range(1.6, 2.8),
        wobble: 0,
      });
    }
  }
  return specs;
}

/**
 * Every bubble in one instanced draw: camera-facing quads, each shading a sphere of soap film
 * with a wobbling outline. Thin-film interference tints its reflections, a window of the bright
 * water overhead curves round the top, the rim catches the light, and through it the aqua shows
 * slightly lensed. Depth of field softens the nearest and the farthest; haze fades the far ones.
 * Drawn far to near.
 */
export function Bubbles({ shared }: { shared: SharedUniforms }) {
  const geometry = useDisposable(() => {
    const specs = layout().map((s) => ({ s, rise: riser(s) }));
    specs.sort((a, b) => b.s.distance - a.s.distance);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    const body = new Float32Array(specs.length * 4);
    const rise = new Float32Array(specs.length * 4);
    const look = new Float32Array(specs.length * 4);
    const rand = makeRandom(91);
    specs.forEach(({ s, rise: r }, i) => {
      body.set([r.x, r.z, r.r, rand.next()], i * 4);
      rise.set([r.y0, r.yMin, r.yRange, r.speed], i * 4);
      look.set([s.sway ?? 0.1, s.swayRate ?? 0.22, s.wobble ?? 0.03, s.bright ?? 1], i * 4);
    });
    g.setAttribute('aBody', new THREE.InstancedBufferAttribute(body, 4));
    g.setAttribute('aRise', new THREE.InstancedBufferAttribute(rise, 4));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 4));
    g.instanceCount = specs.length;
    return g;
  });

  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...shared, uFocus: { value: 12 }, uAperture: { value: 0.16 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      premultipliedAlpha: true,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        uniform float uTime, uFocus, uAperture;
        attribute vec4 aBody;
        attribute vec4 aRise;
        attribute vec4 aLook;
        varying vec2 vP;
        varying vec2 vS;
        varying vec4 vLook;
        varying float vBright;
        varying float vLens;
        // Quad half-size in bubble radii: room for the wobble and a defocused edge.
        const float QUAD = 1.3;
        void main() {
          float seed = aBody.w;
          float y = aRise.y + mod(aRise.x + uTime * aRise.w, aRise.z);
          float x = aBody.x + sin(uTime * aLook.y + seed * 6.2832) * aLook.x
            + sin(uTime * aLook.y * 2.3 + seed * 17.0) * aLook.x * 0.3;
          vec4 mv = modelViewMatrix * vec4(x, y, aBody.y, 1.0);
          float dist = -mv.z;
          float r = aBody.z;
          vP = position.xy * 2.0 * QUAD;
          mv.xy += vP * r;
          vS = mv.xy / -mv.z;
          // Circle of confusion over the bubble's own radius, both on screen.
          float blur = clamp(uAperture * abs(dist / uFocus - 1.0) / r, 0.0, 0.5);
          float haze = smoothstep(14.0, 46.0, dist);
          vLook = vec4(seed, blur, haze, aLook.z);
          vBright = aLook.w;
          vLens = r / dist;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vP;
        varying vec2 vS;
        varying vec4 vLook;
        varying float vBright;
        varying float vLens;
        ${aquaGLSL}

        // The bright water overhead and the deep blue below, as the film reflects them (view space).
        vec3 env(vec3 r) {
          vec3 c = mix(uLow * 0.6, uHigh * 1.2, smoothstep(-0.7, 0.2, r.y));
          return mix(c, uTop * 1.6, smoothstep(0.1, 0.9, r.y));
        }

        // An arc of light round the sphere: centred on angle a (0 up, clockwise), spanning ±w,
        // between radii r0 and r1, with soft edges e.
        float arc(vec2 q, float a, float w, float r0, float r1, float e) {
          float ang = atan(q.x, q.y) - a;
          ang = abs(mod(ang + 3.14159, 6.28318) - 3.14159);
          float rho = length(q);
          return (1.0 - smoothstep(w - e * 2.0, w + e * 2.0, ang))
            * smoothstep(r0 - e, r0 + e, rho) * (1.0 - smoothstep(r1 - e, r1 + e, rho));
        }

        void main() {
          float seed = vLook.x;
          float blur = vLook.y;
          float haze = vLook.z;
          float wob = vLook.w;
          float t = uTime * (0.8 + seed * 0.5);

          // A wobbling outline: low modes of a ring, drifting round.
          float th = atan(vP.y, vP.x);
          float k = 1.0 + wob * (sin(2.0 * th + t * 1.1 + seed * 6.3) * 0.75
            + sin(3.0 * th - t * 0.83 + seed * 13.0) * 0.45
            + sin(4.0 * th + t * 1.37 + seed * 3.1) * 0.2);
          vec2 q = vP / k;
          float rho = length(q);
          float aa = fwidth(rho) * 1.2;
          float soft = max(aa, blur);
          if (rho > 1.0 + soft * 1.2) discard;
          float inside = 1.0 - smoothstep(1.0 - soft, 1.0 + soft * 0.6, rho);

          vec2 qn = q * min(1.0, 0.995 / max(rho, 1e-4));
          vec3 n = vec3(qn, sqrt(max(0.0, 1.0 - dot(qn, qn))));
          float edge = 1.0 - n.z;
          float fres = 0.07 + 0.93 * edge * edge * edge;

          // Soap film: its thickness swirls about and drains downwards (thinner at the top);
          // interference at that thickness and angle colours what it reflects.
          float swirl = sin(n.x * 2.6 + t * 0.21 + seed * 5.0 + sin(n.y * 3.1 - t * 0.17 + seed * 2.0) * 1.5)
            + sin(n.y * 2.9 - t * 0.15 + seed * 9.0 + sin(n.x * 2.4 + t * 0.19) * 1.3)
            + sin(n.x * 6.0 - n.y * 4.5 + t * 0.3 + seed * 3.0) * 0.35;
          float thick = 420.0 + seed * 160.0 + swirl * 85.0 - n.y * 150.0;
          float cosT = sqrt(1.0 - (1.0 - n.z * n.z) / 1.769);
          vec3 phase = 2.0 * 1.33 * thick * cosT / vec3(650.0, 532.0, 450.0);
          vec3 film = 0.5 - 0.5 * cos(6.28318 * phase);
          film *= 2.0;
          vec3 chroma = film - dot(film, vec3(0.3333));

          vec3 r = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);
          vec3 sky = env(r);
          float skyLum = clamp(dot(sky, vec3(0.3, 0.5, 0.2)), 0.2, 1.2);
          vec3 col = sky * mix(vec3(1.0), film, 0.7) * fres;
          // The rainbow sheen, strongest towards the rim but swirling right across the face; the
          // small ones, a few pixels across, stay mostly silver.
          float big = smoothstep(0.012, 0.09, vLens);
          col += chroma * (0.1 + 0.55 * edge * edge) * mix(0.18, 0.5, big) * skyLum;

          // The window of bright water overhead, two panes curving round the near wall, and
          // light gathered along the lower rim.
          float e = aa * 0.6 + blur * 0.3;
          float panes = arc(q, -0.02, 0.2, 0.64, 0.87, e) + arc(q, 0.44, 0.16, 0.65, 0.85, e) * 0.75;
          float hi = panes * (0.55 + 0.45 * smoothstep(0.64, 0.87, rho));
          float rim = smoothstep(0.8, 0.99, rho) * smoothstep(0.3, -0.9, q.y);
          float sharp = 1.0 - smoothstep(0.0, 0.45, blur);
          col += vec3(1.75, 1.95, 2.0) * hi * mix(0.45, 1.0, sharp);
          col += vec3(0.3, 0.85, 1.0) * rim * 0.35 * mix(vec3(1.0), film, big);
          // A crisp bright ring round the silhouette, where the film is seen edge on (kept a couple
          // of pixels wide on the small ones, so it doesn't shimmer as they rise).
          float ringIn = min(0.8, 0.975 - aa * 2.5);
          col += (sky * 0.3 + vec3(0.12, 0.2, 0.22)) * smoothstep(ringIn, 0.975, rho) * mix(vec3(1.0), film, 0.5 * big);

          // Through the bubble: the aqua, lensed upside down, and a little dimmed at the rim.
          vec3 lensed = min(aqua(vS - qn * vLens * 0.9), vec3(1.1));
          float through = 0.13 * (1.0 - edge);
          col += lensed * through;
          float alpha = through + fres * 0.3;

          float fade = vBright * (1.0 - haze * 0.75);
          vec3 tint = aqua(vS) * haze * 0.35 * fres;
          gl_FragColor = vec4((col * fade + tint) * inside, alpha * inside * (1.0 - haze * 0.6));
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={30} />;
}
