import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { noise, shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { halfHeightAt, inFrame } from './frame.ts';
import { dew } from './light.ts';

// Everything far behind the leaves, out of focus: the blurred canopy with the sun breaking
// through it, bokeh discs of light, a sunshower's distant rain and soft shafts of light.

const BACK_Z = -60;

/**
 * The far canopy: deep shade on the left (behind the title), brightening towards a warm gap
 * in the leaves at the upper right where the sun breaks through, all softly mottled with
 * out-of-focus foliage that drifts in the breeze.
 */
export function Canopy() {
  const material = useDisposable(() => {
    const h = halfHeightAt(BACK_Z);
    return shaderMaterial({
      depthWrite: false,
      uniforms: {
        uTime: dew.uTime,
        uFrame: { value: new THREE.Vector2(h * (16 / 9), h) },
        uShade: { value: new THREE.Color('#082a10') },
        uMid: { value: new THREE.Color('#1d5a1c') },
        uLit: { value: new THREE.Color('#7fb52e') },
        uGap: { value: new THREE.Color('#fff0a8') },
        uSky: { value: new THREE.Color('#bfe9ff') },
      },
      vertexShader: /* glsl */ `
        uniform vec2 uFrame;
        varying vec2 vF;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vF = world.xy / uFrame;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uShade, uMid, uLit, uGap, uSky;
        varying vec2 vF;
        ${noise}
        void main() {
          vec2 f = vF;
          vec2 sun = vec2(0.66, 1.32);
          float ds = length((f - sun) * vec2(0.85, 1.0));
          float light = smoothstep(2.1, 0.0, ds);
          // Shade to light across the frame, darker low down.
          vec3 col = mix(uShade, uMid, smoothstep(-1.4, 0.7, f.x * 0.75 + f.y * 0.45));
          col = mix(col, uLit, light * light * 0.85);
          // Blurred leaf masses, calmer behind the title.
          vec2 drift = vec2(uTime * 0.008, sin(uTime * 0.05) * 0.03);
          float n = snoise(f * vec2(1.2, 1.5) + drift) * 0.62 + snoise(f * 2.6 - drift * 1.7 + 7.3) * 0.38;
          float calm = mix(0.18, 0.5, smoothstep(-0.7, 0.4, f.x));
          col *= 1.0 + n * calm;
          col *= mix(0.75, 1.0, smoothstep(-1.4, -0.2, f.y));
          // Glimpses of sky through the leaves above, and the bright gap where the sun is.
          float sky = smoothstep(0.45, 1.25, f.y + n * 0.35) * smoothstep(-0.6, 0.4, f.x) * smoothstep(1.9, 0.6, ds);
          col = mix(col, uSky * 1.1, sky * 0.55);
          float gap = exp(-ds * ds * 4.0);
          // Kept under the bloom threshold: a blooming sky would haze over the big leaf.
          col += uGap * (pow(light, 4.0) * 0.42 + gap * 0.45 + exp(-ds * ds * 40.0) * 0.25);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
  });
  const h = halfHeightAt(BACK_Z);
  return (
    <mesh material={material} position={[0, 0, BACK_Z]} renderOrder={-100} frustumCulled={false}>
      <planeGeometry args={[h * (16 / 9) * 2.4, h * 2 * 1.7]} />
    </mesh>
  );
}

// Bokeh colours: warm sun, pale lime, white-gold, leaf green.
// Bokeh colours: warm sun and white-gold near the light, lime and mint in the green shade.
const SUN_BOKEH = ['#ffd45a', '#fff1b0', '#ffe27a'].map((c) => new THREE.Color(c));
const LEAF_BOKEH = ['#c8ff5a', '#9cf04a', '#d8ff9a', '#e8ff8a', '#b0f0ff'].map((c) => new THREE.Color(c));

/**
 * Out-of-focus sun glints through the far leaves: soft discs with a faint bright rim, most
 * towards the sun and the right, few and dim behind the title. They drift and breathe.
 */
export function Bokeh({ count = 46, seed = 5 }: { count?: number; seed?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const pos = new Float32Array(count * 3);
    const look = new Float32Array(count * 4);
    const color = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Lean the scatter towards the light: the canopy gap and the open sky beside the big leaf.
      let fx = rand.range(-1.15, 1.15);
      let fy = rand.range(-1.3, 1.35);
      if (rand.chance(0.6)) {
        fx = 0.45 + rand.range(-0.5, 0.65);
        fy = 0.85 + rand.range(-0.55, 0.5);
      }
      let behindTitle = fx < -0.1 && fy < 0.35 && fy > -0.85;
      // Only a few, small and faint, in the shade behind the menu.
      if (behindTitle && rand.chance(0.6)) {
        fx = rand.range(-1.1, 0.2);
        fy = rand.range(0.45, 1.35);
        behindTitle = false;
      }
      const z = rand.range(-30, -14);
      const near = Math.hypot(fx - 0.66, fy - 1.15);
      const [x, y] = inFrame(fx, fy, z);
      pos.set([x, y, z], i * 3);
      const size = rand.range(0.7, 2.3) * (behindTitle ? 0.6 : 1);
      // Dimmer low down, where only 4:3 shows them.
      // Capped, so with the bright sky behind them they stay under the bloom threshold.
      const bright = Math.min((behindTitle ? 0.2 : 0.55) + Math.max(0, 1.4 - near) * rand.range(0.3, 0.8), 1) * (fy < -0.9 ? 0.55 : 1);
      look.set([size, bright, rand.range(0, 100), rand.range(0.6, 1.4)], i * 4);
      const c = near < 0.8 ? rand.pick(SUN_BOKEH) : rand.pick(LEAF_BOKEH);
      color.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 4));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    g.instanceCount = count;
    return g;
  }, [count, seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      uniforms: { uTime: dew.uTime },
      vertexShader: /* glsl */ `
        attribute vec3 aPos;
        attribute vec4 aLook;   // size, brightness, phase, speed
        attribute vec3 aColor;
        uniform float uTime;
        varying vec2 vQ;
        varying vec3 vColor;
        void main() {
          float t = uTime * aLook.w + aLook.z;
          vec3 c = aPos + vec3(sin(t * 0.11) * 0.8, sin(t * 0.083 + 1.0) * 0.5, 0.0);
          float breathe = 0.7 + 0.3 * sin(t * 0.37) * sin(t * 0.21 + 2.0);
          vColor = aColor * aLook.y * breathe;
          vQ = position.xy * 2.0;
          vec4 world = modelMatrix * vec4(c + vec3(position.xy * aLook.x * 2.0, 0.0), 1.0);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vQ;
        varying vec3 vColor;
        void main() {
          float r = length(vQ);
          float fw = fwidth(r) * 1.5 + 0.1;
          float disc = 1.0 - smoothstep(1.0 - fw, 1.0, r);
          if (disc <= 0.0) discard;
          // A lens's bokeh: an even disc, brighter towards its rim, with a faint glow outside.
          float ring = smoothstep(0.6, 0.97, r) * 0.22;
          float body = 0.36 + 0.06 * (1.0 - r);
          float halo = exp(-max(r - 0.9, 0.0) * 12.0) * 0.1;
          // Additive light.
          gl_FragColor = vec4(vColor * (disc * (body + ring) + halo), 0.0);
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} renderOrder={-90} frustumCulled={false} />;
}

/** A sunshower far off: thin streaks catching the light, brightest towards the sun. */
export function Rain({ count = 110, seed = 9 }: { count?: number; seed?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const data = new Float32Array(count * 4);
    const look = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const z = rand.range(-26, -9);
      const h = halfHeightAt(z);
      const [x] = inFrame(rand.range(-1.2, 1.2), 0, z);
      data.set([x, z, rand.range(0, 1), h * 2.9], i * 4);
      look.set([rand.range(9, 14), rand.range(0.7, 1.4), rand.range(0.04, 0.07) * (10 - z) / 30, rand.range(0.4, 1)], i * 4);
    }
    g.setAttribute('aRain', new THREE.InstancedBufferAttribute(data, 4));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 4));
    g.instanceCount = count;
    return g;
  }, [count, seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      uniforms: { uTime: dew.uTime, uSunColor: dew.uSunColor },
      vertexShader: /* glsl */ `
        attribute vec4 aRain;  // x, z, start (0..1 of the fall), fall height
        attribute vec4 aLook;  // speed, length, width, brightness
        uniform float uTime;
        varying vec2 vQ;
        varying float vLight;
        void main() {
          float span = aRain.w;
          float y = span * 0.5 - mod(aRain.z * span + uTime * aLook.x, span);
          vec3 c = vec3(aRain.x + y * -0.06, y, aRain.y);
          vec4 mv = modelViewMatrix * vec4(c, 1.0);
          mv.xy += vec2(position.x * aLook.z, position.y * aLook.y);
          vQ = position.xy * 2.0;
          // Lit streaks towards the sun at the upper right.
          vec2 f = vec2(c.x / (span * 0.62), c.y / (span * 0.35));
          vLight = aLook.w * (0.25 + smoothstep(-1.2, 1.2, f.x + f.y * 0.6));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunColor;
        varying vec2 vQ;
        varying float vLight;
        void main() {
          float across = 1.0 - abs(vQ.x);
          float along = smoothstep(-1.0, 0.6, vQ.y) * (1.0 - smoothstep(0.6, 1.0, vQ.y));
          float a = across * across * along * vLight * 0.22;
          gl_FragColor = vec4(uSunColor * a, 0.0);
        }
      `,
    }),
  );

  return <mesh geometry={geometry} material={material} renderOrder={-80} frustumCulled={false} />;
}

/**
 * Soft shafts of sunlight fanning down from the gap in the canopy, far back behind the leaves,
 * fading out long before the title. Each brightens, dims and leans a little on its own.
 */
export function Shafts({ count = 7, seed = 21, z = -20, renderOrder = -85 }: { count?: number; seed?: number; z?: number; renderOrder?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const h = halfHeightAt(z);
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Angle below the horizontal pointing left (fanned), width, brightness, phase.
      const fan = 0.95 + (0.6 * (i + rand.range(-0.3, 0.3))) / (count - 1);
      data.set([fan, h * rand.range(0.05, 0.14), rand.range(0.45, 1), rand.range(0, 50)], i * 4);
    }
    g.setAttribute('aShaft', new THREE.InstancedBufferAttribute(data, 4));
    g.instanceCount = count;
    return g;
  }, [count, seed, z]);

  const material = useDisposable(() => {
    const [sx, sy] = inFrame(0.55, 1.3, z);
    return shaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      uniforms: {
        uTime: dew.uTime,
        uOrigin: { value: new THREE.Vector3(sx, sy, z) },
        uLength: { value: halfHeightAt(z) * 2.3 },
        uColor: { value: new THREE.Color('#fff4c0').multiplyScalar(0.3) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aShaft;  // angle, width, brightness, phase
        uniform float uTime, uLength;
        uniform vec3 uOrigin;
        varying vec2 vQ;
        varying float vLight;
        void main() {
          float t = uTime + aShaft.w;
          float a = aShaft.x + sin(t * 0.07) * 0.025;
          vec2 dir = vec2(-cos(a), -sin(a));
          // Wound to face the camera.
          vec2 side = vec2(dir.y, -dir.x);
          float along = position.y + 0.5;
          // Shafts widen away from the gap.
          float w = aShaft.y * (0.3 + along * 1.4);
          vec2 p = uOrigin.xy + dir * along * uLength + side * position.x * w;
          vQ = vec2(position.x * 2.0, along);
          vLight = aShaft.z * (0.5 + 0.5 * sin(t * 0.23) * sin(t * 0.13 + 1.7));
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, uOrigin.z, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vQ;
        varying float vLight;
        void main() {
          float across = exp(-vQ.x * vQ.x * 3.0);
          float along = smoothstep(0.0, 0.15, vQ.y) * (1.0 - smoothstep(0.25, 0.85, vQ.y));
          gl_FragColor = vec4(uColor * across * along * vLight, 0.0);
        }
      `,
    });
  });

  return <mesh geometry={geometry} material={material} renderOrder={renderOrder} frustumCulled={false} />;
}
