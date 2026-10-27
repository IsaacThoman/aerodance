import { useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial, simplex } from '../shared/glsl.ts';
import { SURFACE_BAKE, bakeCube, makeCubeTarget } from './bake.ts';
import { AURORA } from './aurora.ts';
import type { OrbitVariant } from './layout.ts';
import { CLOUD_SPEED, DAY_KEY_DIR, MOON_DIR, NIGHT_KEY_DIR, PLANET_AXIS, SPIN_SPEED, world } from './layout.ts';

/** Texels along each face of the planet's baked maps. */
const SURFACE_SIZE = 768;
/** The sphere the planet is drawn on, following the camera: inside the sky's, outside the stage. */
const SHELL_RADIUS = 1450;

const Y = new THREE.Vector3(0, 1, 0);
const TILT = new THREE.Quaternion().setFromUnitVectors(Y, PLANET_AXIS);
const turn = new THREE.Quaternion();
const rotation = new THREE.Matrix4();

/** World to planet frame, `angle` radians into its spin: undoes the tilt and the turn so far. */
function planetToLocal(target: THREE.Matrix3, angle: number): void {
  turn.setFromAxisAngle(Y, angle % (Math.PI * 2));
  turn.premultiply(TILT).invert();
  target.setFromMatrix4(rotation.makeRotationFromQuaternion(turn));
}

/**
 * The planet far below the deck, ray-traced per pixel against a sphere rather than drawn as
 * triangles, so its limb is a smooth anti-aliased curve. It's drawn on a sphere that follows the
 * camera, at the far plane, behind everything but the sky and stars. One pass draws the ground
 * (glossy oceans with a sun glint, shallows, forests, deserts, ice), its drifting clouds and their
 * shadows, the haze and luminous rim of the atmosphere and the sunrise blazing along the limb.
 *   night: the night face instead: warm city lights, moonlit clouds and a Moon glint on the sea, a
 *     thin blue airglow, gold and teal dusk where the sun has just set, and the aurora
 */
export function Planet({ night }: OrbitVariant) {
  const mesh = useRef<THREE.Mesh>(null);
  const gl = useThree((s) => s.gl);
  const surface = useDisposable(() => makeCubeTarget(SURFACE_SIZE));
  useLayoutEffect(() => bakeCube(gl, surface, SURFACE_BAKE), [gl, surface]);

  const material = useDisposable(
    () =>
      shaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        uniforms: {
          uTime: world.uTime,
          uSunDir: world.uSunDir,
          uCenter: world.uCenter,
          uRadius: world.uRadius,
          uKeyDir: { value: night ? NIGHT_KEY_DIR : DAY_KEY_DIR },
          uMoonDir: { value: MOON_DIR },
          uSurface: { value: surface.texture },
          uSpin: { value: new THREE.Matrix3() },
          uCloudSpin: { value: new THREE.Matrix3() },
        },
        defines: night ? { NIGHT: '' } : {},
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uCenter, uSunDir, uKeyDir, uMoonDir;
          uniform float uRadius, uTime;
          uniform mat3 uSpin, uCloudSpin;
          uniform samplerCube uSurface;
          varying vec3 vDir;
          ${simplex}
          #ifdef NIGHT
          ${AURORA}
          #endif

          void main() {
            vec3 rd = normalize(vDir);
            // Everything in planet radii from its centre, which keeps the numbers small.
            vec3 oc = (cameraPosition - uCenter) / uRadius;
            float tca = max(-dot(oc, rd), 0.0);
            // How close the ray passes to the centre, and the pixel's footprint there.
            float b = length(oc + rd * tca);
            float px = max(fwidth(b), 1e-6);
            float cover = 1.0 - smoothstep(1.0 - px, 1.0 + px * 0.5, b);
            float th = sqrt(max(1.0 - b * b, 0.0));
            // Off the edge, the point the ray grazes: shading stays continuous across the limb.
            vec3 n = normalize(oc + rd * (tca - th));
            vec3 v = -rd;
            float mu = max(dot(n, v), 0.0);
            float ndl = dot(n, uKeyDir);
            float day = smoothstep(-0.12, 0.3, ndl);

            // Ground.
            vec3 ln = uSpin * n;
            vec4 s = textureCube(uSurface, ln);
            // Fine detail the bake is too coarse for, close under the deck, fading out towards the
            // limb before it could shimmer.
            float fine = 1.0 - smoothstep(0.4, 0.8, length(fwidth(ln)) * 300.0);
            float h = (s.r - 0.5) / 1.6 + 0.005 * snoise(ln * 220.0) * fine;
            float land = smoothstep(-0.004, 0.018, h);
            float lat = abs(ln.y);
            vec3 ocean = mix(vec3(0.003, 0.025, 0.11), vec3(0.006, 0.09, 0.32), smoothstep(-0.3, -0.04, h));
            ocean = mix(ocean, vec3(0.012, 0.26, 0.36), smoothstep(-0.035, 0.0, h) * 0.8);
            vec3 green = mix(vec3(0.02, 0.13, 0.035), vec3(0.11, 0.27, 0.035), smoothstep(0.0, 0.14, h));
            vec3 ground = mix(vec3(0.36, 0.26, 0.12), green, smoothstep(0.3, 0.5, s.a));
            ground = mix(ground, vec3(0.1, 0.13, 0.06), smoothstep(0.2, 0.32, h) * 0.6);
            vec3 albedo = mix(ocean, ground, land);
            float ice = smoothstep(0.78, 0.86, lat + (s.a - 0.5) * 0.12 + land * 0.06);
            albedo = mix(albedo, vec3(0.8, 0.9, 1.0), ice);

            // Clouds, drifting on their own, and their shadows on the ground.
            vec3 cn = uCloudSpin * n;
            float cloud = textureCube(uSurface, cn).g;
            float wisps = snoise(cn * 300.0) * 0.6 + snoise(cn * 110.0) * 0.4;
            cloud = clamp(cloud + wisps * 0.9 * cloud * (1.0 - cloud) * fine, 0.0, 1.0);
            float shadow = textureCube(uSurface, uCloudSpin * normalize(n + uKeyDir * 0.012)).g;

            vec3 sun = vec3(1.0, 0.95, 0.86) * 1.35;
            vec3 sky = vec3(0.02, 0.06, 0.16);
            float wrap = max(ndl * 0.9 + 0.1, 0.0);
            vec3 col = albedo * (sun * max(ndl, 0.0) * (1.0 - shadow * 0.55) + sky * day + vec3(0.002, 0.005, 0.016));
            float wet = (1.0 - land) * (1.0 - ice) * (1.0 - cloud);

            #ifdef NIGHT
            // Moonlight: a cool wash, and the Moon's glint on the sea out towards the limb.
            float moon = max(dot(n, uMoonDir) * 0.8 + 0.2, 0.0);
            col += albedo * vec3(0.05, 0.07, 0.12) * moon;
            float nhm = max(dot(n, normalize(uMoonDir + v)), 0.0);
            col += vec3(0.75, 0.85, 1.0) * (pow(nhm, 400.0) * 1.6 + pow(nhm, 60.0) * 0.08) * wet;
            #else
            // Glossy oceans: the real sun's glint out at the limb under the sunrise, a second glint
            // on the face below it (lit by the sun swung partway towards the camera), and a broad
            // soft sheen across the day side.
            float nhs = max(dot(n, normalize(uSunDir + v)), 0.0);
            col += vec3(1.0, 0.85, 0.65) * (pow(nhs, 300.0) * 6.0 + pow(nhs, 40.0) * 0.35) * wet;
            vec3 glintDir = normalize(uSunDir + normalize(oc) * 0.45);
            float ng = max(dot(n, normalize(glintDir + v)), 0.0);
            col += vec3(1.0, 0.92, 0.8) * (pow(ng, 220.0) * 2.5 + pow(ng, 30.0) * 0.18) * wet;
            float nh = max(dot(n, normalize(uKeyDir + v)), 0.0);
            col += vec3(0.25, 0.55, 1.0) * pow(nh, 14.0) * 0.1 * day * (1.0 - cloud * 0.5);
            #endif

            // Clouds: white by day, a warm band at the terminator, dim blue at night.
            vec3 cloudLit = vec3(0.92, 0.96, 1.0) * (sun * wrap * 0.88 + sky * 1.5 * day);
            cloudLit += vec3(1.0, 0.6, 0.45) * exp(-pow((ndl - 0.02) / 0.07, 2.0)) * 0.35;
            cloudLit += vec3(0.01, 0.02, 0.05);
            #ifdef NIGHT
            cloudLit += vec3(0.07, 0.09, 0.15) * moon;
            #endif
            col = mix(col, cloudLit, cloud * 0.95);

            // City lights where the night falls, glowing through thin cloud.
            float dark = 1.0 - smoothstep(-0.25, 0.05, ndl);
            float towns = mix(1.0, 0.2 + 1.8 * smoothstep(0.15, 0.8, 0.5 + 0.5 * snoise(ln * 420.0)), fine);
            col += vec3(1.0, 0.56, 0.22) * s.b * towns * dark * (1.0 - cloud * 0.75) * 3.2;

            // Atmosphere: haze thickening towards the limb, blue by day and violet by night.
            float glance = 1.0 - mu;
            vec3 hazeDay = vec3(0.16, 0.5, 1.2);
            vec3 hazeNight = vec3(0.012, 0.025, 0.12);
            vec3 haze = mix(hazeNight, hazeDay, day);
            col = mix(col, haze, pow(glance, 3.0) * 0.85);
            col += hazeDay * pow(glance, 1.5) * 0.08 * day;

            // The rim: a thin bright line hugging the limb with a softer glow beyond it.
            float alt = b - 1.0;
            float line = exp(-abs(alt) / (alt > 0.0 ? 0.0035 : 0.002));
            float glow = exp(-max(alt, 0.0) / 0.018) * (1.0 - cover);
            float wide = exp(-max(alt, 0.0) / 0.07) * (1.0 - cover);
            vec3 rimDay = vec3(0.3, 0.85, 1.9);
            vec3 rimNight = vec3(0.03, 0.06, 0.3);
            vec3 rim = mix(rimNight, rimDay, smoothstep(-0.35, 0.35, ndl));
            vec3 glowCol = rim * (line + glow * 0.3) + rim * wide * 0.08;
            float toward = max(dot(rd, uSunDir), 0.0);
            #ifdef NIGHT
            // Airglow: a thin blue band floating just off the limb all the way round.
            glowCol += vec3(0.08, 0.32, 0.9) * exp(-abs(alt - 0.003) / 0.0014) * 0.55;
            // Dusk where the sun has just set: gold hugging the limb, teal spreading either side.
            glowCol += vec3(2.0, 1.1, 0.4) * pow(toward, 90.0) * (line * 0.9 + glow * 0.25);
            glowCol += vec3(0.2, 0.95, 0.9) * pow(toward, 14.0) * (line * 0.45 + glow * 0.18 + wide * 0.06);
            glowCol += vec3(1.6, 0.5, 0.12) * exp(-abs(alt + 0.004) / 0.004) * pow(toward, 40.0) * 0.6;
            glowCol += aurora(rd, oc, uTime);
            #else
            // The sunrise: gold along the limb either side of the sun, orange low in the air just
            // inside the limb, and white-hot where the sun itself breaks over it.
            float near = pow(toward, 60.0);
            float core = pow(toward, 2000.0);
            glowCol += vec3(2.0, 1.15, 0.45) * near * (line * 0.8 + glow * 0.15);
            glowCol += vec3(2.2, 0.55, 0.1) * exp(-abs(alt + 0.0035) / 0.003) * pow(toward, 24.0) * 0.8;
            glowCol += vec3(3.0, 2.6, 2.2) * core * (line + glow * 0.5 + wide * 0.3);
            #endif

            gl_FragColor = vec4(col * cover + glowCol, cover);
          }
        `,
      }),
    [surface, night],
  );

  useFrame((state) => {
    const time = world.uTime.value;
    planetToLocal(material.uniforms.uSpin.value, time * SPIN_SPEED);
    planetToLocal(material.uniforms.uCloudSpin.value, time * CLOUD_SPEED + 4.6);
    mesh.current?.position.copy(state.camera.position);
  });

  return (
    <mesh ref={mesh} material={material} renderOrder={-950} frustumCulled={false}>
      <sphereGeometry args={[SHELL_RADIUS, 48, 24]} />
    </mesh>
  );
}
