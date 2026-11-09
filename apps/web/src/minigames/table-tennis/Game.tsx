import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useLoader, useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import Character, { createGelMaterial, gelGeometry } from '../../../../../packages/character/Character.tsx';
import type { CharacterAppearance } from '../../../../../packages/character/Character.tsx';
import modelUrl from '../../../../../packages/character/assets/aero-character.glb?url';
import type { CharacterPose, Triple } from '../../../../../packages/pose/performance.ts';
import BiodomeArena, { BIODOME_FAR, BIODOME_POST } from '../../../../../packages/arenas/biodome/BiodomeArena.tsx';
import { DANCER_LOOKS } from '../../../../../packages/stages/shared/Dancers.tsx';
import { StageEnvironment } from '../../../../../packages/stages/shared/Environment.tsx';
import type { EnvironmentLight } from '../../../../../packages/stages/shared/Environment.tsx';
import { PLAYERS } from '../../game/results.ts';
import { FONT, drawDarkGlassPanel, drawShadowText } from '../../ui/draw.ts';
import { useMinigameFrame, useMinigameOverlay } from '../hooks.ts';
import { MinigameWorld, SeenBy } from '../scene.tsx';
import type { MinigameCameraProps } from '../scene.tsx';
import type { MinigameContext, MinigamePhase } from '../types.ts';
import type { RawPose } from '../pose/body.ts';
import { DEFAULT_FOV, bodyTurn, flatWorld, handPose } from './arms.ts';
import type { BodyTurn, HandPose, Side, Vec3 } from './arms.ts';
import { OneEuro } from './oneEuro.ts';
import { ASSIST, SWING, contactNudge, interceptNudge, strongestSwing } from './assist.ts';
import { LaggedBall } from './lagged.ts';
import { BOT, botServe, botShot, botTarget, planReturn, reachRoom } from './bot.ts';
import type { BotLevel } from './bot.ts';
import { coming, describePass, endPass, recalibrate, shiftWords, trackPass } from './calibrate.ts';
import type { Pass, PassResult } from './calibrate.ts';
import { BALL_R, NET, ROOM, TABLE, v3 } from './ball.ts';
import type { Ball, PaddlePose, V3 } from './ball.ts';
import { flightStep } from './flight.ts';
import type { FlightEvent, Swinger } from './flight.ts';
import { arrival, autoplayBlade, autoplayRaised } from './autoplay.ts';
import { bounced, dead, endOf, heldBall, hit, mine, mineBall, newRally, otherEnd, tossBall, tossed } from './rally.ts';
import type { End } from './rally.ts';
import { GAP, HOLD_NORMAL, faceNormal, forehand, heading, holdPose, onPaddle, planServe, serveBall, servePose, serveStrike, strokeOffset } from './robot.ts';
import type { ArmPose, ServeMotion } from './robot.ts';
import { RobotOpponent, aimRobot, createRobotDriver } from './RobotOpponent.tsx';
import type { StationDriver } from '../../../../../packages/robots/shared/station.ts';
import { choiceLabel, nextChoice, optionsOf } from './options.ts';
import type { OptionId, SceneId } from './options.ts';

/*
 * Table Tennis (index.ts), in first person, from the end of a ping-pong table in the Biodome
 * (packages/arenas/biodome) or a blank room (the Scene setting, 'debug'): the
 * dancers' glass hands following the player's (the pose and Hand Landmarker landmarks the host's
 * camera sends with the game's 'hands' tracking, turned into the hands' places and angles by
 * arms.ts), a paddle in the right. The ball's physics (ball.ts) meet the player's paddle as it
 * really moves (flight.ts).
 *
 * Alone, the opponent is a robot arm at the far end (the Torven six-axis arm from the robot hall:
 * RobotOpponent.tsx), which holds the ball on its paddle between rallies; raising the left hand
 * (or Space) has it toss the ball up and serve (robot.ts), and the bot (bot.ts) plays back what
 * the player returns, the arm's inverse kinematics putting its paddle on the ball.
 *
 * With two, the screen splits (MinigameWorld's views): Player 1 on the left at the near end,
 * Player 2 on the right at the far end, each in first person, playing the other in an open rally
 * (rally.ts): no points, only a count of the shots in a row that land on the other half. Each sees
 * the other as their glass dancer (Dancer, SeenBy the other's view), the dancer's hands the very
 * hands that hold the paddles, so a paddle is where it's seen. The ball waits over the server's
 * end; raising the left hand (or Space) tosses it up, for them to hit. Whoever's end a dead ball
 * finishes at serves next. Hand tracking needs one player in the picture, so with two the paddles
 * follow the pose's wrists and fingers.
 *
 * The settings are the minigame's options (options.ts), and keys step them while playing:
 * B the bot's shots, R whether it returns everything (alone). Aim assist (assist.ts) always runs
 * at Max, and paddle calibration (calibrate.ts) shifts each paddle by the way its swings keep
 * missing; the HUD says how each ball went by it. In development, T slows time (the swing keeps
 * its own speed), F makes the paddles forgiving (they reach further than they look), L steps the
 * hits' lag compensation (the paddle, seen late through the camera, meets the ball as it was
 * then: LaggedBall; 'auto' measures the delay from each pose's capture time), and O and P have a
 * stand-in (autoplay.ts) play for the first and the last player.
 *
 * It's open play: no match, nothing to finish; the round lasts until the players leave.
 */

// The eye, in the room, and the shoulders from it in the body's frame (which doesn't tilt).
const EYE = new THREE.Vector3(0, 1.6, 1.6);
const PITCH = -0.22;
const FOV = 100;
// Each view of a split screen is 8:9: the same height of view keeps the table as big, and the
// paddle's swings across in view.
const SPLIT_FOV = 100;
const SHOULDER: Record<Side, THREE.Vector3> = { right: new THREE.Vector3(0.2, -0.05, 0.05), left: new THREE.Vector3(-0.2, -0.05, 0.05) };
// Where a hand rests while it's lost: down by the side, out of view.
const REST: Record<Side, Vec3> = { right: { x: 0.02, y: -0.55, z: -0.1 }, left: { x: -0.02, y: -0.55, z: -0.1 } };
const LOST_MS = 500;
const NO_SHIFT = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DEV = import.meta.env.DEV;
// Tracked reach is scaled up a little: arms held out read better a touch longer.
const REACH = 1.1;
// The hand's diameter, in metres (the dancers' hands are big, cartoon mitts).
const HAND_SIZE = 0.13;
// The mitt sits this far past the wrist, along the hand, and the paddle's blade this far past the mitt.
const MITT = 0.04;
const BLADE_UP = 0.15;
const RUBBER = '#ff3b5c';
// The table's middle (the net), its near end a step in front of the eye.
const TABLE_Z = EYE.z - 0.45 - TABLE.halfLength;
// Each end's eye in the room: Player 1's at the near end, Player 2's the same at the far end,
// facing back down the table; and the body's turn there.
const EYES: Record<End, THREE.Vector3> = { 0: EYE, 1: new THREE.Vector3(-EYE.x, EYE.y, 2 * TABLE_Z - EYE.z) };
const YAW: Record<End, number> = { 0: 0, 1: Math.PI };
// The eye in each player's own frame (rally.ts mine: the table's frame, them at +z).
const OWN_EYE = v3(EYE.x, EYE.y, EYE.z - TABLE_Z);
// The paddle's blade: its radius, and half its thickness, as drawn and when forgiving.
const BLADE = { radius: 0.075, halfThickness: 0.006 };
const FORGIVING = { radius: 0.13, halfThickness: 0.04 };
// The left wrist this far above its shoulder raises the hand (and back below the lower mark, lowers it);
// held up, the robot serves again this often.
const RAISED = { up: 0.02, down: -0.1, again: 2.5 };
// A ball goes back to the robot this long after it's dead (on the floor, or settled).
const DEAD_S = 1;
// Time's speeds, stepped through with T.
const TIME_SCALES = [1, 0.5, 0.25] as const;
// How late the paddle is to the ball, stepped through with L: 'auto' is the tracker's measured
// delay (camera to result) and DRAW_LAG more for the hand's easing and the screen; or set, in seconds.
const HIT_LAGS = ['auto', 0, 0.06, 0.1, 0.15] as const;
type HitLag = typeof HIT_LAGS[number];
const DRAW_LAG = 0.05;
// The ball's drawn place eases onto a rewound hit's this fast (per second).
const CATCH_UP = 14;
const TRAIL = 28;
// A ring spreading on the table where the ball bounces: how long it lasts (s), its radius from
// and to (m), and how many can show at once.
const RIPPLE = { life: 0.6, from: 0.03, to: 0.23, count: 3 } as const;
const easeOut = (u: number) => 1 - (1 - u) * (1 - u);
const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// The robot's paddle holding the ball at home, face up (the ball's middle at BOT.home).
const HOLD_START: ArmPose = holdPose(0);
// The ball and its trail (and the bounces' rings) in each scene: white in the plain room, orange
// in the Biodome, where a white ball is lost against the pale deck and the bright haze.
// A little glow of its own keeps it bright against the robot's orange paint.
const BALL_LOOK: Record<SceneId, { ball: string; trail: string; glow: number }> = {
  debug: { ball: '#fff7ea', trail: '#fff3d6', glow: 0 },
  biodome: { ball: '#ff8a1f', trail: '#ffc27a', glow: 0.55 },
};
// The glass dancers each player sees the other as: the menu dancers' looks, this many metres to
// the character's unit (its hands are then about as big as a player's own first-person mitts are
// to them), the head at the eye.
const DANCER_SCALE = 0.34;

// openreef's environment: the glass hands mostly reflect it, and it keeps their gel aqua.
const ENV_LIGHTS: readonly EnvironmentLight[] = [
  { position: [0, 24, 4], color: '#f2ffff', intensity: 5, size: [26, 26] },
  { position: [-14, 16, 2], color: '#fffbe8', intensity: 4, size: [6, 10] },
  { position: [-18, 3, 6], color: '#5ff0ff', intensity: 1.8, size: [8, 10] },
  { position: [18, 4, -4], color: '#7fe8ff', intensity: 1.6, size: [8, 10] },
  { position: [0, 5, 22], color: '#8feaff', intensity: 1.0, size: [14, 7] },
];

interface HandTarget { pose: HandPose; at: number; }
/** A player: what the tracker last said about their hands, and the scene's hands and paddle for the ball. */
interface Rig {
  /** Their end of the table (and their player number, less one). */
  end: End;
  hands: Record<Side, HandTarget | null>;
  /** Poses are coming in (the hands follow them; until then they rest at REST). */
  tracked: boolean;
  /** The camera sends no world landmarks, so the arms' depth is read from the picture alone (arms.ts flatWorld). */
  flat: boolean;
  /** The paddle's blade (its centre; its face's normal is its +z). */
  blade: THREE.Object3D | null;
  /** The tracker's measured delay, camera to result, in seconds. */
  latency: number;
  /**
   * The aim assist's slide of the right hand, set by the ball for the next frame, and the slide it
   * was drawn with this frame; the paddle's calibration shift, set by the ball's passes, and as
   * drawn this frame (eased onto it). All in the player's own frame (rally.ts mine).
   */
  nudge: THREE.Vector3;
  nudged: THREE.Vector3;
  shift: THREE.Vector3;
  shifted: THREE.Vector3;
  /** How their torso and head are turned, for the glass dancer the other player sees (null: not seen). */
  body: BodyTurn | null;
  /** Development: a stand-in plays for them (autoplay.ts), setting their hands. */
  autoplay: boolean;
}
/** The round's settings, and the keys pressed for it. */
interface Play {
  forgiving: boolean;
  /** Space was pressed: serve a ball. */
  serve: boolean;
  /** How fast the ball's world runs (1: real time). */
  timeScale: number;
  /** How late the paddle is to the ball (hits are judged against the ball as it was then). */
  hitLag: HitLag;
  /** Alone: how hard the bot's shots are, and whether it returns the player's misses too. */
  botLevel: BotLevel;
  botAlways: boolean;
}

const newRig = (end: End): Rig => ({
  end, hands: { left: null, right: null }, tracked: false, flat: false, blade: null, latency: 0,
  nudge: new THREE.Vector3(), nudged: new THREE.Vector3(), shift: new THREE.Vector3(), shifted: new THREE.Vector3(), body: null, autoplay: false,
});

/** A direction in a player's own frame, turned into the room's (or back). */
function toRoom(end: End, v: THREE.Vector3, out: THREE.Vector3) {
  return end === 0 ? out.copy(v) : out.set(-v.x, v.y, -v.z);
}

/** How late a player's paddle is to the ball, in the ball's time (the camera off: not at all). */
const lagOf = (rig: Rig, play: Play) => (!rig.tracked ? 0 : (play.hitLag === 'auto' ? (rig.latency > 0 ? rig.latency + DRAW_LAG : 0) : play.hitLag) * play.timeScale);

/** A hand held at a wrist, pointing up and forward, knuckles level (index towards the middle). */
const heldPose = (side: Side, wrist: Vec3): HandPose => ({
  wrist, dir: { x: 0, y: 0.8, z: -0.6 }, across: { x: side === 'right' ? -1 : 1, y: 0, z: 0 }, from: 'pose',
});

// ?fov=<degrees>: the webcam's horizontal field of view, which sets how depth is read (arms.ts).
const FOV_PARAM = Number(new URLSearchParams(location.search).get('fov')) || DEFAULT_FOV;
const vec = (a: number[]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });
const arr = (a: Vec3) => [a.x, a.y, a.z];
const SIDES = ['left', 'right'] as const;

/**
 * A player's hands from the host's poses, as each one arrives: arms.ts on its picture and world
 * landmarks (stand-ins from the picture when the camera sends none) and the hands found, one-euro
 * filtered; and how their torso and head are turned. The tracking's delay is each pose's age
 * when it's first seen. A stand-in's hands (autoplay) are its own.
 */
function usePlayerHands(rig: Rig) {
  const st = useMemo(() => ({
    seen: null as RawPose | null,
    filters: Object.fromEntries(SIDES.map((side) => [side, { wrist: new OneEuro(1.2, 3), dir: new OneEuro(1, 1.2), across: new OneEuro(1, 1.2) }])) as Record<Side, Record<'wrist' | 'dir' | 'across', OneEuro>>,
  }), []);
  useMinigameFrame((frame) => {
    const p = frame.players[rig.end];
    rig.tracked = true;
    const raw = p?.raw;
    if (!raw || raw === st.seen) return;
    st.seen = raw;
    const now = performance.now();
    const image = raw.landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.confidence ?? 1 }));
    const pose = { landmarks: image, world: raw.world ? [...raw.world] : flatWorld(image, raw.input) };
    rig.flat = !raw.world;
    rig.body = bodyTurn(pose.world, image);
    for (const side of SIDES) {
      if (rig.autoplay) break;
      const hand = raw.hands?.find((h) => h.side === side);
      const next = handPose(pose, hand, side, raw.input, FOV_PARAM);
      if (!next) continue;
      const f = st.filters[side], t = now / 1000;
      rig.hands[side] = { at: now, pose: { from: next.from,
        wrist: vec(f.wrist.filter(arr(next.wrist), t)), dir: vec(f.dir.filter(arr(next.dir), t)), across: vec(f.across.filter(arr(next.across), t)) } };
    }
    const age = (now - raw.capturedAt) / 1000;
    if (age >= 0 && age < 1) rig.latency = rig.latency > 0 ? rig.latency * 0.9 + age * 0.1 : age;
  });
}

function PlayerTracking({ rig }: { rig: Rig }) {
  usePlayerHands(rig);
  return null;
}

/**
 * Material settings that keep the hands' aqua environment (scene.environment) off the room and
 * table: an empty environment of their own, at no strength.
 */
function useNoReflections() {
  const gl = useThree((s) => s.gl);
  const none = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const target = pmrem.fromScene(new THREE.Scene());
    pmrem.dispose();
    return target;
  }, [gl]);
  useEffect(() => () => none.dispose(), [none]);
  return useMemo(() => ({ envMap: none.texture, envMapIntensity: 0 }), [none]);
}

function Room() {
  const plain = useNoReflections();
  const wall = useMemo(() => new THREE.MeshStandardMaterial({ color: '#eef1f5', roughness: 0.9, ...plain }), [plain]);
  const floor = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d6dce5', roughness: 0.75, ...plain }), [plain]);
  // The room's walls (ball.ts ROOM), round the table: deep enough behind its far end for the robot.
  const W = ROOM.halfWidth * 2, H = ROOM.height, near = TABLE_Z + ROOM.near, far = TABLE_Z + ROOM.far, D = near - far, mid = (near + far) / 2;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-z={mid} receiveShadow material={floor}><planeGeometry args={[W, D]} /></mesh>
      <mesh rotation-x={Math.PI / 2} position={[0, H, mid]} material={wall}><planeGeometry args={[W, D]} /></mesh>
      <mesh position-z={far} receiveShadow material={wall}><planeGeometry args={[W, H * 2]} /></mesh>
      <mesh position-z={near} rotation-y={Math.PI} material={wall}><planeGeometry args={[W, H * 2]} /></mesh>
      <mesh position={[-W / 2, 0, mid]} rotation-y={Math.PI / 2} receiveShadow material={wall}><planeGeometry args={[D, H * 2]} /></mesh>
      <mesh position={[W / 2, 0, mid]} rotation-y={-Math.PI / 2} receiveShadow material={wall}><planeGeometry args={[D, H * 2]} /></mesh>
      <hemisphereLight args={['#ffffff', '#aab4c4', 1.7]} />
      <directionalLight position={[0.4, 2.95, 1.9]} intensity={1.4} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0005}
        shadow-camera-left={-4.5} shadow-camera-right={4.5} shadow-camera-top={4.5} shadow-camera-bottom={-4.5} shadow-camera-near={0.1} shadow-camera-far={10} />
    </group>
  );
}

/** A ping-pong table, as the Table Tennis minigame draws it: blue top, white lines, a net. */
function Table() {
  const plain = useNoReflections();
  const parts = useMemo(() => ({
    top: new THREE.MeshPhysicalMaterial({ color: '#1450b8', roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.3, ...plain }),
    white: new THREE.MeshStandardMaterial({ color: '#e9edf2', roughness: 0.5, ...plain }),
    frame: new THREE.MeshStandardMaterial({ color: '#9aa6b4', roughness: 0.4, metalness: 0.3, ...plain }),
    mesh: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, ...plain }),
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 10),
  }), [plain]);
  useEffect(() => () => { for (const part of Object.values(parts)) part.dispose(); }, [parts]);
  const { box, cylinder, top, white, frame, mesh } = parts;
  const { halfLength: L, halfWidth: W, top: Y } = TABLE;
  const line = 0.03, lift = 0.0015;
  return (
    <group position-z={TABLE_Z}>
      <mesh geometry={box} material={top} position={[0, Y - 0.015, 0]} scale={[W * 2, 0.03, L * 2]} castShadow receiveShadow />
      {/* White lines: the edges and the centre line. */}
      <mesh geometry={box} material={white} position={[W - line / 2, Y + lift, 0]} scale={[line, 0.002, L * 2]} />
      <mesh geometry={box} material={white} position={[-W + line / 2, Y + lift, 0]} scale={[line, 0.002, L * 2]} />
      <mesh geometry={box} material={white} position={[0, Y + lift, L - line / 2]} scale={[W * 2, 0.002, line]} />
      <mesh geometry={box} material={white} position={[0, Y + lift, -L + line / 2]} scale={[W * 2, 0.002, line]} />
      <mesh geometry={box} material={white} position={[0, Y + lift, 0]} scale={[0.012, 0.002, L * 2]} />
      {/* Under the top: a frame and four legs. */}
      <mesh geometry={box} material={frame} position={[0, Y - 0.06, 0]} scale={[W * 1.8, 0.06, L * 1.8]} castShadow />
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} geometry={cylinder} material={frame} position={[sx * (W - 0.12), (Y - 0.08) / 2, sz * (L - 0.25)]} scale={[0.03, Y - 0.08, 0.03]} castShadow />
      ))}
      {/* The net, its white band along the top, and its posts. */}
      <mesh geometry={box} material={mesh} position={[0, Y + NET.height / 2, 0]} scale={[NET.halfWidth * 2, NET.height, 0.004]} />
      <mesh geometry={box} material={white} position={[0, Y + NET.height - 0.006, 0]} scale={[NET.halfWidth * 2, 0.014, 0.008]} />
      {[-1, 1].map((sx) => <mesh key={sx} geometry={cylinder} material={frame} position={[sx * NET.halfWidth, Y + NET.height / 2, 0]} scale={[0.012, NET.height + 0.02, 0.012]} />)}
    </group>
  );
}

/** The dancers' glass hands, from the character model: the bind pose's mesh, centred. */
function useHandGeometry(side: Side) {
  const gltf = useLoader(GLTFLoader, modelUrl);
  const geometry = useMemo(() => {
    let source: THREE.BufferGeometry | null = null;
    // The player's right hand is the one on the model's +x (Arm.R), as seen from behind.
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name.replace(/[^\w]/g, '').startsWith(side === 'right' ? 'ArmR' : 'ArmL')) source = (o as THREE.Mesh).geometry; });
    if (!source) throw Error(`The character has no ${side} hand`);
    const geo = gelGeometry(source);
    for (const name of Object.keys(geo.attributes)) if (name === 'skinIndex' || name === 'skinWeight') geo.deleteAttribute(name);
    geo.center();
    geo.computeBoundingSphere();
    return geo;
  }, [gltf, side]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/** The gel as a look has it (Character's appearance), at this opacity (the gel's own, 0.72, by default). */
function useGel(look: CharacterAppearance, opacity?: number) {
  const gel = useMemo(() => {
    const material = createGelMaterial();
    material.color = new THREE.Color(look.color);
    material.roughness = 0.36 - look.gloss * 0.0029;
    material.clearcoat = 0.4 + look.gloss * 0.006;
    if (opacity !== undefined) material.opacity = opacity;
    return material;
  }, [look, opacity]);
  useEffect(() => () => gel.dispose(), [gel]);
  return gel;
}

/** A ping-pong paddle: rubber on both faces (the front along +z), a wooden handle down −y. */
function Paddle({ rubber, forgiving }: { rubber: string; forgiving: boolean }) {
  const parts = useMemo(() => ({
    face: new THREE.MeshStandardMaterial({ color: rubber, roughness: 0.75 }),
    back: new THREE.MeshStandardMaterial({ color: new THREE.Color(rubber).multiplyScalar(0.75), roughness: 0.75 }),
    wood: new THREE.MeshStandardMaterial({ color: '#e9c48c', roughness: 0.5 }),
    edge: new THREE.MeshStandardMaterial({ color: '#c99a5c', roughness: 0.5 }),
    blade: new THREE.CylinderGeometry(0.075, 0.075, 0.004, 40).rotateX(Math.PI / 2),
    core: new THREE.CylinderGeometry(0.074, 0.074, 0.006, 40).rotateX(Math.PI / 2),
    handle: new THREE.BoxGeometry(0.028, 0.1, 0.022),
    reach: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    reachShape: new THREE.CircleGeometry(FORGIVING.radius, 40),
  }), [rubber]);
  useEffect(() => () => { for (const part of Object.values(parts)) part.dispose(); }, [parts]);
  return (
    <group>
      <mesh geometry={parts.blade} material={parts.face} position-z={0.005} castShadow />
      <mesh geometry={parts.core} material={parts.edge} castShadow />
      <mesh geometry={parts.blade} material={parts.back} position-z={-0.005} castShadow />
      <mesh geometry={parts.handle} material={parts.wood} position-y={-0.12} castShadow />
      {/* The forgiving paddle's reach, faintly. */}
      {forgiving && <mesh geometry={parts.reachShape} material={parts.reach} />}
    </group>
  );
}

// One hand, following the rig: the mitt just past the wrist, the paddle's handle in it, its blade
// along the hand and its face square to the knuckles (a shakehand grip). With two players the
// other one sees it too, as their opponent's dancer's hand: a mitt in the dancer's proportions
// (SeenBy their view), its tip where the player's own (SeenBy theirs) ends, so it holds the very
// paddle the ball meets. The player's own mitt still casts its shadow in both views.
function Hand({ side, rig, forgiving, two }: { side: Side; rig: Rig; forgiving: boolean; two: boolean }) {
  const geometry = useHandGeometry(side);
  const gel = useGel(DANCER_LOOKS[rig.end], 0.72);
  const dancerGel = useGel(DANCER_LOOKS[rig.end], DANCER_LOOKS[rig.end].opacity);
  const shadowOnly = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), []);
  useEffect(() => () => shadowOnly.dispose(), [shadowOnly]);
  const group = useRef<THREE.Group>(null);
  const state = useMemo(() => ({ wrist: new THREE.Vector3(REST[side].x, REST[side].y, REST[side].z), turn: new THREE.Quaternion(), started: false }), [side]);
  const tmp = useMemo(() => ({ wrist: new THREE.Vector3(), dir: new THREE.Vector3(), across: new THREE.Vector3(), face: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion(), body: new THREE.Matrix4(), yaw: new THREE.Quaternion(), v: new THREE.Vector3() }), []);
  const radius = geometry.boundingSphere?.radius ?? 0.33;
  const scale = HAND_SIZE / (2 * radius);
  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const now = performance.now();
    const target = rig.hands[side];
    const lost = rig.tracked && (!target || now - target.at >= LOST_MS);
    const pose = !rig.tracked || lost ? heldPose(side, REST[side]) : target!.pose;
    // The tracker's ~30 Hz, eased to the screen's rate (it's already filtered); a lost hand drops slowly.
    const k = 1 - Math.exp(-(lost ? 4 : 24) * delta);
    state.wrist.lerp(tmp.wrist.set(pose.wrist.x, pose.wrist.y, pose.wrist.z).multiplyScalar(rig.tracked ? REACH : 1), k);
    // The hand's frame: y along the hand, x across the knuckles, z (the paddle's front face) out of the palm.
    const dir = tmp.dir.set(pose.dir.x, pose.dir.y, pose.dir.z).normalize();
    const across = tmp.across.set(pose.across.x, pose.across.y, pose.across.z);
    const face = tmp.face.crossVectors(across, dir);
    if (face.lengthSq() > 1e-6) {
      face.normalize();
      across.crossVectors(dir, face);
      tmp.q.setFromRotationMatrix(tmp.m.makeBasis(across, dir, face));
      if (!state.started) { state.turn.copy(tmp.q); state.started = true; } else state.turn.slerp(tmp.q, k);
    }
    // Into the room: the body's frame is at the player's eye, facing down the table, level.
    tmp.yaw.setFromAxisAngle(UP, YAW[rig.end]);
    tmp.body.makeRotationFromQuaternion(tmp.yaw).setPosition(EYES[rig.end]);
    g.quaternion.multiplyQuaternions(tmp.yaw, state.turn);
    const wrist = tmp.wrist.copy(state.wrist).add(SHOULDER[side]).applyMatrix4(tmp.body);
    // The mitt sits just past the wrist, along the hand. The paddle's hand slides as the aim assist
    // says, and is shifted as its calibration has it.
    g.position.copy(wrist).addScaledVector(tmp.dir.set(0, 1, 0).applyQuaternion(g.quaternion), MITT);
    if (side === 'right') {
      rig.nudged.copy(rig.nudge);
      // (Only while the camera's on: the hands waiting for it aren't the player's.)
      rig.shifted.lerp(rig.tracked ? rig.shift : NO_SHIFT, 1 - Math.exp(-3 * delta));
      g.position.add(toRoom(rig.end, rig.nudged, tmp.v)).add(toRoom(rig.end, rig.shifted, tmp.v));
    }
    // After the game's frames take in this frame's pose (useMinigameFrame, -0.5) and a stand-in's (-0.4), before the ball (0).
  }, -0.25);
  // The ball looks for the paddle's blade in the rig.
  const blade = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    if (side !== 'right') return undefined;
    rig.blade = blade.current;
    return () => { rig.blade = null; };
  }, [rig, side]);
  // The dancer's mitt, its tip at the player's own mitt's.
  const big = radius * DANCER_SCALE;
  return (
    <group ref={group}>
      {two ? (
        <>
          <SeenBy views={[rig.end]}><mesh geometry={geometry} material={gel} scale={scale} /></SeenBy>
          <mesh geometry={geometry} material={shadowOnly} scale={scale} castShadow />
          <SeenBy views={[otherEnd(rig.end)]}><mesh geometry={geometry} material={dancerGel} scale={DANCER_SCALE} position-y={HAND_SIZE / 2 - big} /></SeenBy>
        </>
      ) : <mesh geometry={geometry} material={gel} scale={scale} castShadow />}
      {side === 'right' && <group ref={blade} position-y={BLADE_UP}><Paddle rubber={RUBBER} forgiving={forgiving} /></group>}
    </group>
  );
}

function Hands({ rig, forgiving, two }: { rig: Rig; forgiving: boolean; two: boolean }) {
  return (
    <Suspense fallback={null}>
      <Hand side="right" rig={rig} forgiving={forgiving} two={two} />
      <Hand side="left" rig={rig} forgiving={forgiving} two={two} />
    </Suspense>
  );
}

const deg = (radians: number) => (radians * 180) / Math.PI;
// The character's body bone's pivot is this many of its units below its head's middle (as it stands, neutralCharacterPose).
const HEAD_ABOVE_BODY = 1.6;
const FEET_BELOW_BODY = 0.8;

/**
 * A player's glass dancer, as the other player sees them (Character, posed directly): its head at
 * their eye, its body below, turned as the tracker sees theirs (arms.ts bodyTurn). Its own hands
 * are left out: the player's hands (Hand) are its hands, drawn where the paddle really is.
 *
 * The character faces its +z and has its left at +x; a player's own frame faces −z with their
 * right at +x. Half a turn about the vertical goes from one to the other: a turn about the
 * vertical stays as it is, and those about x and z change sign.
 */
function Dancer({ rig }: { rig: Rig }) {
  const pose = useRef<CharacterPose | null>(null);
  const eased = useMemo(() => ({ yaw: 0, roll: 0, pitch: 0, headYaw: 0, headRoll: 0 }), []);
  useFrame((_, delta) => {
    const turn = rig.body;
    const k = 1 - Math.exp(-8 * delta);
    for (const key of Object.keys(eased) as (keyof BodyTurn)[]) eased[key] += ((turn?.[key] ?? 0) - eased[key]) * k;
    pose.current = dancerPose(eased);
    // Before Character poses itself (0).
  }, -0.2);
  const eye = EYES[rig.end];
  return (
    <group position={[eye.x, 0, eye.z]} rotation-y={rig.end === 0 ? Math.PI : 0} scale={DANCER_SCALE}>
      <Suspense fallback={null}>
        <Character appearance={DANCER_LOOKS[rig.end]} performanceRef={pose as RefObject<CharacterPose | null>} />
      </Suspense>
    </group>
  );
}

/** The dancer's pose (Character's units, about its feet) for a body turned so. */
function dancerPose(turn: BodyTurn): CharacterPose {
  const u = (metres: number) => metres / DANCER_SCALE;
  // The head round the eye, a little behind it; the body below, as far behind as the shoulders.
  const headY = u(EYE.y + 0.03), bodyY = headY - HEAD_ABOVE_BODY;
  const hidden: Triple = [0, bodyY, 0];
  return {
    body: [0, bodyY, u(-0.08)], bodyRotation: [deg(-turn.pitch), deg(turn.yaw), deg(-turn.roll)], bodyScale: [1, 1, 1],
    head: [0, headY, u(-0.06)], headRotation: [deg(-turn.pitch * 0.5), deg(turn.headYaw), deg(-turn.headRoll)], headScale: 1,
    leftHand: hidden, rightHand: hidden, handScale: 0.001,
    leftFoot: [0.4, bodyY - FEET_BELOW_BODY, 0], rightFoot: [-0.4, bodyY - FEET_BELOW_BODY, 0], footScale: 1,
  };
}

/** What the HUD shows, kept up by the ball. */
interface Hud {
  flying: boolean; returns: number; rally: number; best: number;
  /** How the last ball went by each player's paddle. */
  passes: (PassResult | null)[];
  /** With two: who serves, and whether the ball's waiting for them. */
  server: End; holding: boolean;
}
/** Each player's part of the ball's frame: their paddle last frame (the table's frame) and where they'd moved it (their own), their swings, the ball's pass, their left hand. */
interface Player { paddle: PaddlePose | null; moved: V3 | null; speeds: { t: number; vel: V3 }[]; pass: Pass | null; raised: boolean; }

/**
 * The ball, and the robot's paddle alone: the ball held on the robot's paddle until a serve (the
 * left hand raised, or Space), tossed up and struck, then flying (ball.ts) in the table's frame at
 * the time's speed, met by the players' paddles as they moved this frame (as they were a lag ago:
 * LaggedBall, flight.ts), with a fading trail behind it. A hit judged in the past puts the ball
 * where it is now, and its drawn place eases onto that. A dead ball (on the floor, or settled)
 * goes back to the robot. A return that lands on the far half counts, and the bot (bot.ts) plays
 * it back, the robot's paddle drawn back, swung through the ball and followed through (robot.ts):
 * a rally lasts as long as the player keeps returning it.
 *
 * With two, the ball waits over the server's end until they raise their left hand (or Space),
 * then it's tossed up for them to hit, and the open rally (rally.ts) counts the shots that land
 * on the other half; a dead ball goes to whoever's end it finished at.
 */
function PlayBall({ ctx, rigs, play, hud, scene, robot }: { ctx: MinigameContext; rigs: Rig[]; play: Play; hud: Hud; scene: SceneId; robot: StationDriver | null }) {
  const two = rigs.length > 1;
  const plain = useNoReflections();
  const look = BALL_LOOK[scene];
  const parts = useMemo(() => ({
    ball: new THREE.MeshStandardMaterial({ color: look.ball, emissive: look.ball, emissiveIntensity: look.glow, roughness: 0.35, ...plain }),
    shape: new THREE.SphereGeometry(BALL_R, 20, 14),
    trail: Array.from({ length: TRAIL }, (_, i) => new THREE.MeshBasicMaterial({ color: look.trail, transparent: true, depthWrite: false, opacity: 0.45 * (1 - i / TRAIL) })),
    ring: new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2),
    ripples: Array.from({ length: RIPPLE.count }, () => new THREE.MeshBasicMaterial({ color: new THREE.Color(look.trail).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })),
  }), [plain, look]);
  useEffect(() => () => {
    parts.ball.dispose(); parts.shape.dispose(); parts.ring.dispose();
    for (const m of [...parts.trail, ...parts.ripples]) m.dispose();
  }, [parts]);
  const ballMesh = useRef<THREE.Mesh>(null);
  const trailGroup = useRef<THREE.Group>(null);
  const rippleGroup = useRef<THREE.Group>(null);
  const st = useMemo(() => ({
    ball: (two ? heldBall(0, 0) : { pos: onPaddle(HOLD_START), vel: v3(), cooldown: 0 }) as Ball,
    lagged: null as LaggedBall | null, drawnOff: v3(), flying: false, deadAt: Infinity, slowSince: null as number | null, servedAt: -Infinity,
    hits: 0, returns: 0, hitThisServe: false, trail: [] as THREE.Vector3[], time: 0,
    /** The players' own time. */
    real: 0,
    players: rigs.map((): Player => ({ paddle: null, moved: null, speeds: [], pass: null, raised: false })),
    /** When the ball was last hit (by anyone), alone the rally's returns so far and the best, and since when the ball's been held to serve. */
    touchedAt: -Infinity, rally: 0, best: 0, heldSince: 0,
    /** Alone: the player hit the ball last, and their return has had its one fair bounce (for the bot to play). */
    yours: false, farBounce: false,
    /**
     * The bot: where it meets the ball (its paddle's middle then), when it last struck it, the spot
     * it's aiming its next shot at, the shot's heading (from above) and whether it's on its
     * forehand, and its paddle's face and stroke as drawn (eased).
     */
    bot: { pos: { ...BOT.home }, hitAt: -Infinity, aim: null as V3 | null, dir: v3(0, 0, 1), fore: true, normal: { ...HOLD_NORMAL }, offset: v3() },
    /** The robot's paddle this frame (the table's frame). */
    arm: HOLD_START as ArmPose,
    /** A serve asked for, and one under way (the toss, the strike, the follow-through), and its ball's velocity off the paddle. */
    serveAsked: false, serve: null as ServeMotion | null, serveVel: v3(),
    /** With two: the open rally, and each player's hits. */
    duel: newRally(0), hitsBy: [0, 0],
    /** The ball's latest bounces on the table, newest last: where (the table's frame), and when (the ball's time). */
    ripples: [] as { at: V3; t: number }[],
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const tmp = useMemo(() => ({ p: new THREE.Vector3(), n: new THREE.Vector3(), q: new THREE.Quaternion(), nudge: new THREE.Vector3() }), []);
  // The robot holds the ball from the start (the countdown too).
  useMemo(() => { if (robot) aimRobot(robot, HOLD_START); }, [robot]);
  // Development: the ball, the players, the settings and the camera (a split screen's views in
  // its `cameras`), for scripted swings and staged shots from play.ts.
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    Object.assign(window, { tableTennis: { ball: st, rig: rigs[0], rigs, play, camera } });
    return () => { Reflect.deleteProperty(window, 'tableTennis'); };
  }, [st, rigs, play, camera]);
  // Who's waiting to serve: alone, the player (for the robot to serve), while the ball's held.
  const serverOf = (): End => (two ? st.duel.server : 0);
  const holding = () => !st.flying && !st.serve;
  // The ball where it's drawn, easing onto a rewound hit's place, and its trail (newest first)
  // while it flies; then what the HUD and play.ts show.
  const draw = (dt: number) => {
    const b = st.ball;
    const ease = Math.exp(-CATCH_UP * dt);
    st.drawnOff = st.flying ? v3(st.drawnOff.x * ease, st.drawnOff.y * ease, st.drawnOff.z * ease) : v3();
    const at = new THREE.Vector3(b.pos.x + st.drawnOff.x, b.pos.y + st.drawnOff.y, b.pos.z + st.drawnOff.z + TABLE_Z);
    ballMesh.current?.position.copy(at);
    if (!st.flying) st.trail.length = 0;
    else if (dt > 0) { st.trail.unshift(at); st.trail.length = Math.min(st.trail.length, TRAIL); }
    trailGroup.current?.children.forEach((child, i) => {
      const p = st.trail[i + 1];
      child.visible = !!p;
      if (p) { child.position.copy(p); child.scale.setScalar(1 - (i / TRAIL) * 0.6); }
    });
    // The bounces' rings, spreading and fading.
    rippleGroup.current?.children.forEach((child, i) => {
      const r = st.ripples[i], u = r ? (st.time - r.t) / RIPPLE.life : 1;
      child.visible = u >= 0 && u < 1;
      if (!child.visible || !r) return;
      child.position.set(r.at.x, TABLE.top + 0.002, r.at.z + TABLE_Z);
      child.scale.setScalar(RIPPLE.from + (RIPPLE.to - RIPPLE.from) * easeOut(u));
      parts.ripples[i].opacity = 0.8 * (1 - u) * (1 - u);
    });
    const rally = two ? st.duel.count : st.rally, best = two ? Math.max(st.duel.best, st.duel.count) : st.best;
    Object.assign(hud, { flying: st.flying, returns: st.returns, rally, best, server: serverOf(), holding: holding() });
    ctx.report({
      ball: st.flying ? 'flying' : 'ready', hits: st.hits, returns: st.returns, rally, best,
      ...(two ? { server: serverOf() + 1, hits1: st.hitsBy[0], hits2: st.hitsBy[1] } : {}),
      autoplay: rigs.filter((rig) => rig.autoplay).map((rig) => rig.end + 1).join(',') || null,
    });
  };
  // The robot's paddle this frame: through a serve, as it goes; otherwise where the bot meets the
  // ball (or home), with the stroke's swing on it, its face eased round to the shot's heading (or
  // up, holding the ball). The ball rides on it while it's held.
  const moveRobot = (dt: number, plan: { t: number; at: V3 } | null) => {
    if (!robot) return;
    const bot = st.bot;
    if (st.serve) {
      st.arm = servePose(st.serve, st.time);
      const ball = serveBall(st.serve, st.time, st.arm);
      if (ball) st.ball.pos = ball;
      if (st.time >= st.serve.end) {
        // Over: the bot takes it from here, from where the paddle is.
        bot.pos = { x: st.arm.pos.x + st.arm.normal.x * GAP, y: st.arm.pos.y + st.arm.normal.y * GAP, z: st.arm.pos.z + st.arm.normal.z * GAP };
        bot.normal = { ...st.arm.normal };
        bot.dir = heading(v3(), st.arm.normal);
        bot.offset = v3();
        bot.hitAt = -Infinity;
        st.serve = null;
      }
    } else {
      const held = !st.flying;
      if (plan && bot.aim) { bot.dir = heading(bot.pos, bot.aim); bot.fore = forehand(plan.at); }
      const face = held ? HOLD_NORMAL : faceNormal(bot.dir);
      const offset = held ? v3() : strokeOffset(plan ? plan.t : null, st.time - bot.hitAt, bot.dir, bot.fore, reachRoom(bot.pos));
      const kn = 1 - Math.exp(-12 * dt), ko = 1 - Math.exp(-30 * dt);
      const n = v3(bot.normal.x + (face.x - bot.normal.x) * kn, bot.normal.y + (face.y - bot.normal.y) * kn, bot.normal.z + (face.z - bot.normal.z) * kn);
      const l = Math.hypot(n.x, n.y, n.z) || 1;
      bot.normal = v3(n.x / l, n.y / l, n.z / l);
      bot.offset = v3(bot.offset.x + (offset.x - bot.offset.x) * ko, bot.offset.y + (offset.y - bot.offset.y) * ko, bot.offset.z + (offset.z - bot.offset.z) * ko);
      const bob = held ? 0.008 * Math.sin(st.time * 2.2) : 0;
      st.arm = {
        pos: v3(bot.pos.x + bot.offset.x - bot.normal.x * GAP, bot.pos.y + bot.offset.y - bot.normal.y * GAP + bob, bot.pos.z + bot.offset.z - bot.normal.z * GAP),
        normal: bot.normal,
      };
      if (held) st.ball.pos = onPaddle(st.arm);
    }
    aimRobot(robot, st.arm);
  };
  // Development: a stand-in (autoplay.ts) sets its player's hands before they're drawn, from the
  // ball as they'd see it (a lag ago): its blade where the swing should be (the wrist that puts
  // it there, through Hand's reach, mitt and blade, less the paddle's calibration), and its left
  // hand up a while after it's been given the ball to serve.
  useFrame(() => {
    const now = performance.now();
    for (const rig of rigs) {
      if (!rig.autoplay) continue;
      const seen = st.flying && st.lagged ? mineBall(rig.end, st.lagged.then(lagOf(rig, play))) : null;
      const blade = autoplayBlade(seen && arrival(seen, play.timeScale));
      const grip = heldPose('right', REST.right);
      const reach = MITT + BLADE_UP, s = SHOULDER.right, d = grip.dir, k = 1 / (rig.tracked ? REACH : 1);
      grip.wrist = {
        x: (blade.x - OWN_EYE.x - s.x - d.x * reach - rig.shifted.x) * k,
        y: (blade.y - OWN_EYE.y - s.y - d.y * reach - rig.shifted.y) * k,
        z: (blade.z - OWN_EYE.z - s.z - d.z * reach - rig.shifted.z) * k,
      };
      rig.hands.right = { at: now, pose: grip };
      const raised = autoplayRaised(holding() && serverOf() === rig.end ? st.time - st.heldSince : null);
      rig.hands.left = { at: now, pose: heldPose('left', raised ? { x: -0.05, y: 0.3, z: -0.15 } : { x: -0.05, y: -0.4, z: -0.1 }) };
    }
  }, -0.4);
  useFrame((_, delta) => {
    // Real time (the players'), and the ball's world's.
    // Only while playing: the countdown and a pause hold everything where it is.
    const playing = ctx.phase() === 'playing';
    const dt = playing ? Math.min(delta, 1 / 20) : 0;
    const worldDt = dt * play.timeScale;
    st.time += worldDt;
    // Each paddle where it's drawn now, in the table's frame (with the reach it has), where the
    // player has it in their own frame (without the aim assist's slide), and where they've moved
    // it (without its calibration either).
    const pads = rigs.map((rig) => {
      if (!rig.blade) return { paddle: null, raw: null, moved: null };
      rig.blade.getWorldPosition(tmp.p);
      tmp.n.set(0, 0, 1).applyQuaternion(rig.blade.getWorldQuaternion(tmp.q));
      const paddle: PaddlePose = { center: v3(tmp.p.x, tmp.p.y, tmp.p.z - TABLE_Z), normal: v3(tmp.n.x, tmp.n.y, tmp.n.z), ...(play.forgiving ? FORGIVING : BLADE) };
      const c = mine(rig.end, paddle.center);
      const raw = v3(c.x - rig.nudged.x, c.y - rig.nudged.y, c.z - rig.nudged.z);
      const moved = v3(raw.x - rig.shifted.x, raw.y - rig.shifted.y, raw.z - rig.shifted.z);
      return { paddle, raw, moved };
    });
    const keep = () => rigs.forEach((_, i) => { st.players[i].paddle = pads[i].paddle; st.players[i].moved = pads[i].moved; });
    // Held while not playing: the ball, the bot, the score and the paddles' calibration stay as
    // they are, whatever the paddles do (they're still followed, so play resumes without a jump).
    if (!playing) {
      keep();
      draw(0);
      return;
    }
    const help = ASSIST.max;
    st.real += dt;
    const now = performance.now();
    // Each player's swing (at their own speed, whatever the time's; neither the assist's slide nor
    // the calibration's shift is a swing), how late they see the ball, and their left hand raised
    // above its shoulder (from the tracker), with some give before it counts as lowered.
    const you = rigs.map((rig, i) => {
      const p = st.players[i], moved = pads[i].moved;
      const paddleVel = p.moved && moved && dt > 0 ? v3((moved.x - p.moved.x) / dt, (moved.y - p.moved.y) / dt, (moved.z - p.moved.z) / dt) : undefined;
      // Only a hand being tracked swings (one lost drifts down to its rest, which is no swing).
      const right = rig.hands.right;
      const live = rig.tracked && !!right && now - right.at < LOST_MS;
      if (paddleVel && live) p.speeds.push({ t: st.real, vel: paddleVel });
      while (p.speeds.length && st.real - p.speeds[0].t > 0.5) p.speeds.shift();
      const left = rig.hands.left;
      const fresh = rig.tracked && left && now - left.at < LOST_MS;
      const wasRaised = p.raised;
      p.raised = !!fresh && left.pose.wrist.y > (p.raised ? RAISED.down : RAISED.up);
      return { paddleVel, live, wasRaised, lag: lagOf(rig, play), swing: strongestSwing(p.speeds, st.real) };
    });
    // The server's left hand raised (not in the middle of a rally: an arm swung up mid-rally isn't a serve).
    const s = serverOf();
    const idle = !st.flying || st.time - Math.max(st.servedAt, st.touchedAt) > RAISED.again * play.timeScale;
    const serve = play.serve || (st.players[s].raised && idle && (!you[s].wasRaised || st.time - st.servedAt > RAISED.again * play.timeScale));
    play.serve = false;
    let plan: { t: number; at: V3 } | null = null;
    const endRally = () => { if (st.rally) { st.best = Math.max(st.best, st.rally); st.rally = 0; } };
    // A pass over: said in the HUD, and the paddle's calibration moved by it.
    const finishPass = (i: number, struck: boolean) => {
      const p = st.players[i];
      if (!p.pass) return;
      const pass = endPass(p.pass, struck, SWING.minSpeed);
      p.pass = null;
      const shifted = recalibrate(rigs[i].shift, pass); rigs[i].shift.set(shifted.x, shifted.y, shifted.z);
      hud.passes[i] = pass;
    };
    const finishPasses = () => rigs.forEach((_, i) => finishPass(i, false));
    // The ball's flight over (it's dead, or a stalled rally's ball taken back).
    const over = () => {
      st.flying = false;
      st.bot.aim = null;
      st.heldSince = st.time;
      if (two) dead(st.duel, endOf(st.ball.pos.z)); else endRally();
      finishPasses();
    };
    if (two) {
      // The serve: a stalled rally's ball back to the server, and tossed up from over their end.
      if (serve) {
        if (st.flying) { over(); st.duel.server = s; }
        st.ball = tossBall(s);
        st.lagged = new LaggedBall(st.ball, st.time);
        tossed(st.duel);
        rigs.forEach((_, i) => { st.players[i].pass = null; });
        Object.assign(st, { flying: true, deadAt: Infinity, slowSince: null, servedAt: st.time, drawnOff: v3() });
        st.trail.length = 0;
      } else if (!st.flying) {
        const held = heldBall(st.duel.server, st.time);
        st.ball.pos = held.pos; st.ball.vel = held.vel;
      }
    } else {
      // A serve asked for: the ball back to the robot if it's still out (a rally stalled), and served once it's holding it.
      if (serve && !st.serve) {
        st.serveAsked = true;
        if (st.flying) over();
      }
      if (holding() && st.serveAsked && dist(st.bot.pos, BOT.home) < 0.02 && dist(st.bot.normal, HOLD_NORMAL) < 0.05) {
        endRally();
        // Struck from above where it's held, down onto its own half and over onto the player's.
        const from = serveStrike(st.arm.pos);
        const flight = botServe(from, play.botLevel);
        const vel = flight?.vel ?? v3(0, 0, 3);
        const dir = heading(from, flight?.second ?? v3(0, 0, 1));
        const tilt = Math.min(0.35, Math.max(-0.2, Math.atan2(vel.y, Math.hypot(vel.x, vel.z))));
        st.serve = planServe(st.time, st.arm.pos, dir, faceNormal(dir, tilt));
        st.serveVel = vel;
        st.serveAsked = false;
      }
    }
    const b = st.ball;
    if (!two && st.serve && !st.flying && st.time >= st.serve.strikeAt) {
      // The strike: the ball's flight begins.
      b.pos = { ...st.serve.strike };
      b.vel = { ...st.serveVel };
      b.cooldown = 0;
      st.lagged = new LaggedBall(b, st.time);
      st.drawnOff = v3();
      st.players[0].pass = null;
      Object.assign(st, { flying: true, deadAt: Infinity, slowSince: null, servedAt: st.time, hitThisServe: false, yours: false, farBounce: false });
      st.trail.length = 0;
    } else if (st.flying && st.lagged) {
      const lagged = st.lagged;
      // Each ball's pass by each paddle, as its player saw it: kept at its nearest.
      rigs.forEach((rig, i) => {
        const raw = pads[i].raw;
        if (!you[i].live || !raw) return;
        const then = mineBall(rig.end, lagged.then(you[i].lag));
        if (coming(then, raw.z)) st.players[i].pass = trackPass(st.players[i].pass, then, raw, Math.hypot(you[i].swing.x, you[i].swing.y, you[i].swing.z));
      });
      const before = { ...b.pos };
      const swingers: Swinger[] = rigs.map((rig, i) => ({
        end: rig.end, raw: pads[i].raw, paddleVel: you[i].paddleVel, swing: you[i].swing, lag: you[i].lag,
        from: st.players[i].paddle ?? pads[i].paddle, to: pads[i].paddle,
      }));
      const flight = flightStep(lagged, worldDt, swingers, help, play.timeScale);
      // Drawn from where it was, easing onto where a hit (judged a lag ago) put it.
      const by = flight.events.find((e): e is FlightEvent & { type: 'paddle' } => e.type === 'paddle')?.by;
      if ((flight.swung || flight.hit) && by !== undefined && you[by].lag > 0) st.drawnOff = v3(before.x + st.drawnOff.x - b.pos.x, before.y + st.drawnOff.y - b.pos.y, before.z + st.drawnOff.z - b.pos.z);
      for (const e of flight.events) {
        if (two) {
          if (e.type === 'paddle' && e.by !== undefined) { st.hits += 1; st.hitsBy[e.by] += 1; hit(st.duel, e.by); st.touchedAt = st.time; finishPass(e.by, true); }
          if (e.type === 'table' && bounced(st.duel, endOf(e.at.z)) === 'fair') st.returns += 1;
        } else {
          if (e.type === 'paddle') { st.hits += 1; st.hitThisServe = true; st.yours = true; st.touchedAt = st.time; st.farBounce = false; finishPass(0, true); }
          if (e.type === 'table' && e.side === 'far' && st.hitThisServe) { st.returns += 1; st.rally += 1; st.hitThisServe = false; st.farBounce = true; }
          // Anything else after the far half's bounce: the bot can't play it.
          else if (e.type !== 'paddle') st.farBounce = false;
          if (e.type === 'table' && e.side === 'near') st.hitThisServe = false;
        }
        if (e.type === 'table') { st.ripples.push({ at: e.at, t: st.time }); if (st.ripples.length > RIPPLE.count) st.ripples.shift(); }
        if (e.type === 'floor' && st.deadAt === Infinity) st.deadAt = st.time + DEAD_S;
      }
      // Gone by a paddle (or away) unhit.
      rigs.forEach((rig, i) => {
        const raw = pads[i].raw;
        if (st.players[i].pass && (!raw || !coming(mineBall(rig.end, lagged.then(you[i].lag)), raw.z))) finishPass(i, false);
      });
      // Settled anywhere (on the table too): still or barely rolling for a while.
      if (Math.hypot(b.vel.x, b.vel.y, b.vel.z) < 0.25) st.slowSince ??= st.time; else st.slowSince = null;
      const settled = st.slowSince !== null && st.time - st.slowSince > 0.6;
      if (robot) {
        // The bot goes to where it will meet the player's return (a fair one, or any it can get to if
        // it returns everything), and hits it as it gets there. Returning a miss ends the rally's count.
        plan = st.yours && st.deadAt === Infinity && !st.serve ? planReturn(b, st.farBounce, play.botAlways) : null;
        // The spot its shot will go to, chosen as it sets off for the ball (its paddle turns to face it).
        if (plan) st.bot.aim ??= botTarget(play.botLevel);
        if (plan && plan.t <= worldDt * 1.01 && dist(st.bot.pos, plan.at) < 0.3) {
          if (!st.farBounce) endRally();
          const aim = st.bot.aim ?? undefined;
          lagged.hitThen(0, (struck) => botShot(struck.pos, play.botLevel, Math.random, aim));
          Object.assign(st, { touchedAt: st.time, hitThisServe: false, yours: false, farBounce: false, slowSince: null });
          st.bot.hitAt = st.time;
          st.bot.aim = null;
        }
        if (!st.serve) {
          const goal = plan?.at ?? BOT.home, bot = st.bot.pos;
          const away = dist(goal, bot);
          // Returning everything, it's as quick as it needs to be to get there.
          const speed = plan && play.botAlways ? Math.max(BOT.speed, away / Math.max(plan.t, worldDt)) : BOT.speed;
          const move = Math.min(1, (speed * worldDt) / (away || 1));
          st.bot.pos = v3(bot.x + (goal.x - bot.x) * move, bot.y + (goal.y - bot.y) * move, bot.z + (goal.z - bot.z) * move);
        }
      }
      if (settled || st.time > st.deadAt || st.time - Math.max(st.servedAt, st.touchedAt) > 12) over();
    } else if (robot && !st.serve) {
      // Back home between rallies, to hold the ball.
      const bot = st.bot.pos, k = 1 - Math.exp(-5 * worldDt);
      st.bot.pos = v3(bot.x + (BOT.home.x - bot.x) * k, bot.y + (BOT.home.y - bot.y) * k, bot.z + (BOT.home.z - bot.z) * k);
    }
    moveRobot(worldDt, plan);
    // Each assist's slide for the next frame: towards where the ball will meet that player's
    // paddle, quickly as it nears, and slowly back once it's gone.
    rigs.forEach((rig, i) => {
      const { raw, paddle } = pads[i], paddleVel = you[i].paddleVel;
      const seen = st.flying && st.lagged && raw && paddle && paddleVel ? mineBall(rig.end, st.lagged.then(you[i].lag)) : null;
      const nudge = !seen || !raw || !paddle || !paddleVel ? null
        : help.swing ? interceptNudge(seen, raw, paddleVel, play.timeScale, help.reach)
          : contactNudge(seen, { ...paddle, center: raw, normal: mine(rig.end, paddle.normal) }, paddleVel, play.timeScale, help.reach);
      tmp.nudge.set(nudge?.x ?? 0, nudge?.y ?? 0, nudge?.z ?? 0);
      rig.nudge.lerp(tmp.nudge, 1 - Math.exp(-(nudge ? 30 : 5) * dt));
    });
    keep();
    draw(dt);
  });
  return (
    <>
      <mesh ref={ballMesh} geometry={parts.shape} material={parts.ball} castShadow />
      <group ref={trailGroup}>
        {parts.trail.map((m, i) => <mesh key={i} geometry={parts.shape} material={m} visible={false} />)}
      </group>
      <group ref={rippleGroup}>
        {parts.ripples.map((m, i) => <mesh key={i} geometry={parts.ring} material={m} visible={false} />)}
      </group>
    </>
  );
}

interface HudLine { text: string; size: number; weight?: number; color?: string; }

/**
 * The HUD's lines, on the game's overlay: the score, the last ball's pass, the settings, and the
 * keys, in a dark glass panel in the top left (the host's scores are off, so the corner is free).
 * With two, a panel for each in their view's outer top corner, and a line between the views.
 */
function TableTennisHud({ ctx, rigs, play, hud }: { ctx: MinigameContext; rigs: Rig[]; play: Play; hud: Hud }) {
  const two = rigs.length > 1;
  useMinigameOverlay({
    // From the countdown on: not over the how-to card.
    phases: HUD_PHASES,
    draw: (g, ui) => {
      const tracking = ctx.handTracking();
      const score = `Rally ${hud.rally}   ·   Best ${hud.best}${two ? '' : `   ·   Returns ${hud.returns}`}`;
      const devLine = (): HudLine | null => (DEV ? {
        text: `Development: T time ${play.timeScale === 1 ? '1×' : play.timeScale === 0.5 ? '½×' : '¼×'} · F forgiving ${play.forgiving ? 'on' : 'off'} · L hit timing ${lagWords(rigs[0], play)} · ${two ? 'O/P stand-ins' : 'O stand-in'} ${rigs.some((r) => r.autoplay) ? rigs.filter((r) => r.autoplay).map((r) => `P${r.end + 1}`).join('+') : 'off'}`,
        size: 16, color: '#cfe3f5',
      } : null);
      if (!two) {
        const rig = rigs[0];
        const lines: HudLine[] = [
          { text: score, size: 28, weight: 800 },
          { text: !hud.flying ? 'Raise your left hand for the robot to serve' : hud.passes[0] ? describePass(hud.passes[0]) : 'Swing through the ball', size: 22 },
          { text: `Aim assist Max  ·  Bot ${choiceLabel('botShots', play.botLevel)}, returns ${play.botAlways ? 'everything' : 'fair shots'}`, size: 18, color: '#dff4ff' },
          { text: `Paddle calibration (shifted ${shiftWords(rig.shift)})`, size: 18, color: '#dff4ff' },
        ];
        // Tracking that isn't all there, said plainly.
        const warning = rig.flat ? 'This camera sends no 3D tracking: your arms\' depth is a guess'
          : tracking === 'loading' ? 'Loading hand tracking…'
            : tracking === 'dropped' ? 'Hand tracking is off (the phone was too slow): the paddle follows your arm'
              : tracking === 'unavailable' ? 'No hand tracking: the paddle follows your arm' : null;
        if (warning) lines.push({ text: warning, size: 18, color: '#ffe08a' });
        lines.push({ text: 'Keys: Space serve · B bot shots · R bot returns', size: 16, color: '#cfe3f5' });
        const dev = devLine();
        if (dev) lines.push(dev);
        panel(g, ui.w, lines, 'left');
        return;
      }
      // The line between the views.
      g.save();
      g.fillStyle = 'rgba(255, 255, 255, 0.55)';
      g.fillRect(ui.w / 2 - 1.5, 0, 3, ui.h);
      g.restore();
      rigs.forEach((rig) => {
        const pass = hud.passes[rig.end];
        const status = hud.holding ? (hud.server === rig.end ? 'Raise your left hand to serve' : `Player ${hud.server + 1} serves`)
          : pass ? describePass(pass) : 'Swing through the ball';
        const lines: HudLine[] = [
          { text: PLAYERS[rig.end].name, size: 22, weight: 800, color: PLAYERS[rig.end].light },
          { text: score, size: 28, weight: 800 },
          { text: status, size: 22 },
          { text: `Paddle calibration (shifted ${shiftWords(rig.shift)})`, size: 18, color: '#dff4ff' },
        ];
        if (rig.flat) lines.push({ text: 'This camera sends no 3D tracking: your arms\' depth is a guess', size: 18, color: '#ffe08a' });
        if (rig.end === 0) {
          if (tracking !== 'on') lines.push({ text: 'Two players: the paddles follow your arms (no hand tracking)', size: 18, color: '#ffe08a' });
          lines.push({ text: 'Keys: Space serve', size: 16, color: '#cfe3f5' });
          const dev = devLine();
          if (dev) lines.push(dev);
        }
        panel(g, ui.w, lines, rig.end === 0 ? 'left' : 'right');
      });
    },
  });
  return null;
}

/**
 * A dark glass panel of lines in a top corner, sized to its widest line and kept clear of the
 * pause icon at the top centre: a line too long for that shrinks.
 */
function panel(g: CanvasRenderingContext2D, width: number, lines: readonly HudLine[], corner: 'left' | 'right') {
  const pad = 16, gap = 7, margin = 32, top = 32;
  const room = width / 2 - 70 - margin - pad * 2;
  let w = 0, h = pad * 2 - gap;
  const sized = lines.map((line) => {
    g.font = `${line.weight ?? 700} ${line.size}px ${FONT}`;
    const size = Math.min(line.size, (line.size * room) / g.measureText(line.text).width);
    g.font = `${line.weight ?? 700} ${size}px ${FONT}`;
    w = Math.max(w, g.measureText(line.text).width);
    h += size + gap;
    return { ...line, size };
  });
  const x = corner === 'left' ? margin : width - margin - (w + pad * 2);
  drawDarkGlassPanel(g, { x, y: top, w: w + pad * 2, h }, 20);
  let y = top + pad;
  for (const line of sized) {
    drawShadowText(g, line.text, x + pad, y + line.size / 2, { size: line.size, weight: line.weight ?? 700, color: line.color });
    y += line.size + gap;
  }
}

const HUD_PHASES: readonly MinigamePhase[] = ['countdown', 'playing', 'paused', 'finishing'];
const lagWords = (rig: Rig, play: Play) => (play.hitLag === 'auto' ? `auto (${rig.latency > 0 ? Math.round((rig.latency + DRAW_LAG) * 1000) : '–'} ms)` : play.hitLag ? `${Math.round(play.hitLag * 1000)} ms` : 'off');

/** A view from an end's eye, tilted down a little, down the table. */
function viewFrom(end: End, fov: number, scene: SceneId): MinigameCameraProps {
  const eye = EYES[end], forward = end === 0 ? -1 : 1;
  return {
    position: [eye.x, eye.y, eye.z], target: [eye.x, eye.y + Math.sin(PITCH), eye.z + forward * Math.cos(PITCH)],
    fov, near: scene === 'biodome' ? 0.03 : 0.02, far: scene === 'biodome' ? BIODOME_FAR : 40,
  };
}

/**
 * The game: the room, the table, the players' hands and the ball, and the HUD; alone, the robot;
 * with two, a view each and each other's dancers.
 */
export default function TableTennis({ ctx }: { ctx: MinigameContext }) {
  // (The player count is the round's, fixed for it.)
  const two = ctx.playerCount >= 2;
  const [rigs] = useState<Rig[]>(() => (two ? [newRig(0), newRig(1)] : [newRig(0)]));
  const [play] = useState<Play>(() => {
    const chosen = optionsOf(ctx.options);
    return { forgiving: false, serve: false, timeScale: 1, hitLag: 'auto', botLevel: chosen.botShots, botAlways: chosen.botAlways };
  });
  const [forgiving, setForgiving] = useState(false);
  // The scene is chosen on the preview, for the round.
  const [scene] = useState<SceneId>(() => optionsOf(ctx.options).scene);
  const hud = useMemo<Hud>(() => ({ flying: false, returns: 0, rally: 0, best: 0, passes: rigs.map(() => null), server: 0, holding: true }), [rigs]);
  const robot = useMemo(() => (two ? null : createRobotDriver()), [two]);
  const views = useMemo(() => (two ? [viewFrom(0, SPLIT_FOV, scene), viewFrom(1, SPLIT_FOV, scene)] : undefined), [two, scene]);
  const camera = useMemo(() => viewFrom(0, FOV, scene), [scene]);

  // Space serves; alone, B and R step the settings (and save them, as the preview would); in
  // development, T steps time's speed, F makes the paddles forgiving, L steps the hit timing,
  // and O and P switch stand-ins on and off for the first and last players.
  useEffect(() => {
    const step = (id: OptionId, value: string) => { const next = nextChoice(id, value); ctx.setOption(id, next); return next; };
    const key = (e: KeyboardEvent) => {
      // Not with a modifier, nor a key something else took.
      if (e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || ctx.phase() !== 'playing') return;
      if (e.code === 'Space') { e.preventDefault(); play.serve = true; }
      else if (!two && e.code === 'KeyB') play.botLevel = optionsOf({ botShots: step('botShots', play.botLevel) }).botShots;
      else if (!two && e.code === 'KeyR') play.botAlways = step('botReturns', play.botAlways ? 'everything' : 'fair') === 'everything';
      else if (DEV && e.code === 'KeyF') setForgiving((on) => { play.forgiving = !on; return !on; });
      else if (DEV && e.code === 'KeyT') play.timeScale = TIME_SCALES[(TIME_SCALES.indexOf(play.timeScale as typeof TIME_SCALES[number]) + 1) % TIME_SCALES.length];
      else if (DEV && e.code === 'KeyL') play.hitLag = HIT_LAGS[(HIT_LAGS.indexOf(play.hitLag) + 1) % HIT_LAGS.length];
      else if (DEV && (e.code === 'KeyO' || e.code === 'KeyP')) { const rig = e.code === 'KeyO' ? rigs[0] : rigs[rigs.length - 1]; rig.autoplay = !rig.autoplay; }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [ctx, rigs, play, two]);

  return (
    <>
      <MinigameWorld camera={camera} views={views}
        background="#e6e8ec" shadows post={scene === 'biodome' ? BIODOME_POST : undefined}
        environment={scene === 'biodome' ? false : <StageEnvironment top="#e6ffff" horizon="#34b2e6" bottom="#2a86bc" lights={ENV_LIGHTS} intensity={1.05} />}>
        {scene === 'biodome' ? (
          // The Biodome brings its own table, lights, fog and reflections, round its origin.
          <group position-z={TABLE_Z}><BiodomeArena /></group>
        ) : (
          <>
            <Room />
            <Table />
          </>
        )}
        {rigs.map((rig) => <Hands key={rig.end} rig={rig} forgiving={forgiving} two={two} />)}
        {/* Each player's dancer, seen by the other. */}
        {two && rigs.map((rig) => <SeenBy key={rig.end} views={[otherEnd(rig.end)]}><Dancer rig={rig} /></SeenBy>)}
        <PlayBall ctx={ctx} rigs={rigs} play={play} hud={hud} scene={scene} robot={robot} />
        {robot && <RobotOpponent driver={robot} tableZ={TABLE_Z} />}
      </MinigameWorld>
      {rigs.map((rig) => <PlayerTracking key={rig.end} rig={rig} />)}
      <TableTennisHud ctx={ctx} rigs={rigs} play={play} hud={hud} />
    </>
  );
}
