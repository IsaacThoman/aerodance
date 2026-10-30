import { useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { beat, reducedMotion, useDisposable } from '../shared/hooks.ts';
import { makeRandom } from '../shared/random.ts';
import { gelMaterial, inkMaterial } from './gel.ts';
import { blobGeometry, mergeAll } from './geometry.ts';
import { FLOOR } from './layout.ts';
import { BAR_STOOLS, STOOL_SEAT } from './Bar.tsx';
import { STAGE_R, STAGE_TOP } from './DanceFloor.tsx';

interface Blob {
  x: number;
  z: number;
  size: number;
  color: THREE.Color;
  yaw: number;
  style: number;
  offset: number;
  seed: number;
  lift: number;
}

const COLORS = ['#3ee8ff', '#8dff4a', '#ff5ad0', '#a77bff', '#4f8dff', '#3dffc0', '#d65bff', '#ffe04a'];

// Leave the speaker stacks, the camera's foreground and the bar counter clear.
function roomFloor(x: number, z: number, r: number, theta: number) {
  if (Math.abs(Math.abs(x) - 6.9) < 1.6 && Math.abs(z + 3.3) < 1.6) return false;
  if (x * x + (z - 12.6) ** 2 < 11 * 11) return false;
  return !(x > 0 && r > 9.3 && theta > 1.65);
}

// Up on the stage, keep a step behind the dancers' line (up to four of them, three units
// either side of the middle) so nobody hides or bumps into them.
function stageFloor(x: number, z: number) {
  return z < -2.3 || (Math.abs(x) > 4 && z < -0.3);
}

// Aeroling crowd on and around the stage: bob, hop and sway on the beat.
function useCrowd() {
  return useDisposable(() => {
    const rand = makeRandom(9001);
    const blobs: Blob[] = [];
    const place = (count: number, r0: number, r1: number, t0: number, t1: number, lift = 0, fits = roomFloor) => {
      for (let tries = 0, n = 0; n < count && tries < count * 40; tries++) {
        const r = rand.range(r0, r1);
        const theta = rand.range(t0, t1);
        const x = r * Math.sin(theta);
        const z = r * Math.cos(theta);
        if (blobs.some((b) => (b.x - x) ** 2 + (b.z - z) ** 2 < 0.95)) continue;
        if (!fits(x, z, r, theta)) continue;
        const size = rand.range(0.8, 1.15);
        blobs.push({
          x,
          z,
          size,
          color: new THREE.Color(rand.pick(COLORS)).multiplyScalar(0.17),
          yaw: Math.atan2(-x, -z) + rand.range(-0.35, 0.35),
          style: rand.next(), // < 0.55 hop, < 0.85 bob, else sway
          offset: rand.range(-0.06, 0.06),
          // Burn the two draws that once picked a glow stick so the crowd keeps its layout.
          seed: (rand.next(), rand.next(), rand.next()),
          lift,
        });
        n++;
      }
    };
    // Patrons perched on the bar stools, facing the room.
    BAR_STOOLS.forEach(([x, , z], i) => {
      if (i === 2) return;
      blobs.push({
        x,
        z,
        size: 0.75,
        color: new THREE.Color(rand.pick(COLORS)).multiplyScalar(0.3),
        yaw: Math.atan2(-x, -z) + rand.range(-0.6, 0.6),
        style: 0.9,
        offset: rand.range(-0.06, 0.06),
        seed: rand.next(),
        lift: STOOL_SEAT - FLOOR,
      });
    });
    place(22, 6.35, 7.6, -1.1, 1.1);
    place(26, 6.4, 11.5, 0.9, 2.05);
    place(26, 6.4, 11.5, -2.05, -0.9);
    // Edge in from the rim so no blob's base hangs over it.
    place(20, 2.3, STAGE_R - 0.6, Math.PI / 2 - 0.3, Math.PI * 1.5 + 0.3, STAGE_TOP - FLOOR, stageFloor);
    return blobs;
  }, []);
}

export default function Crowd() {
  const blobs = useCrowd();
  const bodies = useRef<THREE.InstancedMesh>(null);
  const eyes = useRef<THREE.InstancedMesh>(null);

  const res = useDisposable(() => {
    const l = new THREE.SphereGeometry(0.06, 10, 8).scale(0.8, 1.25, 0.6).translate(-0.13, 0.66, 0.4);
    const r = new THREE.SphereGeometry(0.06, 10, 8).scale(0.8, 1.25, 0.6).translate(0.13, 0.66, 0.4);
    const eyesGeo = mergeAll([l, r]);
    return {
      body: blobGeometry(18),
      eyes: eyesGeo,
      gel: gelMaterial({ key: 'crowd', color: '#ffffff', rim: 10, rimPower: 5, glow: 0.04, envMapIntensity: 0.15 }),
      ink: inkMaterial(),
      m: new THREE.Matrix4(),
      q: new THREE.Quaternion(),
      e: new THREE.Euler(),
      p: new THREE.Vector3(),
      s: new THREE.Vector3(),
    };
  });

  useLayoutEffect(() => {
    const bm = bodies.current;
    if (!bm) return;
    blobs.forEach((b, i) => bm.setColorAt(i, b.color));
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
  }, [blobs]);

  useFrame((state) => {
    const [bm, em] = [bodies.current, eyes.current];
    if (!bm || !em) return;
    const t = reducedMotion ? 0 : state.clock.elapsedTime;
    const { m, q, e, p, s } = res;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const ph = (((beat.phase + b.offset) % 1) + 1) % 1;
      const kick = Math.exp(-ph * 6);
      let y = 0;
      let sy;
      let lean = 0;
      if (b.style < 0.55) {
        // Hop: airborne mid-beat, squash on landing.
        const hop = Math.sin(Math.PI * ph);
        const big = beat.bar % 4 === 3 ? 1.6 : 1;
        y = hop * 0.28 * big * (0.7 + b.seed * 0.6);
        sy = 1 - kick * 0.16 + hop * 0.08;
      } else if (b.style < 0.85) {
        sy = 1 - kick * 0.12;
        lean = kick * 0.18;
      } else {
        lean = Math.sin(t * 2.1 + b.seed * 10) * 0.12;
        sy = 1 - kick * 0.08;
      }
      e.set(lean, b.yaw, Math.sin(t * 1.7 + b.seed * 20) * 0.06);
      q.setFromEuler(e);
      const sc = b.size;
      p.set(b.x, FLOOR + b.lift + y * sc, b.z);
      s.set(sc * (1 + (1 - sy) * 0.6), sc * sy, sc * (1 + (1 - sy) * 0.6));
      m.compose(p, q, s);
      bm.setMatrixAt(i, m);
      em.setMatrixAt(i, m);
    }
    bm.instanceMatrix.needsUpdate = true;
    em.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={bodies} args={[res.body, res.gel, blobs.length]} frustumCulled={false} />
      <instancedMesh ref={eyes} args={[res.eyes, res.ink, blobs.length]} frustumCulled={false} />
    </group>
  );
}
