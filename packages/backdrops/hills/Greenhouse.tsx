import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { fx, landGLSL, skyGLSL } from './fx.ts';
import { landHeight } from './terrain.ts';

/** A dome: [x, z, radius]. */
export type DomeSite = readonly [x: number, z: number, radius: number];

/** Glass greenhouse domes on the hillside: aqua-tinted, white-ribbed, mirroring the sky, glinting in the sun. */
export function Greenhouses({ sites }: { sites: readonly DomeSite[] }) {
  const geometry = useDisposable(() => {
    // A smooth hemisphere; its ribs are drawn in the shader, anti-aliased, rather than modelled.
    const dome = new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = dome.index;
    g.setAttribute('position', dome.attributes.position);
    g.setAttribute('normal', dome.attributes.normal);
    const data = new Float32Array(sites.length * 4);
    sites.forEach(([x, z, r], i) => data.set([x, landHeight(x, z) - r * 0.08, z, r], i * 4));
    g.setAttribute('aSite', new THREE.InstancedBufferAttribute(data, 4));
    g.instanceCount = sites.length;
    return g;
  }, [sites]);

  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...fx, uTint: { value: new THREE.Color('#5fe0d8') }, uPlants: { value: new THREE.Color('#2f8a2a') } },
      vertexShader: /* glsl */ `
        attribute vec4 aSite;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec3 vLocal;
        void main() {
          vec3 world = aSite.xyz + position * aSite.w;
          vWorld = world;
          vNormal = normal;
          vLocal = position;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint, uPlants;
        ${skyGLSL}
        ${landGLSL}
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec3 vLocal;
        // Anti-aliased lines at whole values of x, about a pixel and a half wide.
        float lines(float x) {
          float w = fwidth(x) * 1.25;
          float d = abs(fract(x + 0.5) - 0.5);
          return 1.0 - smoothstep(w * 0.5, w, d);
        }
        void main() {
          vec3 n = normalize(vNormal);
          vec3 v = normalize(cameraPosition - vWorld);
          float nv = max(dot(n, v), 0.0);
          vec3 r = reflect(-v, n);
          vec3 sky = skyGradient(vec3(r.x, abs(r.y), r.z));
          float fres = 0.25 + 0.75 * pow(1.0 - nv, 3.0);
          vec3 col = mix(uTint * 0.45, sky * 1.3, fres);
          // Lush planting showing through the lower glass.
          col = mix(col, uPlants * (0.7 + 0.5 * tnoise(vLocal.xz * 6.0 + 3.0).r), smoothstep(0.5, 0.15, vLocal.y) * (1.0 - fres) * 0.8);
          // Glossy highlights: a soft window of key light and a hot sun glint.
          float key = pow(max(dot(n, normalize(uKeyDir + v)), 0.0), 24.0);
          float glint = pow(max(dot(n, normalize(uSunDir + v)), 0.0), 90.0);
          col += uKeyColor * key * 1.6 + uSunColor * glint * 5.0;
          // White ribs: meridians and two rings, plus the footing.
          float ang = atan(vLocal.z, vLocal.x) / 6.2831853 * 10.0;
          float lat = asin(clamp(vLocal.y, 0.0, 1.0)) / 1.5707963 * 3.0;
          float ribs = max(lines(ang) * smoothstep(0.97, 0.85, vLocal.y), lines(lat));
          ribs = max(ribs, smoothstep(0.1, 0.02, vLocal.y));
          col = mix(col, vec3(1.1) * (0.75 + 0.35 * dot(n, uKeyDir)), ribs * 0.7);
          col = applyLandHaze(col, vWorld);
          float a = clamp(0.4 + fres * 0.45 + key * 0.5 + glint + ribs * 0.6, 0.0, 1.0);
          gl_FragColor = vec4(col, a);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}
