import type { CSSProperties } from 'react';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGelMaterial, gelGeometry } from '../../../../packages/character/Character.tsx';
import modelUrl from '../../../../packages/character/assets/aero-character.glb?url';
import { RenderPipeline, resetPost } from '../../../../packages/stages/shared/post.tsx';
import { StageEnvironment } from '../../../../packages/stages/shared/Environment.tsx';
import type { EnvironmentLight } from '../../../../packages/stages/shared/Environment.tsx';
import { DISPLAY_MODES, displayModeFor } from '../display.ts';
import type { DisplayMode } from '../display.ts';
import FixedRenderResolution from '../FixedRenderResolution.tsx';
import { PLAYER_COLORS } from '../menu/layout.ts';
import { DEFAULT_FOV, handPose } from './arms.ts';
import type { HandPose, Side, Vec3 } from './arms.ts';
import { HandTracker } from './HandTracker.ts';
import type { TrackerView } from './HandTracker.ts';
import { OneEuro } from './oneEuro.ts';
import { ASSIST, ASSIST_LEVELS, SWING, assistReturn, contactNudge, interceptNudge, strongestSwing, swingHit } from './assist.ts';
import { LaggedBall } from './lagged.ts';
import { BOT, BOT_LEVELS, botShot, planReturn } from './bot.ts';
import type { BotLevel } from './bot.ts';
import { coming, describePass, endPass, recalibrate, shiftWords, trackPass } from './calibrate.ts';
import type { Pass, PassResult } from './calibrate.ts';
import type { AssistLevel } from './assist.ts';
import { BALL_R, NET, TABLE, aimServe, v3 } from './ball.ts';
import type { Ball, BallEvent, PaddlePose, V3 } from './ball.ts';
import './hands.css';

/*
 * /?hands: a first-person look at a blank room from the end of a ping-pong table, a paddle in the
 * dancers' glass right hand. The webcam tracks the player's pose in 3D and each hand's angle
 * (HandTracker, arms.ts) and the hands follow them. Raising the left hand (or Space) has the
 * launcher at the far end serve a ball; the ball's physics (ball.ts) meet the paddle as it really
 * moves. T slows time (the player's swing keeps its own speed); F makes the paddle forgiving (it
 * reaches further than it looks); A steps the aim assist (assist.ts); L steps the hits' lag
 * compensation (the paddle, seen late through the camera, meets the ball as it was then:
 * LaggedBall); C turns the paddle's calibration on or off (calibrate.ts: it shifts the paddle by
 * the way its swings keep missing, and the HUD says how each ball went by it); B steps how hard
 * the bot's shots are, and R whether it returns everything or only fair returns. In development, ?video=<url> plays a video as the camera. It
 * renders as the stages do: a 640×480 buffer through the stages' post (RenderPipeline), lit by a
 * StageEnvironment.
 */

// The eye, in the room, and the shoulders from it in the body's frame (which doesn't tilt).
const EYE = new THREE.Vector3(0, 1.6, 1.6);
const PITCH = -0.22;
const FOV = 100;
const SHOULDER: Record<Side, THREE.Vector3> = { right: new THREE.Vector3(0.2, -0.05, 0.05), left: new THREE.Vector3(-0.2, -0.05, 0.05) };
// Where a hand rests while it's lost: down by the side, out of view.
const REST: Record<Side, Vec3> = { right: { x: 0.02, y: -0.55, z: -0.1 }, left: { x: -0.02, y: -0.55, z: -0.1 } };
// Where the hands wait while the camera is off, held up in view.
const IDLE: Record<Side, Vec3> = { right: { x: -0.06, y: -0.2, z: -0.4 }, left: { x: 0.06, y: -0.2, z: -0.4 } };
const LOST_MS = 500;
const NO_SHIFT = new THREE.Vector3();
// Tracked reach is scaled up a little: arms held out read better a touch longer.
const REACH = 1.1;
// The hand's diameter, in metres (the dancers' hands are big, cartoon mitts).
const HAND_SIZE = 0.13;
const RUBBER = '#ff3b5c';
const BOT_RUBBER = '#2f6bff';
// The bot's paddle lunges this far (m) at the ball over this long (s) as it hits.
const BOT_LUNGE = { depth: 0.2, time: 0.28 };
// The table's middle (the net), its near end a step in front of the eye.
const TABLE_Z = EYE.z - 0.45 - TABLE.halfLength;
// The paddle's blade: its radius, and half its thickness, as drawn and when forgiving.
const BLADE = { radius: 0.075, halfThickness: 0.006 };
const FORGIVING = { radius: 0.13, halfThickness: 0.04 };
// The launcher: its mouth (in the table's frame, behind the far end), how long its serves fly to
// their first bounce, and where on the near half they're aimed (x across, z from the net).
const LAUNCHER = { x: 0, y: TABLE.top + 0.25, z: -TABLE.halfLength - 0.3 };
const SERVE = { flight: 0.65, x: 0.35, near: 0.5, far: 0.95 };
// The left wrist this far above its shoulder raises the hand (and back below the lower mark, lowers it);
// held up, the launcher serves again this often.
const RAISED = { up: 0.02, down: -0.1, again: 2.5 };
// A ball goes back into the launcher this long after it's dead (on the floor, or settled).
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

// openreef's environment: the glass hands mostly reflect it, and it keeps their gel aqua.
const ENV_LIGHTS: readonly EnvironmentLight[] = [
  { position: [0, 24, 4], color: '#f2ffff', intensity: 5, size: [26, 26] },
  { position: [-14, 16, 2], color: '#fffbe8', intensity: 4, size: [6, 10] },
  { position: [-18, 3, 6], color: '#5ff0ff', intensity: 1.8, size: [8, 10] },
  { position: [18, 4, -4], color: '#7fe8ff', intensity: 1.6, size: [8, 10] },
  { position: [0, 5, 22], color: '#8feaff', intensity: 1.0, size: [14, 7] },
];

interface HandTarget { pose: HandPose; at: number; }
/** What the tracker last said about each hand, and the scene's hands and paddle for the ball. */
interface Rig {
  hands: Record<Side, HandTarget | null>;
  /** The camera is on (the hands follow it; else they wait at IDLE). */
  tracked: boolean;
  /** The paddle's blade (its centre; its face's normal is its +z). */
  blade: THREE.Object3D | null;
  forgiving: boolean;
  /** Space was pressed: serve a ball. */
  serve: boolean;
  /** How fast the ball's world runs (1: real time). */
  timeScale: number;
  assist: AssistLevel;
  /** How late the paddle is to the ball (hits are judged against the ball as it was then). */
  hitLag: HitLag;
  /** The tracker's measured delay, camera to result, in seconds. */
  latency: number;
  /** The aim assist's slide of the right hand (in the room), set by the ball for the next frame. */
  nudge: THREE.Vector3;
  /** The slide the right hand was drawn with this frame. */
  nudged: THREE.Vector3;
  /** Whether the paddle calibrates itself; its shift (in the room), set by the ball's passes, and as drawn this frame (eased onto it). */
  calibrating: boolean;
  shift: THREE.Vector3;
  shifted: THREE.Vector3;
  /** How hard the bot's shots are, and whether it returns the player's misses too. */
  botLevel: BotLevel;
  botAlways: boolean;
}

/** A hand held at a wrist, pointing up and forward, knuckles level (index towards the middle). */
const heldPose = (side: Side, wrist: Vec3): HandPose => ({
  wrist, dir: { x: 0, y: 0.8, z: -0.6 }, across: { x: side === 'right' ? -1 : 1, y: 0, z: 0 }, from: 'pose',
});

// ?fov=<degrees>: the webcam's horizontal field of view, which sets how depth is read (arms.ts).
const FOV_PARAM = Number(new URLSearchParams(location.search).get('fov')) || DEFAULT_FOV;
const vec = (a: number[]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });
const arr = (a: Vec3) => [a.x, a.y, a.z];

function useTracker(rig: Rig) {
  const [tracker] = useState(() => new HandTracker());
  const [view, setView] = useState<TrackerView>(tracker.view);
  useEffect(() => {
    // Each hand's position and angles, one-euro filtered as results come in.
    const filters = Object.fromEntries((['left', 'right'] as const).map((side) => [side, {
      wrist: new OneEuro(1.2, 3), dir: new OneEuro(1, 1.2), across: new OneEuro(1, 1.2),
    }])) as Record<Side, Record<'wrist' | 'dir' | 'across', OneEuro>>;
    let shown = 0;
    const off = tracker.subscribe((next, fresh) => {
      // Re-render the HUD a few times a second, not on every result.
      const now = performance.now();
      if (!fresh || now - shown > 250 || next.status !== 'running') { shown = now; setView(next); }
      if (!fresh?.pose) return;
      const t = now / 1000;
      for (const side of ['left', 'right'] as const) {
        const pose = handPose(fresh.pose, fresh.hands.find((h) => h.side === side), side, fresh.size, FOV_PARAM);
        if (!pose) continue;
        const f = filters[side];
        rig.hands[side] = { at: now, pose: { from: pose.from,
          wrist: vec(f.wrist.filter(arr(pose.wrist), t)), dir: vec(f.dir.filter(arr(pose.dir), t)), across: vec(f.across.filter(arr(pose.across), t)) } };
      }
      rig.tracked = true;
      rig.latency = next.latencyMs / 1000;
    });
    return () => { off(); };
  }, [tracker, rig]);
  useEffect(() => {
    const stop = () => tracker.stop();
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); tracker.stop(); };
  }, [tracker]);
  return { tracker, view };
}

// The view: from the eye, tilted down a little.
function PovCamera() {
  const camera = useThree((s) => s.camera);
  useLayoutEffect(() => {
    camera.position.copy(EYE);
    camera.rotation.set(PITCH, 0, 0, 'YXZ');
    camera.updateMatrixWorld();
  }, [camera]);
  return null;
}

// As the stages render: their post defaults, and PCF shadows.
function StageLook() {
  const gl = useThree((s) => s.gl);
  useLayoutEffect(() => {
    resetPost();
    Object.assign(gl.shadowMap, { enabled: true, type: THREE.PCFShadowMap, autoUpdate: true });
  }, [gl]);
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
  const W = 6, H = 3, D = 8;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow material={floor}><planeGeometry args={[W, D]} /></mesh>
      <mesh rotation-x={Math.PI / 2} position-y={H} material={wall}><planeGeometry args={[W, D]} /></mesh>
      <mesh position-z={-D / 2} receiveShadow material={wall}><planeGeometry args={[W, H * 2]} /></mesh>
      <mesh position-z={D / 2} rotation-y={Math.PI} material={wall}><planeGeometry args={[W, H * 2]} /></mesh>
      <mesh position-x={-W / 2} rotation-y={Math.PI / 2} receiveShadow material={wall}><planeGeometry args={[D, H * 2]} /></mesh>
      <mesh position-x={W / 2} rotation-y={-Math.PI / 2} receiveShadow material={wall}><planeGeometry args={[D, H * 2]} /></mesh>
      <hemisphereLight args={['#ffffff', '#aab4c4', 1.7]} />
      <directionalLight position={[0.4, 2.95, 1.9]} intensity={1.4} castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.0005}
        shadow-camera-left={-3} shadow-camera-right={3} shadow-camera-top={3} shadow-camera-bottom={-3} shadow-camera-near={0.1} shadow-camera-far={8} />
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

/** The launcher behind the far end: a glossy body on a stand, its barrel at the player. */
function Launcher() {
  const plain = useNoReflections();
  const parts = useMemo(() => ({
    body: new THREE.MeshPhysicalMaterial({ color: '#f4f7fb', roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1, ...plain }),
    trim: new THREE.MeshStandardMaterial({ color: '#2fb4e8', roughness: 0.35, ...plain }),
    dark: new THREE.MeshStandardMaterial({ color: '#273140', roughness: 0.5, ...plain }),
  }), [plain]);
  useEffect(() => () => { for (const part of Object.values(parts)) part.dispose(); }, [parts]);
  const { x, y, z } = LAUNCHER;
  return (
    <group position={[x, 0, z + TABLE_Z]}>
      {/* The stand: a pole on a round foot. */}
      <mesh material={parts.dark} position-y={0.02} castShadow><cylinderGeometry args={[0.2, 0.22, 0.04, 24]} /></mesh>
      <mesh material={parts.dark} position-y={(y - 0.12) / 2} castShadow><cylinderGeometry args={[0.025, 0.025, y - 0.12, 12]} /></mesh>
      {/* The body, a hopper on top, and the barrel (its mouth at LAUNCHER). */}
      <group position-y={y}>
        <mesh material={parts.body} position-z={-0.08} castShadow><sphereGeometry args={[0.14, 24, 16]} /></mesh>
        <mesh material={parts.trim} position-z={-0.08} rotation-x={Math.PI / 2}><torusGeometry args={[0.14, 0.012, 8, 32]} /></mesh>
        <mesh material={parts.body} position={[0, 0.16, -0.12]} castShadow><cylinderGeometry args={[0.1, 0.05, 0.14, 20]} /></mesh>
        <mesh material={parts.trim} position-z={0.02} rotation-x={Math.PI / 2} castShadow><cylinderGeometry args={[0.035, 0.045, 0.14, 20]} /></mesh>
        <mesh material={parts.dark} position-z={0.092} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.026, 0.026, 0.006, 20]} /></mesh>
      </group>
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

/** The gel in Player 1's colour and the menu dancers' gloss (Character's appearance). */
function useGel() {
  const gel = useMemo(() => {
    const material = createGelMaterial();
    const gloss = 85;
    material.color = new THREE.Color(PLAYER_COLORS[0]);
    material.roughness = 0.36 - gloss * 0.0029;
    material.clearcoat = 0.4 + gloss * 0.006;
    return material;
  }, []);
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
// along the hand and its face square to the knuckles (a shakehand grip).
function Hand({ side, rig, forgiving }: { side: Side; rig: Rig; forgiving: boolean }) {
  const camera = useThree((s) => s.camera);
  const geometry = useHandGeometry(side);
  const gel = useGel();
  const group = useRef<THREE.Group>(null);
  const state = useMemo(() => ({ wrist: new THREE.Vector3(REST[side].x, REST[side].y, REST[side].z), turn: new THREE.Quaternion(), started: false }), [side]);
  const tmp = useMemo(() => ({ wrist: new THREE.Vector3(), dir: new THREE.Vector3(), across: new THREE.Vector3(), face: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Quaternion(), body: new THREE.Matrix4(), yaw: new THREE.Quaternion() }), []);
  const scale = HAND_SIZE / (2 * (geometry.boundingSphere?.radius ?? 0.33));
  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const now = performance.now();
    const target = rig.hands[side];
    const lost = rig.tracked && (!target || now - target.at >= LOST_MS);
    const pose = !rig.tracked ? heldPose(side, IDLE[side]) : lost ? heldPose(side, REST[side]) : target!.pose;
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
    // Into the room: the body's frame is at the eye, facing the camera's way but level.
    tmp.yaw.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, camera.rotation.y);
    tmp.body.makeRotationFromQuaternion(tmp.yaw).setPosition(camera.position);
    g.quaternion.multiplyQuaternions(tmp.yaw, state.turn);
    const wrist = tmp.wrist.copy(state.wrist).add(SHOULDER[side]).applyMatrix4(tmp.body);
    // The mitt sits just past the wrist, along the hand. The paddle's hand slides as the aim assist
    // says, and is shifted as its calibration has it.
    g.position.copy(wrist).addScaledVector(tmp.dir.set(0, 1, 0).applyQuaternion(g.quaternion), 0.04);
    if (side === 'right') {
      rig.nudged.copy(rig.nudge);
      // (Only while the camera's on: the hands waiting for it aren't the player's.)
      rig.shifted.lerp(rig.tracked ? rig.shift : NO_SHIFT, 1 - Math.exp(-3 * delta));
      g.position.add(rig.nudged).add(rig.shifted);
    }
  }, -1);
  // The ball looks for the paddle's blade in the rig.
  const blade = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    if (side !== 'right') return undefined;
    rig.blade = blade.current;
    return () => { rig.blade = null; };
  }, [rig, side]);
  return (
    <group ref={group}>
      <mesh geometry={geometry} material={gel} scale={scale} castShadow />
      {side === 'right' && <group ref={blade} position-y={0.15}><Paddle rubber={RUBBER} forgiving={forgiving} /></group>}
    </group>
  );
}

function Hands({ rig, forgiving }: { rig: Rig; forgiving: boolean }) {
  return (
    <Suspense fallback={null}>
      <Hand side="right" rig={rig} forgiving={forgiving} />
      <Hand side="left" rig={rig} forgiving={forgiving} />
    </Suspense>
  );
}

/**
 * The ball: waiting in the launcher's mouth until a serve (the left hand raised, or Space), then
 * flying (ball.ts) in the table's frame at the time's speed, met by the paddle as it moved this
 * frame (as it was a lag ago: LaggedBall), with a fading trail behind it. A hit judged in the past
 * puts the ball where it is now, and its drawn place eases onto that. A dead ball (on the floor, or settled) goes back into the
 * launcher. A return that lands on the far half counts, and the bot (bot.ts), a floating paddle at
 * the far end, plays it back: a rally lasts as long as the player keeps returning it.
 */
interface Score { returns: number; rally: number; best: number; }
function PlayBall({ rig, onScore, onPass }: { rig: Rig; onScore: (score: Score) => void; onPass: (pass: PassResult) => void }) {
  const gl = useThree((s) => s.gl);
  const plain = useNoReflections();
  const parts = useMemo(() => ({
    ball: new THREE.MeshStandardMaterial({ color: '#fff7ea', roughness: 0.35, ...plain }),
    shape: new THREE.SphereGeometry(BALL_R, 20, 14),
    trail: Array.from({ length: TRAIL }, (_, i) => new THREE.MeshBasicMaterial({ color: '#fff3d6', transparent: true, depthWrite: false, opacity: 0.45 * (1 - i / TRAIL) })),
  }), [plain]);
  useEffect(() => () => { parts.ball.dispose(); parts.shape.dispose(); for (const m of parts.trail) m.dispose(); }, [parts]);
  const ballMesh = useRef<THREE.Mesh>(null);
  const trailGroup = useRef<THREE.Group>(null);
  const botPaddle = useRef<THREE.Group>(null);
  const st = useMemo(() => ({
    ball: { pos: { ...LAUNCHER }, vel: v3(), cooldown: 0 } as Ball, lagged: null as LaggedBall | null, drawnOff: v3(), flying: false, deadAt: Infinity, slowSince: null as number | null, servedAt: -Infinity,
    hits: 0, returns: 0, hitThisServe: false, raised: false, paddle: null as PaddlePose | null, moved: null as V3 | null, trail: [] as THREE.Vector3[], time: 0,
    /** The ball's pass by the player's paddle, while it's coming. */
    pass: null as Pass | null,
    /** The player's own time, and the blade's speeds in it lately (for the swing's strength). */
    real: 0, speeds: [] as { t: number; vel: V3 }[],
    /** When the ball was last hit (by either), the rally's returns so far, and the best. */
    touchedAt: -Infinity, rally: 0, best: 0,
    /** The player hit the ball last, and their return has had its one fair bounce (for the bot to play). */
    yours: false, farBounce: false,
    bot: { pos: { ...BOT.home }, hitAt: -Infinity },
  }), []);
  const tmp = useMemo(() => ({ p: new THREE.Vector3(), n: new THREE.Vector3(), q: new THREE.Quaternion(), nudge: new THREE.Vector3() }), []);
  // Development: the ball and the rig, for scripted swings from play.ts.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    Object.assign(window, { handsBall: st, handsRig: rig });
    return () => { Reflect.deleteProperty(window, 'handsBall'); Reflect.deleteProperty(window, 'handsRig'); };
  }, [st, rig]);
  useFrame((_, delta) => {
    // Real time (the player's), and the ball's world's.
    const dt = Math.min(delta, 1 / 20);
    const worldDt = dt * rig.timeScale;
    st.time += worldDt;
    // The paddle where it's drawn now, in the table's frame (with the reach it has), where the
    // player has it (without the aim assist's slide), and where they've moved it (without its calibration either).
    let paddle: PaddlePose | null = null;
    let raw: V3 | null = null;
    let moved: V3 | null = null;
    if (rig.blade) {
      rig.blade.getWorldPosition(tmp.p);
      tmp.n.set(0, 0, 1).applyQuaternion(rig.blade.getWorldQuaternion(tmp.q));
      paddle = { center: v3(tmp.p.x, tmp.p.y, tmp.p.z - TABLE_Z), normal: v3(tmp.n.x, tmp.n.y, tmp.n.z), ...(rig.forgiving ? FORGIVING : BLADE) };
      raw = v3(paddle.center.x - rig.nudged.x, paddle.center.y - rig.nudged.y, paddle.center.z - rig.nudged.z);
      moved = v3(raw.x - rig.shifted.x, raw.y - rig.shifted.y, raw.z - rig.shifted.z);
    }
    // The paddle swings at the player's own speed, whatever the time's (and neither the assist's
    // slide nor the calibration's shift is a swing).
    const paddleVel = st.moved && moved && dt > 0 ? v3((moved.x - st.moved.x) / dt, (moved.y - st.moved.y) / dt, (moved.z - st.moved.z) / dt) : undefined;
    const help = ASSIST[rig.assist];
    st.real += dt;
    if (paddleVel) st.speeds.push({ t: st.real, vel: paddleVel });
    while (st.speeds.length && st.real - st.speeds[0].t > 0.5) st.speeds.shift();
    // How late the paddle is to the ball, in the ball's time (the camera off: not at all).
    const lag = !rig.tracked ? 0 : (rig.hitLag === 'auto' ? (rig.latency > 0 ? rig.latency + DRAW_LAG : 0) : rig.hitLag) * rig.timeScale;
    // The left hand raised above its shoulder (from the tracker), with some give before it counts as lowered.
    const left = rig.hands.left;
    const fresh = rig.tracked && left && performance.now() - left.at < LOST_MS;
    const wasRaised = st.raised;
    st.raised = !!fresh && left.pose.wrist.y > (st.raised ? RAISED.down : RAISED.up);
    // Not in the middle of a rally (an arm swung up mid-rally isn't a serve).
    const idle = !st.flying || st.time - Math.max(st.servedAt, st.touchedAt) > RAISED.again * rig.timeScale;
    const serve = rig.serve || (st.raised && idle && (!wasRaised || st.time - st.servedAt > RAISED.again * rig.timeScale));
    rig.serve = false;
    const b = st.ball;
    const score = () => onScore({ returns: st.returns, rally: st.rally, best: st.best });
    const endRally = () => { if (st.rally) { st.best = Math.max(st.best, st.rally); st.rally = 0; score(); } };
    // A pass over: said in the HUD, and the paddle's calibration moved by it.
    const finishPass = (hit: boolean) => {
      if (!st.pass) return;
      const pass = endPass(st.pass, hit, SWING.minSpeed);
      st.pass = null;
      if (rig.calibrating) { const s = recalibrate(rig.shift, pass); rig.shift.set(s.x, s.y, s.z); }
      onPass(pass);
    };
    if (serve) {
      endRally();
      // Aimed at a spot on the near half, a little different each time.
      const target = v3((Math.random() * 2 - 1) * SERVE.x, 0, SERVE.near + Math.random() * (SERVE.far - SERVE.near));
      b.pos = { ...LAUNCHER };
      b.vel = aimServe(LAUNCHER, target, SERVE.flight);
      b.cooldown = 0;
      st.lagged = new LaggedBall(b, st.time);
      st.drawnOff = v3();
      st.pass = null;
      Object.assign(st, { flying: true, deadAt: Infinity, slowSince: null, servedAt: st.time, hitThisServe: false, yours: false, farBounce: false });
      st.trail.length = 0;
    } else if (st.flying && st.lagged) {
      // The ball's pass by the paddle, as the player saw it: kept at its nearest.
      const then = raw ? st.lagged.then(lag) : null;
      const swing = strongestSwing(st.speeds, st.real);
      if (rig.tracked && then && raw && coming(then, raw.z)) st.pass = trackPass(st.pass, then, raw, Math.hypot(swing.x, swing.y, swing.z));
      // A return the assist bends towards the far half, the moment it leaves the paddle.
      const onHit = help.landing > 0 ? (hit: Ball) => { hit.vel = assistReturn(hit.pos, hit.vel, help.landing); } : undefined;
      const before = { ...b.pos };
      // At max, a swing that has passed near the ball (as it was a lag ago) hits it.
      const swung = help.swing && then && raw && paddleVel ? swingHit(then, raw, paddleVel, swing, rig.timeScale) : null;
      const events: BallEvent[] = swung ? st.lagged.hitThen(lag, (hit) => assistReturn(hit.pos, swung, help.landing)) : [];
      const stepped = st.lagged.step(worldDt, lag, st.paddle ?? paddle, paddle, { paddleVel, onHit });
      events.push(...stepped.events);
      // Drawn from where it was, easing onto where the hit put it.
      if ((swung || stepped.hit) && lag > 0) st.drawnOff = v3(before.x + st.drawnOff.x - b.pos.x, before.y + st.drawnOff.y - b.pos.y, before.z + st.drawnOff.z - b.pos.z);
      for (const e of events) {
        if (e.type === 'paddle') { st.hits += 1; st.hitThisServe = true; st.yours = true; st.touchedAt = st.time; st.farBounce = false; finishPass(true); }
        if (e.type === 'table' && e.side === 'far' && st.hitThisServe) { st.returns += 1; st.rally += 1; st.hitThisServe = false; st.farBounce = true; score(); }
        // Anything else after the far half's bounce: the bot can't play it.
        else if (e.type !== 'paddle') st.farBounce = false;
        if (e.type === 'table' && e.side === 'near') st.hitThisServe = false;
        if (e.type === 'floor' && st.deadAt === Infinity) st.deadAt = st.time + DEAD_S;
      }
      // Gone by the paddle (or away) unhit.
      const after = raw ? st.lagged.then(lag) : null;
      if (st.pass && (!after || !raw || !coming(after, raw.z))) finishPass(false);
      // Settled anywhere (on the table too): still or barely rolling for a while.
      if (Math.hypot(b.vel.x, b.vel.y, b.vel.z) < 0.25) st.slowSince ??= st.time; else st.slowSince = null;
      const settled = st.slowSince !== null && st.time - st.slowSince > 0.6;
      // The bot goes to where it will meet the player's return (a fair one, or any it can get to if
      // it returns everything), and hits it as it gets there. Returning a miss ends the rally's count.
      const plan = st.yours && st.deadAt === Infinity ? planReturn(b, st.farBounce, rig.botAlways) : null;
      if (plan && plan.t <= worldDt * 1.01 && Math.hypot(st.bot.pos.x - plan.at.x, st.bot.pos.y - plan.at.y, st.bot.pos.z - plan.at.z) < 0.3) {
        if (!st.farBounce) endRally();
        st.lagged.hitThen(0, (hit) => botShot(hit.pos, rig.botLevel));
        Object.assign(st, { touchedAt: st.time, hitThisServe: false, yours: false, farBounce: false, slowSince: null });
        st.bot.hitAt = st.time;
      }
      const goal = plan?.at ?? BOT.home, bot = st.bot.pos;
      const away = Math.hypot(goal.x - bot.x, goal.y - bot.y, goal.z - bot.z);
      // Returning everything, it's as quick as it needs to be to get there.
      const speed = plan && rig.botAlways ? Math.max(BOT.speed, away / Math.max(plan.t, worldDt)) : BOT.speed;
      const move = Math.min(1, (speed * worldDt) / (away || 1));
      st.bot.pos = v3(bot.x + (goal.x - bot.x) * move, bot.y + (goal.y - bot.y) * move, bot.z + (goal.z - bot.z) * move);
      if (settled || st.time > st.deadAt || st.time - Math.max(st.servedAt, st.touchedAt) > 12) { st.flying = false; b.pos = { ...LAUNCHER }; endRally(); finishPass(false); }
    } else {
      // Back home between rallies.
      const bot = st.bot.pos, k = 1 - Math.exp(-3 * worldDt);
      st.bot.pos = v3(bot.x + (BOT.home.x - bot.x) * k, bot.y + (BOT.home.y - bot.y) * k, bot.z + (BOT.home.z - bot.z) * k);
    }
    // The bot's paddle, lunging at the ball as it hits.
    const lunge = Math.sin(Math.PI * Math.min(1, Math.max(0, (st.time - st.bot.hitAt) / BOT_LUNGE.time)));
    botPaddle.current?.position.set(st.bot.pos.x, st.bot.pos.y, st.bot.pos.z + TABLE_Z + lunge * BOT_LUNGE.depth);
    if (botPaddle.current) botPaddle.current.rotation.x = -0.2 - lunge * 0.35;
    // The assist's slide for the next frame: towards where the ball will meet the player's paddle,
    // quickly as it nears, and slowly back once it's gone.
    const seen = st.flying && st.lagged && raw && paddle && paddleVel ? st.lagged.then(lag) : null;
    const nudge = !seen || !raw || !paddle || !paddleVel ? null
      : help.swing ? interceptNudge(seen, raw, paddleVel, rig.timeScale, help.reach)
        : contactNudge(seen, { ...paddle, center: raw }, paddleVel, rig.timeScale, help.reach);
    tmp.nudge.set(nudge?.x ?? 0, nudge?.y ?? 0, nudge?.z ?? 0);
    rig.nudge.lerp(tmp.nudge, 1 - Math.exp(-(nudge ? 30 : 5) * dt));
    st.paddle = paddle;
    st.moved = moved;
    // Draw it, and its trail (newest first) while it flies.
    const ease = Math.exp(-CATCH_UP * dt);
    st.drawnOff = st.flying ? v3(st.drawnOff.x * ease, st.drawnOff.y * ease, st.drawnOff.z * ease) : v3();
    const at = new THREE.Vector3(b.pos.x + st.drawnOff.x, b.pos.y + st.drawnOff.y, b.pos.z + st.drawnOff.z + TABLE_Z);
    ballMesh.current?.position.copy(at);
    if (!st.flying) st.trail.length = 0; else { st.trail.unshift(at); st.trail.length = Math.min(st.trail.length, TRAIL); }
    trailGroup.current?.children.forEach((child, i) => {
      const p = st.trail[i + 1];
      child.visible = !!p;
      if (p) { child.position.copy(p); child.scale.setScalar(1 - (i / TRAIL) * 0.6); }
    });
    const c = gl.domElement.dataset;
    c.handsBall = st.flying ? 'flying' : 'ready';
    c.handsHits = String(st.hits);
    c.handsReturns = String(st.returns);
  });
  return (
    <>
      <mesh ref={ballMesh} geometry={parts.shape} material={parts.ball} castShadow />
      {/* The bot: a paddle floating at the far end, its face to the player. */}
      <group ref={botPaddle} position={[BOT.home.x, BOT.home.y, BOT.home.z + TABLE_Z]}>
        <group scale={1.6}><Paddle rubber={BOT_RUBBER} forgiving={false} /></group>
      </group>
      <group ref={trailGroup}>
        {parts.trail.map((m, i) => <mesh key={i} geometry={parts.shape} material={m} visible={false} />)}
      </group>
    </>
  );
}

// The canvas reports itself ready (for scripts/play.ts) once it has drawn.
function Ready({ rig }: { rig: Rig }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  if (import.meta.env.DEV) Object.assign(window, { handsScene: scene });
  const frames = useRef(0);
  useFrame(() => {
    frames.current += 1;
    if (frames.current === 3) gl.domElement.dataset.handsReady = 'true';
    gl.domElement.dataset.handsInput = rig.tracked ? 'camera' : 'none';
  });
  return null;
}

// The camera's picture, mirrored, with the tracked arms, the cuts the hands are looked for in and
// the hands found drawn over it.
const ARM_BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];
const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
function Preview({ tracker }: { tracker: HandTracker }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const c = canvas.current, ctx = c?.getContext('2d');
      const video = tracker.video;
      if (!c || !ctx || !video || !video.videoWidth) return;
      // The picture's shape, at the preview's width.
      const w = c.width, h = Math.round((w * video.videoHeight) / video.videoWidth);
      if (c.height !== h) c.height = h;
      ctx.save();
      ctx.translate(w, 0); ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, w, h);
      const result = tracker.view.result;
      const line = (points: { x: number; y: number }[], bones: number[][]) => {
        ctx.beginPath();
        for (const [a, b] of bones) { ctx.moveTo(points[a].x * w, points[a].y * h); ctx.lineTo(points[b].x * w, points[b].y * h); }
        ctx.stroke();
      };
      if (result?.pose) { ctx.lineWidth = 3; ctx.strokeStyle = '#7fd0ff'; line(result.pose.landmarks, ARM_BONES); }
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      for (const cut of result?.cuts ?? []) ctx.strokeRect(cut.x * w, cut.y * h, cut.w * w, cut.h * h);
      ctx.lineWidth = 2;
      for (const hand of result?.hands ?? []) { ctx.strokeStyle = hand.side === 'right' ? '#ff3b5c' : '#3b7bff'; line(hand.landmarks, HAND_BONES); }
      ctx.restore();
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [tracker]);
  return <canvas ref={canvas} className="hands-preview" width={320} height={180} />;
}

export default function HandsApp() {
  const viewport = useRef<HTMLDivElement>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => displayModeFor(innerWidth, innerHeight));
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setDisplayMode(displayModeFor(entry.contentRect.width, entry.contentRect.height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [rig] = useState<Rig>(() => ({
    hands: { left: null, right: null }, tracked: false, blade: null, forgiving: false, serve: false, timeScale: 1,
    assist: 'max', hitLag: 'auto', latency: 0, nudge: new THREE.Vector3(), nudged: new THREE.Vector3(),
    calibrating: true, shift: new THREE.Vector3(), shifted: new THREE.Vector3(), botLevel: 'medium', botAlways: true,
  }));
  const [forgiving, setForgiving] = useState(false);
  const [assist, setAssist] = useState<AssistLevel>(rig.assist);
  const [hitLag, setHitLag] = useState<HitLag>(rig.hitLag);
  const [timeScale, setTimeScale] = useState<number>(1);
  const [score, setScore] = useState<Score>({ returns: 0, rally: 0, best: 0 });
  const [calibrating, setCalibrating] = useState(rig.calibrating);
  const [lastPass, setLastPass] = useState<PassResult | null>(null);
  const [botLevel, setBotLevel] = useState<BotLevel>(rig.botLevel);
  const [botAlways, setBotAlways] = useState(rig.botAlways);
  const { tracker, view } = useTracker(rig);
  if (import.meta.env.DEV) Object.assign(window, { handsTracker: tracker });
  const running = view.status === 'starting' || view.status === 'running';

  // Space serves; T steps time's speed; F makes the paddle forgiving; A steps the aim assist; L the
  // hits' lag compensation; C turns the paddle's calibration on or off (off, its shift is dropped); B
  // steps how hard the bot's shots are; R has it return everything, or only fair returns.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Space is the launcher's, not the focused button's.
      if (e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'Space') rig.serve = true;
      if (e.code === 'KeyF') setForgiving((on) => { rig.forgiving = !on; return !on; });
      if (e.code === 'KeyT') setTimeScale((now) => {
        const next = TIME_SCALES[(TIME_SCALES.indexOf(now as typeof TIME_SCALES[number]) + 1) % TIME_SCALES.length];
        rig.timeScale = next;
        return next;
      });
      if (e.code === 'KeyA') setAssist((now) => { rig.assist = ASSIST_LEVELS[(ASSIST_LEVELS.indexOf(now) + 1) % ASSIST_LEVELS.length]; return rig.assist; });
      if (e.code === 'KeyC') setCalibrating((on) => { rig.calibrating = !on; if (on) rig.shift.set(0, 0, 0); return !on; });
      if (e.code === 'KeyB') setBotLevel((now) => { rig.botLevel = BOT_LEVELS[(BOT_LEVELS.indexOf(now) + 1) % BOT_LEVELS.length]; return rig.botLevel; });
      if (e.code === 'KeyR') setBotAlways((on) => { rig.botAlways = !on; return !on; });
      if (e.code === 'KeyL') setHitLag((now) => { rig.hitLag = HIT_LAGS[(HIT_LAGS.indexOf(now) + 1) % HIT_LAGS.length]; return rig.hitLag; });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [rig]);

  const toggle = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (running) { tracker.stop(); rig.tracked = false; rig.hands = { left: null, right: null }; return; }
    void tracker.start(import.meta.env.DEV ? new URLSearchParams(location.search).get('video') : null);
  };
  const result = view.result;
  const hands = result?.hands.map((h) => (h.side === 'right' ? 'R' : 'L')).sort().join(' ') || 'none';
  const status = view.status === 'error' ? view.message : view.status === 'starting' ? view.message
    : !result?.pose ? 'Step back so the camera sees your arms' : `Tracking · ${view.hz} Hz · hands: ${hands}`;

  return (
    <div ref={viewport} className="display-viewport">
      <div className="canvas-frame display" style={{ '--display-aspect': DISPLAY_MODES[displayMode].aspect } as CSSProperties}>
        <Canvas dpr={1} flat gl={{ antialias: false }} camera={{ fov: FOV, near: 0.02, far: 40 }}>
          <FixedRenderResolution />
          <StageLook />
          <color attach="background" args={['#e6e8ec']} />
          <StageEnvironment top="#e6ffff" horizon="#34b2e6" bottom="#2a86bc" lights={ENV_LIGHTS} intensity={1.05} />
          <PovCamera />
          <Room />
          <Table />
          <Launcher />
          <Hands rig={rig} forgiving={forgiving} />
          <PlayBall rig={rig} onScore={setScore} onPass={setLastPass} />
          <Ready rig={rig} />
          <RenderPipeline samples={0} aspect={DISPLAY_MODES[displayMode].aspect} />
        </Canvas>
        <div className="hands-hud">
          <button type="button" className="hands-button" onClick={toggle}>{running ? 'Stop camera' : 'Start camera'}</button>
          <span className="hands-status">{running || view.status === 'error' ? status : 'Start the camera to play'}</span>
          <span className="hands-status">Raise your left hand (or Space) to serve · Rally: {score.rally} · Best: {score.best} · Returns: {score.returns}</span>
          <span className="hands-status">T: time {timeScale === 1 ? '1×' : timeScale === 0.5 ? '½×' : '¼×'} · A: aim assist {assist} · F: forgiving paddle {forgiving ? 'on' : 'off'} · L: hit timing {hitLag === 'auto' ? `auto (${running && view.latencyMs ? Math.round(view.latencyMs + DRAW_LAG * 1000) : '–'} ms)` : hitLag ? `${Math.round(hitLag * 1000)} ms` : 'off'}</span>
        </div>
        <div className="hands-hud hands-hud-low">
          <span className="hands-status">{lastPass ? describePass(lastPass) : 'Each ball that comes at you: how far off your paddle was'}</span>
          <span className="hands-status">B: bot shots {botLevel} · R: bot returns {botAlways ? 'everything' : 'fair shots'}</span>
          <span className="hands-status">C: calibrate {calibrating ? `on (paddle shifted ${shiftWords(rig.shift)})` : 'off'}</span>
        </div>
        {view.status === 'running' && <Preview tracker={tracker} />}
      </div>
    </div>
  );
}
