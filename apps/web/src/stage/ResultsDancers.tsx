import { Suspense, createRef, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import Character from '../../../../packages/character/Character.tsx';
import { DANCER_LOOKS, dancerSpot } from '../../../../packages/stages/shared/Dancers.tsx';
import type { DancerPlacement, StageMeta } from '../../../../packages/stages/index.ts';
import type { MotionTake } from '../../../../packages/pose/motion.ts';
import type { Pose, TrackCalibration } from '../../../../packages/pose/choreography.ts';
import { PLAYERS, REVEAL, easeOut, resultsTag, timeline } from '../game/results.ts';
import type { ResultsShow } from '../game/results.ts';

/*
 * The 3D side of the results screen, in place of the
 * reference dancers on the song's stage (ResultsScreen's scoreboard covers the left of the
 * screen; StageView shifts the stage's picture right):
 *   - win: the winner steps up to centre stage under a light column, on a glowing halo in
 *     their colour, with confetti, and grows to full size; everyone else fades away.
 *   - tie: the tied dancers gather side by side at centre stage on gold halos (the rest fade).
 *   - solo: the one dancer takes centre stage.
 * Everything animates from the dance-floor positions to the result at the reveal. From then
 * on the dancers left on stage copy their player's live pose while the camera still sees them
 * (`live`), and dance the celebration clip when it doesn't (no camera, a replay, or they left).
 */

/** The players' live poses during the results (the GameSession's). */
export interface ResultsLive {
  /** The smoothed pose to draw now (null while the camera doesn't see them). */
  livePose(id: number, now: number): Pose | null;
  calibration(id: number): TrackCalibration | null;
}

// Without a pose for this long, a tracked dancer goes back to the celebration clip.
const LOST_MS = 600;

const FOOT_CLEARANCE = 0.015;
const GOLD = '#ffd34d';

interface GlowProps { color: string; intensity: RefObject<number>; }

function Halo({ color, intensity }: GlowProps) {
  const ring = useRef<THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>>(null);
  const glow = useRef<THREE.Mesh>(null);
  const material = useMemo(() => new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uK: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uK, uTime; varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float disc = smoothstep(1.0, 0.0, r) * 0.55;
        float rings = smoothstep(0.08, 0.0, abs(fract(r * 2.0 - uTime * 0.6) - 0.5) - 0.38) * smoothstep(1.0, 0.6, r);
        gl_FragColor = vec4(uColor * (disc + rings * 0.8) * uK * 1.0, 1.0);
      }
    `,
  }), [color]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame((s) => {
    const k = intensity.current;
    material.uniforms.uK.value = k;
    material.uniforms.uTime.value = s.clock.elapsedTime;
    if (ring.current) {
      ring.current.scale.setScalar(0.6 + 0.4 * k);
      ring.current.material.opacity = k;
    }
    if (glow.current) glow.current.visible = k > 0.01;
  });
  return (
    <group position={[0, 0.02, 0]}>
      <mesh ref={glow} rotation={[-Math.PI / 2, 0, 0]} material={material} renderOrder={3}>
        <planeGeometry args={[3.6, 3.6]} />
      </mesh>
      <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]} renderOrder={4}>
        <torusGeometry args={[1.25, 0.05, 10, 96]} />
        <meshBasicMaterial color={color} transparent opacity={0} toneMapped={false} />
      </mesh>
    </group>
  );
}

function LightColumn({ color, intensity }: GlowProps) {
  const material = useMemo(() => new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Back faces only: the column glows behind the dancer instead of washing over them.
    side: THREE.BackSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uK: { value: 0 } },
    vertexShader: 'varying float vY; varying vec3 vN; varying vec3 vV; void main() { vY = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uK; varying float vY; varying vec3 vN; varying vec3 vV; void main() { float edge = pow(abs(dot(normalize(vN), normalize(-vV))), 1.4); gl_FragColor = vec4(uColor * edge * (1.0 - vY) * 0.24 * uK, 1.0); }',
  }), [color]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => { material.uniforms.uK.value = intensity.current; });
  return (
    <mesh material={material} position={[0, 6, 0]} renderOrder={5}>
      <cylinderGeometry args={[1.5, 1.1, 12, 40, 1, true]} />
    </mesh>
  );
}

const CONFETTI = 160;
function Confetti({ colors, show }: { colors: readonly string[]; show: RefObject<ResultsShow> }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const pieces = useMemo(() => Array.from({ length: CONFETTI }, () => ({
    x: (Math.random() - 0.5) * 9,
    z: (Math.random() - 0.5) * 4,
    y0: 6 + Math.random() * 6,
    v: 1.2 + Math.random() * 1.4,
    sway: Math.random() * 6.28,
    spin: (Math.random() - 0.5) * 8,
    delay: Math.random() * 2.5,
  })), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const geometry = useMemo(() => new THREE.PlaneGeometry(0.12, 0.2), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), []);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const c = new THREE.Color();
    for (let i = 0; i < CONFETTI; i++) m.setColorAt(i, c.set(colors[i % colors.length]));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [colors]);
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const s = show.current;
    const t = timeline(s, performance.now() / 1000).t - REVEAL;
    pieces.forEach((p, i) => {
      const age = t - p.delay * 0.4;
      // Falls from above after the reveal, then keeps drifting down on a loop.
      const fall = age < 0 ? -100 : (age * p.v) % 14;
      dummy.position.set(p.x + Math.sin(age * 1.7 + p.sway) * 0.4, p.y0 - fall - 2, p.z);
      dummy.rotation.set(age * p.spin, age * p.spin * 0.7, age * 0.9);
      dummy.scale.setScalar(age < 0 ? 0 : 1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[geometry, material, CONFETTI]} frustumCulled={false} />;
}

interface SeatDancerProps {
  seat: number;
  motion: MotionTake;
  playback: RefObject<number>;
  /** Copies the player's live pose when there is one (from the reveal, for those who stay). */
  live: ResultsLive | null;
  tracking: RefObject<boolean>;
  opacity: RefObject<number>;
}

// One seat's character: the player's live pose while the camera sees them and `tracking` is on,
// else the celebration clip.
function SeatDancer({ seat, motion, playback, live, tracking, opacity }: SeatDancerProps) {
  const poseRef = useRef<Pose | null>(null);
  const seen = useRef(-Infinity);
  const [calibration, setCalibration] = useState<TrackCalibration | null>(null);
  useFrame(() => {
    const now = performance.now();
    const pose = live && tracking.current ? live.livePose(seat, now) : null;
    poseRef.current = pose;
    if (pose) seen.current = now;
    const next = live && tracking.current && now - seen.current < LOST_MS ? live.calibration(seat) : null;
    if (next !== calibration) setCalibration(next);
  }, -1);
  return (
    <Character
      motion={calibration ? null : motion}
      person={seat % 2}
      playback={playback}
      poseRef={poseRef}
      calibration={calibration}
      live
      opacityRef={opacity}
      appearance={DANCER_LOOKS[seat % DANCER_LOOKS.length]}
    />
  );
}

/**
 * show: ref of { start, results, winner, leaders } (start on the render clock, results [{ score }])
 * floor: the stage's meta.dancers ({ position, rotationY, spacing, scale })
 * motion, playback: the captured demo clip the dancers celebrate to
 * live: the players' live poses, for the dancers left on stage after the reveal
 */
export interface ResultsDancersProps {
  motion: MotionTake;
  /** Seconds into the motion take. */
  playback: RefObject<number>;
  show: RefObject<ResultsShow>;
  floor: DancerPlacement;
  accent: StageMeta['accent'];
  live?: ResultsLive | null;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export default function ResultsDancers({ motion, playback, show, floor, accent, live = null }: ResultsDancersProps) {
  const { position = [0, 0, 0], rotationY = 0, spacing = 4, scale = 1 } = floor;
  const s0 = show.current;
  const count = s0.results.length;
  const solo = count === 1;
  const seats = Array.from({ length: count }, (_, i) => i);
  const groups = useMemo(() => Array.from({ length: count }, () => createRef<THREE.Group>()), [count]);
  const halo = useMemo((): RefObject<number>[] => Array.from({ length: count }, () => ({ current: 0 })), [count]);
  const opacity = useMemo((): RefObject<number>[] => Array.from({ length: count }, () => ({ current: 1 })), [count]);
  const tracking = useMemo((): RefObject<boolean>[] => Array.from({ length: count }, () => ({ current: false })), [count]);
  const column = useRef(0);
  const feet = useMemo(() => new THREE.Vector3(), []);
  const winColor = s0.winner === null ? GOLD : PLAYERS[s0.winner % PLAYERS.length].color;
  const confettiColors = useMemo(() => (s0.winner === null ? [GOLD, '#ffffff', accent[0]] : [PLAYERS[s0.winner % PLAYERS.length].color, PLAYERS[s0.winner % PLAYERS.length].light, '#ffffff', accent[0], GOLD]), [s0.winner, accent]);
  useEffect(() => () => { resultsTag.visible = false; }, []);

  useFrame(({ camera }) => {
    const s = show.current;
    // k: the walk to the result spots (slow, eased at both ends); glow: halo and column fade-in.
    const { t, reveal, step: k } = timeline(s, performance.now() / 1000);
    const glow = easeOut(reveal);
    // Who stays on stage: the solo dancer, the winner, or everyone tied for first.
    const stays = solo ? [0] : s.winner !== null ? [s.winner] : s.leaders;
    seats.forEach((seat) => {
      const g = groups[seat].current;
      if (!g) return;
      const spot = dancerSpot(seat, count, spacing);
      const place = stays.indexOf(seat);
      let x = spot.x;
      let z;
      let sc;
      if (place >= 0) {
        // To centre stage (side by side when tied), at full size.
        const end = dancerSpot(place, stays.length, spacing);
        x = lerp(spot.x, end.x, k);
        z = (stays.length === 1 ? (solo ? 0.6 : 0.8) : 0) * k;
        sc = lerp(spot.scale, end.scale, k);
      } else {
        // Steps back as it fades away.
        z = -1.6 * k;
        sc = spot.scale * (1 - 0.15 * k);
      }
      g.position.set(x, 0, z);
      g.scale.setScalar(sc);
      opacity[seat].current = place >= 0 ? 1 : 1 - glow;
      g.visible = opacity[seat].current > 0.001;
      tracking[seat].current = place >= 0 && t >= REVEAL;
      halo[seat].current = place >= 0 ? glow : 0;
    });
    column.current = (stays.length === 1 ? 1 : 0) * glow;
    // Where the featured dancer's feet are on screen, for their name under them.
    const featured = stays.length === 1 ? groups[stays[0]].current : null;
    if (featured) {
      feet.setFromMatrixPosition(featured.matrixWorld).project(camera);
      Object.assign(resultsTag, { x: (feet.x + 1) / 2, y: (1 - feet.y) / 2, visible: true });
    } else resultsTag.visible = false;
  });

  // The halo, column and confetti follow the featured dancer (or sit between them on a tie).
  const featured = solo ? 0 : s0.winner;

  return (
    <group position={[position[0], position[1] + FOOT_CLEARANCE * scale, position[2]]} rotation={[0, rotationY, 0]} scale={scale}>
      <Suspense fallback={null}>
        {seats.map((seat) => (
          <group key={seat} ref={groups[seat]}>
            {/* Mirrored like a dance coach, on an inner group: the outer one is rescaled every frame. */}
            <group scale={[-1, 1, 1]}>
              <SeatDancer seat={seat} motion={motion} playback={playback} live={live} tracking={tracking[seat]} opacity={opacity[seat]} />
            </group>
            <Halo color={featured === null ? GOLD : PLAYERS[seat % PLAYERS.length].color} intensity={halo[seat]} />
          </group>
        ))}
      </Suspense>
      {featured !== null && (
        <group position={[0, 0, solo ? 0.6 : 0.8]}>
          <LightColumn color={winColor} intensity={column} />
        </group>
      )}
      <Confetti colors={confettiColors} show={show} />
    </group>
  );
}
