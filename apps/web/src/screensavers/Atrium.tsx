import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Atrium as AtriumInterior } from '../../../../packages/stages/atrium/Atrium.tsx';
import { AXIS, GALLERY, LEVELS } from '../../../../packages/stages/atrium/layout.ts';
import { makeAtriumUniforms } from '../../../../packages/stages/atrium/shading.ts';
import { reducedMotion, useDisposable } from '../../../../packages/stages/shared/hooks.ts';
import ScenicCamera from './ScenicCamera.tsx';

// Follow the pool's rim, then look diagonally across the upper glass walkway
// to the park. Both arcs stay on the visitor side of the plants and rails.
const SHOTS = [
  {
    fov: 59,
    frame(camera: THREE.PerspectiveCamera, t: number) {
      const angle = -0.17 + Math.sin(t * 0.028) * 0.37;
      camera.position.set(11.8 * Math.sin(angle), 1.95 + Math.cos(t * 0.07) * 0.12, AXIS.z + 11.8 * Math.cos(angle));
      camera.lookAt(1.4 + 1.25 * Math.sin(t * 0.04), 6.45, AXIS.z - 1);
    },
  },
  {
    fov: 52,
    frame(camera: THREE.PerspectiveCamera, t: number) {
      const angle = -0.68 + Math.sin(t * 0.029) * 0.26;
      camera.position.set(14 * Math.sin(angle), LEVELS[1] + 1.62, AXIS.z + 14 * Math.cos(angle));
      camera.lookAt(1.5, 7.2 + Math.cos(t * 0.046) * 0.58, AXIS.z - 2.2);
    },
  },
];

// A four-panel mechanical clock suspended from the gallery's ring beam.
// Each changing panel rotates down around its horizontal spindle.
function GalleryClock() {
  const parts = useDisposable(() => {
    const textures = Array.from({ length: 10 }, (_, digit) => {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 192;
      const ctx = c.getContext('2d')!;
      const panel = ctx.createLinearGradient(0, 0, 0, c.height);
      panel.addColorStop(0, '#20363b');
      panel.addColorStop(0.5, '#152b33');
      panel.addColorStop(0.501, '#263940');
      panel.addColorStop(1, '#15262e');
      ctx.fillStyle = panel;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.font = '600 155px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f4f5e8';
      ctx.fillText(String(digit), 64, 105);
      ctx.fillStyle = '#0a181c';
      ctx.fillRect(0, 95, 128, 3);
      const texture = new THREE.CanvasTexture(c);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    });
    return {
      textures,
      casing: new RoundedBoxGeometry(3.25, 1.33, 0.36, 3, 0.13),
      inset: new RoundedBoxGeometry(3.06, 1.14, 0.05, 3, 0.06),
    };
  });
  const panels = useRef<(THREE.Mesh | null)[]>([]);
  const digits = useRef([-1, -1, -1, -1]);
  const started = useRef([0, 0, 0, 0]);
  const displayed = useRef({ minute: -1, value: 0 });
  useFrame(() => {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    if (displayed.current.minute !== minute) {
      const local = new Date(now);
      displayed.current = { minute, value: local.getHours() * 100 + local.getMinutes() };
    }
    const { value } = displayed.current;
    for (let i = 0; i < 4; i++) {
      const panel = panels.current[i];
      if (!panel) continue;
      const next = Math.floor(value / 10 ** (3 - i)) % 10;
      if (digits.current[i] !== next) {
        started.current[i] = digits.current[i] === -1 || reducedMotion ? 0 : now;
        digits.current[i] = next;
        (panel.material as THREE.MeshBasicMaterial).map = parts.textures[next];
      }
      const progress = Math.min(1, (now - started.current[i]) / 440);
      panel.rotation.x = (1 - progress) ** 2 * Math.PI / 2;
    }
  });

  return <group position={[-1.12, GALLERY.y - 1.47, AXIS.z + 2.99]} rotation-y={-0.33}>
    {[-1.12, 1.12].map(x => <mesh key={x} position={[x, 1.07, 0]}>
      <cylinderGeometry args={[0.035, 0.04, 1.02, 12]} /><meshBasicMaterial color="#9dacb0" />
    </mesh>)}
    <mesh geometry={parts.casing}><meshBasicMaterial color="#d5e4de" /></mesh>
    <mesh geometry={parts.inset} position-z={0.177}><meshBasicMaterial color="#11232a" /></mesh>
    {[-1.038, -0.407, 0.407, 1.038].map((x, i) =>
      <mesh key={x} position={[x, 0, 0.207]} ref={panel => { panels.current[i] = panel; }}>
        <planeGeometry args={[0.60, 0.94]} /><meshBasicMaterial map={parts.textures[0]} />
      </mesh>
    )}
    {[-0.15, 0.15].map(y => <mesh key={y} position={[0, y, 0.208]}>
      <circleGeometry args={[0.041, 16]} /><meshBasicMaterial color="#deeadf" />
    </mesh>)}
  </group>;
}

export default function Atrium({ view, clock }: { view: number; clock: boolean }) {
  const uniforms = useMemo(() => makeAtriumUniforms({ fov: SHOTS[0].fov, foreShade: 0 }), []);
  useFrame((_, delta) => { uniforms.uTime.value += Math.min(delta, 0.1) * (reducedMotion ? 0.5 : 1); });
  return <>
    <ScenicCamera view={view} shots={SHOTS} near={0.15} far={3000} />
    <AtriumInterior uniforms={uniforms} />
    {clock && <GalleryClock />}
  </>;
}
