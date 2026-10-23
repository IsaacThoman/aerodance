import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Character from '../../../../packages/character/Character.tsx';
import type { CharacterAppearance } from '../../../../packages/character/Character.tsx';
import { POP_DURATION } from '../../../../packages/character/balloonPop.ts';
import { loadMotion } from '../../../../packages/character/motion.ts';
import { MAX_PLAYERS } from '../../../../packages/pose/choreography.ts';
import type { MotionTake } from '../../../../packages/pose/motion.ts';
import motionUrl from '../../../../packages/character/assets/dance.adpose?url';
import DancerEntrance, { DURATION as ENTRANCE_END, LEAD_SECONDS as ENTRANCE_LEAD } from '../../../../packages/stages/shared/DancerEntrance.tsx';
import { PLAYER_COLORS } from './layout.ts';

/**
 * The captured Frutiger dancers on a glass puck, pinned to the right of the screen: one per
 * player (`count`, 1-4) in the player colours, spaced evenly and centred on the puck. They
 * live in their own scene with a fixed camera, so they ride along with the drone flight
 * instead of being left behind in the city. Drawn after the world and before the menu
 * (useFrame priority 1.5); they slide off to the right while the menu is hidden.
 *
 * When the count goes up, the new dancer makes the same entrance as at the start of a song
 * (stages/shared/DancerEntrance.tsx), without the floor ripple: bubbles rising around it and
 * a squash-and-stretch pop. When it goes down, the leaving dancer swells up and pops like a
 * balloon, its skin tearing open (packages/character/balloonPop.ts). The rest dance on and
 * regroup around the middle. Two stand side by side; three make a triangle with
 * player 3 at the front, and four a diamond with player 4 at the back, so the puck keeps
 * its size. The diamond stands turned a little, so the back dancer isn't hidden behind the
 * front one.
 *
 * On Song Select the stage rises to the middle of the screen (`raised`, nothing sits above
 * it there).
 *
 * <MenuDancers visible raised count={3} />
 */

const APPEARANCES: readonly CharacterAppearance[] = PLAYER_COLORS.map((color) => ({ color, gloss: 85, accessory: 'None' }));
const PUCK = { r: 3.1, h: 0.26 };
// Stage placement in front of the fixed camera (looking down -Z), then turned to face it.
const STAGE = { x: 4.3, y: -2.6, z: -19, tilt: 0.2, turn: -0.22 };
// How far the outer dancers stand from the puck's middle: two side by side keep their
// original spots, and three and four spread out a little further.
const RING = 1.45;
const WIDE_RING = 1.9;
// How far the stage rises when it's raised.
const RAISE = 1.5;
const SLIDE = 12;
// Easing approaches its target forever; snap once the remaining step is imperceptible.
const SPOT_EPSILON = 0.01;
// Players three and four dance the duet's parts a beat behind one and two.
const LAG = [0, 0, 3.5, 3.5];
// Leaving: the dancer swells for this long, then pops.
const SWELL = 0.1;

// How far the diamond is turned about the middle (radians): the front dancer steps left and
// the back one right, so the back one shows between the others.
const DIAMOND_TURN = -0.25;
// [x, z] on the circle at `angle` from the front (+z, towards the camera).
const onRing = (angle: number): [number, number] => [WIDE_RING * Math.sin(angle), WIDE_RING * Math.cos(angle)];
// Where each dancer stands for each count, as [x, z]: left, right, then front, then back.
const SLOTS: readonly (readonly [number, number])[][] = [
  [[0, 0]],
  [[-RING, 0], [RING, 0]],
  [onRing(-2 * Math.PI / 3), onRing(2 * Math.PI / 3), onRing(0)],
  [-Math.PI / 2, Math.PI / 2, 0, Math.PI].map((a) => onRing(a + DIAMOND_TURN)),
];
const slot = (i: number, n: number) => SLOTS[n - 1][i];
const clampCount = (n: number) => Math.min(MAX_PLAYERS, Math.max(1, Math.round(n)));

type Phase = 'in' | 'out' | 'spawn' | 'pop';
interface Dancer { phase: Phase; t: number }

function Environment({ scene }: { scene: THREE.Scene }) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    scene.environment = target.texture;
    room.dispose();
    pmrem.dispose();
    return () => {
      scene.environment = null;
      target.dispose();
    };
  }, [gl, scene]);
  return null;
}

function Puck() {
  return (
    <group renderOrder={-1}>
      <mesh position={[0, -PUCK.h / 2, 0]} renderOrder={-1}>
        <cylinderGeometry args={[PUCK.r, PUCK.r * 1.04, PUCK.h, 96]} />
        <meshPhysicalMaterial
          color="#c4f6ff"
          roughness={0.08}
          metalness={0.2}
          clearcoat={1}
          transparent
          opacity={0.6}
          depthWrite={false}
          envMapIntensity={1.6}
        />
      </mesh>
      <mesh position={[0, 0.002, 0]} rotation={[Math.PI / 2, 0, 0]} renderOrder={-1}>
        <torusGeometry args={[PUCK.r - 0.03, 0.045, 10, 128]} />
        <meshBasicMaterial color="#7affdc" transparent opacity={0.85} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
        <ringGeometry args={[PUCK.r * 0.8, PUCK.r * 0.81, 96]} />
        <meshBasicMaterial color="#38d7ed" transparent opacity={0.6} depthWrite={false} />
      </mesh>
    </group>
  );
}

class Quiet extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.warn('Menu dancers could not load', err); }
  render() { return this.state.failed ? null : this.props.children; }
}

export interface MenuDancersProps {
  visible?: boolean;
  /** Song Select: the stage rises to the middle of the screen. */
  raised?: boolean;
  /** Dancers on the puck, one per player (1-4). */
  count?: number;
}

export default function MenuDancers({ visible = true, raised = false, count = 2 }: MenuDancersProps) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const [motion, setMotion] = useState<MotionTake | null>(null);
  const stage = useMemo(() => new THREE.Scene(), []);
  const cam = useMemo(() => new THREE.PerspectiveCamera(30, 16 / 9, 0.5, 60), []);
  const rig = useRef<THREE.Group>(null);
  const clock = useRef(0);
  const shown = useRef(0);
  const lift = useRef(0);
  const n = clampCount(count);
  const spots = useRef<(THREE.Group | null)[]>([]);
  const placed = useRef<boolean[]>([]);
  const initial = useRef(n);
  const dancers = useRef<Dancer[]>(APPEARANCES.map((_, i) => ({ phase: i < n ? 'in' : 'out', t: 0 })));
  const lastCount = useRef(n);
  const opacity = useMemo(() => APPEARANCES.map((_, i) => ({ current: i < initial.current ? 1 : 0 })), []);
  const playback = useMemo(() => APPEARANCES.map(() => ({ current: 0 })), []);
  // Seconds since each dancer popped; negative while whole.
  const pops = useMemo(() => APPEARANCES.map(() => ({ current: -1 })), []);
  const still = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  // Each dancer's entrance clock, in the song-clock terms DancerEntrance expects: -Infinity
  // keeps it hidden, Infinity shows it settled, and an arrival counts up from -ENTRANCE_LEAD.
  const entrances = useMemo(() => APPEARANCES.map((_, i) => {
    const clock = { ms: i < initial.current ? Infinity : -Infinity };
    return { clock, timeMs: () => clock.ms };
  }), []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(motionUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Dance capture unavailable');
        return response.arrayBuffer();
      })
      .then((bytes) => setMotion(loadMotion(bytes)))
      .catch((e: unknown) => { if (!(e instanceof Error && e.name === 'AbortError')) console.warn('Menu dancers could not load', e); });
    return () => controller.abort();
  }, []);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    shown.current += ((visible ? 1 : 0) - shown.current) * Math.min(1, dt * (visible ? 2.5 : 5));
    if (!motion || !rig.current || shown.current < 0.005) return;

    const t = state.clock.elapsedTime;
    const away = 1 - shown.current;
    // Off screen (or with reduced motion) everything snaps: no bubbles or pops.
    const offscreen = shown.current < 0.05;
    const animate = !offscreen && !still;
    const k = offscreen ? 1 : Math.min(1, dt * 4);
    const list = dancers.current;
    // A new count: newcomers make their entrance at their spot, leavers start to pop. A dancer
    // whose character hasn't loaded yet just takes its new state: nobody saw it to begin with.
    if (n !== lastCount.current) {
      list.forEach((d, i) => {
        const playing = i < n;
        const spot = spots.current[i];
        const shown = animate && !!spot;
        if (playing && (d.phase === 'out' || d.phase === 'pop')) {
          Object.assign(d, { phase: shown ? 'spawn' : 'in', t: 0 });
          entrances[i].clock.ms = shown ? -ENTRANCE_LEAD * 1000 : Infinity;
          pops[i].current = -1;
          if (spot) [spot.position.x, spot.position.z] = slot(i, n);
        } else if (!playing && (d.phase === 'in' || d.phase === 'spawn')) {
          Object.assign(d, { phase: shown ? 'pop' : 'out', t: 0 });
          // Cut any entrance short: the leaver pops at full size, or is simply gone.
          entrances[i].clock.ms = shown ? Infinity : -Infinity;
        }
      });
      lastCount.current = n;
    }

    if (!still) clock.current += dt;
    playback.forEach((p, i) => { p.current = clock.current + LAG[i]; });

    // Rise and regrouping ease in, unless the stage is off screen.
    lift.current += ((raised ? RAISE : 0) - lift.current) * k;

    list.forEach((d, i) => {
      const spot = spots.current[i];
      if (!spot) return;
      const o = opacity[i];
      const entrance = entrances[i].clock;
      const [tx, tz] = slot(Math.min(i, n - 1), n);
      d.t += dt;
      if (Number.isFinite(entrance.ms)) {
        entrance.ms += dt * 1000;
        if (entrance.ms >= (ENTRANCE_END - ENTRANCE_LEAD) * 1000) entrance.ms = Infinity;
      }
      let size = 1;
      if (d.phase === 'in' || d.phase === 'spawn') {
        spot.position.x += (tx - spot.position.x) * k;
        spot.position.z += (tz - spot.position.z) * k;
        if (Math.hypot(tx - spot.position.x, tz - spot.position.z) < SPOT_EPSILON) spot.position.set(tx, spot.position.y, tz);
      }
      if (d.phase === 'in') {
        o.current = 1;
      } else if (d.phase === 'spawn') {
        // The song-start entrance on the dancer's own clock: it pops up settled at zero, and
        // its bubbles rise on a moment longer.
        o.current = 1;
        if (entrance.ms >= 0) d.phase = 'in';
      } else if (d.phase === 'pop') {
        // Swells up taut, quivering, then tears open and pops like a balloon.
        const q = Math.min(1, d.t / SWELL);
        size = 1 + 0.18 * q * q + 0.02 * q * Math.sin(d.t * 120);
        o.current = 1;
        pops[i].current = d.t - SWELL;
        if (d.t >= SWELL + POP_DURATION) {
          d.phase = 'out';
          entrance.ms = -Infinity;
          pops[i].current = -1;
          o.current = 0;
        }
      } else {
        o.current = 0;
        spot.position.set(tx, spot.position.y, tz);
      }
      spot.visible = o.current > 0.001;
      spot.scale.setScalar(size);
    });

    // A 4:3 display brings the larger puck slightly inward, keeping the whole group
    // clear of both the menu controls and the right edge (including four dancers).
    const compact = state.size.width / state.size.height < 1.5;
    rig.current.scale.setScalar(compact ? 0.86 : 1);
    rig.current.position.set(
      (compact ? 3.25 : STAGE.x) + away * away * SLIDE,
      STAGE.y + lift.current + (still ? 0 : Math.sin(t * 1.3) * 0.06),
      STAGE.z,
    );
    rig.current.rotation.set(STAGE.tilt, STAGE.turn, still ? 0 : Math.sin(t * 0.7) * 0.012);
  }, 0.5);

  useFrame(() => {
    if (!motion || !rig.current || shown.current < 0.005) return;
    // Match the world's selected display aspect, including anamorphic widescreen.
    if ('aspect' in camera && cam.aspect !== camera.aspect) { cam.aspect = camera.aspect; cam.updateProjectionMatrix(); }
    const ac = gl.autoClear;
    const tm = gl.toneMapping;
    gl.autoClear = false;
    // The gel material was tuned under ACES in the prototype; the world itself renders untoned.
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.clearDepth();
    gl.render(stage, cam);
    gl.toneMapping = tm;
    gl.autoClear = ac;
  }, 1.5);

  if (!motion) return null;
  return createPortal(
    <>
      <Environment scene={stage} />
      <hemisphereLight args={['#d9faff', '#489789', 1.3]} />
      <directionalLight position={[-6, 12, 8]} intensity={2.5} />
      <pointLight position={[0, 1.3, 3]} color="#65f7ff" intensity={8} distance={9} />
      <group ref={rig} position={[STAGE.x + SLIDE, STAGE.y, STAGE.z]}>
        <Quiet>
          <Suspense fallback={null}>
            <Puck />
            {APPEARANCES.map((appearance, i) => (
              <group
                key={i}
                ref={(g) => {
                  // Placed once; after that the frame loop moves it, so a new count never snaps it.
                  if (g && !placed.current[i]) {
                    placed.current[i] = true;
                    [g.position.x, g.position.z] = slot(Math.min(i, n - 1), n);
                    g.visible = i < n;
                  }
                  spots.current[i] = g;
                }}
              >
                <DancerEntrance timeMs={entrances[i].timeMs} color={appearance.color} seed={i + 1} ripple={false}>
                  {/* Mirrored inside the entrance, as on the stages: a mirrored entrance would turn its bubbles' backs to the camera. */}
                  <group scale={[-1, 1, 1]}>
                    <Character
                      motion={motion}
                      person={i % 2}
                      playback={playback[i]}
                      appearance={appearance}
                      // Player 1 never leaves, so it keeps the solid (depth-writing) outline.
                      opacityRef={i ? opacity[i] : undefined}
                      popRef={i ? pops[i] : undefined}
                    />
                  </group>
                </DancerEntrance>
              </group>
            ))}
          </Suspense>
        </Quiet>
      </group>
    </>,
    stage,
  );
}
