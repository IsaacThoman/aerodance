import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { hash, shaderMaterial } from '../shared/glsl.ts';
import { noiseTexture, palette } from '../polar/world.ts';
import { CABIN, cabinPoint } from './layout.ts';
import { haze, panes, snowcabin } from './palette.ts';
import { patchScenery } from './materials.ts';
import { merge } from './geometry.ts';
import { FLUE, cabinIcicles, cabinSnow, cabinTimber, glassGeometry } from './cabinShape.ts';

/**
 * The glass gable: a warm room behind the panes, traced per pixel through the A-frame's own
 * shape (floor, sloping walls, back wall with its hearth, the loft and its railing, an armchair
 * and a little tree), so it shifts with real depth as the camera moves. A cool sheen of sky and
 * a glossy streak lie over it, and the timber glazing bars over that.
 */
function glassMaterial() {
  return shaderMaterial({
    uniforms: { uTime: snowcabin.uTime, uNoise: snowcabin.uNoise, uFire: snowcabin.uFire, uBeat: snowcabin.uBeat },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vCamera;
      varying vec3 vWorld;
      void main() {
        vLocal = position;
        vCamera = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uFire, uBeat;
      varying vec3 vLocal;
      varying vec3 vCamera;
      varying vec3 vWorld;
      ${hash}
      ${noiseTexture}
      ${palette}
      ${panes}
      ${haze}
      const float ROOM = ${(CABIN.depth - 0.4).toFixed(2)};
      const float LOFT = CABIN_FLOOR + 5.1;
      const float LOFT_EDGE = -4.3;
      const vec3 FIRE = vec3(0.0, CABIN_FLOOR + 0.5, -ROOM + 0.45);
      const vec3 LAMP = vec3(0.0, CABIN_FLOOR + 3.9, -1.9);
      const vec3 GLOW = vec3(1.0, 0.55, 0.22);

      // Where a ray from inside the glass meets a sloping wall (side -1 left, 1 right).
      float slope(vec3 ro, vec3 rd, float side) {
        float b = CABIN_HALF / CABIN_HEIGHT;
        float rate = -side * rd.x - b * rd.y;
        if (rate >= -1e-4) return 1e5;
        return -(CABIN_HALF - side * ro.x - b * (ro.y - CABIN_FLOOR)) / rate;
      }

      float plank(float x, float width) {
        float i = floor(x / width);
        return (0.86 + 0.14 * hash11(i * 7.13)) * (1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.06, fract(x / width)) ));
      }

      vec3 lit(vec3 p, vec3 n) {
        vec3 f = FIRE - p;
        vec3 l = LAMP - p;
        float fire = (max(dot(n, normalize(f)), 0.0) * 0.7 + 0.3) * 5.0 / (1.0 + dot(f, f) * 0.12) * uFire;
        float lamp = (max(dot(n, normalize(l)), 0.0) * 0.7 + 0.3) * 3.2 / (1.0 + dot(l, l) * 0.16);
        return GLOW * (fire + lamp) + vec3(0.1, 0.06, 0.035);
      }

      vec3 interior(vec3 ro, vec3 rd) {
        float t = (-ROOM - ro.z) / rd.z;
        float kind = 1.0;
        vec3 n = vec3(0.0, 0.0, 1.0);
        if (rd.y < 0.0) {
          float tf = (CABIN_FLOOR - ro.y) / rd.y;
          if (tf < t) { t = tf; kind = 2.0; n = vec3(0.0, 1.0, 0.0); }
        }
        float tl = slope(ro, rd, -1.0);
        if (tl < t) { t = tl; kind = 3.0; n = normalize(vec3(CABIN_HEIGHT, -CABIN_HALF, 0.0)); }
        float tr = slope(ro, rd, 1.0);
        if (tr < t) { t = tr; kind = 3.0; n = normalize(vec3(-CABIN_HEIGHT, -CABIN_HALF, 0.0)); }
        if (abs(rd.y) > 1e-4) {
          float tf = (LOFT - ro.y) / rd.y;
          if (tf > 0.0 && tf < t && ro.z + rd.z * tf < LOFT_EDGE) { t = tf; kind = 4.0; n = vec3(0.0, -sign(rd.y), 0.0); }
        }
        // The loft's edge beam and railing.
        float te = (LOFT_EDGE - ro.z) / rd.z;
        if (te > 0.0 && te < t) {
          vec3 p = ro + rd * te;
          float y = p.y - LOFT;
          float rail = step(-0.4, y) * step(y, 0.0) + step(0.0, y) * step(y, 1.0) * max(step(abs(fract(p.x * 2.4) - 0.5), 0.12), step(0.88, y));
          if (rail > 0.0) { t = te; kind = 5.0; }
        }
        // An armchair facing the hearth, and a little tree in the corner.
        float tc = (-6.2 - ro.z) / rd.z;
        if (tc > 0.0 && tc < t) {
          vec3 p = ro + rd * tc;
          vec2 c = vec2(abs(p.x + 2.0) - 0.75, p.y - CABIN_FLOOR - 0.6);
          if (length(max(c, 0.0)) < 0.3 && p.y > CABIN_FLOOR) { t = tc; kind = 6.0; }
        }
        float tt = (-7.0 - ro.z) / rd.z;
        if (tt > 0.0 && tt < t) {
          vec3 p = ro + rd * tt;
          float y = (p.y - CABIN_FLOOR) / 2.9;
          float w = 1.0 * (1.0 - y) * (0.72 + 0.28 * fract(y * 4.0));
          if (y > 0.04 && y < 1.0 && abs(p.x - 2.7) < w) { t = tt; kind = 7.0; }
        }
        vec3 p = ro + rd * t;
        vec3 col;
        vec3 emit = vec3(0.0);
        if (kind < 1.5) {
          // Back wall: planks, a stone chimney breast with the fire in it, a little round window.
          col = vec3(0.5, 0.3, 0.16) * plank(p.y, 0.32);
          float breast = 1.0 - smoothstep(1.15, 1.2, abs(p.x));
          vec2 block = vec2(p.x * 2.2 + floor(p.y * 3.0) * 0.5, p.y * 3.0);
          float stone = 0.8 + 0.2 * hash12(floor(block));
          col = mix(col, vec3(0.42, 0.4, 0.4) * stone * (1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.08, min(fract(block.x), fract(block.y))))), breast);
          float y = p.y - CABIN_FLOOR;
          col = mix(col, vec3(0.2, 0.1, 0.05), (1.0 - smoothstep(1.4, 1.45, abs(p.x))) * step(1.18, y) * step(y, 1.32));
          if (abs(p.x) < 0.72 && y < 1.0) {
            float flame = noise4(vec2(p.x * 3.0, y * 2.5 - uTime * 1.8)).r * 0.5 + 0.5;
            float shape = smoothstep(0.0, 0.5, (1.0 - y) * (0.9 - abs(p.x)) * 1.6 + flame * 0.5 - 0.35);
            emit = mix(vec3(1.4, 0.35, 0.06), vec3(4.0, 2.2, 0.8), shape * shape) * shape * uFire + vec3(0.12, 0.03, 0.01);
            col = vec3(0.0);
          }
          float win = length(vec2(p.x, y - 7.2));
          if (win < 0.55) { col = vec3(0.0); emit = mix(vec3(0.02, 0.06, 0.12), vec3(0.05, 0.25, 0.2), smoothstep(0.5, -0.3, y - 7.2)); }
        } else if (kind < 2.5) {
          // Floorboards and a rug in front of the hearth.
          col = vec3(0.46, 0.27, 0.14) * plank(p.x, 0.28);
          vec2 r = (p.xz - vec2(0.0, -5.6)) / vec2(2.1, 1.5);
          float rug = 1.0 - smoothstep(0.96, 1.0, length(r));
          float border = smoothstep(0.7, 0.75, length(r)) * (1.0 - smoothstep(0.85, 0.9, length(r)));
          col = mix(col, mix(vec3(0.06, 0.36, 0.4), vec3(0.85, 0.75, 0.55), border), rug);
        } else if (kind < 3.5) {
          col = vec3(0.55, 0.34, 0.18) * plank(p.y * 1.16, 0.3);
        } else if (kind < 4.5) {
          col = vec3(0.32, 0.18, 0.09) * (0.75 + 0.25 * step(0.2, fract(p.x * 1.2)));
        } else if (kind < 5.5) {
          col = vec3(0.16, 0.08, 0.04);
        } else if (kind < 6.5) {
          col = vec3(0.45, 0.08, 0.1);
        } else {
          // Dark boughs strung with coloured lights, a star on top.
          col = vec3(0.02, 0.12, 0.07);
          vec2 g = vec2(p.x * 4.0, p.y * 4.0);
          vec2 id = floor(g);
          float h = hash12(id);
          float bulb = smoothstep(0.32, 0.12, length(fract(g) - 0.5)) * step(0.55, h);
          vec3 tint = h > 0.85 ? vec3(1.0, 0.3, 0.35) : h > 0.7 ? vec3(0.3, 0.9, 1.0) : vec3(1.0, 0.75, 0.3);
          emit = tint * bulb * (2.0 + 1.5 * sin(uTime * 2.0 + h * 40.0)) * (1.0 + uBeat * 0.5);
          emit += vec3(3.0, 2.4, 1.0) * smoothstep(0.2, 0.0, length(p.xy - vec2(2.7, CABIN_FLOOR + 2.95)));
        }
        col = col * lit(p, n) + emit;
        // The pendant lamp's glow, where the ray passes it.
        float tc2 = dot(LAMP - ro, rd);
        if (tc2 > 0.0 && tc2 < t) {
          vec3 d = ro + rd * tc2 - LAMP;
          float d2 = dot(d, d);
          col += vec3(1.0, 0.7, 0.4) * (exp(-d2 / 0.03) * 5.0 + exp(-d2 / 0.6) * 0.5);
        }
        return col;
      }

      void main() {
        vec3 ro = vLocal;
        vec3 v = normalize(vCamera - vLocal);
        vec3 rd = -v;
        rd.z = min(rd.z, -0.02);
        rd = normalize(rd);
        float aa = length(fwidth(vLocal.xy)) * 0.7;
        float pane = paneMask(vLocal.xy, aa);
        vec3 inside = interior(ro, rd) * 0.9;
        // A cool reflection of the sky, stronger at a glance, and a glossy streak across the glass.
        float fres = 0.05 + 0.95 * pow(1.0 - max(v.z, 0.0), 5.0);
        vec3 r = reflect(-v, vec3(0.0, 0.0, 1.0));
        vec3 sky = mix(vec3(0.03, 0.16, 0.18), vec3(0.01, 0.03, 0.09), smoothstep(0.0, 0.6, r.y));
        float streak = smoothstep(0.7, 0.0, abs(vLocal.x * 0.55 + vLocal.y - 7.2 + v.x * 3.0)) * 0.12 + smoothstep(0.25, 0.0, abs(vLocal.x * 0.55 + vLocal.y - 8.4 + v.x * 3.0)) * 0.08;
        vec3 glass = inside * (1.0 - fres) + sky * fres + vec3(0.7, 0.85, 1.0) * streak;
        // Glazing bars: timber, warm where the room lights their inner edges.
        vec3 frame = vec3(0.16, 0.09, 0.045) + vec3(0.25, 0.12, 0.05) * smoothstep(0.0, 6.0, 10.0 - vLocal.y) * 0.4;
        vec3 col = mix(frame, glass, pane);
        gl_FragColor = vec4(fieldHaze(col, vWorld), 1.0);
      }
    `,
  });
}

/** Smoke from the stovepipe: a soft, slowly churning plume leaning away on the breeze. */
function smokeMaterial(flue: THREE.Vector3) {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: snowcabin.uTime, uNoise: snowcabin.uNoise, uFlue: { value: flue } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uFlue;
      varying vec2 vUv;
      void main() {
        float h = position.y;
        vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
        vec3 p = uFlue + vec3(h * h * 6.5 + sin(uTime * 0.3 + h * 4.0) * 0.5 * h, h * 15.0, h * h * 2.0);
        p += right * position.x * (1.0 + 5.5 * h);
        vUv = vec2(position.x + 0.5, h);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      ${noiseTexture}
      void main() {
        float h = vUv.y;
        float x = vUv.x - 0.5;
        vec4 n = noise4(vec2(x * 2.2, h * 4.0 - uTime * 0.16));
        vec4 m = noise4(vec2(x * 5.0 + 9.0, h * 9.0 - uTime * 0.3));
        float body = exp(-x * x * 14.0);
        float wisps = smoothstep(-0.35, 0.7, n.r * 0.75 + m.g * 0.4 + 0.15);
        float a = body * wisps * smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.35, 1.0, h)) * 0.5;
        if (a < 0.003) discard;
        vec3 col = mix(vec3(0.3, 0.33, 0.42), vec3(0.42, 0.5, 0.62), h) + vec3(0.3, 0.14, 0.05) * (1.0 - smoothstep(0.0, 0.12, h));
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}

/** The glass A-frame: timber, snow load, icicles, the glowing gable and the stovepipe's smoke. */
export function Cabin() {
  const timber = useDisposable(() => merge(cabinTimber()));
  const snow = useDisposable(() => merge(cabinSnow()));
  const ice = useDisposable(() => merge(cabinIcicles()));
  const glass = useDisposable(glassGeometry);
  const plume = useDisposable(() => new THREE.PlaneGeometry(1, 1, 1, 12).translate(0, 0.5, 0));
  const materials = useDisposable(() => ({
    timber: patchScenery(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.18 }), { key: 'timber', ibl: 0.35 }),
    snow: patchScenery(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide }), { key: 'snow', ibl: 0.55, sparkle: 0.25 }),
    ice: patchScenery(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.06, clearcoat: 1, emissive: '#3a9ad0', emissiveIntensity: 0.18 }), { key: 'ice', ibl: 1.2 }),
    glass: glassMaterial(),
    smoke: smokeMaterial(new THREE.Vector3(...cabinPoint(...FLUE))),
  }));
  return (
    <>
      <group position={[CABIN.x, 0, CABIN.z]} rotation={[0, CABIN.heading, 0]}>
        <mesh geometry={timber} material={materials.timber} />
        <mesh geometry={snow} material={materials.snow} />
        <mesh geometry={ice} material={materials.ice} />
        <mesh geometry={glass} material={materials.glass} />
      </group>
      {/* The plume places itself in world space; it blends before the glass dancers, which write no depth. */}
      <mesh geometry={plume} material={materials.smoke} frustumCulled={false} renderOrder={-30} />
    </>
  );
}
