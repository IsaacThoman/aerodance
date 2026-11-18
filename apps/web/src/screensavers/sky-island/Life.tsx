import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { shaderMaterial } from '../../../../../packages/stages/shared/glsl.ts';
import { makeRandom } from '../../../../../packages/stages/shared/random.ts';
import { GREENHOUSE, TREES, groundHeight } from './layout.ts';
import { W, commonGLSL } from './world.ts';

/*
 * What grows and flies on the island: round glossy trees swaying in the wind (and the plants in
 * the greenhouse, lit warm at night), and the fireflies and glowing pollen of a clear night (motes
 * of pollen in the sun by day).
 */

// One tree, in its own units (a size-1 tree is about 4.6 tall): a trunk and a round canopy of three puffs.
function treeGeometry() {
  const tag = (geo: THREE.BufferGeometry, canopy: number) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(canopy), 1));
    return g;
  };
  const trunk = new THREE.CylinderGeometry(0.17, 0.3, 2.4, 10, 1, true);
  trunk.translate(0, 1.2, 0);
  const puff = (r: number, x: number, y: number, z: number) => { const g = new THREE.IcosahedronGeometry(r, 3); g.translate(x, y, z); return tag(g, 1); };
  return mergeGeometries([tag(trunk, 0), puff(1.55, 0, 3.15, 0), puff(1.05, 0.95, 2.6, 0.35), puff(0.95, -0.8, 2.75, -0.45)]);
}

// The trees, then the greenhouse's plants: [x, z, size, kind] (kind 3: a plant under glass, 4: a flowering one).
function plantings() {
  const rand = makeRandom(3);
  const inside: (readonly [number, number, number, number])[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rand.range(-0.25, 0.25), r = GREENHOUSE.r * (i % 3 === 0 ? 0.15 : rand.range(0.38, 0.58));
    inside.push([GREENHOUSE.x + Math.cos(a) * r, GREENHOUSE.z + Math.sin(a) * r, i % 3 === 0 ? 0.62 : rand.range(0.32, 0.45), rand.chance(0.35) ? 4 : 3]);
  }
  return [...TREES, ...inside];
}

export function Trees() {
  const geometry = useDisposable(() => {
    const base = treeGeometry();
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
    const all = plantings();
    const trees = new Float32Array(all.length * 4), kinds = new Float32Array(all.length * 2);
    all.forEach(([x, z, s, kind], i) => {
      trees.set([x, groundHeight(x, z) - 0.15, z, s], i * 4);
      kinds.set([kind, (i * 0.618) % 1], i * 2);
    });
    g.setAttribute('aTree', new THREE.InstancedBufferAttribute(trees, 4));
    g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kinds, 2));
    g.instanceCount = all.length;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      attribute float aPart;
      attribute vec4 aTree;
      attribute vec2 aKind;
      uniform float uSway, uWind;
      uniform vec2 uWindDir;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      varying float vPart;
      varying float vKind;
      void main() {
        vec3 p = position;
        // Swaying: leaning downwind and rocking, more the higher up (under glass, still).
        float high = max(p.y - 1.0, 0.0) / 3.5;
        float open = step(aKind.x, 2.5);
        float rock = sin(uSway + aKind.y * 6.2831) * (0.25 + 0.75 * uWind) + sin(uSway * 2.3 + aKind.y * 17.0) * 0.25 * uWind;
        p.xz += uWindDir * high * high * (0.1 + 0.55 * uWind) * (0.6 * uWind + rock * 0.5) * open;
        vWorld = aTree.xyz + p * aTree.w;
        vNormal = normal;
        vLocal = position;
        vPart = aPart;
        vKind = aKind.x;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vLocal;
      varying float vPart;
      varying float vKind;
      ${commonGLSL}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 leaf = vKind < 0.5 ? vec3(0.05, 0.36, 0.05) : vKind < 1.5 ? vec3(0.95, 0.42, 0.58) : vKind < 2.5 ? vec3(0.3, 0.62, 0.05) : vKind < 3.5 ? vec3(0.06, 0.42, 0.1) : vec3(0.9, 0.35, 0.5);
        float leafy = tnoise(vWorld.xz * 0.9 + vWorld.y * 0.6).r * 0.5 + tnoise(vWorld.xz * 2.3 - vWorld.y).g * 0.5;
        leaf *= 0.85 + 0.3 * leafy;
        vec3 albedo = vPart > 0.5 ? leaf : vec3(0.34, 0.22, 0.14);
        float snow = uSnowCover * smoothstep(0.35, 0.8, n.y + leafy * 0.2) * vPart * step(vKind, 2.5);
        albedo = mix(albedo, vec3(0.9, 0.93, 0.98), snow);
        float dif = clamp((dot(n, uKeyDir) + 0.35) / 1.35, 0.0, 1.0);
        // Deeper inside the canopy, darker.
        float ao = mix(0.55, 1.0, smoothstep(1.6, 3.8, vLocal.y)) * mix(1.0, 0.75, 1.0 - vPart);
        vec3 col = albedo * (uKeyColor * dif + ambient(n) * ao + flashLight(n));
        // Glossy round canopies: a soft highlight and the sky round their rims, glossier when wet.
        float nv = max(dot(n, v), 0.0);
        col += uKeyColor * keyGlint(n, v, 24.0) * (0.12 + 0.35 * uWet) * vPart * (1.0 - snow);
        col += envColor(n) * pow(max(1.0 - nv, 0.0), 3.0) * 0.22 * vPart;
        // Light through the leaves from behind.
        col += leaf * uKeyColor * pow(max(dot(-v, uKeyDir), 0.0), 5.0) * 0.35 * vPart;
        // Under glass: lit by the greenhouse's lamps at night.
        col += albedo * vec3(1.0, 0.7, 0.4) * uLamps * 0.9 * step(2.5, vKind);
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

const MOTES = 90;

/** Fireflies over the island on a clear night, glowing; motes of pollen catching the sun by day. */
export function Fireflies() {
  const geometry = useDisposable(() => {
    const rand = makeRandom(91);
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    g.setAttribute('uv', plane.attributes.uv);
    const data = new Float32Array(MOTES * 4);
    for (let i = 0; i < MOTES; i++) {
      const a = rand.range(0, Math.PI * 2), r = Math.sqrt(rand.next()) * 18;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      data.set([x, groundHeight(x, z) + rand.range(0.6, 4.2), z, rand.next()], i * 4);
    }
    g.setAttribute('aMote', new THREE.InstancedBufferAttribute(data, 4));
    g.instanceCount = MOTES;
    return g;
  });
  const material = useDisposable(() => shaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...W },
    vertexShader: /* glsl */ `
      attribute vec4 aMote;
      uniform float uTime, uFireflies, uDaylight, uOvercast, uRain;
      varying vec2 vUv;
      varying float vGlow;
      varying float vNight;
      void main() {
        float s = aMote.w * 40.0;
        vec3 c = aMote.xyz + vec3(sin(uTime * 0.31 + s) * 1.4 + sin(uTime * 0.13 + s * 2.0) * 1.2, sin(uTime * 0.41 + s * 1.3) * 0.6, cos(uTime * 0.27 + s * 0.7) * 1.4);
        float blink = smoothstep(0.35, 0.95, sin(uTime * (0.8 + aMote.w) + s * 3.0) * 0.5 + 0.5);
        float day = uDaylight * (1.0 - uOvercast) * (1.0 - uRain) * step(aMote.w, 0.5);
        vGlow = uFireflies * blink + day * 0.5;
        vNight = uFireflies;
        vec4 mv = viewMatrix * vec4(c, 1.0);
        mv.xy += position.xy * mix(0.09, 0.22, uFireflies);
        vUv = uv;
        gl_Position = vGlow < 0.003 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vGlow;
      varying float vNight;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float a = exp(-dot(p, p) * 5.0);
        vec3 col = mix(vec3(1.0, 0.98, 0.85) * 0.5, vec3(0.75, 1.0, 0.35) * 7.0, vNight);
        gl_FragColor = vec4(col * a * vGlow, 1.0);
      }
    `,
  }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={9} />;
}
