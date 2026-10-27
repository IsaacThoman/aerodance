import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { LAYOUT_GLSL, PLATFORM, WATER_Y } from './layout.ts';
import { LOOK_UNIFORMS, useAtrium } from './shading.ts';

// The dancers' stage: a round white platform reaching into the pool in front of the column, its
// top polished and inlaid with a soft sunburst, a glass rim lit from within that pulses on the
// beat, and a ring of light where it meets the water.

const { r: R, top: TOP } = PLATFORM;

/** The platform's top: pale, with fine concentric grooves and a faint lime and aqua sunburst. */
function makeFloorTexture(ring: readonly [string, string]): THREE.CanvasTexture {
  const s = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const m = s / 2;
  const g = ctx.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.7, '#f6fafc');
  g.addColorStop(0.9, '#eef5f8');
  g.addColorStop(1, '#e2edf2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // A sunburst of petals in the look's two colours.
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    ctx.save();
    ctx.translate(m, m);
    ctx.rotate(a);
    const pg = ctx.createLinearGradient(m * 0.12, 0, m * 0.82, 0);
    pg.addColorStop(0, `${ring[i % 2]}38`);
    pg.addColorStop(1, `${ring[i % 2]}00`);
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.moveTo(m * 0.12, 0);
    ctx.quadraticCurveTo(m * 0.45, m * 0.07, m * 0.82, 0);
    ctx.quadraticCurveTo(m * 0.45, -m * 0.07, m * 0.12, 0);
    ctx.fill();
    ctx.restore();
  }
  // Fine concentric grooves, every fourth a little stronger.
  for (let i = 1; i < 16; i++) {
    ctx.beginPath();
    ctx.arc(m, m, (i / 16) * m * 0.96, 0, Math.PI * 2);
    ctx.strokeStyle = i % 4 === 0 ? 'rgba(120,170,195,0.45)' : 'rgba(150,190,210,0.18)';
    ctx.lineWidth = i % 4 === 0 ? 4 : 2;
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** The glass rim and the light at the waterline: bright bands in the look's colours, on the beat. */
const glowFragment = /* glsl */ `
${LOOK_UNIFORMS}
${LAYOUT_GLSL}
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uStrength;
uniform float uWater;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  float a = atan(vWorld.x, vWorld.z);
  // The two colours chase each other round the rim.
  float k = sin(a * 3.0 - uTime * 0.6) * 0.5 + 0.5;
  vec3 col = mix(uColorA, uColorB, k);
  float pulse = 0.65 + 0.55 * uBeat;
  float alpha;
  if (uWater > 0.5) {
    // A soft spill on the water, brightest at the platform.
    float d = vUv.y;
    alpha = exp(-d * 4.0) * 0.55 * smoothstep(POOL_R, POOL_R - 0.3, length(vWorld.xz - AXIS.xz));
  } else {
    // A bright core band through the middle of the rim.
    float y = abs(vUv.y - 0.5) * 2.0;
    alpha = mix(0.35, 1.0, exp(-y * y * 6.0));
  }
  gl_FragColor = vec4(col * alpha * uStrength * pulse, 1.0);
}
`;

const glowVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** A ring band between two radii (water) or a short wall at radius r (rim), uv.y 0..1 across it. */
function band(r0: number, r1: number, y0: number, y1: number, segments = 128): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, segments, 1, true);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const t = uv.getY(i);
    const a = Math.atan2(p.getX(i), p.getZ(i));
    const r = THREE.MathUtils.lerp(r0, r1, 1 - t);
    p.setXYZ(i, Math.sin(a) * r, THREE.MathUtils.lerp(y0, y1, t), Math.cos(a) * r);
    uv.setY(i, 1 - t);
  }
  g.computeVertexNormals();
  return g;
}

export function Platform() {
  const { look, uniforms } = useAtrium();
  const geo = useDisposable(() => {
    // The deck, a rounded white lip, and the body down into the water.
    const lathe = (points: [number, number][], segments = 128) =>
      new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
    return {
      top: new THREE.CircleGeometry(R - 0.32, 128).rotateX(-Math.PI / 2).translate(0, TOP, 0),
      lip: lathe([[R - 0.32, TOP], [R - 0.08, TOP - 0.01], [R + 0.02, TOP - 0.07], [R + 0.04, TOP - 0.16]]),
      body: lathe([[R + 0.04, TOP - 0.36], [R + 0.08, TOP - 0.5], [R + 0.3, 0.02], [R + 0.36, -0.2]]),
      rim: band(R + 0.042, R + 0.042, TOP - 0.36, TOP - 0.16),
      water: band(R + 0.36, R + 2.6, WATER_Y + 0.01, WATER_Y + 0.01),
    };
  });
  const floorTexture = useDisposable(() => makeFloorTexture(look.ring));
  const mats = useDisposable(() => {
    const glow = (water: boolean) =>
      shaderMaterial({
        uniforms: {
          ...uniforms,
          uColorA: { value: new THREE.Color(look.ring[0]) },
          uColorB: { value: new THREE.Color(look.ring[1]) },
          uStrength: { value: look.ringGlow * (water ? 0.8 : 1.6) },
          uWater: { value: water ? 1 : 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        vertexShader: glowVertex,
        fragmentShader: glowFragment,
      });
    return {
      // Lit by the key, the fill and the reflections like the dancers, so it needs far less of the
      // bright environment than they do, or it outshines the room.
      top: new THREE.MeshPhysicalMaterial({ color: look.platform, map: floorTexture, roughness: 0.32, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.25, envMapIntensity: 0.3 }),
      white: new THREE.MeshPhysicalMaterial({ color: look.platform, roughness: 0.25, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 0.45 }),
      rim: glow(false),
      water: glow(true),
    };
  });
  return (
    <group>
      <mesh geometry={geo.top} material={mats.top} receiveShadow />
      <mesh geometry={geo.lip} material={mats.white} receiveShadow />
      <mesh geometry={geo.body} material={mats.white} receiveShadow />
      <mesh geometry={geo.rim} material={mats.rim} renderOrder={3} />
      <mesh geometry={geo.water} material={mats.water} renderOrder={3} />
    </group>
  );
}
