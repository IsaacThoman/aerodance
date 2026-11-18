import { useRef } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { hash, shaderMaterial } from '../../../../../packages/stages/shared/glsl.ts';
import { makeRandom } from '../../../../../packages/stages/shared/random.ts';
import { makeCloudAtlas } from '../../../../../packages/stages/shared/Sky.tsx';
import { SEA_Y } from './layout.ts';
import { W, commonGLSL } from './world.ts';

/*
 * The sky round the island: the dome (the sky's colours, the sun, the moon in its real phase, the
 * stars turning, a layer of cloud that thickens to overcast), big cumulus standing up out of the
 * sea of clouds, the sea of clouds itself far below, the sun's lens flare and a storm's lightning.
 */

const quad = (w = 1, h = 1) => {
  const plane = new THREE.PlaneGeometry(w, h);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.attributes.position);
  g.setAttribute('uv', plane.attributes.uv);
  return g;
};

/** The dome, following the camera: drawn after the opaque scene at the far plane, so only the sky's own pixels are shaded. */
export function SkyDome() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() => shaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uMoonDir, uMoonR, uMoonU, uMoonSun, uStarAxis;
      uniform float uSunDisc, uStars, uMoonVis, uStarAngle;
      uniform vec2 uDrift;
      varying vec3 vDir;
      ${commonGLSL}
      ${hash}
      vec3 turn(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
      // Stars on a grid over the faces of a cube round the sky (in the stars' own frame): some
      // cells have one, most faint, a few bright, twinkling.
      float starField(vec3 d) {
        vec3 a = abs(d);
        vec2 uv;
        float face;
        if (a.x > a.y && a.x > a.z) { uv = d.yz / a.x; face = d.x > 0.0 ? 0.0 : 1.0; }
        else if (a.y > a.z) { uv = d.xz / a.y; face = d.y > 0.0 ? 2.0 : 3.0; }
        else { uv = d.xy / a.z; face = d.z > 0.0 ? 4.0 : 5.0; }
        vec2 p = uv * 70.0;
        vec2 cell = floor(p);
        float rnd = hash12(cell + face * 131.7);
        if (rnd < 0.82) return 0.0;
        float k = (rnd - 0.82) / 0.18;
        vec2 local = fract(p) - 0.5 - (hash22(cell + face * 17.3) - 0.5) * 0.6;
        float size = mix(0.07, 0.17, k * k);
        float s = smoothstep(size, 0.0, length(local));
        float tw = 0.7 + 0.3 * sin(uTime * (1.3 + k * 3.0) + rnd * 60.0);
        return s * tw * mix(0.35, 5.0, k * k * k * k);
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyGradient(d);
        float sd = dot(d, uSunDir);
        float x = max(1.0 - sd, 0.0);
        // The sun: a wide glow (through haze and thin cloud too), its halo and its disc.
        col += uSunColor * (exp(-x * 7.0) * 0.08 * uDaylight * (1.0 - 0.6 * uOvercast) + exp(-x * 90.0) * 0.25 * uSunDisc + exp(-x * 900.0) * 0.9 * uSunDisc);
        col += uSunColor * smoothstep(1.3e-4, 0.85e-4, x) * uSunDisc * 16.0;
        float above = smoothstep(-0.01, 0.1, d.y);
        // The stars and a faint Milky Way, turning about the pole.
        if (uStars > 0.002) {
          vec3 ds = turn(d, uStarAxis, -uStarAngle);
          float b = dot(ds, vec3(0.42, 0.62, -0.66));
          float band = exp(-b * b * 16.0) * (0.35 + 0.65 * texture2D(uNoise, ds.xy * 1.3 + 0.2).g * texture2D(uNoise, ds.yz * 1.7 + 0.5).b * 2.0);
          col += (vec3(0.85, 0.9, 1.0) * starField(ds) + vec3(0.32, 0.36, 0.6) * band * 0.035) * uStars * above;
        }
        // The moon: a sphere lit by the sun from where it really is, so its phase is the real one.
        float md = dot(d, uMoonDir);
        if (md > 0.985 && uMoonVis > 0.002) {
          vec2 q = vec2(dot(d, uMoonR), dot(d, uMoonU)) / 0.021;
          float r2 = dot(q, q);
          if (r2 < 1.0) {
            vec3 n = vec3(q, sqrt(max(1.0 - r2, 0.0)));
            float lit = smoothstep(-0.06, 0.1, dot(n, uMoonSun));
            float maria = 0.78 + 0.22 * texture2D(uNoise, q * 0.18 + 0.4).r;
            vec3 mc = vec3(1.0, 0.97, 0.9) * maria * mix(1.1, 2.4, 1.0 - uDaylight) * lit;
            float a = (1.0 - smoothstep(0.84, 1.0, r2)) * uMoonVis * mix(0.12 * (1.0 - uDaylight), mix(1.0, 0.75, uDaylight), lit);
            col = mix(col, mc, a);
          }
          col += vec3(0.4, 0.5, 0.85) * exp(-sqrt(r2) * 0.6) * 0.07 * (uMoonSun.z * 0.5 + 0.5) * uMoonVis * (1.0 - uDaylight);
        }
        // A layer of cloud above, thickening into an overcast sheet; lightning lights it from within.
        if (d.y > 0.0) {
          vec2 uv = d.xz / (d.y + 0.14) * 0.3 + uDrift;
          float n = texture2D(uNoise, uv * 0.55).r * 0.6 + texture2D(uNoise, uv * 1.5 + 0.37).g * 0.3 + texture2D(uNoise, uv * 3.9 + 0.71).b * 0.1;
          float thr = mix(0.74, 0.0, smoothstep(0.2, 1.0, uCloud));
          float m = smoothstep(thr, thr + 0.2, n) * smoothstep(0.0, 0.12, d.y);
          float dens = smoothstep(thr, thr + 0.55, n);
          vec3 cc = mix(uCloudLit, uCloudShade, clamp(dens * 0.75 + uOvercast * 0.2, 0.0, 1.0));
          cc += uSunColor * uSunDisc * pow(max(sd, 0.0), 8.0) * (1.0 - dens) * 1.3;
          cc += uGlow * uGlowAmount * pow(sunward(d), 3.0) * (1.0 - smoothstep(0.0, 0.3, d.y)) * 0.5;
          cc += vec3(0.7, 0.76, 1.0) * uFlash * (0.5 + dens) * 1.3;
          col = mix(col, cc, m * 0.96);
        }
        // Rain falling from the cloud base, greying the distance.
        float shafts = 0.6 + 0.4 * texture2D(uNoise, normalize(d.xz + vec2(1e-5, 0.0)) * 1.7 + 0.3).r;
        col = mix(col, uCloudShade * 0.9, uRain * 0.45 * shafts * (1.0 - smoothstep(-0.02, 0.22, d.y)) * step(-0.05, d.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }));
  useFrame(({ camera }) => mesh.current?.position.copy(camera.position));
  return (
    <mesh ref={mesh} material={material} renderOrder={10} frustumCulled={false}>
      <sphereGeometry args={[100, 48, 24]} />
    </mesh>
  );
}

// Cumulus round the island: [count], each standing up out of the sea of clouds or floating higher.
const CUMULUS = 18;

/**
 * Big cumulus billboards on a wide ring round the island, drifting round it with the wind. The
 * more cloud there is, the more of them show (each has its own threshold); lit by the sun (gold
 * when it's low) with silver linings, grey when overcast, moonlit at night.
 */
export function Cumulus() {
  const atlas = useDisposable(() => makeCloudAtlas(17));
  const geometry = useDisposable(() => {
    const rand = makeRandom(41);
    const g = quad();
    const items = Array.from({ length: CUMULUS }, (_, i) => {
      const radius = rand.range(420, 1100);
      // Spread evenly round the ring, the first few (the ones a clear sky keeps) spaced widest.
      const angle = (i / CUMULUS) * Math.PI * 2 * 7.0 + rand.range(-0.2, 0.2);
      const towering = rand.chance(0.6);
      const w = rand.range(260, 520) * (radius / 800);
      return { angle, radius, y: towering ? SEA_Y + w * 0.18 : rand.range(-20, 90), w, h: w * rand.range(0.62, 0.82), cell: rand.int(0, 3), flip: rand.sign(), threshold: (i + rand.range(0, 0.8)) / CUMULUS };
    });
    // Far ones first, so nearer ones draw over them.
    items.sort((a, b) => b.radius - a.radius);
    const cloud = new Float32Array(CUMULUS * 4), shape = new Float32Array(CUMULUS * 3);
    items.forEach((c, i) => {
      cloud.set([c.angle, c.radius, c.y, c.threshold], i * 4);
      shape.set([c.w * c.flip, c.h, c.cell], i * 3);
    });
    g.setAttribute('aCloud', new THREE.InstancedBufferAttribute(cloud, 4));
    g.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 3));
    g.instanceCount = CUMULUS;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    uniforms: { ...W, uMap: { value: atlas }, uSpin: CLOUD_SPIN, uCover: CLOUD_COVER },
    vertexShader: /* glsl */ `
      attribute vec4 aCloud;
      attribute vec3 aShape;
      uniform float uSpin, uCover;
      varying vec2 vUv;
      varying float vVis;
      varying vec3 vWorld;
      void main() {
        float a = aCloud.x + uSpin;
        vec3 c = vec3(cos(a) * aCloud.y, aCloud.z, sin(a) * aCloud.y);
        vVis = smoothstep(aCloud.w - 0.12, aCloud.w + 0.12, uCover);
        vec4 mv = viewMatrix * vec4(c, 1.0);
        vec2 size = aShape.xy * (0.7 + 0.3 * vVis);
        mv.xy += position.xy * size;
        vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vWorld = c + camR * position.x * size.x + camU * position.y * size.y;
        vec2 cell = vec2(mod(aShape.z, 2.0), 1.0 - floor(aShape.z / 2.0));
        vUv = (uv + cell) * 0.5;
        gl_Position = vVis < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uSunDisc;
      varying vec2 vUv;
      varying float vVis;
      varying vec3 vWorld;
      ${commonGLSL}
      void main() {
        vec4 t = texture2D(uMap, vUv);
        if (t.a < 0.004) discard;
        float light = clamp(t.r / t.a, 0.0, 1.0);
        vec3 dir = normalize(vWorld - cameraPosition);
        float up = fract(vUv.y * 2.0);
        float sw = sunward(dir);
        vec3 col = mix(uCloudShade, uCloudLit * mix(0.9, 1.12, sw), smoothstep(0.15, 0.95, light) * mix(0.72, 1.0, smoothstep(0.2, 0.7, up)));
        // The low sun's glow on its side, and silver linings on thin edges close to it.
        col += uGlow * uGlowAmount * pow(sw, 4.0) * 0.35 * light;
        float edge = 1.0 - smoothstep(0.05, 0.75, t.a);
        col += uSunColor * edge * pow(max(dot(dir, uSunDir), 0.0), 14.0) * 2.2 * uSunDisc;
        col += vec3(0.7, 0.76, 1.0) * uFlash * 1.1 * (0.4 + light);
        float dist = length(vWorld - cameraPosition);
        // Hazier the further off and the lower down (their feet melt into the sea of clouds).
        float low = 1.0 - smoothstep(-0.04, 0.05, dir.y);
        col = mix(col, hazeColor(dir), clamp(fogAmount(dist * 0.22) + 0.3 * low, 0.0, 0.92));
        float a = t.a * vVis;
        gl_FragColor = vec4(col * a, a);
      }
    `,
  }), [atlas]);
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-5} />;
}

/** How far round the island the wind has carried the cumulus (radians), and how many show (0..1). */
export const CLOUD_SPIN = { value: 0 };
export const CLOUD_COVER = { value: 0 };

// The sea of clouds: a polar grid round the island, its rings closer together near the middle.
const SEA_RINGS = 120;
const SEA_SEGMENTS = 144;
const SEA_RADIUS = 6500;

function seaGeometry() {
  const positions = new Float32Array((SEA_RINGS + 1) * SEA_SEGMENTS * 3);
  for (let j = 0; j <= SEA_RINGS; j++) {
    const r = j === 0 ? 0 : 4 * Math.pow(SEA_RADIUS / 4, (j - 1) / (SEA_RINGS - 1));
    for (let i = 0; i < SEA_SEGMENTS; i++) {
      const a = (i / SEA_SEGMENTS) * Math.PI * 2;
      positions.set([Math.cos(a) * r, 0, Math.sin(a) * r], (j * SEA_SEGMENTS + i) * 3);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < SEA_RINGS; j++) {
    for (let i = 0; i < SEA_SEGMENTS; i++) {
      const a = j * SEA_SEGMENTS + i, b = j * SEA_SEGMENTS + ((i + 1) % SEA_SEGMENTS);
      const c = a + SEA_SEGMENTS, d = b + SEA_SEGMENTS;
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

/**
 * The sea of clouds the island floats over: billows heaped up near it (flattening into the
 * distance), drifting with the wind, lit by the sun or the moon from above with the island's
 * shadow on it, melting into the haze at the horizon.
 */
export function CloudSea() {
  const geometry = useDisposable(seaGeometry);
  const material = useDisposable(() => shaderMaterial({
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      uniform sampler2D uNoise;
      uniform vec2 uSeaDrift;
      varying vec3 vWorld;
      float billows(vec2 q) { return textureLod(uNoise, q, 0.0).r * 0.7 + textureLod(uNoise, q * 3.0 + 0.3, 0.0).g * 0.3; }
      void main() {
        vec2 w = position.xz;
        float amp = 1.0 - smoothstep(300.0, 1500.0, length(w));
        float h = (billows((w + uSeaDrift) * 0.004) - 0.5) * 30.0 * amp;
        vWorld = vec3(w.x, ${SEA_Y.toFixed(1)} + h, w.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uSeaDrift;
      uniform float uSunDisc;
      varying vec3 vWorld;
      ${commonGLSL}
      float billows(vec2 q) { return texture2D(uNoise, q).r * 0.7 + texture2D(uNoise, q * 3.0 + 0.3).g * 0.3; }
      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / max(dist, 1e-3);
        vec2 q = (vWorld.xz + uSeaDrift) * 0.004;
        float amp = (1.0 - smoothstep(300.0, 1500.0, length(vWorld.xz))) * 30.0 + 8.0;
        float e = 0.003;
        float h0 = billows(q), hx = billows(q + vec2(e, 0.0)), hz = billows(q + vec2(0.0, e));
        // Smaller puffs on the billows, shading only (they fade with distance in the texture's mips).
        vec2 qp = q * 9.0 + uSeaDrift * 0.004;
        float p0 = texture2D(uNoise, qp).b, px = texture2D(uNoise, qp + vec2(e * 9.0, 0.0)).b, pz = texture2D(uNoise, qp + vec2(0.0, e * 9.0)).b;
        vec2 slope = vec2(hx - h0, hz - h0) / e * 0.004 * amp + vec2(px - p0, pz - p0) / (e * 9.0) * 0.036 * 2.4;
        vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
        float lit = clamp(dot(n, uKeyDir) * 0.65 + 0.35, 0.0, 1.0);
        float ao = smoothstep(0.2, 0.75, h0 * 0.7 + p0 * 0.3);
        vec3 col = mix(uCloudShade, uCloudLit, lit * mix(0.5, 1.0, ao));
        // Light through the thin tops towards the sun, and the low sun's glow on its side.
        float x = max(1.0 - dot(-v, uSunDir), 0.0);
        col += uSunColor * uSunDisc * (exp(-x * 40.0) * 0.45 + exp(-x * 8.0) * 0.1);
        col += uGlow * uGlowAmount * pow(sunward(-v), 4.0) * 0.25;
        // The island's shadow, cast down by the sun or the moon.
        if (uKeyDir.y > 0.05) {
          vec2 hit = vWorld.xz + uKeyDir.xz * ((-10.0 - vWorld.y) / uKeyDir.y);
          float sh = 1.0 - smoothstep(12.0, 23.0, length(hit));
          col *= 1.0 - sh * 0.4 * clamp(dot(uKeyColor, vec3(0.3)), 0.0, 1.0);
        }
        col += flashLight(n) * 0.6;
        float f = 1.0 - exp(-pow(dist * (0.0003 + uFogDensity * 0.5), 1.3));
        f = max(f, smoothstep(${(SEA_RADIUS * 0.45).toFixed(1)}, ${(SEA_RADIUS * 0.95).toFixed(1)}, length(vWorld.xz)));
        col = mix(col, hazeColor(-v), clamp(f, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// Lens flare ghosts along the line from the sun through the middle of the picture:
// [t along the line, size (NDC height), shape 0 disc / 1 ring / 2 hexagon / 3 starburst, r, g, b, alpha].
const GHOSTS = [
  [0.0, 0.34, 3, 1.0, 0.95, 0.85, 0.3],
  [0.32, 0.03, 0, 0.55, 0.95, 1.0, 0.14],
  [0.55, 0.06, 2, 0.6, 1.0, 0.85, 0.07],
  [0.78, 0.11, 1, 0.5, 0.8, 1.0, 0.06],
  [1.15, 0.045, 2, 1.0, 0.75, 0.6, 0.06],
];

/** Where the flare is (the sun in NDC) and how much it shows: the driver sets them. */
export const FLARE = { sun: new THREE.Vector2(), vis: { value: 0 }, aspect: { value: 16 / 9 } };

/** A gentle Vista-style lens flare from the sun, drawn before bloom so its core glows. */
export function SunFlare() {
  const geometry = useDisposable(() => {
    const g = quad(2, 2);
    const a = new Float32Array(GHOSTS.length * 3), c = new Float32Array(GHOSTS.length * 4);
    GHOSTS.forEach(([t, size, shape, r, gg, b, al], i) => { a.set([t, size, shape], i * 3); c.set([r, gg, b, al], i * 4); });
    g.setAttribute('aGhost', new THREE.InstancedBufferAttribute(a, 3));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(c, 4));
    g.instanceCount = GHOSTS.length;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uSun: { value: FLARE.sun }, uVis: FLARE.vis, uAspect: FLARE.aspect, uTime: W.uTime, uSunColor: W.uSunColor },
    vertexShader: /* glsl */ `
      attribute vec3 aGhost;
      attribute vec4 aColor;
      uniform vec2 uSun;
      uniform float uAspect, uVis;
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vShape;
      void main() {
        vec2 center = mix(uSun, -uSun, aGhost.x * 0.5);
        vec2 q = position.xy * aGhost.y;
        if (aGhost.z > 2.5) q.x *= 3.0;
        q.x /= uAspect;
        vUv = uv;
        vColor = aColor * vec4(1.0, 1.0, 1.0, uVis);
        vShape = aGhost.z;
        gl_Position = uVis < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(center + q, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunColor;
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vShape;
      float hexDist(vec2 p) { p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x); }
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float a = 0.0;
        if (vShape < 0.5) {
          a = exp(-dot(p, p) * 3.5);
        } else if (vShape < 1.5) {
          float r = length(p);
          float k = (r - 0.8) * 8.0;
          a = exp(-k * k) + 0.12 * exp(-r * r * 2.0);
        } else if (vShape < 2.5) {
          float h = hexDist(p);
          a = (1.0 - smoothstep(0.7, 0.85, h)) * (0.5 + 0.5 * smoothstep(0.3, 0.8, h));
        } else {
          vec2 s = vec2(p.x * 3.0, p.y);
          float r = length(s);
          float ang = atan(s.y, s.x + 1e-5);
          float rays = pow(abs(cos(ang * 3.0 + uTime * 0.03)), 30.0) * exp(-r * 2.4) * 0.5;
          float streak = exp(-abs(p.y) * 36.0) * exp(-abs(p.x) * 2.6);
          a = rays + streak * 0.7 + exp(-r * r * 5.0) * 0.3;
        }
        a *= vColor.a * 1.6;
        vec3 tint = mix(vec3(1.0), uSunColor / max(max(uSunColor.r, uSunColor.g), max(uSunColor.b, 1e-3)), 0.6);
        gl_FragColor = vec4(vColor.rgb * tint * a, 1.0);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={60} />;
}

/** The lightning bolt's brightness (0 between strokes): the driver sets it and places the bolt. */
export const BOLT = { value: 0 };

// A forked bolt, 1 unit tall from its foot (y 0) up, as a ribbon: [x, y] along the main channel and two branches.
function boltGeometry() {
  const rand = makeRandom(5);
  const strokes: [number, number][][] = [];
  const main: [number, number][] = [];
  let x = 0;
  for (let i = 0; i <= 16; i++) { main.push([x, 1 - i / 16]); x += rand.range(-0.05, 0.05); }
  strokes.push(main);
  for (const [from, dir] of [[4, 1], [8, -1]] as const) {
    const branch: [number, number][] = [];
    let [bx, by] = main[from];
    for (let i = 0; i <= 6; i++) { branch.push([bx, by]); bx += dir * rand.range(0.01, 0.045); by -= rand.range(0.03, 0.05); }
    strokes.push(branch);
  }
  const positions: number[] = [], across: number[] = [], index: number[] = [];
  for (const [s, stroke] of strokes.entries()) {
    const width = s === 0 ? 0.014 : 0.008;
    for (let i = 0; i < stroke.length; i++) {
      const [px, py] = stroke[i], [qx, qy] = stroke[Math.min(i + 1, stroke.length - 1)], [ox, oy] = stroke[Math.max(i - 1, 0)];
      let tx = qx - ox, ty = qy - oy;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len; ty /= len;
      const base = positions.length / 3;
      const taper = s === 0 ? 1 : 1 - (i / stroke.length) * 0.7;
      positions.push(px - ty * width * taper, py + tx * width * taper, 0, px + ty * width * taper, py - tx * width * taper, 0);
      across.push(-1, 1);
      if (i < stroke.length - 1) index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aAcross', new THREE.Float32BufferAttribute(across, 1));
  g.setIndex(index);
  return g;
}

/** A storm's lightning bolt, far off between the clouds and the sea of clouds, shown for each stroke. */
export function Bolt({ boltRef }: { boltRef: RefObject<THREE.Mesh | null> }) {
  const geometry = useDisposable(boltGeometry);
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uBolt: BOLT },
    vertexShader: /* glsl */ `
      attribute float aAcross;
      varying float vAcross;
      void main() { vAcross = aAcross; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBolt;
      varying float vAcross;
      void main() {
        float core = 1.0 - smoothstep(0.0, 1.0, abs(vAcross));
        gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * (core * core * 14.0 + core * 2.0) * uBolt, 1.0);
      }
    `,
  }));
  return <mesh ref={boltRef} geometry={geometry} material={material} frustumCulled={false} visible={false} renderOrder={-4} />;
}
