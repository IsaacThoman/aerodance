import { useLayoutEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { noise, shaderMaterial } from '../../stages/shared/glsl.ts';
import { RENDER_HEIGHT, RENDER_WIDTH } from '../../stages/shared/post.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { NEBULA_BAKE, bakeCube, makeCubeTarget } from './bake.ts';
import { SUN_SIZE, frameDirection, world } from './layout.ts';

/** How far out the sky and stars are drawn, following the camera. */
const SKY_RADIUS = 1500;

/** How much wider than tall a buffer pixel shows: the 4:3 buffer is stretched to the canvas. */
export function useStretch(): number {
  const size = useThree((s) => s.size);
  return size.width / Math.max(1, size.height) / (RENDER_WIDTH / RENDER_HEIGHT);
}

/**
 * Deep navy space brightening towards the planet, a faint cyan, violet and rose nebula gathered in
 * a band from the top left down towards the sunrise, and the sun's disc, which the planet's limb
 * cuts as it crests.
 */
export function SpaceSky() {
  const gl = useThree((s) => s.gl);
  const mesh = useRef<THREE.Mesh>(null);
  const nebula = useDisposable(() => makeCubeTarget(256));
  useLayoutEffect(() => {
    const band = new THREE.Vector3().crossVectors(frameDirection(0.02, 0.05), frameDirection(0.75, 0.22)).normalize();
    bakeCube(gl, nebula, NEBULA_BAKE, { uBand: { value: band } });
  }, [gl, nebula]);

  const material = useDisposable(
    () =>
      shaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { ...world, uNebula: { value: nebula.texture } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uCenter, uSunDir;
          uniform samplerCube uNebula;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float k = dot(d, normalize(uCenter - cameraPosition));
            vec3 col = mix(vec3(0.0012, 0.0026, 0.011), vec3(0.006, 0.022, 0.075), smoothstep(0.25, 0.85, k));
            col += textureCube(uNebula, d).rgb * 0.085;
            // The sun: a hard bright disc in a soft glow (the angle off it, precise when small).
            float ang = dot(d, uSunDir) > 0.0 ? length(cross(d, uSunDir)) : 2.0;
            float px = max(fwidth(ang), 1e-5);
            float disc = 1.0 - smoothstep(${SUN_SIZE.toFixed(4)} - px, ${SUN_SIZE.toFixed(4)} + px, ang);
            col += vec3(1.0, 0.94, 0.84) * (disc * 25.0 + exp(-ang / 0.02) * 0.2 + exp(-ang / 0.1) * 0.02);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    [nebula],
  );

  useBackdropFrame((state) => mesh.current?.position.copy(state.camera.position));

  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[SKY_RADIUS, 48, 24]} />
    </mesh>
  );
}

export interface StarsProps {
  count?: number;
  seed?: number;
}

/**
 * Stars as soft round points (never single flickering pixels), scattered over the part of the sky
 * the camera sees, a few big enough to wear a four-point sparkle, all twinkling slowly.
 */
export function Stars({ count = 420, seed = 11 }: StarsProps) {
  const points = useRef<THREE.Points>(null);
  const stretch = useStretch();
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const forward = new THREE.Vector3(-0.15, 0.2, -1).normalize();
    const basis = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), forward);
    const p = new THREE.Vector3();
    const tints = [new THREE.Color('#ffffff'), new THREE.Color('#cfe6ff'), new THREE.Color('#9fd4ff'), new THREE.Color('#ffe9c8')];
    for (let i = 0; i < count; i++) {
      // Uniform over a cone a little wider than the view.
      const cos = 1 - rand.next() * (1 - Math.cos(THREE.MathUtils.degToRad(64)));
      const sin = Math.sqrt(1 - cos * cos);
      const a = rand.range(0, Math.PI * 2);
      p.set(Math.cos(a) * sin, Math.sin(a) * sin, -cos).applyQuaternion(basis).multiplyScalar(SKY_RADIUS * 0.9);
      positions.set([p.x, p.y, p.z], i * 3);
      const big = rand.next() ** 7;
      sizes[i] = 2.6 + big * 13;
      const tint = rand.pick(tints);
      const brightness = 0.35 + rand.next() ** 2.5 * 1.2 + big * 2.5;
      colors.set([tint.r * brightness, tint.g * brightness, tint.b * brightness], i * 3);
      phases[i] = rand.next();
    }
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    return g;
  }, [count, seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: world.uTime, uStretch: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize, aPhase;
        attribute vec3 aColor;
        uniform float uTime;
        varying vec3 vColor;
        varying float vSpark;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          float twinkle = 0.78 + 0.22 * sin(uTime * (0.35 + aPhase * 0.9) + aPhase * 40.0);
          vColor = aColor * twinkle;
          vSpark = smoothstep(5.0, 12.0, aSize);
          gl_PointSize = aSize;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStretch;
        varying vec3 vColor;
        varying float vSpark;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          p.x *= uStretch;
          float core = exp(-dot(p, p) * mix(5.0, 40.0, vSpark));
          float spark = (exp(-abs(p.x) * 26.0) * (1.0 - abs(p.y)) + exp(-abs(p.y) * 26.0) * (1.0 - abs(p.x))) * vSpark;
          float a = core + spark * 0.55 + exp(-dot(p, p) * 9.0) * 0.12 * vSpark;
          gl_FragColor = vec4(vColor * a, 1.0);
        }
      `,
    }),
  );
  material.uniforms.uStretch.value = stretch;

  useBackdropFrame((state) => points.current?.position.copy(state.camera.position));

  return <points ref={points} geometry={geometry} material={material} renderOrder={-900} frustumCulled={false} />;
}

const MOON_DIRECTION = frameDirection(0.1, 0.13);
const MOON_DISTANCE = 1000;
const MOON_RADIUS = 26;

/**
 * A small crescent Moon up in the top left, lit from the right by the sunrise: ray-traced on a
 * camera-facing quad, so its edge stays smooth, with soft maria and an icy blue rim.
 */
export function Moon() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      uniforms: { uSunDir: world.uSunDir, uRadius: { value: MOON_RADIUS } },
      vertexShader: /* glsl */ `
        uniform float uRadius;
        varying vec3 vView;
        varying vec3 vCenter;
        void main() {
          vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec4 mv = c + vec4(position.xy * uRadius * 3.0, 0.0, 0.0);
          vView = mv.xyz;
          vCenter = c.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform float uRadius;
        varying vec3 vView;
        varying vec3 vCenter;
        ${noise}
        void main() {
          vec3 rd = normalize(vView);
          float tca = dot(vCenter, rd);
          float b = length(vCenter - rd * tca);
          float px = max(fwidth(b), 1e-4);
          float cover = 1.0 - smoothstep(uRadius - px, uRadius + px, b);
          float th = sqrt(max(uRadius * uRadius - b * b, 0.0));
          vec3 n = normalize(rd * (tca - th) - vCenter);
          vec3 wn = transpose(mat3(viewMatrix)) * n;
          vec3 l = normalize(mat3(viewMatrix) * uSunDir);
          float maria = smoothstep(-0.05, 0.3, fbm(wn * 1.7 + 3.0));
          float mottle = fbm(wn * 6.0 + 9.0);
          vec3 albedo = mix(vec3(0.8, 0.84, 0.9), vec3(0.4, 0.45, 0.55), maria * 0.7) * (0.92 + 0.16 * mottle);
          float ndl = dot(n, l);
          float lit = smoothstep(-0.04, 0.22, ndl);
          float mu = max(dot(n, -rd), 0.0);
          // The dark side is faintly lit by the planet below it.
          vec3 col = albedo * (lit * 2.2 + vec3(0.025, 0.04, 0.08)) + vec3(0.25, 0.55, 1.0) * pow(1.0 - mu, 3.0) * (0.1 + lit * 0.4);
          float halo = exp(-max(b - uRadius, 0.0) / (uRadius * 0.18)) * (1.0 - smoothstep(1.25, 1.48, b / uRadius)) * (1.0 - cover);
          gl_FragColor = vec4(col * cover + vec3(0.1, 0.18, 0.32) * halo * 0.2, cover);
        }
      `,
    }),
  );

  // Rides with the camera like the stars: it's too far away to shift.
  useBackdropFrame((state) => mesh.current?.position.copy(MOON_DIRECTION).multiplyScalar(MOON_DISTANCE).add(state.camera.position));

  return (
    <mesh ref={mesh} material={material} renderOrder={-800} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}
