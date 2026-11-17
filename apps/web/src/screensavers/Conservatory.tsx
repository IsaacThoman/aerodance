import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import BiodomeArena, { BIODOME_FAR } from '../../../../packages/arenas/biodome/BiodomeArena.tsx';
import { WALK_TO_HUB } from '../../../../packages/arenas/biodome/layout.ts';
import { reducedMotion, useDisposable } from '../../../../packages/stages/shared/hooks.ts';
import ScenicCamera from './ScenicCamera.tsx';

const walk = new THREE.CatmullRomCurve3([...WALK_TO_HUB]);
const pathPoint = new THREE.Vector3();
const direction = new THREE.Vector3();

function walkPosition(t: number) {
  const u = 0.40 - 0.34 * Math.cos(t * 0.033);
  walk.getPointAt(u, pathPoint);
  walk.getTangentAt(u, direction);
}

const SHOTS = [
  {
    fov: 52,
    frame(camera: THREE.PerspectiveCamera, t: number) {
      camera.position.set(-6.05 + 0.2 * Math.sin(t * 0.04), 2.02 + 0.10 * Math.sin(t * 0.043), 2.93 + 0.65 * Math.sin(t * 0.028));
      camera.lookAt(-16.6, 3.68 + 0.32 * Math.sin(t * 0.035), -3.48);
    },
  },
  {
    fov: 59,
    frame(camera: THREE.PerspectiveCamera, t: number) {
      walkPosition(t);
      camera.position.copy(pathPoint).y += 1.82;
      pathPoint.addScaledVector(direction, 5.5);
      camera.lookAt(pathPoint.x, pathPoint.y + 1.88, pathPoint.z);
    },
  },
];

// The blue morpho's broad forewing and scalloped hindwing, drawn on one side.
// Their shared hinge folds both wings up. Veins, marginal spots and the dark
// band at the wing tips make the passing butterflies legible close to camera.
function wingTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.beginPath();
  g.moveTo(9, 139);
  g.bezierCurveTo(60, 70, 169, 0, 228, 12);
  g.bezierCurveTo(250, 37, 245, 86, 222, 117);
  g.bezierCurveTo(211, 132, 198, 143, 185, 149);
  g.bezierCurveTo(197, 170, 178, 188, 166, 191);
  g.bezierCurveTo(159, 210, 146, 217, 133, 215);
  g.bezierCurveTo(118, 234, 103, 233, 90, 229);
  g.bezierCurveTo(56, 251, 24, 206, 9, 151);
  g.closePath();
  g.clip();
  const gradient = g.createLinearGradient(20, 219, 185, 40);
  gradient.addColorStop(0, '#0a2747');
  gradient.addColorStop(0.3, '#0c6dc2');
  gradient.addColorStop(0.65, '#25d5eb');
  gradient.addColorStop(1, '#174e9d');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 256, 256);
  g.lineWidth = 18;
  g.strokeStyle = '#152535';
  g.stroke();
  g.lineWidth = 2;
  g.strokeStyle = '#205581';
  for (const [x, y] of [[210, 22], [236, 46], [234, 76], [217, 105], [186, 143], [164, 171], [143, 197], [117, 218], [89, 221]]) {
    g.beginPath();
    g.moveTo(9, 145);
    g.quadraticCurveTo(x * 0.54, 131 + (y - 135) * 0.18, x, y);
    g.stroke();
  }
  g.fillStyle = '#f2f3db';
  for (const [x, y] of [[221, 24], [233, 39], [239, 58], [234, 82], [224, 103]]) {
    g.beginPath();
    g.ellipse(x, y, 2.6, 4.5, 0.46, 0, Math.PI * 2);
    g.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function Morphos({ view }: { view: number }) {
  const insects = useRef<(THREE.Group | null)[]>([]);
  const wings = useRef<(THREE.Group | null)[]>([]);
  const texture = useDisposable(wingTexture);
  const geometry = useDisposable(() => new THREE.PlaneGeometry(0.105, 0.136).translate(0.0525, 0, 0).rotateX(Math.PI / 2));
  const time = useRef({ path: 0, wing: 0 });
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    time.current.wing += dt * (reducedMotion ? 0.5 : 1);
    if (!reducedMotion) time.current.path += dt;
    const t = time.current.path;
    walkPosition(t);
    insects.current.forEach((insect, i) => {
      if (!insect) return;
      const p = t + i * 7.35;
      if (view === 0) {
        insect.position.set(-7.12 - i * 0.53 + Math.sin(p * 0.51) * 0.38,
          1.92 + 0.18 * Math.sin(p * 0.73), 2.13 - i * 0.55 + Math.cos(p * 0.38) * 0.48 + 0.65 * Math.sin(t * 0.028));
        insect.rotation.y = Math.atan2(0.19 * Math.cos(p * 0.51), -0.18 * Math.sin(p * 0.38));
      } else {
        const side = Math.sin(p * 0.46) * 0.51;
        insect.position.copy(pathPoint).addScaledVector(direction, 1.43 + i * 0.75 + 0.32 * Math.cos(p * 0.31));
        insect.position.x += direction.z * side;
        insect.position.z -= direction.x * side;
        insect.position.y += 1.53 + 0.21 * Math.sin(p * 0.67);
        insect.rotation.y = Math.atan2(direction.x, direction.z) + 0.68 * Math.cos(p * 0.46);
      }
      insect.rotation.x = 0.18 + 0.34 * Math.cos(p * 0.73);
      insect.rotation.z = 0.35 * Math.sin(p * 1.1);
      const flap = 0.69 + 0.63 * Math.sin(time.current.wing * 12 + i * 2) * (0.68 + 0.32 * Math.cos(p * 1.8));
      for (const side of [0, 1]) {
        const wing = wings.current[i * 2 + side];
        if (wing) wing.rotation.z = flap * (side === 0 ? 1 : -1);
      }
    });
  });
  return <>{[0, 1].map(i => <group key={i} ref={group => { insects.current[i] = group; }} scale={i === 0 ? 1.36 : 1.03}>
    {[0, 1].map(side => <group key={side} ref={wing => { wings.current[i * 2 + side] = wing; }} scale-x={side === 0 ? 1 : -1}>
      <mesh geometry={geometry}>
        <meshBasicMaterial map={texture} alphaTest={0.35} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </group>)}
    <mesh scale={[0.004, 0.004, 0.047]}><sphereGeometry args={[1, 10, 8]} /><meshStandardMaterial color="#122d38" /></mesh>
  </group>)}</>;
}

export default function Conservatory({ view }: { view: number }) {
  return <>
    <ScenicCamera view={view} shots={SHOTS} near={0.07} far={BIODOME_FAR} />
    <BiodomeArena><Morphos key={view} view={view} /></BiodomeArena>
  </>;
}
