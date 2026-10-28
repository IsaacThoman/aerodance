import { useRef } from 'react';
import * as THREE from 'three';
import type { Vec2, Vec3 } from '../../stages/catalog.ts';
import { ASPECT, useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { fx, skyGLSL, SUN_DIR } from './fx.ts';

/** The deep blue dome with the sun over the turbines; follows the camera. */
export function BlissSky() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { ...fx },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        ${skyGLSL}
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyGradient(d) + sunHalo(d);
          // Soft rays fanning out of the sun, turning slowly.
          vec3 right = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
          vec3 up = cross(right, uSunDir);
          vec2 q = vec2(dot(d, right), dot(d, up));
          float ang = atan(q.y, q.x);
          float rays = 0.5 + 0.5 * sin(ang * 9.0 + uTime * 0.02) * sin(ang * 5.0 - uTime * 0.013 + 1.7);
          float s = max(dot(d, uSunDir), 0.0);
          col += uGlow * rays * pow(s, 18.0) * 0.12;
          col = mix(col, hazeColor(d), 1.0 - smoothstep(-0.02, 0.0, d.y));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  useBackdropFrame((state) => mesh.current?.position.copy(state.camera.position));
  return (
    // Drawn after the opaque land at the far plane, so only the pixels the land leaves are shaded.
    <mesh ref={mesh} material={material} renderOrder={10} frustumCulled={false}>
      <sphereGeometry args={[1000, 48, 24]} />
    </mesh>
  );
}

export interface CumulusProps {
  /** A cloud atlas (makeCloudAtlas), shared between layers. */
  atlas: THREE.Texture;
  count: number;
  /** Centre of the box the clouds live in. */
  center: Vec3;
  /** [width along x, depth along z]. */
  area: Vec2;
  heightJitter: number;
  /** [min, max] billboard width. */
  size: Vec2;
  /** Drift along +x, world units per second. */
  speed: number;
  seed: number;
  renderOrder?: number;
}

/**
 * Big puffy cumulus billboards drifting along +x and wrapping out of sight, lit white on top,
 * soft blue underneath, with a silver lining on the thin edges near the sun.
 */
export function Cumulus({ atlas, count, center, area, heightJitter, size, speed, seed, renderOrder = -500 }: CumulusProps) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed * 13 + 1);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const items = [];
    for (let i = 0; i < count; i++) {
      items.push({
        x: center[0] + ((i + rand.range(0.1, 0.9)) / count - 0.5) * area[0],
        y: center[1] + rand.range(-1, 1) * heightJitter,
        z: center[2] + rand.range(-0.5, 0.5) * area[1],
        s: rand.range(size[0], size[1]),
        cell: rand.int(0, 3),
        flip: rand.sign(),
      });
    }
    // Far to near, so nearer clouds draw over farther ones.
    items.sort((a, b) => a.z - b.z);
    const offsets = new Float32Array(count * 3);
    const scales = new Float32Array(count * 2);
    const cells = new Float32Array(count);
    items.forEach((it, i) => {
      offsets.set([it.x, it.y, it.z], i * 3);
      scales.set([it.s * it.flip, it.s * 0.78], i * 2);
      cells[i] = it.cell;
    });
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    g.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 2));
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 1));
    g.instanceCount = count;
    return g;
  }, [count, seed]);

  const material = useDisposable(
    () =>
      shaderMaterial({
        transparent: true,
        depthWrite: false,
        premultipliedAlpha: true,
        uniforms: {
          ...fx,
          uMap: { value: atlas },
          uSpeed: { value: speed },
          uMinX: { value: center[0] - area[0] / 2 },
          uWidth: { value: area[0] },
          uLit: { value: new THREE.Color('#ffffff').multiplyScalar(1.12) },
          uShade: { value: new THREE.Color('#98b8e8') },
        },
        vertexShader: /* glsl */ `
          attribute vec3 aOffset;
          attribute vec2 aScale;
          attribute float aCell;
          uniform float uTime, uSpeed, uMinX, uWidth;
          varying vec2 vUv;
          varying float vFade;
          varying vec3 vWorld;
          void main() {
            vec3 c = aOffset;
            float x = mod(c.x - uMinX + uTime * uSpeed, uWidth);
            c.x = uMinX + x;
            vFade = smoothstep(0.0, 0.08, x / uWidth) * (1.0 - smoothstep(0.92, 1.0, x / uWidth));
            vec4 mv = modelViewMatrix * vec4(c, 1.0);
            mv.xy += position.xy * aScale;
            vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
            vWorld = c + camR * position.x * aScale.x + camU * position.y * aScale.y;
            gl_Position = projectionMatrix * mv;
            // Canvas rows run top-down; texture v runs bottom-up.
            vec2 cell = vec2(mod(aCell, 2.0), 1.0 - floor(aCell / 2.0));
            vUv = (uv + cell) * 0.5;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          uniform vec3 uLit, uShade;
          ${skyGLSL}
          varying vec2 vUv;
          varying float vFade;
          varying vec3 vWorld;
          void main() {
            vec4 t = texture2D(uMap, vUv);
            if (t.a < 0.004) discard;
            float light = clamp(t.r / t.a, 0.0, 1.0);
            vec3 dir = normalize(vWorld - cameraPosition);
            vec3 col = mix(uShade, uLit, smoothstep(0.2, 0.95, light));
            // Volume: sunlit domes on top, soft blue shade gathering towards the flat base.
            float up = fract(vUv.y * 2.0);
            col *= mix(0.8, 1.1, smoothstep(0.22, 0.7, up));
            // Warmer and brighter on the sun's side of the sky.
            float sw = sunward(dir);
            col *= mix(0.94, 1.08, sw);
            // Silver lining on thin edges close to the sun.
            float edge = 1.0 - smoothstep(0.05, 0.75, t.a);
            float near = pow(max(dot(dir, uSunDir), 0.0), 18.0);
            col += uSunColor * edge * near * 2.4;
            // Melt into the haze near the horizon.
            col = mix(col, hazeColor(dir), 0.55 * (1.0 - smoothstep(0.0, 0.1, dir.y)));
            float a = t.a * vFade;
            gl_FragColor = vec4(col * a, a);
          }
        `,
      }),
    [atlas],
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={renderOrder} />;
}

// Ghosts along the line from the sun through the screen centre:
// [t along the line, size (NDC height), shape, r, g, b, alpha]; shape 0 disc, 1 ring, 2 hexagon, 3 starburst.
const GHOSTS = [
  [0.0, 0.3, 3, 1.0, 0.96, 0.86, 0.32],
  [0.36, 0.022, 0, 0.5, 0.95, 1.0, 0.16],
  [0.56, 0.04, 2, 0.6, 1.0, 0.85, 0.07],
];

/** A gentle Vista-style lens flare from the sun, drawn before bloom so its core glows. */
export function SunFlare() {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    const a = new Float32Array(GHOSTS.length * 3);
    const c = new Float32Array(GHOSTS.length * 4);
    GHOSTS.forEach(([t, size, shape, r, gg, b, al], i) => {
      a.set([t, size, shape], i * 3);
      c.set([r, gg, b, al], i * 4);
    });
    g.setAttribute('aGhost', new THREE.InstancedBufferAttribute(a, 3));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(c, 4));
    g.instanceCount = GHOSTS.length;
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSun: { value: new THREE.Vector2() },
        uVis: { value: 0 },
        uAspect: { value: ASPECT },
        uTime: fx.uTime,
      },
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
          gl_Position = vec4(center + q, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vShape;
        float hexDist(vec2 p) {
          p = abs(p);
          return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x);
        }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float a = 0.0;
          if (vShape < 0.5) {
            a = exp(-dot(p, p) * 3.5);
          } else if (vShape < 1.5) {
            float r = length(p);
            a = exp(-pow((r - 0.8) * 8.0, 2.0)) + 0.12 * exp(-r * r * 2.0);
          } else if (vShape < 2.5) {
            float h = hexDist(p);
            a = (1.0 - smoothstep(0.7, 0.85, h)) * (0.5 + 0.5 * smoothstep(0.3, 0.8, h));
          } else {
            vec2 s = vec2(p.x * 3.0, p.y);
            float r = length(s);
            float ang = atan(s.y, s.x);
            float rays = pow(abs(cos(ang * 3.0 + uTime * 0.03)), 30.0) * exp(-r * 2.4) * 0.5;
            float streak = exp(-abs(p.y) * 36.0) * exp(-abs(p.x) * 2.6);
            a = rays + streak * 0.7 + exp(-r * r * 5.0) * 0.3;
          }
          a *= vColor.a * 1.6;
          gl_FragColor = vec4(vColor.rgb * a, 1.0);
        }
      `,
    }),
  );
  const v = useRef(new THREE.Vector3());
  useBackdropFrame((state) => {
    const cam = state.camera;
    v.current.copy(SUN_DIR).multiplyScalar(500).add(cam.position).project(cam);
    const u = material.uniforms;
    u.uSun.value.set(v.current.x, v.current.y);
    if (cam instanceof THREE.PerspectiveCamera) u.uAspect.value = cam.aspect;
    const edge = Math.max(Math.abs(v.current.x), Math.abs(v.current.y));
    u.uVis.value = v.current.z < 1 ? THREE.MathUtils.clamp((1.25 - edge) / 0.45, 0, 1) : 0;
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={50} />;
}
