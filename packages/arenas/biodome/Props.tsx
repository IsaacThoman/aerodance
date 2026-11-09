import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { Ball, Paddle, PADDLE_REST } from '../shared/Gear.tsx';
import { TABLE } from '../shared/Table.tsx';
import { PLANTERS, PLANTER_TOP } from './layout.ts';
import { gardenParts } from './Garden.tsx';
import { instanced, merge } from './shading.ts';

// The court's things, in the deck's glossy white and timber: an umpire's chair, slatted benches
// with towels and bottles, a bowl of balls, fiddlehead lamps with glowing seed-pod globes,
// planters, and the garden bed at the far end (Garden.tsx).

const WHITE = '#f5faf9';

// ------------------------------------------------------------------ printed graphics

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

const texture = (c: HTMLCanvasElement) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

function towelTexture(base: string, stripe: string): THREE.CanvasTexture {
  const [c, g] = canvas(128, 256);
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 256);
  g.fillStyle = stripe;
  g.fillRect(0, 24, 128, 14);
  g.fillRect(0, 218, 128, 14);
  const rand = makeRandom(base.length);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rand.chance(0.5) ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    g.fillRect(rand.range(0, 128), rand.range(0, 256), 2, 2);
  }
  return texture(c);
}

// ------------------------------------------------------------------ geometry

const placed = (g: THREE.BufferGeometry, x: number, y: number, z: number, yaw = 0) => g.rotateY(yaw).translate(x, y, z);

function tube(points: THREE.Vector3[], radius: number, segments = 24, radial = 8) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, radius, radial);
}

function buildProps() {
  const white: THREE.BufferGeometry[] = [];
  const timber: THREE.BufferGeometry[] = [];
  const soil: THREE.BufferGeometry[] = [];
  const chrome: THREE.BufferGeometry[] = [];

  // Planters: glossy white bowls, soil inside.
  for (const [x, z, r] of PLANTERS) {
    const profile = [[0.02, 0], [r * 0.62, 0], [r * 0.7, 0.04], [r * 0.98, PLANTER_TOP * 0.7], [r, PLANTER_TOP], [r * 0.93, PLANTER_TOP + 0.02], [r * 0.88, PLANTER_TOP - 0.06]]
      .map(([a, b]) => new THREE.Vector2(a, b));
    white.push(new THREE.LatheGeometry(profile, 40).translate(x, 0, z));
    soil.push(new THREE.CircleGeometry(r * 0.89, 32).rotateX(-Math.PI / 2).translate(x, PLANTER_TOP - 0.04, z));
  }
  const garden = gardenParts();
  white.push(...garden.white);
  soil.push(...garden.soil);

  // The umpire's chair, by the net on the +x side, facing the table.
  {
    const x = 2.75, z = 0, yaw = -Math.PI / 2;
    const parts: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      parts.push(tube([new THREE.Vector3(sx * 0.3, 0, sz * 0.32), new THREE.Vector3(sx * 0.22, 0.6, sz * 0.22), new THREE.Vector3(sx * 0.2, 1.02, sz * 0.2)], 0.025, 8, 8));
    }
    parts.push(new RoundedBoxGeometry(0.56, 0.06, 0.52, 3, 0.025).translate(0, 1.05, 0));
    parts.push(new RoundedBoxGeometry(0.56, 0.5, 0.05, 3, 0.022).translate(0, 1.36, -0.26).rotateX(-0.12));
    parts.push(new RoundedBoxGeometry(0.5, 0.035, 0.18, 2, 0.012).translate(0, 0.55, 0.3));
    for (const sx of [-1, 1]) parts.push(new RoundedBoxGeometry(0.05, 0.05, 0.42, 2, 0.02).translate(sx * 0.27, 1.27, 0.0));
    parts.forEach((p) => white.push(placed(p, x, 0, z, yaw)));
  }

  // Benches: timber slats on white legs, one each side.
  const bench = (x: number, z: number, yaw: number) => {
    const len = 2.1;
    for (let i = 0; i < 4; i++) timber.push(placed(new RoundedBoxGeometry(len, 0.035, 0.085, 2, 0.012).translate(0, 0.45, -0.15 + i * 0.1), x, 0, z, yaw));
    for (let i = 0; i < 3; i++) timber.push(placed(new RoundedBoxGeometry(len, 0.08, 0.03, 2, 0.012).rotateX(0.18).translate(0, 0.62 + i * 0.11, -0.25), x, 0, z, yaw));
    for (const s of [-1, 1]) {
      white.push(placed(tube([new THREE.Vector3(s * (len / 2 - 0.15), 0, 0.17), new THREE.Vector3(s * (len / 2 - 0.15), 0.43, 0.15), new THREE.Vector3(s * (len / 2 - 0.15), 0.43, -0.2), new THREE.Vector3(s * (len / 2 - 0.15), 0.9, -0.28)], 0.022, 16, 8), x, 0, z, yaw));
      white.push(placed(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 14).translate(s * (len / 2 - 0.15), 0.01, 0.17), x, 0, z, yaw));
      white.push(placed(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 14).translate(s * (len / 2 - 0.15), 0.01, -0.12), x, 0, z, yaw));
    }
  };
  bench(4.45, -2.3, -Math.PI / 2);
  bench(-4.45, -2.6, Math.PI / 2);

  // The ball bowl: a white tripod holding a glass bowl of balls, by the far corner.
  const bowl = { x: 3.75, z: -4.75, y: 0.78 };
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    white.push(tube([new THREE.Vector3(bowl.x + Math.sin(a) * 0.32, 0, bowl.z + Math.cos(a) * 0.32), new THREE.Vector3(bowl.x + Math.sin(a) * 0.16, bowl.y - 0.15, bowl.z + Math.cos(a) * 0.16)], 0.018, 4, 8));
  }
  white.push(new THREE.TorusGeometry(0.2, 0.02, 8, 32).rotateX(Math.PI / 2).translate(bowl.x, bowl.y - 0.14, bowl.z));

  // Fiddlehead lamps: a white stem uncurling into a crozier, a glowing globe at its heart.
  const lamps: THREE.Vector3[] = [];
  for (const [x, z] of [[4.72, 3.7], [-4.72, 3.7], [4.72, -3.9], [-4.72, -3.9]] as const) {
    const pts: THREE.Vector3[] = [];
    const out = x > 0 ? -1 : 1;
    for (let i = 0; i <= 10; i++) pts.push(new THREE.Vector3(x, (i / 10) * 2.3, z));
    // The crozier: a spiral curling inwards towards the court.
    const cx = x + out * 0.28, cy = 2.3;
    for (let i = 1; i <= 26; i++) {
      const t = i / 26;
      const a = Math.PI - t * Math.PI * 1.75;
      const r = 0.28 * (1 - t * 0.55);
      pts.push(new THREE.Vector3(cx + out * Math.cos(a) * r, cy + Math.sin(a) * r, z));
    }
    white.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.032, 8));
    white.push(new THREE.CylinderGeometry(0.12, 0.15, 0.06, 20).translate(x, 0.03, z));
    lamps.push(new THREE.Vector3(cx + out * 0.02, cy + 0.02, z));
  }


  // Water bottles: aqua glass with white caps.
  const bottles: [number, number, number][] = [[4.3, 0.47, -1.6], [4.38, 0.47, -1.75], [-4.4, 0.47, -3.3], [3.05, 0, 0.55]];
  for (const [x, y, z] of bottles) {
    chrome.push(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 14).translate(x, y + 0.1, z));
    white.push(new THREE.CylinderGeometry(0.022, 0.03, 0.05, 12).translate(x, y + 0.225, z));
  }

  return {
    white: merge(white),
    timber: merge(timber),
    soil: merge(soil),
    bottles: merge(chrome),
    lamps,
    bowl,
  };
}

/** Balls heaped in the bowl: [x, y, z, orange?]. */
function heap(cx: number, cy: number, cz: number): [number, number, number, boolean][] {
  const rand = makeRandom(88);
  const out: [number, number, number, boolean][] = [];
  const r = TABLE.ball / 2;
  for (let layer = 0; layer < 4; layer++) {
    const ring = 0.05 + layer * 0.045;
    const n = Math.floor((Math.PI * 2 * ring) / (r * 2.1));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + layer;
      out.push([cx + Math.sin(a) * ring, cy - 0.13 + layer * 0.03 + Math.pow(ring / 0.2, 2) * 0.05, cz + Math.cos(a) * ring, rand.chance(0.35)]);
    }
  }
  for (let i = 0; i < 9; i++) out.push([cx + rand.range(-0.08, 0.08), cy - 0.02 + rand.range(0, 0.04), cz + rand.range(-0.08, 0.08), rand.chance(0.35)]);
  return out;
}

export function Props() {
  const parts = useDisposable(buildProps);
  const materials = useDisposable(() => {
    const towelA = towelTexture('#2fc7b0', '#ffffff');
    const towelB = towelTexture('#a6e22e', '#ffffff');
    return {
      maps: [towelA, towelB],
      white: new THREE.MeshPhysicalMaterial({ color: WHITE, roughness: 0.18, metalness: 0.05, clearcoat: 0.9, clearcoatRoughness: 0.06, side: THREE.DoubleSide }),
      timber: new THREE.MeshPhysicalMaterial({ color: '#d9a86a', roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.15 }),
      soil: new THREE.MeshStandardMaterial({ color: '#2a2016', roughness: 1 }),
      bottles: new THREE.MeshPhysicalMaterial({ color: '#7ff0e0', roughness: 0.05, transmission: 0, transparent: true, opacity: 0.75, clearcoat: 1, emissive: '#1a8a7a', emissiveIntensity: 0.3 }),
      glass: new THREE.MeshPhysicalMaterial({ color: '#dffcf4', roughness: 0.05, transparent: true, opacity: 0.28, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide }),
      towelA: new THREE.MeshStandardMaterial({ map: towelA, roughness: 0.95 }),
      towelB: new THREE.MeshStandardMaterial({ map: towelB, roughness: 0.95 }),
      globe: new THREE.MeshBasicMaterial({ color: new THREE.Color('#eafff6').multiplyScalar(1.6) }),
      halo: shaderMaterial({
        uniforms: {},
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      ballWhite: new THREE.MeshPhysicalMaterial({ color: '#fbfbf7', roughness: 0.32, clearcoat: 0.35 }),
      ballOrange: new THREE.MeshPhysicalMaterial({ color: '#ff8a1e', roughness: 0.32, clearcoat: 0.35 }),
    };
  });
  const geo = useDisposable(() => {
    // A towel draped over a bench's seat edge and down its front.
    const towel = new THREE.PlaneGeometry(0.42, 0.9, 6, 18);
    const p = towel.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) + 0.45;
      // Flat over the seat for the first half, then hanging down the front.
      const flat = Math.min(y, 0.36);
      const hang = Math.max(0, y - 0.36);
      p.setXYZ(i, p.getX(i) + Math.sin(y * 9) * 0.01, -hang + Math.sin(p.getX(i) * 14 + y * 6) * 0.006, flat + hang * 0.12);
    }
    towel.computeVertexNormals();
    const balls = heap(parts.bowl.x, parts.bowl.y, parts.bowl.z);
    const sphere = new THREE.SphereGeometry(TABLE.ball / 2, 12, 8);
    return {
      towel,
      bowlGlass: new THREE.SphereGeometry(0.22, 28, 12, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55).translate(parts.bowl.x, parts.bowl.y, parts.bowl.z),
      globes: merge(parts.lamps.map((p) => new THREE.SphereGeometry(0.11, 18, 12).translate(p.x, p.y, p.z))),
      halos: halos(parts.lamps),
      sphere,
      balls,
    };
  });
  const whiteBalls = geo.balls.filter((b) => !b[3]);
  const orangeBalls = geo.balls.filter((b) => b[3]);
  return (
    <>
      <mesh geometry={parts.white} material={materials.white} castShadow receiveShadow />
      <mesh geometry={parts.timber} material={materials.timber} castShadow receiveShadow />
      <mesh geometry={parts.soil} material={materials.soil} receiveShadow />
      <mesh geometry={parts.bottles} material={materials.bottles} />
      <mesh geometry={geo.bowlGlass} material={materials.glass} renderOrder={52} />
      <instancedMesh args={[geo.sphere, materials.ballWhite, whiteBalls.length]} ref={(m) => placeBalls(m, whiteBalls)} />
      <instancedMesh args={[geo.sphere, materials.ballOrange, orangeBalls.length]} ref={(m) => placeBalls(m, orangeBalls)} />
      {/* Towels over the benches. */}
      <mesh geometry={geo.towel} material={materials.towelA} position={[4.62, 0.475, -1.85]} rotation={[0, -Math.PI / 2, 0]} castShadow />
      <mesh geometry={geo.towel} material={materials.towelB} position={[-4.62, 0.475, -2.0]} rotation={[0, Math.PI / 2, 0]} castShadow />
      <mesh geometry={geo.globes} material={materials.globe} />
      <mesh geometry={geo.halos} material={materials.halo} frustumCulled={false} renderOrder={45} />
      {/* Spare paddles and a ball on the far bench. */}
      <Paddle position={[-4.42, 0.47 + PADDLE_REST, -3.0]} rotation={[-Math.PI / 2, 0, 0.3]} rubbers={['#e8323c', '#14202a']} handle="#2fc7b0" />
      <Ball position={[4.1, TABLE.ball / 2, 3.1]} color="#ff8a1e" />
    </>
  );
}

// Soft glows round the lamps' globes, facing the camera.
const HALO_VERTEX = /* glsl */ `
attribute vec3 aCenter;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = viewMatrix * vec4(aCenter, 1.0);
  mv.xy += position.xy * 0.9;
  gl_Position = projectionMatrix * mv;
}
`;
const HALO_FRAGMENT = /* glsl */ `
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = exp(-r * r * 5.0) * 0.32 + exp(-r * r * 30.0) * 0.4;
  gl_FragColor = vec4(vec3(0.75, 1.0, 0.92) * a, 1.0);
}
`;

function halos(points: THREE.Vector3[]): THREE.InstancedBufferGeometry {
  const centres = new Float32Array(points.length * 3);
  points.forEach((p, i) => centres.set(p.toArray(), i * 3));
  return instanced(new THREE.PlaneGeometry(1, 1), points.length, { aCenter: [3, centres] });
}

function placeBalls(mesh: THREE.InstancedMesh | null, balls: [number, number, number, boolean][]) {
  if (!mesh) return;
  const m = new THREE.Matrix4();
  balls.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}
