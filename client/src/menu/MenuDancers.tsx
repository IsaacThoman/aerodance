import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Character from '../../../packages/character/Character.tsx';
import type { CharacterAppearance } from '../../../packages/character/Character.tsx';
import { validateMotion } from '../../../packages/character/motion.ts';
import type { MotionTake } from '../../../packages/pose/legacy.ts';
import motionUrl from '../../../packages/character/assets/dance.json?url';
import { MAX_PLAYERS, PLAYER_COLORS } from './layout.ts';

/**
 * The captured Frutiger dancers on a glass puck, pinned to the right of the screen: one per
 * player (`count`, 1-4) in the player colours, spaced evenly and centred on the puck. They
 * live in their own scene with a fixed camera, so they ride along with the drone flight
 * instead of being left behind in the city. Drawn after the world and before the menu
 * (useFrame priority 1.5); they slide off to the right while the menu is hidden.
 *
 * When the count changes everything eases: a dancer joining splits out of its neighbour, one
 * leaving slides into its neighbour and fades once they overlap, and the puck widens for three
 * and four (the whole stage scales down a little at four so it stays on screen).
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
// Distance between neighbouring dancers: two keep their original spots, three and four
// stand a little closer.
const spacing = (n: number) => (n <= 2 ? 2.9 : 2.5);
// Puck room past the outermost dancer's centre.
const PUCK_MARGIN = 1.65;
// The widest the puck may look on screen (its radius in world units, after scaling).
const FIT_RADIUS = 4.4;
// How far the stage rises when it's raised.
const RAISE = 1.5;
const SLIDE = 12;
// Easing approaches its target forever; snap once the remaining step is imperceptible.
const SPOT_EPSILON = 0.01;
// A leaving dancer fades once it is this close to the neighbour it slides into.
const MERGE_DISTANCE = 0.08;
const FADE_SECONDS = 0.05;
// Players three and four dance the duet's parts a beat behind one and two.
const LAG = [0, 0, 3.5, 3.5];

const slotX = (i: number, n: number) => (i - (n - 1) / 2) * spacing(n);
/** Where dancer i stands for n players; one not playing hides in the last player's spot. */
const targetX = (i: number, n: number) => slotX(Math.min(i, n - 1), n);
const puckRadius = (n: number) => Math.max(PUCK.r, ((n - 1) / 2) * spacing(n) + PUCK_MARGIN);
const stageScale = (n: number) => Math.min(1, FIT_RADIUS / puckRadius(n));
const clampCount = (n: number) => Math.min(MAX_PLAYERS, Math.max(1, Math.round(n)));

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
  const puck = useRef<THREE.Group>(null);
  const clock = useRef(0);
  const shown = useRef(0);
  const lift = useRef(0);
  const n = clampCount(count);
  // The puck's radius and the stage's scale, eased towards the current count's.
  const size = useRef({ r: puckRadius(n), s: stageScale(n) });
  // The puck mounts after the motion loads: start it at the current size.
  const sizePuck = (g: THREE.Group | null) => {
    puck.current = g;
    g?.scale.set(size.current.r / PUCK.r, 1, size.current.r / PUCK.r);
  };
  const spots = useRef<(THREE.Group | null)[]>([]);
  const placed = useRef<boolean[]>([]);
  const initial = useRef(n);
  const opacity = useMemo(() => APPEARANCES.map((_, i) => ({ current: i < initial.current ? 1 : 0 })), []);
  const playback = useMemo(() => APPEARANCES.map(() => ({ current: 0 })), []);
  const still = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(motionUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Dance capture unavailable');
        return response.json();
      })
      .then((data) => setMotion(validateMotion(data)))
      .catch((e: unknown) => { if (!(e instanceof Error && e.name === 'AbortError')) console.warn('Menu dancers could not load', e); });
    return () => controller.abort();
  }, []);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    shown.current += ((visible ? 1 : 0) - shown.current) * Math.min(1, dt * (visible ? 2.5 : 5));
    if (!motion || !rig.current || shown.current < 0.005) return;
    if (!still) clock.current += dt;
    playback.forEach((p, i) => { p.current = clock.current + LAG[i]; });

    const t = state.clock.elapsedTime;
    const away = 1 - shown.current;
    // Rise, regrouping and the puck's size ease in, unless the stage is off screen.
    const k = shown.current < 0.05 ? 1 : Math.min(1, dt * 4);
    lift.current += ((raised ? RAISE : 0) - lift.current) * k;
    const sz = size.current;
    sz.r += (puckRadius(n) - sz.r) * k;
    sz.s += (stageScale(n) - sz.s) * k;
    puck.current?.scale.set(sz.r / PUCK.r, 1, sz.r / PUCK.r);

    APPEARANCES.forEach((_, i) => {
      const spot = spots.current[i];
      if (!spot) return;
      const playing = i < n;
      const target = targetX(i, n);
      // A leaving dancer slides into its neighbour twice as quickly as the others regroup.
      spot.position.x += (target - spot.position.x) * (playing ? k : Math.min(1, k * 2));
      if (Math.abs(target - spot.position.x) < SPOT_EPSILON) spot.position.x = target;
      // Shown while playing, or still on its way into its neighbour.
      const show = playing || Math.abs(target - spot.position.x) > MERGE_DISTANCE;
      const o = opacity[i];
      const step = dt / FADE_SECONDS;
      const goal = show ? 1 : 0;
      o.current = Math.abs(goal - o.current) <= step + Number.EPSILON ? goal : o.current + (show ? step : -step);
      spot.visible = o.current > 0;
    });

    // The stage keeps its right edge where it was as the puck widens.
    const grow = sz.r * sz.s - PUCK.r;
    rig.current.position.set(
      STAGE.x - grow * 0.6 + away * away * SLIDE,
      STAGE.y + lift.current + (still ? 0 : Math.sin(t * 1.3) * 0.06),
      STAGE.z,
    );
    rig.current.scale.setScalar(sz.s);
    rig.current.rotation.set(STAGE.tilt, STAGE.turn, still ? 0 : Math.sin(t * 0.7) * 0.012);
  }, 0.5);

  useFrame(() => {
    if (!motion || !rig.current || shown.current < 0.005) return;
    // Match the world camera's aspect so the stretch to 16:9 is shared.
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
            <group ref={sizePuck}>
              <Puck />
            </group>
            {APPEARANCES.map((appearance, i) => (
              <group
                key={i}
                ref={(g) => {
                  // Placed once; after that the frame loop eases it, so a new count never snaps it.
                  if (g && !placed.current[i]) {
                    placed.current[i] = true;
                    g.position.x = targetX(i, n);
                    g.visible = i < n;
                  }
                  spots.current[i] = g;
                }}
                scale={[-1, 1, 1]}
              >
                <Character
                  motion={motion}
                  person={i % 2}
                  playback={playback[i]}
                  appearance={appearance}
                  opacityRef={opacity[i]}
                />
              </group>
            ))}
          </Suspense>
        </Quiet>
      </group>
    </>,
    stage,
  );
}
