import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { makeRandom } from '../shared/random.ts';
import { polar } from './world.ts';

const buffer = new THREE.Vector2();

export interface SnowfallProps {
  /** How many flakes. */
  count?: number;
  /** The middle of the box they fall through, and its size: they wrap from its floor to its top. */
  center?: Vec3;
  size?: Vec3;
  /** Flake diameter in world units (each varies from half to one and a half times this). */
  flake?: number;
  /** Fall speed, units a second. */
  speed?: number;
  /** Sideways drift with the breeze, units a second (x, z). */
  wind?: readonly [x: number, z: number];
  /** Linear colour times brightness; above the bloom threshold, the nearest flakes glow. */
  color?: THREE.ColorRepresentation;
  intensity?: number;
  /** Flakes fade out this far from the camera, so the box's far edge never shows. */
  fade?: number;
  seed?: number;
  renderOrder?: number;
}

/**
 * Falling snow: soft round points drifting down through a box and wrapping round, tumbling a
 * little on the way. One draw, all of it moved in the vertex shader by the polar clock.
 */
export function Snowfall({
  count = 1400,
  center = [0, 6, -4],
  size = [44, 14, 40],
  flake = 0.07,
  speed = 0.8,
  wind = [0.25, 0.1],
  color = '#dcecff',
  intensity = 1.4,
  fade = 45,
  seed = 7,
  renderOrder = 50,
}: SnowfallProps) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const base = new Float32Array(count * 3);
    const look = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      base.set([rand.range(-0.5, 0.5), rand.next(), rand.range(-0.5, 0.5)], i * 3);
      look.set([rand.range(0.5, 1.5), rand.range(0.7, 1.3), rand.range(0, 100), rand.next()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aLook', new THREE.BufferAttribute(look, 4));
    return g;
  }, [count, seed]);
  const material = useDisposable(
    () =>
      shaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: polar.uTime,
          uCenter: { value: new THREE.Vector3(...center) },
          uSize: { value: new THREE.Vector3(...size) },
          uFlake: { value: flake },
          uSpeed: { value: speed },
          uWind: { value: new THREE.Vector2(...wind) },
          uColor: { value: new THREE.Color(color).multiplyScalar(intensity) },
          uFade: { value: fade },
          uScale: { value: 1 },
          uPixelAspect: { value: 1 },
        },
        vertexShader: /* glsl */ `
          attribute vec4 aLook;
          uniform float uTime, uFlake, uSpeed, uFade, uScale;
          uniform vec3 uCenter, uSize;
          uniform vec2 uWind;
          varying float vAlpha;
          void main() {
            float t = uTime;
            float ph = aLook.z;
            // Down through the box and round again, each flake at its own pace, drifting with the
            // breeze and tumbling side to side.
            float fall = t * uSpeed * aLook.y;
            vec3 p = position * uSize;
            p.y = fract(position.y - fall / uSize.y) * uSize.y - uSize.y * 0.5;
            p.xz += uWind * t * aLook.y;
            p.x += sin(t * 0.9 * aLook.y + ph) * 0.25 + sin(t * 2.3 + ph * 1.7) * 0.06;
            p.z += cos(t * 0.7 * aLook.y + ph * 1.3) * 0.25;
            p.xz = mod(p.xz + uSize.xz * 0.5, uSize.xz) - uSize.xz * 0.5;
            p += uCenter;
            vec4 mv = viewMatrix * vec4(p, 1.0);
            float dist = -mv.z;
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp(uFlake * aLook.x * uScale / max(dist, 0.1), 1.0, 24.0);
            // Fades in and out at the top and bottom of the box and with distance, and behind the camera.
            float edge = smoothstep(0.0, 0.08, fract(position.y - fall / uSize.y)) * smoothstep(1.0, 0.9, fract(position.y - fall / uSize.y));
            vAlpha = edge * (1.0 - smoothstep(uFade * 0.6, uFade, dist)) * step(0.2, dist) * (0.55 + 0.45 * aLook.w);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uPixelAspect;
          varying float vAlpha;
          void main() {
            // The buffer's pixels are shown wider than tall; squeeze the dot back to round.
            vec2 d = (gl_PointCoord - 0.5) * vec2(uPixelAspect, 1.0) * 2.0;
            float r2 = dot(d, d);
            float a = exp(-r2 * 3.0) * (1.0 - smoothstep(0.6, 1.0, r2)) * vAlpha;
            if (a < 0.01) discard;
            gl_FragColor = vec4(uColor, a);
          }
        `,
      }),
    [center.join(), size.join(), flake, speed, wind.join(), color, intensity, fade],
  );
  useFrame(({ gl, camera, size: view }) => {
    gl.getDrawingBufferSize(buffer);
    material.uniforms.uPixelAspect.value = view.width / Math.max(1, view.height) / (buffer.x / buffer.y);
    material.uniforms.uScale.value = (buffer.y * (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5]) / 2;
  });
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={renderOrder} />;
}
