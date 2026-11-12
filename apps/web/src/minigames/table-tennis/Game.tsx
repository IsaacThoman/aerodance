import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
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
import { useMinigameFrame } from '../hooks.ts';
import { MinigameWorld, SeenBy } from '../scene.tsx';
import type { MinigameCameraProps } from '../scene.tsx';
import type { MinigameContext } from '../types.ts';
import { DEFAULT_FOV } from './arms.ts';
import type { BodyTurn, Side } from './arms.ts';
import { ASSIST_LEVELS, DEFAULT_ASSIST } from './assist.ts';
import { BALL_R, NET, ROOM, TABLE } from './ball.ts';
import type { V3 } from './ball.ts';
import { otherEnd } from './rally.ts';
import type { End } from './rally.ts';
import { HIT_LAGS, Round } from './round.ts';
import { playBallSound } from './sound.ts';
import type { Play } from './round.ts';
import { BLADE_UP, EYE, EYES, FORGIVING, TABLE_Z, eyeOf, newHandFilters, newRig, trackHands } from './rig.ts';
import type { Rig } from './rig.ts';
import { RobotOpponent, aimRobot, createRobotDriver } from './RobotOpponent.tsx';
import type { StationDriver } from '../../../../../packages/robots/shared/station.ts';
import { optionsOf, sceneParam } from './options.ts';
import type { SceneId } from './options.ts';
import { TableTennisHud, newHud } from './Hud.tsx';

/*
 * Table Tennis (index.ts), seen from behind the player's glass dancer (Easy controls, as Wii Sports
 * Resort is: the dancer steps across to the ball and a swing's timing hits it: easy.ts) or in
 * first person (Precise controls), from the end of a ping-pong table in the Biodome
 * (packages/arenas/biodome) or a blank room (?scene=debug, for development): the
 * dancers' glass hands following the player's (the pose and Hand Landmarker landmarks the host's
 * camera sends with the game's 'hands' tracking, turned into the hands' places and angles by
 * arms.ts and followed by rig.ts), a paddle in their paddle hand (the Paddle hand setting, each
 * player's own). The round itself is round.ts: the ball's physics (ball.ts) meeting the players'
 * paddles as they really move (flight.ts), the serves, the robot and the count. This file draws it,
 * and sound.ts lets it be heard.
 *
 * Alone, the opponent is a robot arm at the far end (the Torven six-axis arm from the robot hall:
 * RobotOpponent.tsx), which holds the ball on its paddle for its serves, tosses it up and serves
 * (robot.ts), and plays back what the player returns (bot.ts), the arm's inverse kinematics putting
 * its paddle on the ball. The round is a match (first to 6: match.ts) or Return Challenge (the
 * Mode setting).
 *
 * With two, the screen splits (MinigameWorld's views): Player 1 on the left at the near end,
 * Player 2 on the right at the far end, each in first person, playing a match. Each sees the
 * other as their glass dancer (Dancer, SeenBy the other's view), the dancer's hands the very hands
 * that hold the paddles, so a paddle is where it's seen. The camera tracks both players' paddle
 * hands (index.ts tracking), unless the Hand tracking setting is off.
 *
 * A player's serve waits in the air by their paddle hand, a halo round it once it can be served:
 * their free hand raised tosses it, and a swing through it as it comes down (or Space) serves it.
 * When the match is won (or the challenge's run is over) the round finishes with its score.
 *
 * The HUD (Hud.tsx) is Wii Sports Resort's: the score bug, calls where the points are decided,
 * banners for the big moments and prompts while they're needed.
 *
 * Keys while playing: Space serves, A steps the aim assist (assist.ts: Normal unless ?assist= says
 * otherwise; it helps a swing meet the ball and land, and does nothing for a paddle that isn't
 * swung). Paddle calibration (calibrate.ts) shifts each paddle by the way its swings keep missing.
 * In development, D shows the HUD's development panel (how each ball went by each paddle, the
 * calibration, the settings), T slows time (the swing keeps its own speed), F makes the paddles
 * forgiving (they reach further than they look), L steps the hits' lag compensation (the paddle,
 * seen late through the camera, meets the ball as it was then: LaggedBall; 'auto' measures the
 * delay from each pose's capture time), and O and P have a stand-in (autoplay.ts) play for the
 * first and the last player.
 */

// The view: tilted down a little from the eye (rig.ts EYE).
const PITCH = -0.22;
/**
 * Easy's view, from behind: this far behind the player's eye and above it (m), looking at a point
 * this high over the table and this far past its middle (m), with this vertical field of view.
 */
const THIRD = { back: 2.25, up: 0.95, look: { y: 0.74, z: 0.4 }, fov: 44 } as const;
const FOV = 100;
// Each view of a split screen is 8:9: the same height of view keeps the table as big, and the
// paddle's swings across in view.
const SPLIT_FOV = 100;
const DEV = import.meta.env.DEV;
// The hand's diameter, in metres (the dancers' hands are big, cartoon mitts).
const HAND_SIZE = 0.13;
const RUBBER = '#ff3b5c';
// Time's speeds, stepped through with T.
const TIME_SCALES = [1, 0.5, 0.25] as const;
// The ball's drawn place eases onto a rewound hit's this fast (per second).
const CATCH_UP = 14;
const TRAIL = 28;
// A ring spreading on the table where the ball bounces: how long it lasts (s), its radius from
// and to (m), and how many can show at once.
const RIPPLE = { life: 0.6, from: 0.03, to: 0.23, count: 3 } as const;
// The ball waiting to be served: it pops into place over `pop` seconds, and its halo breathes
// between these radii (m), this fast (radians a second).
const WAIT = { pop: 0.18, from: 0.05, to: 0.075, rate: 5 } as const;
const easeOut = (u: number) => 1 - (1 - u) * (1 - u);
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

// ?assist=off|low|normal|high: how much the aim assist helps (assist.ts), until the A key steps it.
const ASSIST_PARAM = ASSIST_LEVELS.find((level) => level === new URLSearchParams(location.search).get('assist')) ?? DEFAULT_ASSIST;
// ?fov=<degrees>: the webcam's horizontal field of view, which sets how depth is read (arms.ts).
const FOV_PARAM = Number(new URLSearchParams(location.search).get('fov')) || DEFAULT_FOV;
/**
 * A player's hands from the host's poses, as each one arrives (rig.ts trackHands).
 */
function usePlayerHands(rig: Rig) {
  const filters = useMemo(newHandFilters, []);
  useMinigameFrame((frame) => { trackHands(rig, frame.players[rig.end]?.raw, performance.now(), filters, FOV_PARAM); });
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
// paddle the ball meets. The player's own mitt still casts its shadow in both views. Seen from
// behind (`third`: Easy's view), everyone sees the dancer's mitt.
function Hand({ side, rig, forgiving, two, third }: { side: Side; rig: Rig; forgiving: boolean; two: boolean; third: boolean }) {
  const geometry = useHandGeometry(side);
  const gel = useGel(DANCER_LOOKS[rig.end], 0.72);
  const dancerGel = useGel(DANCER_LOOKS[rig.end], DANCER_LOOKS[rig.end].opacity);
  const shadowOnly = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), []);
  useEffect(() => () => shadowOnly.dispose(), [shadowOnly]);
  const group = useRef<THREE.Group>(null);
  const radius = geometry.boundingSphere?.radius ?? 0.33;
  const scale = HAND_SIZE / (2 * radius);
  // Where the round put it this frame (rig.ts followHands), after the ball's frame (0).
  useFrame(() => {
    const g = group.current, drawn = rig.drawn[side];
    if (!g) return;
    g.position.copy(drawn.position);
    g.quaternion.copy(drawn.quaternion);
  }, 0.05);
  // The dancer's mitt, its tip at the player's own mitt's.
  const big = radius * DANCER_SCALE;
  return (
    <group ref={group}>
      {third ? <mesh geometry={geometry} material={dancerGel} scale={DANCER_SCALE} position-y={HAND_SIZE / 2 - big} castShadow /> : two ? (
        <>
          <SeenBy views={[rig.end]}><mesh geometry={geometry} material={gel} scale={scale} /></SeenBy>
          <mesh geometry={geometry} material={shadowOnly} scale={scale} castShadow />
          <SeenBy views={[otherEnd(rig.end)]}><mesh geometry={geometry} material={dancerGel} scale={DANCER_SCALE} position-y={HAND_SIZE / 2 - big} /></SeenBy>
        </>
      ) : <mesh geometry={geometry} material={gel} scale={scale} castShadow />}
      {side === rig.paddle && <group position-y={BLADE_UP}><Paddle rubber={RUBBER} forgiving={forgiving} /></group>}
    </group>
  );
}

function Hands({ rig, forgiving, two, third }: { rig: Rig; forgiving: boolean; two: boolean; third: boolean }) {
  return (
    <Suspense fallback={null}>
      <Hand side="right" rig={rig} forgiving={forgiving} two={two} third={third} />
      <Hand side="left" rig={rig} forgiving={forgiving} two={two} third={third} />
    </Suspense>
  );
}

const deg = (radians: number) => (radians * 180) / Math.PI;
// Seen from behind, a player's own dancer is a faint ghost, as Wii Sports Resort draws its player's
// Mii, so it doesn't hide the table.
const GHOST_LOOKS = DANCER_LOOKS.map((look) => ({ ...look, opacity: 0.32 }));
// The character's body bone's pivot is this many of its units below its head's middle (as it stands, neutralCharacterPose).
const HEAD_ABOVE_BODY = 1.6;
const FEET_BELOW_BODY = 0.8;

/**
 * A player's glass dancer, as the other player sees them, or (Easy's view, from behind) as they all
 * do (Character, posed directly): its head at their eye, wherever their body has stepped to
 * (rig.step: Easy's dancer goes across to meet the ball), its body below, turned as the tracker
 * sees theirs (arms.ts bodyTurn). Its own hands are left out: the player's hands (Hand) are its
 * hands, drawn where the paddle really is.
 *
 * The character faces its +z and has its left at +x; a player's own frame faces −z with their
 * right at +x. Half a turn about the vertical goes from one to the other: a turn about the
 * vertical stays as it is, and those about x and z change sign.
 */
function Dancer({ rig, ghost = false }: { rig: Rig; ghost?: boolean }) {
  const pose = useRef<CharacterPose | null>(null);
  const place = useRef<THREE.Group>(null);
  const eased = useMemo(() => ({ yaw: 0, roll: 0, pitch: 0, headYaw: 0, headRoll: 0 }), []);
  const at = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, delta) => {
    eyeOf(rig, at);
    place.current?.position.set(at.x, 0, at.z);
    const turn = rig.body;
    const k = 1 - Math.exp(-8 * delta);
    for (const key of Object.keys(eased) as (keyof BodyTurn)[]) eased[key] += ((turn?.[key] ?? 0) - eased[key]) * k;
    pose.current = dancerPose(eased);
    // Before Character poses itself (0).
  }, -0.2);
  const eye = EYES[rig.end];
  return (
    <group ref={place} position={[eye.x, 0, eye.z]} rotation-y={rig.end === 0 ? Math.PI : 0} scale={DANCER_SCALE}>
      <Suspense fallback={null}>
        <Character appearance={ghost ? GHOST_LOOKS[rig.end] : DANCER_LOOKS[rig.end]} performanceRef={pose as RefObject<CharacterPose | null>} />
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

/**
 * The round's ball (round.ts plays it, with the players' paddles and the robot's), drawn: where
 * it is, easing onto where a hit judged in the past put it, with a fading trail behind it and
 * rings where it bounces; waiting to be served, it pops into place.
 */
function PlayBall({ ctx, round, scene, robot }: { ctx: MinigameContext; round: Round; scene: SceneId; robot: StationDriver | null }) {
  const { rigs, play, two } = round;
  const plain = useNoReflections();
  const look = BALL_LOOK[scene];
  const parts = useMemo(() => ({
    ball: new THREE.MeshStandardMaterial({ color: look.ball, emissive: look.ball, emissiveIntensity: look.glow, roughness: 0.35, ...plain }),
    shape: new THREE.SphereGeometry(BALL_R, 20, 14),
    trail: Array.from({ length: TRAIL }, (_, i) => new THREE.MeshBasicMaterial({ color: look.trail, transparent: true, depthWrite: false, opacity: 0.45 * (1 - i / TRAIL) })),
    ring: new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2),
    ripples: Array.from({ length: RIPPLE.count }, () => new THREE.MeshBasicMaterial({ color: new THREE.Color(look.trail).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })),
    // The waiting ball's halo: a ring facing its server, breathing.
    halo: new THREE.MeshBasicMaterial({ color: new THREE.Color(look.trail).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    haloShape: new THREE.RingGeometry(0.8, 1, 48),
  }), [plain, look]);
  useEffect(() => () => {
    parts.ball.dispose(); parts.shape.dispose(); parts.ring.dispose(); parts.halo.dispose(); parts.haloShape.dispose();
    for (const m of [...parts.trail, ...parts.ripples]) m.dispose();
  }, [parts]);
  const ballMesh = useRef<THREE.Mesh>(null);
  const haloMesh = useRef<THREE.Mesh>(null);
  const trailGroup = useRef<THREE.Group>(null);
  const rippleGroup = useRef<THREE.Group>(null);
  const st = useMemo(() => ({ drawnOff: { x: 0, y: 0, z: 0 } as V3, trail: [] as THREE.Vector3[], real: 0, finished: false }), []);
  // The robot holds the ball from the start (the countdown too).
  useMemo(() => { if (robot) aimRobot(robot, round.arm); }, [robot, round]);
  // Development: the round (its ball, players and settings) and the camera (a split screen's
  // views in its `cameras`), for scripted swings and staged shots from play.ts.
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    Object.assign(window, { tableTennis: { ball: round, round, rig: rigs[0], rigs, play, camera } });
    return () => { Reflect.deleteProperty(window, 'tableTennis'); };
  }, [round, rigs, play, camera]);
  useFrame((_, delta) => {
    const playing = ctx.phase() === 'playing';
    const dt = playing ? Math.min(delta, 1 / 20) : 0;
    round.step(delta, performance.now(), playing);
    if (robot) aimRobot(robot, round.arm);
    // What it hit, heard from where it happened: across the table alone, each player's side of the screen with two.
    for (const e of round.events) playBallSound(e, two ? (e.at.z >= 0 ? -0.6 : 0.6) : e.at.x / TABLE.halfWidth * 0.7);
    const b = round.ball;
    // A hit judged in the past moved the ball: drawn from where it was, easing onto where it is.
    if (round.drawnOff.x || round.drawnOff.y || round.drawnOff.z) { st.drawnOff = round.drawnOff; round.drawnOff = { x: 0, y: 0, z: 0 }; }
    const ease = Math.exp(-CATCH_UP * dt);
    st.drawnOff = round.flying ? { x: st.drawnOff.x * ease, y: st.drawnOff.y * ease, z: st.drawnOff.z * ease } : { x: 0, y: 0, z: 0 };
    const at = new THREE.Vector3(b.pos.x + st.drawnOff.x, b.pos.y + st.drawnOff.y, b.pos.z + st.drawnOff.z + TABLE_Z);
    // Waiting for a player to serve it, it pops into place, and a halo breathes round it once it can
    // be. (Not while the round's clock is stopped, in the countdown or a pause: it's simply there.)
    // Between points, once it's out of play, it's gone.
    const waited = round.playerServes() && round.holding() ? (playing ? (round.time - round.heldSince) / play.timeScale : WAIT.pop) : null;
    const mesh = ballMesh.current, halo = haloMesh.current;
    if (mesh) {
      mesh.visible = round.ballShown();
      mesh.position.copy(at);
      mesh.scale.setScalar(waited === null ? 1 : easeOut(Math.min(1, waited / WAIT.pop)));
    }
    if (halo) {
      halo.visible = waited !== null && round.armed() && round.tossAt === null;
      if (halo.visible) {
        st.real += delta;
        halo.position.copy(at);
        halo.rotation.y = round.server() === 0 ? 0 : Math.PI;
        const breath = 0.5 + 0.5 * Math.sin(st.real * WAIT.rate);
        halo.scale.setScalar(WAIT.from + (WAIT.to - WAIT.from) * breath);
        parts.halo.opacity = 0.75 - 0.4 * breath;
      }
    }
    // Its trail (newest first) while it flies.
    if (!round.flying) st.trail.length = 0;
    else if (dt > 0) { st.trail.unshift(at); st.trail.length = Math.min(st.trail.length, TRAIL); }
    trailGroup.current?.children.forEach((child, i) => {
      const p = st.trail[i + 1];
      child.visible = !!p;
      if (p) { child.position.copy(p); child.scale.setScalar(1 - (i / TRAIL) * 0.6); }
    });
    // The bounces' rings, spreading and fading.
    rippleGroup.current?.children.forEach((child, i) => {
      const r = round.bounces[i], u = r ? (round.time - r.t) / RIPPLE.life : 1;
      child.visible = u >= 0 && u < 1;
      if (!child.visible || !r) return;
      child.position.set(r.at.x, TABLE.top + 0.002, r.at.z + TABLE_Z);
      child.scale.setScalar(RIPPLE.from + (RIPPLE.to - RIPPLE.from) * easeOut(u));
      parts.ripples[i].opacity = 0.8 * (1 - u) * (1 - u);
    });
    // What play.ts and the tests read.
    const point = round.point;
    ctx.report({
      ball: round.flying ? 'flying' : round.holding() ? 'ready' : round.serve ? 'serving' : 'between',
      hits: round.hits, returns: round.returns, rally: round.rally, best: round.best, assist: play.assist, mode: round.mode, controls: play.controls,
      // Easy: the last swing's call (who, from 1, and how it went: hit, smash, early, late).
      swing: round.swingCall ? `${round.swingCall.end + 1}:${round.swingCall.kind}` : null,
      // The match's score (Player 1's, or the player's, first), or the challenge's returns; whose serve it is (alone, 2 is the robot's).
      score: round.mode === 'challenge' ? round.challenge.returns : round.match.score.join('|'),
      server: round.server() + 1,
      tossed: round.tossAt !== null,
      // The last point: who won it (from 1) and why (match.ts PointReason).
      point: point ? `${point.to + 1}:${point.reason}` : null,
      done: round.done,
      ...(two ? { hits1: round.hitsBy[0], hits2: round.hitsBy[1] } : {}),
      autoplay: rigs.filter((rig) => rig.autoplay).map((rig) => rig.end + 1).join(',') || null,
    });
    // The match won (or the challenge's run over), a beat after its last point: the results.
    if (round.finished() && !st.finished) {
      st.finished = true;
      if (round.mode === 'challenge') ctx.finish([round.challenge.returns]);
      else if (two) ctx.finish([...round.match.score], { best: false });
      else {
        const won = round.match.winner === 0;
        ctx.finish([round.match.score[0]], { headline: won ? 'YOU WIN!' : 'THE ROBOT WINS', player: won ? 0 : undefined, best: false, opponent: { name: 'Robot', score: round.match.score[1] } });
      }
    }
  });
  return (
    <>
      <mesh ref={ballMesh} geometry={parts.shape} material={parts.ball} castShadow />
      <mesh ref={haloMesh} geometry={parts.haloShape} material={parts.halo} visible={false} />
      <group ref={trailGroup}>
        {parts.trail.map((m, i) => <mesh key={i} geometry={parts.shape} material={m} visible={false} />)}
      </group>
      <group ref={rippleGroup}>
        {parts.ripples.map((m, i) => <mesh key={i} geometry={parts.ring} material={m} visible={false} />)}
      </group>
    </>
  );
}

/**
 * A view from an end's eye, tilted down a little, down the table (Precise: first person); or
 * (`third`: Easy, as Wii Sports Resort's) from behind and above the player's dancer, the whole
 * table in view, the camera still while the dancer steps across.
 */
function viewFrom(end: End, fov: number, scene: SceneId, third = false): MinigameCameraProps {
  const eye = EYES[end], forward = end === 0 ? -1 : 1;
  const far = scene === 'biodome' ? BIODOME_FAR : 40;
  if (third) {
    const { back, up, look } = THIRD;
    return {
      position: [eye.x, eye.y + up, eye.z - forward * back], target: [eye.x, look.y, TABLE_Z + forward * look.z],
      fov: THIRD.fov, near: 0.05, far,
    };
  }
  return {
    position: [eye.x, eye.y, eye.z], target: [eye.x, eye.y + Math.sin(PITCH), eye.z + forward * Math.cos(PITCH)],
    fov, near: scene === 'biodome' ? 0.03 : 0.02, far,
  };
}

/**
 * The game: the room, the table, the players' hands and the ball, and the HUD (Hud.tsx); alone,
 * the robot; with two, a view each and each other's dancers.
 */
export default function TableTennis({ ctx }: { ctx: MinigameContext }) {
  // (The player count is the round's, fixed for it.)
  const two = ctx.playerCount >= 2;
  // Each player's paddle hand is theirs (the Paddle hand setting), for the round.
  const [rigs] = useState<Rig[]>(() => {
    const hands = optionsOf(ctx.options).paddleHands;
    return two ? [newRig(0, hands[0]), newRig(1, hands[1])] : [newRig(0, hands[0])];
  });
  const [play] = useState<Play>(() => {
    const chosen = optionsOf(ctx.options);
    return { mode: chosen.mode, controls: chosen.controls, forgiving: false, serve: false, timeScale: 1, hitLag: 'auto', assist: ASSIST_PARAM, botLevel: chosen.opponent };
  });
  const [round] = useState(() => new Round(rigs, play));
  const [hud] = useState(newHud);
  const [forgiving, setForgiving] = useState(false);
  // The Biodome, or (?scene=debug) the plain room, for the round.
  const [scene] = useState<SceneId>(() => sceneParam());
  const robot = useMemo(() => (two ? null : createRobotDriver()), [two]);
  // Easy is seen from behind each player's dancer (as Wii Sports Resort is); Precise in first person.
  const third = play.controls === 'easy';
  const views = useMemo(() => (two ? [viewFrom(0, SPLIT_FOV, scene, third), viewFrom(1, SPLIT_FOV, scene, third)] : undefined), [two, scene, third]);
  const camera = useMemo(() => viewFrom(0, FOV, scene, third), [scene, third]);

  // Space serves; A steps the aim assist; in development, D shows the HUD's development panel, T steps
  // time's speed, F makes the paddles forgiving, L steps the hit timing, and O and P switch stand-ins
  // on and off for the first and last players.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Not with a modifier, nor a key something else took.
      if (e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || ctx.phase() !== 'playing') return;
      if (e.code === 'Space') { e.preventDefault(); play.serve = true; }
      // (The aim assist is Precise's: Easy's hits are their swings' timing.)
      else if (e.code === 'KeyA' && play.controls === 'precise') play.assist = ASSIST_LEVELS[(ASSIST_LEVELS.indexOf(play.assist) + 1) % ASSIST_LEVELS.length];
      else if (DEV && e.code === 'KeyF') setForgiving((on) => { play.forgiving = !on; return !on; });
      else if (DEV && e.code === 'KeyT') play.timeScale = TIME_SCALES[(TIME_SCALES.indexOf(play.timeScale as typeof TIME_SCALES[number]) + 1) % TIME_SCALES.length];
      else if (DEV && e.code === 'KeyL') play.hitLag = HIT_LAGS[(HIT_LAGS.findIndex((lag) => lag === play.hitLag) + 1) % HIT_LAGS.length];
      else if (DEV && (e.code === 'KeyO' || e.code === 'KeyP')) { const rig = e.code === 'KeyO' ? rigs[0] : rigs[rigs.length - 1]; rig.autoplay = !rig.autoplay; }
      else if (DEV && e.code === 'KeyD') hud.dev = !hud.dev;
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [ctx, rigs, play, two, hud]);

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
        {rigs.map((rig) => <Hands key={rig.end} rig={rig} forgiving={forgiving} two={two} third={third} />)}
        {/* Each player's dancer: seen from behind by everyone (Easy), or in first person by the other. */}
        {third ? (two ? rigs.map((rig) => (
          <group key={rig.end}>
            <SeenBy views={[rig.end]}><Dancer rig={rig} ghost /></SeenBy>
            <SeenBy views={[otherEnd(rig.end)]}><Dancer rig={rig} /></SeenBy>
          </group>
        )) : <Dancer rig={rigs[0]} ghost />)
          : two && rigs.map((rig) => <SeenBy key={rig.end} views={[otherEnd(rig.end)]}><Dancer rig={rig} /></SeenBy>)}
        <PlayBall ctx={ctx} round={round} scene={scene} robot={robot} />
        {robot && <RobotOpponent driver={robot} tableZ={TABLE_Z} />}
        {/* The HUD, in here to see the world's camera (its calls are drawn where the points were decided). */}
        <TableTennisHud ctx={ctx} round={round} hud={hud} />
      </MinigameWorld>
      {rigs.map((rig) => <PlayerTracking key={rig.end} rig={rig} />)}
    </>
  );
}
