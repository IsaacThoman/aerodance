import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { fx, landGLSL, skyGLSL } from './fx.ts';
import { landHeight } from './terrain.ts';

// The rotor's hub, in the turbine's own units (the tower is 30 tall).
const HUB = new THREE.Vector3(0, 30.4, 2.5);

// Tags a part as tower (0) or rotor (1) and keeps only what the shader reads.
function part(g: THREE.BufferGeometry, rotor: number) {
  g.deleteAttribute('uv');
  g.setAttribute('aRotor', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(rotor), 1));
  return g;
}

/** One turbine: tower and nacelle around the origin, the rotor around its own hub (spun in the shader). */
function buildTurbine() {
  const tower = new THREE.CylinderGeometry(0.72, 1.45, 30, 18, 1, true);
  tower.translate(0, 15, 0);
  const collar = new THREE.CylinderGeometry(1.7, 1.8, 0.7, 18, 1, true);
  collar.translate(0, 0.35, 0);
  const nacelle = new THREE.CapsuleGeometry(1.2, 3.8, 6, 16);
  nacelle.rotateX(Math.PI / 2);
  nacelle.translate(0, HUB.y, -0.4);
  const spinner = new THREE.SphereGeometry(1.05, 18, 10);
  spinner.scale(1, 1, 1.5);
  const blades: THREE.BufferGeometry[] = [part(spinner, 1)];
  for (let i = 0; i < 3; i++) {
    // Chunky, rounded blades: the buffer is 640x480, so thin tips would only shimmer.
    const shape = new THREE.Shape();
    shape.moveTo(-0.7, 0.5);
    shape.quadraticCurveTo(-1.9, 2.8, -1.3, 6);
    shape.lineTo(-0.62, 14);
    shape.quadraticCurveTo(0.02, 15.8, 0.52, 14);
    shape.lineTo(0.8, 6);
    shape.quadraticCurveTo(1.05, 2.6, 0.7, 0.5);
    shape.lineTo(-0.7, 0.5);
    const b = new THREE.ShapeGeometry(shape, 6);
    // A little pitch, so each blade flashes as it turns through the light.
    b.rotateY(0.32);
    b.rotateZ((i / 3) * Math.PI * 2);
    blades.push(part(b, 1));
  }
  return mergeGeometries([part(tower, 0), part(collar, 0), part(nacelle, 0), ...blades]);
}

/** A turbine on the ridge: [x, z, scale]. */
export type TurbineSite = readonly [x: number, z: number, scale: number];

export function Turbines({ sites, seed = 17 }: { sites: readonly TurbineSite[]; seed?: number }) {
  const geometry = useDisposable(() => {
    const rand = makeRandom(seed);
    const base = buildTurbine();
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
    const bases = new Float32Array(sites.length * 3);
    const params = new Float32Array(sites.length * 4);
    sites.forEach(([x, z, s], i) => {
      bases.set([x, landHeight(x, z) - 0.6, z], i * 3);
      // Yaw (facing the breeze, three-quarters towards us), scale, rotor phase, speed.
      params.set([0.42 + rand.range(-0.12, 0.12), s, rand.range(0, Math.PI * 2), rand.range(0.5, 0.68)], i * 4);
    });
    g.setAttribute('aBase', new THREE.InstancedBufferAttribute(bases, 3));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    g.instanceCount = sites.length;
    return g;
  }, [sites, seed]);

  const material = useDisposable(() =>
    shaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { ...fx, uHub: { value: HUB }, uWhite: { value: new THREE.Color('#ffffff') } },
      vertexShader: /* glsl */ `
        attribute float aRotor;
        attribute vec3 aBase;
        attribute vec4 aParams;
        uniform float uTime;
        uniform vec3 uHub;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vRotor;
        vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
        void main() {
          vec3 p = position;
          vec3 n = normal;
          if (aRotor > 0.5) {
            float a = aParams.z - uTime * aParams.w;
            p.xy = rot(p.xy, a);
            n.xy = rot(n.xy, a);
            p += uHub;
          }
          // Yaw about the tower: local +z (the rotor's axis) turns towards (sin yaw, cos yaw).
          p.zx = rot(p.zx, aParams.x);
          n.zx = rot(n.zx, aParams.x);
          vec3 world = aBase + p * aParams.y;
          vWorld = world;
          vNormal = n;
          vRotor = aRotor;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uWhite;
        ${skyGLSL}
        ${landGLSL}
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vRotor;
        void main() {
          vec3 n = normalize(vNormal);
          if (!gl_FrontFacing) n = -n;
          vec3 toCam = cameraPosition - vWorld;
          vec3 v = normalize(toCam);
          float dif = clamp((dot(n, uKeyDir) + 0.35) / 1.35, 0.0, 1.0);
          vec3 col = uWhite * (uKeyColor * dif * 0.95 + ambient(n) * 1.35 + 0.12);
          // Glossy white enamel: a crisp key highlight, the sky in the edges, a sunny rim.
          vec3 hk = normalize(uKeyDir + v);
          col += uKeyColor * (pow(max(dot(n, hk), 0.0), 60.0) * 1.8 + pow(max(dot(n, hk), 0.0), 8.0) * 0.25);
          float f = pow(1.0 - abs(dot(n, v)), 3.0);
          vec3 r = reflect(-v, n);
          col = mix(col, skyGradient(vec3(r.x, abs(r.y), r.z)) * 1.25, f * 0.55);
          vec3 hs = normalize(uSunDir + v);
          float glint = pow(max(dot(n, hs), 0.0), 160.0);
          col += uSunColor * glint * mix(3.0, 7.0, vRotor);
          col += uGlow * f * pow(max(dot(-v, uSunDir), 0.0), 6.0) * 0.8;
          col = applyHaze(col, vWorld, 1.0);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
