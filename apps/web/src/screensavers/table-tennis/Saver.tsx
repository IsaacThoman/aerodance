import { Suspense, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import Character from '../../../../../packages/character/Character.tsx';
import type { CharacterPose } from '../../../../../packages/pose/performance.ts';
import BiodomeArena, { BIODOME_FAR, BIODOME_POST } from '../../../../../packages/arenas/biodome/BiodomeArena.tsx';
import { Paddle } from '../../../../../packages/arenas/shared/Gear.tsx';
import { DANCER_LOOKS } from '../../../../../packages/stages/shared/Dancers.tsx';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import type { StationDriver } from '../../../../../packages/robots/shared/station.ts';
import { BALL_R, TABLE } from '../../minigames/table-tennis/ball.ts';
import { mine } from '../../minigames/table-tennis/rally.ts';
import type { End } from '../../minigames/table-tennis/rally.ts';
import { TABLE_Z } from '../../minigames/table-tennis/rig.ts';
import { RobotOpponent, aimRobot, createRobotDriver } from '../../minigames/table-tennis/RobotOpponent.tsx';
import { SaverWorld, placeCamera, shiftPicture } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';
import { DANCER_SCALE, DancerPlayer, PADDLE_SCALE, newPose } from './dancer.ts';
import { Match, isScenario } from './match.ts';
import { Scoreboard } from './Scoreboard.tsx';
import { turnForPreview, views } from './views.ts';
import type { Follow, ViewId } from './views.ts';

/*
 * Table Tennis (index.ts): the match (match.ts) drawn in the Biodome, the minigame's arena.
 * Everything here is in the minigame's room: the table's middle at z = TABLE_Z, the near end
 * (+z, the dancer's) and the far end (−z, the robot's or the second dancer's). Each frame the
 * match moves on first, then the dancers are posed, the arms aimed and the camera flown.
 */

/** The ball, a little larger than life so it reads at 640×480, orange as the minigame's Biodome ball. */
const BALL = { color: '#ff8a1f', trail: '#ffb35c', glow: 0.6, size: 1.3, trailLength: 14 } as const;
const RIPPLE = { life: 0.55, from: 0.03, to: 0.2 } as const;
const RUBBERS: readonly [string, string] = ['#e8323c', '#161c26'];
const HANDLES = ['#2a8cff', '#a45cff'] as const;
// The match's own seed (the same opening rallies each time it's shown, then its own course).
const SEED = 11;
// Frames to draw before the veil may come down.
const READY_FRAMES = 6;

/** The match, moved on each frame (by Director) before anything reads it. */
function useMatch(ctx: ScreensaverContext) {
  const match = useMemo(() => new Match(isScenario(ctx.scenario) ? ctx.scenario : 'robot', SEED), [ctx.scenario]);
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    Reflect.set(window, 'tableTennisSaver', match);
    return () => { Reflect.deleteProperty(window, 'tableTennisSaver'); };
  }, [match]);
  return match;
}

/** Moves the match on, flies the camera through the views, and says when it's ready. */
function Director({ ctx, match }: { ctx: ScreensaverContext; match: Match }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const follow = useMemo<Follow>(() => ({ x: 0 }), []);
  const shots = useMemo(() => views(follow, match.scenario === 'robots'), [follow, match]);
  const state = useMemo(() => ({ frames: 0, reported: -1 }), []);
  useFrame((_, delta) => {
    match.step(delta);
    const near = match.players[0];
    const x = near instanceof DancerPlayer ? near.bx.x : near.blade.c.x;
    follow.x += (x - follow.x) * (1 - Math.exp(-1.2 * Math.min(delta, 0.1)));
  }, -1);
  useFrame(() => {
    const view = (ctx.view() in shots ? ctx.view() : 'broadcast') as ViewId;
    placeCamera(camera, turnForPreview(shots[view](ctx.viewTime()), view, ctx.shift()), 40);
    shiftPicture(camera, ctx.shift());
    state.frames += 1;
    if (state.frames === READY_FRAMES) ctx.ready();
    if (match.time - state.reported > 0.25) {
      state.reported = match.time;
      ctx.report({ ttScore: match.score.join('-'), ttGames: match.games.join('-'), ttShots: match.shots, ttPoints: match.points.length, ttFlying: match.round.flying });
    }
  }, -0.2);
  return null;
}

/** A glass dancer at an end, posed by its player each frame. */
function GlassDancer({ match, end }: { match: Match; end: End }) {
  const player = match.players[end] as DancerPlayer;
  const pose = useMemo(newPose, []);
  const poseRef = useRef<CharacterPose | null>(pose);
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    player.pose(pose);
    const g = group.current;
    if (!g) return;
    const at = mine(end, { x: player.bx.x, y: 0, z: player.bz.x });
    g.position.set(at.x, 0, at.z + TABLE_Z);
    // Facing down the table, towards the net.
    g.rotation.y = end === 0 ? Math.PI : 0;
  }, -0.5);
  return (
    <group ref={group} scale={DANCER_SCALE}>
      <Character appearance={DANCER_LOOKS[end]} performanceRef={poseRef as RefObject<CharacterPose | null>} />
    </group>
  );
}

/** A player's paddle where the round has its blade (rig.ts: its middle, and the hand's turn). */
function PlayerPaddle({ match, end }: { match: Match; end: End }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const rig = match.rigs[end], g = group.current;
    if (!g || !rig?.blade) return;
    g.position.copy(rig.blade.center);
    g.quaternion.copy(rig.drawn[rig.paddle].quaternion);
  }, -0.5);
  return (
    <group ref={group}>
      <Paddle rubbers={RUBBERS} handle={HANDLES[end]} scale={PADDLE_SCALE} />
    </group>
  );
}

/** The ball as drawn, its trail, the dead ball fading, and rings where it bounces. */
function MatchBall({ match }: { match: Match }) {
  const parts = useDisposable(() => {
    const trail = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BALL_R * BALL.size, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      BALL.trailLength,
    );
    trail.frustumCulled = false;
    const ripple = new THREE.MeshBasicMaterial({ color: new THREE.Color(BALL.trail).multiplyScalar(1.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    return {
      sphere: new THREE.SphereGeometry(BALL_R * BALL.size, 18, 12),
      ball: new THREE.MeshStandardMaterial({ color: BALL.color, emissive: BALL.color, emissiveIntensity: BALL.glow, roughness: 0.35 }),
      trail,
      ring: new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2),
      ripples: [ripple, ripple.clone(), ripple.clone()],
    };
  });
  const ball = useRef<THREE.Mesh>(null);
  const dead = useRef<THREE.Mesh>(null);
  const rings = useRef<THREE.Group>(null);
  const st = useMemo(() => ({
    trail: Array.from({ length: BALL.trailLength }, () => new THREE.Vector3()), count: 0,
    m: new THREE.Matrix4(), c: new THREE.Color(), base: new THREE.Color(BALL.trail), s: new THREE.Vector3(), q: new THREE.Quaternion(),
  }), []);
  useFrame(() => {
    const drawn = match.drawnBall(), b = ball.current;
    if (b) {
      b.visible = !!drawn && drawn.size > 0.01;
      if (drawn) { b.position.set(drawn.pos.x, drawn.pos.y, drawn.pos.z + TABLE_Z); b.scale.setScalar(Math.max(0.01, drawn.size)); }
    }
    const d = match.deadBall(), dm = dead.current;
    if (dm) {
      dm.visible = !!d && d.size > 0.01;
      if (d) { dm.position.set(d.pos.x, d.pos.y, d.pos.z + TABLE_Z); dm.scale.setScalar(Math.max(0.01, d.size)); }
    }
    // The trail, newest first, while it flies.
    if (!match.round.flying || !drawn) st.count = 0;
    else {
      const last = st.trail[st.trail.length - 1];
      st.trail.copyWithin(1, 0);
      st.trail[0] = last.set(drawn.pos.x, drawn.pos.y, drawn.pos.z + TABLE_Z);
      st.count = Math.min(st.count + 1, st.trail.length);
    }
    const t = parts.trail;
    for (let i = 0; i < st.trail.length; i++) {
      const on = i > 0 && i < st.count;
      const k = on ? 1 - i / st.trail.length : 0;
      st.s.setScalar(on ? 0.9 - (i / st.trail.length) * 0.5 : 0.0001);
      st.m.compose(st.trail[i], st.q, st.s);
      t.setMatrixAt(i, st.m);
      t.setColorAt(i, st.c.copy(st.base).multiplyScalar(0.45 * k * k));
    }
    t.instanceMatrix.needsUpdate = true;
    if (t.instanceColor) t.instanceColor.needsUpdate = true;
    // The bounces' rings, spreading and fading.
    rings.current?.children.forEach((ring, i) => {
      const mark = match.marks[i], u = mark ? (match.time - mark.t) / RIPPLE.life : 1;
      ring.visible = u >= 0 && u < 1;
      if (!ring.visible || !mark) return;
      ring.position.set(mark.at.x, TABLE.top + 0.003, mark.at.z + TABLE_Z);
      ring.scale.setScalar(RIPPLE.from + (RIPPLE.to - RIPPLE.from) * (1 - (1 - u) * (1 - u)));
      parts.ripples[i].opacity = 0.7 * (1 - u) * (1 - u);
    });
  }, -0.5);
  return (
    <>
      <mesh ref={ball} geometry={parts.sphere} material={parts.ball} castShadow />
      <mesh ref={dead} geometry={parts.sphere} material={parts.ball} castShadow visible={false} />
      <primitive object={parts.trail} />
      <group ref={rings}>
        {parts.ripples.map((m, i) => <mesh key={i} geometry={parts.ring} material={m} visible={false} />)}
      </group>
    </>
  );
}

/** The robot arms: the round's bot at the far end, and with two arms the near one (the far one turned round the table). */
function Robots({ match }: { match: Match }) {
  const far = useMemo(() => (match.players[1] ? null : createRobotDriver()), [match]);
  const near = useMemo(() => (match.scenario === 'robots' ? createRobotDriver() : null), [match]);
  useFrame(() => {
    if (far) aimRobot(far, match.round.arm);
    if (near) {
      // Its paddle where the round has its blade, in the bot's frame (the far end's, turned round).
      const b = match.players[0].blade;
      aimRobot(near, { pos: mine(1, b.c), normal: mine(1, b.n) });
    }
  }, -0.5);
  return (
    <>
      {far && <RobotOpponent driver={far} tableZ={TABLE_Z} />}
      {near && <NearArm driver={near} />}
    </>
  );
}

function NearArm({ driver }: { driver: StationDriver }) {
  return (
    <group position-z={2 * TABLE_Z} rotation-y={Math.PI}>
      <RobotOpponent driver={driver} tableZ={TABLE_Z} />
    </group>
  );
}

export default function TableTennisSaver({ ctx }: { ctx: ScreensaverContext }) {
  const match = useMatch(ctx);
  const dancers = ([0, 1] as const).filter((end) => match.players[end] instanceof DancerPlayer);
  return (
    <SaverWorld camera={{ fov: 40, near: 0.05, far: BIODOME_FAR }} shadows post={BIODOME_POST} environment={false}>
      <Suspense fallback={null}>
        <group position-z={TABLE_Z}><BiodomeArena /></group>
        <Robots match={match} />
        {dancers.map((end) => <GlassDancer key={end} match={match} end={end} />)}
        {dancers.map((end) => <PlayerPaddle key={end} match={match} end={end} />)}
        <MatchBall match={match} />
        <Scoreboard ctx={ctx} match={match} />
        <Director ctx={ctx} match={match} />
      </Suspense>
    </SaverWorld>
  );
}
