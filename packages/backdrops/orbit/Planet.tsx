import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useBackdropFrame } from '../shared/frame.ts';
import { SURFACE_BAKE, bakeCube, makeCubeTarget } from './bake.ts';
import { CLOUD_SPEED, PLANET_AXIS, PLANET_CENTER, PLANET_RADIUS, SPIN_SPEED, world } from './layout.ts';

/** Texels along each face of the planet's baked maps. */
const SURFACE_SIZE = 512;
/** The shell the planet is drawn on reaches past the surface to hold the atmosphere's glow. */
const SHELL = 1.25;

const CENTER = PLANET_CENTER.toArray();
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
 * The planet, ray-traced against a sphere on a shell around it rather than drawn as triangles,
 * so its limb is a smooth anti-aliased curve at any size. One pass draws the ground (oceans with
 * a sun glint, shallows, forests, deserts, ice), its own drifting cloud layer with shadows, city
 * lights on the night side, the haze and luminous rim of the atmosphere, and the sunrise blazing
 * along the limb. It writes the depth of its surface, not of the shell it's drawn on.
 */
export function Planet() {
  const gl = useThree((s) => s.gl);
  const surface = useDisposable(() => makeCubeTarget(SURFACE_SIZE));
  useLayoutEffect(() => bakeCube(gl, surface, SURFACE_BAKE), [gl, surface]);

  const material = useDisposable(
    () =>
      shaderMaterial({
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: true,
        uniforms: {
          ...world,
          uSurface: { value: surface.texture },
          uSpin: { value: new THREE.Matrix3() },
          uCloudSpin: { value: new THREE.Matrix3() },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uCenter, uSunDir, uKeyDir;
          uniform float uRadius;
          uniform mat3 uSpin, uCloudSpin;
          uniform samplerCube uSurface;
          uniform mat4 projectionMatrix;
          varying vec3 vWorld;

          void main() {
            vec3 rd = normalize(vWorld - cameraPosition);
            vec3 oc = cameraPosition - uCenter;
            float tca = -dot(oc, rd);
            // How close the ray passes to the centre, and the pixel's footprint there.
            float b = length(oc + rd * tca);
            float px = max(fwidth(b), 1e-4);
            float cover = 1.0 - smoothstep(uRadius - px, uRadius + px * 0.5, b);
            float th = sqrt(max(uRadius * uRadius - b * b, 0.0));
            // Off the edge, the point the ray grazes: shading stays continuous across the limb.
            vec3 hit = oc + rd * (tca - th);
            vec3 n = normalize(hit);
            vec3 v = -rd;
            float mu = max(dot(n, v), 0.0);
            float ndl = dot(n, uKeyDir);
            float day = smoothstep(-0.12, 0.3, ndl);

            // Ground.
            vec3 ln = uSpin * n;
            vec4 s = textureCube(uSurface, ln);
            float h = (s.r - 0.5) / 1.6;
            float land = smoothstep(-0.004, 0.018, h);
            float lat = abs(ln.y);
            vec3 ocean = mix(vec3(0.003, 0.022, 0.095), vec3(0.006, 0.085, 0.3), smoothstep(-0.3, -0.04, h));
            ocean = mix(ocean, vec3(0.012, 0.24, 0.33), smoothstep(-0.035, 0.0, h) * 0.75);
            vec3 green = mix(vec3(0.02, 0.12, 0.03), vec3(0.1, 0.26, 0.03), smoothstep(0.0, 0.14, h));
            vec3 ground = mix(vec3(0.34, 0.25, 0.12), green, smoothstep(0.3, 0.5, s.a));
            ground = mix(ground, vec3(0.1, 0.13, 0.06), smoothstep(0.2, 0.32, h) * 0.6);
            vec3 albedo = mix(ocean, ground, land);
            float ice = smoothstep(0.78, 0.86, lat + (s.a - 0.5) * 0.12 + land * 0.06);
            albedo = mix(albedo, vec3(0.8, 0.9, 1.0), ice);

            // Clouds, drifting on their own, and their shadows on the ground.
            vec3 cn = uCloudSpin * n;
            float cloud = textureCube(uSurface, cn).g;
            float shadow = textureCube(uSurface, uCloudSpin * normalize(n + uKeyDir * 0.012)).g;

            vec3 sun = vec3(1.0, 0.95, 0.86) * 1.35;
            vec3 sky = vec3(0.02, 0.06, 0.16);
            float wrap = max(ndl * 0.9 + 0.1, 0.0);
            vec3 col = albedo * (sun * max(ndl, 0.0) * (1.0 - shadow * 0.55) + sky * day + vec3(0.002, 0.005, 0.016));

            // Glossy oceans: the real sun's glint out at the limb under the sunrise, a second glint
            // on the face below it (lit by the sun swung partway towards the camera), and a broad
            // soft sheen across the day side.
            float wet = (1.0 - land) * (1.0 - ice) * (1.0 - cloud);
            float nhs = max(dot(n, normalize(uSunDir + v)), 0.0);
            col += vec3(1.0, 0.85, 0.65) * (pow(nhs, 300.0) * 6.0 + pow(nhs, 40.0) * 0.35) * wet;
            vec3 glintDir = normalize(uSunDir + normalize(cameraPosition - uCenter) * 0.45);
            float ng = max(dot(n, normalize(glintDir + v)), 0.0);
            col += vec3(1.0, 0.92, 0.8) * (pow(ng, 220.0) * 2.5 + pow(ng, 30.0) * 0.18) * wet;
            float nh = max(dot(n, normalize(uKeyDir + v)), 0.0);
            col += vec3(0.25, 0.55, 1.0) * pow(nh, 14.0) * 0.1 * day * (1.0 - cloud * 0.5);

            // Clouds: white by day, a warm band at the terminator, dim blue at night.
            vec3 cloudLit = vec3(0.92, 0.96, 1.0) * (sun * wrap * 0.88 + sky * 1.5 * day);
            cloudLit += vec3(1.0, 0.6, 0.45) * exp(-pow((ndl - 0.02) / 0.07, 2.0)) * 0.35;
            cloudLit += vec3(0.01, 0.02, 0.05);
            col = mix(col, cloudLit, cloud * 0.95);

            // City lights where the night falls.
            float night = 1.0 - smoothstep(-0.25, 0.05, ndl);
            col += vec3(1.0, 0.56, 0.22) * s.b * night * (1.0 - cloud * 0.75) * 3.0;

            // Atmosphere: haze thickening towards the limb, blue by day and violet by night.
            float glance = 1.0 - mu;
            vec3 hazeDay = vec3(0.16, 0.5, 1.2);
            vec3 hazeNight = vec3(0.012, 0.025, 0.12);
            vec3 haze = mix(hazeNight, hazeDay, day);
            col = mix(col, haze, pow(glance, 3.0) * 0.85);
            col += hazeDay * pow(glance, 1.5) * 0.08 * day;

            // The rim: a thin bright line hugging the limb with a softer glow beyond it.
            float alt = (b - uRadius) / uRadius;
            float line = exp(-abs(alt) / (alt > 0.0 ? 0.007 : 0.004));
            float glow = exp(-max(alt, 0.0) / 0.035) * (1.0 - cover);
            float wide = exp(-max(alt, 0.0) / 0.12) * (1.0 - cover);
            float fade = 1.0 - smoothstep(${(SHELL - 0.08).toFixed(3)}, ${(SHELL - 0.01).toFixed(3)}, b / uRadius);
            vec3 rimDay = vec3(0.3, 0.85, 1.9);
            vec3 rimNight = vec3(0.03, 0.06, 0.3);
            vec3 rim = mix(rimNight, rimDay, smoothstep(-0.35, 0.35, ndl));
            vec3 glowCol = rim * (line + glow * 0.3) + rim * wide * 0.08;
            // The sunrise: gold along the limb either side of the sun, orange low in the air just
            // inside the limb, and white-hot where the sun itself breaks over it.
            float toward = max(dot(rd, uSunDir), 0.0);
            float near = pow(toward, 60.0);
            float core = pow(toward, 2000.0);
            glowCol += vec3(2.0, 1.15, 0.45) * near * (line * 0.8 + glow * 0.15);
            glowCol += vec3(2.2, 0.55, 0.1) * exp(-abs(alt + 0.007) / 0.006) * pow(toward, 16.0) * 0.8;
            glowCol += vec3(3.0, 2.6, 2.2) * core * (line + glow * 0.5 + wide * 0.3);
            glowCol *= fade;

            gl_FragColor = vec4(col * cover + glowCol, cover);
            // The depth of the surface rather than the shell; the glow beyond the limb hides nothing.
            vec4 clip = projectionMatrix * viewMatrix * vec4(uCenter + hit, 1.0);
            gl_FragDepth = cover > 0.5 ? (clip.z / clip.w) * 0.5 + 0.5 : 1.0;
          }
        `,
      }),
    [surface],
  );

  useBackdropFrame((_state, _delta, time) => {
    planetToLocal(material.uniforms.uSpin.value, time * SPIN_SPEED);
    planetToLocal(material.uniforms.uCloudSpin.value, time * CLOUD_SPEED + 1.7);
  });

  return (
    <mesh position={CENTER} material={material} renderOrder={0} frustumCulled={false}>
      <sphereGeometry args={[PLANET_RADIUS * SHELL, 64, 32]} />
    </mesh>
  );
}
