import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { reducedMotion, useDisposable } from '../../../../packages/stages/shared/hooks.ts';
import { mulberry32 } from '../aero/random.ts';
import { jellyFragment, jellyGeometry, jellyVertex } from './lagoonJellies.ts';
import { floorHeight, kelpFragment, kelpGarden, kelpVertex, sandFragment, seabed, waterFragment, waterVertex } from './lagoonReef.ts';

const bloom = [
  // x, y, z, bell radius, colour
  [2.35, 1.35, 0.8, 1.19, '#feb3a4'], [-2.6, 0.35, -0.6, 0.81, '#b1ebff'],
  [-0.75, 2, -5.6, 0.68, '#e8bdff'], [4.7, 0.1, -3.4, 0.62, '#9be4ff'],
  [-5.5, 1.8, -5, 0.71, '#ffbc9d'], [0.6, -0.15, -7.5, 0.51, '#a5e7fd'],
  [2.4, 2.35, -10, 0.49, '#deb4ee'], [-3.5, 1.2, -9.4, 0.51, '#bce9ee'],
  [5.8, 2.1, -9.5, 0.72, '#ffc4bb'], [-8.9, 0.74, -9, 0.65, '#b4e9f4'],
] as const;

// A shared vector lets all materials observe updates without per-frame uploads from React.
type WaterTime = { timeAndDay: { value: THREE.Vector2 } }

function Jelly({ index, geometry, water }: { index: number; geometry: THREE.BufferGeometry; water: WaterTime }) {
  const mesh = useRef<THREE.Mesh>(null);
  const [x, y, z, radius, color] = bloom[index];
  const phase = index * 2.4 + 0.62;
  const uniforms = useMemo(() => ({ timeAndDay: water.timeAndDay, phase: { value: phase }, hue: { value: new THREE.Color(color) } }), [water, phase, color]);
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const t = water.timeAndDay.value.x;
    m.position.set(x + 0.68 * Math.sin(t * 0.119 + phase), y + 0.32 * Math.sin(t * 0.19 + phase) + 0.07 * Math.cos(t * 1.52 + phase), z + 0.46 * Math.cos(t * 0.16 + phase));
    m.rotation.set(0.12 + 0.24 * Math.sin(t * 0.16 + phase), phase + t * 0.06, 0.25 * Math.cos(t * 0.18 + phase));
  });
  return <mesh ref={mesh} geometry={geometry} scale={radius}>
    <shaderMaterial uniforms={uniforms} vertexShader={jellyVertex} fragmentShader={jellyFragment} transparent depthWrite={false} side={THREE.DoubleSide} forceSinglePass />
  </mesh>;
}

function Stones() {
  const stones = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!stones.current) return;
    const dummy = new THREE.Object3D(), tint = new THREE.Color(), rnd = mulberry32(3275);
    for (let i = 0; i < stones.current.count; i++) {
      const x = (rnd() - 0.5) * 33, z = 4 - rnd() * 31;
      const bank = Math.min(1, Math.abs(x) / 7);
      const radius = 0.12 + rnd() ** 2 * (0.25 + 1.52 * bank);
      dummy.position.set(x, floorHeight(x, z) - 0.1, z);
      dummy.scale.set(radius * (1.1 + rnd()), radius * (0.4 + rnd() * 0.5), radius);
      dummy.rotation.set(rnd() * 0.31, rnd() * 6.28, rnd() * 0.29);
      dummy.updateMatrix();
      stones.current.setMatrixAt(i, dummy.matrix);
      tint.setRGB(0.075 + rnd() * 0.035, 0.16 + rnd() * 0.055, 0.155 + rnd() * 0.04);
      stones.current.setColorAt(i, tint);
    }
    stones.current.computeBoundingSphere();
  }, []);
  return <instancedMesh ref={stones} args={[undefined, undefined, 84]}>
    <icosahedronGeometry args={[1, 1]} /><meshStandardMaterial roughness={0.87} />
  </instancedMesh>;
}

// A sealed instrument on a mooring. The emissive display only uploads a new
// texture when the local minute changes.
function StationClock() {
  const casing = useDisposable(() => new RoundedBoxGeometry(1.88, 0.85, 0.32, 4, 0.2));
  const texture = useDisposable(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 198;
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
  const minute = useRef(-1);
  useFrame(() => {
    const now = Date.now();
    const stamp = Math.floor(now / 60000);
    if (minute.current === stamp) return;
    minute.current = stamp;
    const date = new Date(now);
    const g = texture.image.getContext('2d')!;
    g.clearRect(0, 0, 512, 198);
    const glaze = g.createLinearGradient(0, 0, 0, 198);
    glaze.addColorStop(0, '#377575');
    glaze.addColorStop(0.48, '#123f4b');
    glaze.addColorStop(0.51, '#113648');
    glaze.addColorStop(1, '#225463');
    g.fillStyle = glaze;
    g.beginPath();
    g.roundRect(0, 0, 512, 198, 48);
    g.fill();
    g.fillStyle = '#c1ffdf';
    g.font = 'bold 132px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const digits = (n: number) => String(n).padStart(2, '0');
    g.fillText(digits(date.getHours()) + ':' + digits(date.getMinutes()), 256, 104);
    texture.needsUpdate = true;
  });
  return <group position={[-3.75, -2.24, 0.63]} rotation-y={0.28}>
    <mesh position-y={-0.72}><cylinderGeometry args={[0.15, 0.31, 1.58, 20]} /><meshStandardMaterial color="#507578" metalness={0.2} /></mesh>
    <group rotation-x={-0.18}>
      <mesh geometry={casing}><meshStandardMaterial color="#8cad9e" metalness={0.49} roughness={0.25} /></mesh>
      <mesh position-z={0.163}><planeGeometry args={[1.64, 0.63]} /><meshBasicMaterial map={texture} alphaTest={0.25} /></mesh>
    </group>
  </group>;
}

function Plankton({ water }: { water: WaterTime }) {
  const geometry = useDisposable(() => {
    const rnd = mulberry32(5830), pos: number[] = [];
    for (let i = 0; i < 370; i++) pos.push((rnd() - 0.5) * 33, rnd() * 11, 5.3 - rnd() * 28);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  });
  return <points geometry={geometry} frustumCulled={false}>
    <shaderMaterial uniforms={water} transparent depthWrite={false}
      vertexShader={`
        uniform vec2 timeAndDay;
        #define time timeAndDay.x
        varying float opacity;
        void main() {
          vec3 p = position;
          p.y = mod(p.y + time * (0.11 + 0.035 * cos(p.z)), 11.) - 3.5;
          p.x += 0.14 * sin(time * 0.52 + p.y + p.z);
          vec4 mv = modelViewMatrix * vec4(p, 1.);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((12. + 4. * sin(p.x * 38.)) / -mv.z, 1., 3.5);
          opacity = 0.32 * clamp(1. + mv.z / 37., 0., 1.) * smoothstep(-3.5, -2., p.y);
        }
      `}
      fragmentShader={`
        varying float opacity;
        void main() {
          float glow = max(0., 1. - length(gl_PointCoord - 0.5) * 2.);
          gl_FragColor = vec4(0.64, 1., 0.91, glow * opacity);
          #include <colorspace_fragment>
        }
      `} />
  </points>;
}

export default function Lagoon({ view, clock }: { view: number; clock: boolean }) {
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  const water = useMemo(() => ({ timeAndDay: { value: new THREE.Vector2(0, 0.5) } }), []);
  const bell = useDisposable(jellyGeometry), sand = useDisposable(seabed), kelp = useDisposable(kelpGarden);
  const sun = useRef<THREE.DirectionalLight>(null);
  const minute = useRef(-1);
  useLayoutEffect(() => {
    camera.fov = (view === 0 ? 41 : 45) * Math.max(1, 1.52 / camera.aspect);
    camera.near = 0.08;
    camera.far = 160;
    camera.updateProjectionMatrix();
  }, [camera, camera.aspect, view]);
  useFrame((_, dt) => {
    const t = water.timeAndDay.value.x += Math.min(0.1, dt) * (reducedMotion ? 0.35 : 1);
    const stamp = Math.floor(Date.now() / 60000);
    if (stamp !== minute.current) {
      minute.current = stamp;
      const local = new Date(stamp * 60000);
      const hour = local.getHours() + local.getMinutes() / 60;
      const daylight = 0.5 - 0.5 * Math.cos(hour * Math.PI / 12);
      water.timeAndDay.value.y = daylight;
      if (sun.current) sun.current.intensity = 0.75 + 1.1 * daylight;
    }
    const sway = reducedMotion ? 0 : Math.sin(t * 0.084);
    if (view === 0) {
      camera.position.set(sway * 0.43, 0.51 + sway * 0.1, 10.7);
      camera.lookAt(0, 0.17, -1);
    } else {
      camera.position.set(-4.15 + sway * 0.56, -1.37, 7.8 + sway * 0.18);
      camera.lookAt(0.4, 0.52, -2.15);
    }
  }, -1);
  return <>
    <fogExp2 attach="fog" args={['#367886', 0.045]} />
    <hemisphereLight args={['#c0ffed', '#408889', 1.16]} />
    <directionalLight ref={sun} position={[-5, 9, 3]} color="#dafff1" intensity={1.7} />
    <mesh>
      <sphereGeometry args={[86, 40, 30]} />
      <shaderMaterial uniforms={water} vertexShader={waterVertex} fragmentShader={waterFragment} side={THREE.BackSide} depthWrite={false} />
    </mesh>
    <mesh geometry={sand}><shaderMaterial uniforms={water} vertexShader={waterVertex} fragmentShader={sandFragment} /></mesh>
    <Stones />
    <mesh geometry={kelp}><shaderMaterial uniforms={water} vertexShader={kelpVertex} fragmentShader={kelpFragment} vertexColors side={THREE.DoubleSide} /></mesh>
    {bloom.map((_, i) => <Jelly key={i} index={i} water={water} geometry={bell} />)}
    <Plankton water={water} />
    {clock && <StationClock />}
  </>;
}
