import { Suspense, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import Character from '../../../packages/character/Character.tsx';
import { MAX_PLAYERS } from '../../../packages/pose/choreography.ts';
import type { PlayerCount, Pose, TrackCalibration } from '../../../packages/pose/choreography.ts';
import { DANCER_LOOKS } from '../../../packages/stages/shared/Dancers.tsx';
import { LIVE_PANEL, livePanelCenterX, livePanelHeight } from '../game/layout.ts';

/*
 * The players' own characters during a song: one small glass dancer per player in their
 * colour in the top corners (player 1 left, player 2 right; with three or four, players 1 and
 * 2 left and the rest right), copying their live pose. They ride along in
 * front of the stage camera, so they stay put while it drifts, and are mirrored like the
 * reference dancers so a player's raised right hand shows on the same side as the coach's.
 *
 * live: { playerCount, livePose(id, now) → { landmarks } | null, calibration(id) }
 */

/** The players' live characters: GameSession's smoothed poses and calibrations. */
export interface LiveDancers {
  playerCount: PlayerCount;
  /** The pose to draw now (null hides the character). */
  livePose(id: number, now: number): Pose | null;
  calibration(id: number): TrackCalibration | null;
}

// The character's height at scale 1 with its arms down, as it stands in a panel.
const HEIGHT = 3.4;
// In front of the camera: near enough to sit in front of any stage set.
const DISTANCE = 3;
const LOOKS = DANCER_LOOKS.map((look) => ({ ...look, opacity: 0.92 }));

interface LivePlayerProps { id: number; live: LiveDancers; anchor: RefObject<THREE.Group | null>; }

function LivePlayer({ id, live, anchor }: LivePlayerProps) {
  const poseRef = useRef<Pose | null>(null);
  const [calibration, setCalibration] = useState<TrackCalibration | null>(null);
  useFrame(() => {
    const c = live.calibration(id);
    if (c !== calibration) setCalibration(c);
    poseRef.current = live.livePose(id, performance.now());
  }, -1);
  return (
    <group ref={anchor}>
      {/* Mirrored like a dance coach, the same as the reference dancers. */}
      <group scale={[-1, 1, 1]}>
        {calibration && <Character poseRef={poseRef} calibration={calibration} appearance={LOOKS[id]} />}
      </group>
    </group>
  );
}

export default function LivePanels({ live }: { live: LiveDancers }) {
  const root = useRef<THREE.Group>(null);
  const anchors = useMemo((): RefObject<THREE.Group | null>[] => Array.from({ length: MAX_PLAYERS }, () => ({ current: null })), []);
  useFrame(({ camera }) => {
    const g = root.current;
    if (!g || !('isPerspectiveCamera' in camera)) return;
    // Close to the camera, so they shouldn't throw shadows across the stage.
    g.traverse((o) => { if ('isMesh' in o) o.castShadow = false; });
    g.position.copy(camera.position);
    g.quaternion.copy(camera.quaternion);
    const viewH = 2 * DISTANCE * Math.tan((camera.fov * Math.PI) / 360);
    const viewW = viewH * camera.aspect;
    const count = live.playerCount;
    const height = livePanelHeight(count);
    const scale = (height * viewH) / HEIGHT;
    for (let id = 0; id < count; id++) {
      const a = anchors[id].current;
      if (!a) continue;
      a.position.set((livePanelCenterX(id, count) - 0.5) * viewW, (0.5 - LIVE_PANEL.top - height) * viewH, -DISTANCE);
      a.scale.setScalar(scale);
    }
  }, 0.5);
  return (
    <group ref={root}>
      <Suspense fallback={null}>
        {Array.from({ length: live.playerCount }, (_, id) => <LivePlayer key={id} id={id} live={live} anchor={anchors[id]} />)}
      </Suspense>
    </group>
  );
}
