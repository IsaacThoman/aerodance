import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { createLakeNormalPixels } from '../aero/lakeNormals.ts';
import { mulberry32 } from '../aero/random.ts';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { StageEnvironment } from '../../../../packages/stages/shared/Environment.tsx';
import { CloudField, SkyDome } from '../../../../packages/stages/shared/Sky.tsx';
import { reducedMotion, useDisposable } from '../../../../packages/stages/shared/hooks.ts';
import ScenicCamera from './ScenicCamera.tsx';
import type { ScenicShot } from './ScenicCamera.tsx';

const SHOTS: readonly ScenicShot[] = [
  {
    fov: 36,
    frame(camera, t) {
      camera.position.set(5.7 + Math.sin(t * 0.07) * 0.86, 4.95, 10.62);
      camera.lookAt(0, 1.96, 0);
    },
  },
  {
    fov: 35,
    frame(camera, t) {
      camera.position.set(-8.55, 3.14 + Math.sin(t * 0.07) * 0.19, 6.25 + Math.sin(t * 0.049) * 0.7);
      camera.lookAt(-0.1, 1.94, 0.09);
    },
  },
];
const COLORS = ['#ff6547', '#ff9633', '#ffcd39', '#d3e936', '#8ee84b', '#35d79d', '#20c7cf', '#36aafc', '#677de9', '#9868e3', '#d565d9', '#f47caa'];
const BEAM_Y = 4.1;
const PITCH = 0.68;
const X = (i: number) => (i - (COLORS.length - 1) * 0.5) * PITCH;

function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, sides = 12) {
  const axis = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(radius, radius, axis.length(), sides, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
  const center = a.clone().lerp(b, 0.5);
  return g.applyQuaternion(q).translate(center.x, center.y, center.z);
}

function joined(parts: THREE.BufferGeometry[]) {
  const all = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  return all;
}

// The pavilion has a single cantilevered rail. Keeping the front open leaves
// a clear line of sight to the wave from either end.
function Rail() {
  const metal = useDisposable(() => {
    const parts: THREE.BufferGeometry[] = [];
    for (const dir of [-1, 1]) {
      const x = dir * 4.52;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 0.33, -1.43), new THREE.Vector3(x + dir * 0.03, 1.3, -1.39),
        new THREE.Vector3(x + dir * 0.02, 3.43, -0.82), new THREE.Vector3(x - dir * 0.05, 3.99, -0.41),
        new THREE.Vector3(x - dir * 0.35, BEAM_Y, 0),
      ]);
      parts.push(new THREE.TubeGeometry(curve, 38, 0.11, 14, false));
    }
    parts.push(rod(new THREE.Vector3(-4.22, BEAM_Y, 0), new THREE.Vector3(4.22, BEAM_Y, 0), 0.095, 24));
    return joined(parts);
  });
  return <mesh geometry={metal} castShadow><meshStandardMaterial color="#7cb1b2" metalness={0.82} roughness={0.22} /></mesh>;
}

function Pendulums() {
  const mounts = useRef<THREE.Group>(null);
  const elapsed = useRef(8.2);
  const pendulums = useDisposable(() => COLORS.map((_, i) => {
    // The square-root law of a pendulum's period: each successive string
    // makes one additional swing in the same 100-second repeat interval.
    const length = 3.02 * (40 / (40 + i)) ** 2;
    const apex = new THREE.Vector3(0, -length + 0.28, 0);
    return {
      string: joined([
        rod(new THREE.Vector3(-0.2, 0, 0), apex, 0.012, 8),
        rod(new THREE.Vector3(0.2, 0, 0), apex, 0.012, 8),
      ]),
      length,
    };
  }));
  const ball = useDisposable(() => new THREE.SphereGeometry(0.32, 42, 28));
  const ferrule = useDisposable(() => new THREE.CylinderGeometry(0.049, 0.055, 0.10, 14));
  const bearing = useDisposable(() => new THREE.CylinderGeometry(0.126, 0.126, 0.45, 20).rotateZ(Math.PI / 2));
  const bright = useDisposable(() => new THREE.MeshStandardMaterial({ color: '#9babad', metalness: 0.78, roughness: 0.23 }));
  const wire = useDisposable(() => new THREE.MeshStandardMaterial({ color: '#637277', metalness: 0.52, roughness: 0.3 }));
  useFrame((_, dt) => {
    const time = elapsed.current = (elapsed.current + Math.min(dt, 0.1) * (reducedMotion ? 0.42 : 1)) % 100;
    mounts.current?.children.forEach((swing, i) => {
      swing.rotation.x = 0.61 * Math.cos(time * Math.PI * 2 * (40 + i) / 100);
    });
  });
  return <group ref={mounts} position-y={BEAM_Y}>
    {pendulums.map(({ length, string }, i) => <group key={i} position-x={X(i)}>
      <mesh geometry={bearing} material={bright} />
      <mesh geometry={string} material={wire} castShadow />
      <mesh geometry={ferrule} material={bright} position-y={-length + 0.32} />
      <mesh geometry={ball} position-y={-length} castShadow>
        <meshPhysicalMaterial color={COLORS[i]} metalness={0.38} roughness={0.12} clearcoat={0.86} clearcoatRoughness={0.065} />
      </mesh>
    </group>)}
  </group>;
}

function PolishedDeck() {
  const geometry = useDisposable(() => new THREE.PlaneGeometry(9.44, 3.36));
  const surface = useDisposable(() => {
    const mesh = new Reflector(geometry, { textureWidth: 320, textureHeight: 240, multisample: 0, clipBias: 0.002 });
    const material = mesh.material as THREE.ShaderMaterial;
    // The steel under the glass receives the shadows. The coating catches a
    // softer, partial reflection of the swinging bobs and their support.
    material.transparent = true;
    material.depthWrite = false;
    material.fragmentShader = `
      uniform sampler2D tDiffuse;
      varying vec4 vUv;
      void main() {
        gl_FragColor = vec4(texture2DProj(tDiffuse, vUv).rgb, 0.43);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `;
    return mesh;
  }, [geometry]);
  return <primitive object={surface} rotation-x={-Math.PI / 2} position-y={0.407} />;
}

function Pool() {
  const normals = useDisposable(() => {
    const data = createLakeNormalPixels(128, [[3, 1, 0.4, 0.63], [-1, 6, 0.7, 0.55], [6, 4, 1.2, 0.29], [11, -2, 0.2, 0.11]]);
    const texture = new THREE.DataTexture(new Uint8Array(data.buffer), 128, 128);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(185, 185);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  });
  useFrame((_, delta) => { normals.offset.x = (normals.offset.x + Math.min(delta, 0.1) * 0.028) % 1; });
  return <mesh rotation-x={-Math.PI / 2} position-y={-0.68}>
    <planeGeometry args={[800, 800]} />
    <meshStandardMaterial color="#2489a3" roughness={0.18} metalness={0.33} normalMap={normals} normalScale={[0.45, 0.45]} />
  </mesh>;
}

function Pavilion() {
  const base = useDisposable(() => new RoundedBoxGeometry(10.08, 0.56, 3.94, 5, 0.26));
  const trim = useDisposable(() => new RoundedBoxGeometry(10.0, 0.15, 3.88, 4, 0.07));
  const deck = useDisposable(() => new RoundedBoxGeometry(9.88, 0.17, 3.8, 4, 0.082));
  const rims = useDisposable(() => {
    const rings = [14.2, 14.48, 19.6].map(radius => new THREE.TorusGeometry(radius, 0.031, 8, 160).rotateX(Math.PI / 2).translate(0, radius < 16 ? -0.264 : -0.673, 0));
    return joined(rings);
  });
  return <>
    <mesh geometry={base} position-y={0.02} receiveShadow castShadow><meshStandardMaterial color="#e9f8f3" roughness={0.21} metalness={0.23} /></mesh>
    <mesh geometry={trim} position-y={0.268}><meshStandardMaterial color="#3da5a9" metalness={0.48} roughness={0.23} /></mesh>
    <mesh geometry={deck} position-y={0.319} receiveShadow><meshStandardMaterial color="#4f8e94" metalness={0.25} roughness={0.3} /></mesh>
    <mesh position-y={-0.42} receiveShadow><cylinderGeometry args={[16.2, 16.8, 0.31, 128]} /><meshStandardMaterial color="#acc1c0" /></mesh>
    <mesh geometry={rims}><meshStandardMaterial color="#51928e" roughness={0.33} /></mesh>
    <Pool />
    <PolishedDeck />
    <Rail />
    <Pendulums />
  </>;
}

// Low islands and wind turbines across the reflecting pool give the gallery a
// horizon. All nine blades share one mesh per rotor.
function Horizon() {
  const rotors = useRef<THREE.Group>(null);
  const hills = useDisposable(() => {
    const g = new THREE.SphereGeometry(1, 64, 36);
    const pos = g.attributes.position;
    const colors = [];
    const green = new THREE.Color('#29764f'), lime = new THREE.Color('#7aa441'), tone = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const ridges = 0.78 + 0.12 * Math.sin(x * 7.5 + z * 1.8) + 0.09 * Math.sin(z * 6.2 - x * 4);
      pos.setY(i, y * ridges);
      tone.copy(green).lerp(lime, Math.max(0, y) * (0.6 + 0.3 * Math.sin(x * 8 + z * 4)));
      colors.push(tone.r, tone.g, tone.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const tree = new THREE.SphereGeometry(1, 9, 6);
    const rnd = mulberry32(48);
    const parts: THREE.BufferGeometry[] = [];
    const islands = [
      [-33, -5.4, -38, 29, 9, 12], [4, -8.5, -52, 38, 13.3, 19], [37, -7.7, -35, 25, 14.0, 17],
      [51, -8.6, -1, 26, 13.8, 16], [-45, -9.1, 20, 25, 13.9, 20],
    ];
    for (const [x,y,z,w,h,d] of islands) {
      parts.push(g.clone().scale(w,h,d).translate(x,y,z));
      // Small stands on the crest make the scale of the distant islands visible.
      for (let i = 0; i < 65; i++) {
        const nx = rnd() * 1.7 - 0.85, nz = rnd() * 1.5 - 0.68;
        const ridge = 0.78 + 0.12 * Math.sin(nx * 7.5 + nz * 1.8) + 0.09 * Math.sin(nz * 6.2 - nx * 4);
        const height = y + Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)) * ridge * h;
        if (height < -0.34) continue;
        const r = 0.22 + rnd() * 0.39;
        const canopy = tree.clone().scale(r, r * 2.3, r).translate(x + nx * w, height + r * 0.45, z + nz * d);
        tone.set(rnd() < 0.5 ? '#458259' : '#5f943b');
        const c = new Float32Array(canopy.attributes.position.count * 3);
        for (let j = 0; j < c.length; j += 3) tone.toArray(c, j);
        canopy.setAttribute('color', new THREE.BufferAttribute(c, 3));
        parts.push(canopy);
      }
    }
    tree.dispose();
    g.dispose();
    return joined(parts);
  });
  const blades = useDisposable(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(-0.13, 0.9, -0.21, 2.0, 0.07, 3.72);
    shape.bezierCurveTo(0.19, 3.79, 0.43, 1.04, 0.18, 0.36);
    shape.closePath();
    const blade = new THREE.ShapeGeometry(shape);
    const rotor = joined([0, 1, 2].map(i => blade.clone().rotateZ(i * Math.PI * 2 / 3)));
    blade.dispose();
    return rotor;
  });
  const sites = [[-30, 2.7, -40], [-22, 2.65, -43], [31, 3.8, -36]];
  useFrame((_, delta) => { rotors.current?.children.forEach((r,i) => { r.rotation.z -= Math.min(delta, 0.1) * (0.36 + 0.035 * i); }); });
  return <>
    <mesh geometry={hills}><meshStandardMaterial vertexColors roughness={1} /></mesh>
    {sites.map(([x,y,z]) => <mesh key={x} position={[x,y,z]}><cylinderGeometry args={[0.1, 0.18, 6, 16]} /><meshStandardMaterial color="#e1eee8" /></mesh>)}
    <group ref={rotors}>{sites.map(([x,y,z]) => <mesh key={x} position={[x, y + 3, z + 0.18]} scale={0.65} geometry={blades}><meshStandardMaterial color="#e1eee8" side={THREE.DoubleSide} /></mesh>)}</group>
  </>;
}

export default function Mobile({ view }: { view: number; clock: boolean }) {
  return <>
    <ScenicCamera view={view} shots={SHOTS} />
    <fog attach="fog" args={['#addbe2', 25, 149]} />
    <SkyDome top="#258de9" horizon="#c7f4ff" sunDirection={[-0.45, 0.53, -1]} sunGlow={0.7} />
    <CloudField count={19} center={[0, 12, -53]} area={[142, 33]} heightJitter={11} size={[5, 12]} speed={0.33} opacity={0.54} />
    <StageEnvironment preset="room" intensity={0.51} />
    <hemisphereLight args={['#c9edff', '#66848a', 0.67]} />
    <directionalLight position={[-4, 9, 5]} intensity={1.85} color="#fff1d4" castShadow shadow-mapSize={[1024,1024]} shadow-camera-left={-7} shadow-camera-right={7} shadow-camera-top={6} shadow-camera-bottom={-6} shadow-normalBias={0.02} />
    <Pavilion />
    <Horizon />
  </>;
}
