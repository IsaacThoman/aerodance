import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import Character from '../../../../packages/character/Character.tsx';
import type { CharacterAppearance } from '../../../../packages/character/Character.tsx';
import { loadMotion } from '../../../../packages/character/motion.ts';
import { MAX_PLAYERS } from '../../../../packages/pose/choreography.ts';
import type { MotionTake } from '../../../../packages/pose/motion.ts';
import motionUrl from '../../../../packages/character/assets/dance.adpose?url';
import { PLAYER_COLORS } from './layout.ts';
import { Burst, SpawnBubble, bubbleMaterial, clamp01, easeOutBack, easeOutCubic, exclaimSprite } from './stageEffects.ts';

/**
 * The captured Frutiger dancers on a glass puck, pinned to the right of the screen: one per
 * player (`count`, 1-4) in the player colours, spaced evenly and centred on the puck. They
 * live in their own scene with a fixed camera, so they ride along with the drone flight
 * instead of being left behind in the city. Drawn after the world and before the menu
 * (useFrame priority 1.5); they slide off to the right while the menu is hidden.
 *
 * When the count goes up, the new dancer arrives in a soap bubble that pops, and the others
 * cheer (a few hops). When it goes down, the leaving dancer swells and pops into droplets,
 * and the others start back in shock (they freeze, hop, and a "!" pops up) before dancing on.
 * The rest regroup around the middle. Two stand side by side; three make a triangle with
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
// A dancer's middle and the top of its head, and its bubble's radius (stage units).
const BODY_Y = 1.5;
const HEAD_Y = 3.3;
const BUBBLE_R = 1.9;
// Arriving: the bubble grows in, wobbles, and pops at BUBBLE_POP; the dancer is settled by SPAWN_END.
const BUBBLE_POP = 0.8;
const SPAWN_END = 0.95;
// Leaving: the dancer swells for this long, then bursts.
const POP_TIME = 0.16;
// Shocked: frozen for SHOCK_FREEZE, one hop, the "!" until SHOCK_END.
const SHOCK_FREEZE = 0.8;
const SHOCK_END = 1.1;
// Cheering: three hops.
const CHEER_HOP = 0.34;
const CHEER_END = CHEER_HOP * 3;

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
interface Dancer { phase: Phase; t: number; burst: boolean }
interface Reaction { kind: 'shock' | 'cheer' | null; t: number; who: boolean[] }

/** How a dancer reacting moves: lift, vertical stretch and backwards lean. */
function reactionPose(r: Reaction) {
  const s = r.t;
  if (r.kind === 'shock' && s < SHOCK_END) {
    const hop = clamp01(s / 0.45);
    const lean = Math.min(clamp01(s / 0.12), clamp01((SHOCK_END - s) / 0.3));
    return { y: 0.5 * Math.sin(Math.PI * hop), stretch: 1 + 0.12 * Math.sin(Math.PI * hop), lean: -0.32 * lean };
  }
  if (r.kind === 'cheer' && s < CHEER_END) {
    const ph = (s % CHEER_HOP) / CHEER_HOP;
    return { y: 0.42 * Math.sin(Math.PI * ph), stretch: 1 + 0.1 * Math.sin(Math.PI * ph), lean: 0 };
  }
  return { y: 0, stretch: 1, lean: 0 };
}

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
  const dancers = useRef<Dancer[]>(APPEARANCES.map((_, i) => ({ phase: i < n ? 'in' : 'out', t: 0, burst: false })));
  const lastCount = useRef(n);
  const reaction = useRef<Reaction>({ kind: null, t: 0, who: [] });
  const opacity = useMemo(() => APPEARANCES.map((_, i) => ({ current: i < initial.current ? 1 : 0 })), []);
  const playback = useMemo(() => APPEARANCES.map(() => ({ current: 0 })), []);
  const still = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  // One bubble, two droplet sprays (the dancer's gel, and bubble film) and a "!" per dancer.
  const fx = useMemo(() => {
    const ball = new THREE.SphereGeometry(1, 32, 24);
    const drop = new THREE.SphereGeometry(1, 12, 8);
    const film = bubbleMaterial();
    const gels = PLAYER_COLORS.map((color) => new THREE.MeshPhysicalMaterial({
      color, roughness: 0.12, clearcoat: 1, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    return {
      ball, drop, film, gels,
      bubbles: APPEARANCES.map(() => new SpawnBubble(ball)),
      gelBursts: gels.map((gel) => new Burst(drop, gel, 14, 0.2)),
      filmBursts: APPEARANCES.map(() => new Burst(drop, film, 10, 0.16)),
      exclaims: APPEARANCES.map(() => exclaimSprite()),
    };
  }, []);
  useEffect(() => () => {
    fx.ball.dispose();
    fx.drop.dispose();
    fx.film.dispose();
    fx.gels.forEach((m) => m.dispose());
    fx.bubbles.forEach((b) => b.dispose());
    fx.exclaims.forEach((s) => { s.material.map?.dispose(); s.material.dispose(); });
  }, [fx]);

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
    // Off screen (or with reduced motion) everything snaps: no bubbles, pops or reactions.
    const offscreen = shown.current < 0.05;
    const animate = !offscreen && !still;
    const k = offscreen ? 1 : Math.min(1, dt * 4);
    const list = dancers.current;
    const startReaction = (kind: Reaction['kind']) => {
      reaction.current = { kind, t: 0, who: list.map((d) => d.phase === 'in') };
    };

    // A new count: newcomers start in a bubble at their spot, leavers start to pop. A dancer
    // whose character hasn't loaded yet just takes its new state: nobody saw it to begin with.
    if (n !== lastCount.current) {
      let popped = false;
      list.forEach((d, i) => {
        const playing = i < n;
        const spot = spots.current[i];
        const shown = animate && !!spot;
        if (playing && (d.phase === 'out' || d.phase === 'pop')) {
          Object.assign(d, { phase: shown ? 'spawn' : 'in', t: 0, burst: false });
          if (spot) [spot.position.x, spot.position.z] = slot(i, n);
        } else if (!playing && (d.phase === 'in' || d.phase === 'spawn')) {
          Object.assign(d, { phase: shown ? 'pop' : 'out', t: 0, burst: false });
          fx.bubbles[i].hide();
          popped ||= shown;
        }
      });
      if (popped) startReaction('shock');
      lastCount.current = n;
    }

    const react = reaction.current;
    react.t += dt;
    // The dance freezes mid-move while the others are shocked (one arriving then, in its bubble
    // too: they all keep time).
    const frozen = react.kind === 'shock' && react.t < SHOCK_FREEZE;
    if (!still && !frozen) clock.current += dt;
    playback.forEach((p, i) => { p.current = clock.current + LAG[i]; });

    // Rise and regrouping ease in, unless the stage is off screen.
    lift.current += ((raised ? RAISE : 0) - lift.current) * k;

    const pose = reactionPose(react);
    list.forEach((d, i) => {
      const spot = spots.current[i];
      if (!spot) return;
      const o = opacity[i];
      const bubble = fx.bubbles[i];
      const [tx, tz] = slot(Math.min(i, n - 1), n);
      d.t += dt;
      let size = 1;
      let stretch = 1;
      let y = 0;
      let lean = 0;
      if (d.phase === 'in' || d.phase === 'spawn') {
        spot.position.x += (tx - spot.position.x) * k;
        spot.position.z += (tz - spot.position.z) * k;
        if (Math.hypot(tx - spot.position.x, tz - spot.position.z) < SPOT_EPSILON) spot.position.set(tx, spot.position.y, tz);
      }
      const { x, z } = spot.position;
      if (d.phase === 'in') {
        o.current = 1;
        if (react.who[i]) ({ y, stretch, lean } = pose);
      } else if (d.phase === 'spawn') {
        // The bubble grows in with a wobble, carrying the dancer down to the puck, then pops.
        const g = d.t;
        if (g < BUBBLE_POP) {
          const wobble = 1 + 0.07 * Math.sin(g * 16) * (1 - clamp01(g / BUBBLE_POP));
          bubble.set(x, BODY_Y + 0.6 * (1 - easeOutCubic(g / BUBBLE_POP)), z, BUBBLE_R * easeOutBack(g / 0.32), wobble, 1);
        } else {
          const pp = clamp01((g - BUBBLE_POP) / (SPAWN_END - BUBBLE_POP));
          bubble.set(x, BODY_Y, z, BUBBLE_R * (1 + 0.35 * pp), 1, 1 - pp);
          if (!d.burst) {
            d.burst = true;
            fx.filmBursts[i].fire(x, BODY_Y, z, BUBBLE_R, 3.2);
            startReaction('cheer');
          }
        }
        size = 0.5 + 0.5 * easeOutCubic((g - 0.1) / 0.7);
        y = 0.6 * (1 - easeOutCubic((g - 0.2) / (BUBBLE_POP - 0.2)));
        o.current = clamp01(g / 0.2);
        if (g >= SPAWN_END) { d.phase = 'in'; bubble.hide(); }
      } else if (d.phase === 'pop') {
        // Swells and stretches, then bursts into droplets of its own gel.
        const q = clamp01(d.t / POP_TIME);
        size = 1 + 0.25 * q * q;
        stretch = 1 + 0.1 * q;
        o.current = 1;
        if (d.t >= POP_TIME) {
          fx.gelBursts[i].fire(x, BODY_Y, z, 1.1, 4.2);
          d.phase = 'out';
          o.current = 0;
        }
      } else {
        o.current = 0;
        spot.position.set(tx, spot.position.y, tz);
      }
      spot.visible = o.current > 0.001;
      spot.position.y = y;
      spot.scale.set(-size / Math.sqrt(stretch), size * stretch, size / Math.sqrt(stretch));
      spot.rotation.x = lean;

      // The shocked show a "!" over their heads.
      const mark = fx.exclaims[i];
      const showMark = react.kind === 'shock' && react.who[i] && d.phase === 'in' && react.t < SHOCK_END;
      mark.visible = showMark;
      if (showMark) {
        const s = 0.9 * easeOutBack(react.t / 0.15) * clamp01((SHOCK_END - react.t) / 0.2);
        mark.scale.set(s, s, 1);
        mark.position.set(x + 0.55, HEAD_Y + y, z + 0.3);
      }
    });
    fx.gelBursts.forEach((b) => b.update(dt));
    fx.filmBursts.forEach((b) => b.update(dt));

    // A 4:3 display keeps the stage smaller, in its own area on the right.
    const compact = state.size.width / state.size.height < 1.5;
    rig.current.scale.setScalar(compact ? 0.72 : 1);
    rig.current.position.set(
      (compact ? 3.65 : STAGE.x) + away * away * SLIDE,
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
            {fx.bubbles.map((b, i) => <primitive key={`bubble${i}`} object={b.mesh} />)}
            {[...fx.gelBursts, ...fx.filmBursts].map((b, i) => <primitive key={`burst${i}`} object={b.group} />)}
            {fx.exclaims.map((s, i) => <primitive key={`mark${i}`} object={s} />)}
            {APPEARANCES.map((appearance, i) => (
              <group
                key={i}
                ref={(g) => {
                  // Placed once; after that the frame loop moves it, so a new count never snaps it.
                  if (g && !placed.current[i]) {
                    placed.current[i] = true;
                    [g.position.x, g.position.z] = slot(Math.min(i, n - 1), n);
                    g.scale.set(-1, 1, 1);
                    g.visible = i < n;
                  }
                  spots.current[i] = g;
                }}
              >
                <Character
                  motion={motion}
                  person={i % 2}
                  playback={playback[i]}
                  appearance={appearance}
                  // Player 1 never leaves, so it keeps the solid (depth-writing) outline.
                  opacityRef={i ? opacity[i] : undefined}
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
