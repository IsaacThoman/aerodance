// The dancers in-engine, at the song clock:
//   Character: the glass characters straight from the curves, unmirrored (as filmed) so they
//     match the video, or mirrored; follows a drag as it happens.
//   Game: exactly what the game shows: the compiled choreography on the song's stage with the
//     game's camera, post-processing and mirrored coach. Recompiled shortly after each edit.
import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PCFShadowMap } from 'three';
import type { Pose } from '../../../packages/pose/choreography.ts';
import type { SongBundle } from '../../../packages/pose/song.ts';
import { createPerformanceSampler } from '../../../packages/pose/performance.ts';
import type { CharacterPose } from '../../../packages/pose/performance.ts';
import { RENDER_HEIGHT, RENDER_WIDTH } from '../../../packages/stages/shared/post.tsx';
import { compileDance, previewCalibrations } from '../compile.ts';
import { createEvaluator } from '../evaluate.ts';
import type { Dance } from '../format.ts';
import { gameBundle } from '../score.ts';
import type { SongClock } from './clock.ts';
import { CharacterScene, GameScene } from './scenes.tsx';

export type StageMode = 'character' | 'game';
class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  render() { return this.state.error ? <div className="pane-note">3D view unavailable: {this.state.error}</div> : this.props.children; }
}
/** Feeds the characters their poses each frame, and renders on demand while paused. */
function Driver({ dance, clock, poses, performances }: { dance: Dance; clock: SongClock; poses: { current: (Pose | null)[] }; performances: { current: (CharacterPose | null)[] } }) {
  const evaluators = useMemo(() => dance.dancers.map(d => createEvaluator(dance, d)), [dance]);
  const performers = useMemo(() => dance.dancers.map(d => createPerformanceSampler(d.performance ?? [])), [dance]);
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => clock.subscribe(() => invalidate()), [clock, invalidate]);
  useEffect(() => { invalidate(); }, [dance, invalidate]);
  useFrame(() => {
    const t = clock.now();
    poses.current = evaluators.map((e, i) => ({ playerId: i, landmarks: e.landmarks(t) }));
    performances.current = performers.map((sample, i) => sample(t - dance.dancers[i].timeOffsetMs));
    if (clock.playing) invalidate();
  }, -2);
  return null;
}
function GameDriver({ clock }: { clock: SongClock }) {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => clock.subscribe(() => invalidate()), [clock, invalidate]);
  useFrame(() => { if (clock.playing) invalidate(); });
  return null;
}
export default function StagePane({ dance, clock, mode, mirror, focus }: { dance: Dance; clock: SongClock; mode: StageMode; mirror: boolean; focus: number | null }) {
  const poses = useRef<(Pose | null)[]>([]);
  const performances = useRef<(CharacterPose | null)[]>([]);
  // Calibrations change only with the poses' overall placement; recompute after edits settle.
  const [calibrations, setCalibrations] = useState(() => previewCalibrations(dance));
  const [bundle, setBundle] = useState<SongBundle | null>(null);
  const [compiling, setCompiling] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setCalibrations(previewCalibrations(dance)), 300);
    return () => clearTimeout(timer);
  }, [dance]);
  useEffect(() => {
    if (mode !== 'game') return;
    setCompiling(true);
    const timer = setTimeout(() => {
      try { setBundle(gameBundle(dance, compileDance(dance))); } finally { setCompiling(false); }
    }, 400);
    return () => clearTimeout(timer);
  }, [dance, mode]);
  const counts = calibrations.length === dance.dancers.length;
  return (
    <div className="stage-pane" aria-label={mode === 'game' ? 'Game preview' : 'Characters'}>
      <Boundary>
        {mode === 'character' && counts && (
          <Canvas frameloop="demand" dpr={[1, 2]} shadows={{ type: PCFShadowMap }} gl={{ antialias: true }}>
            <Driver dance={dance} clock={clock} poses={poses} performances={performances} />
            <CharacterScene poses={poses} performances={performances} calibrations={calibrations} mirror={mirror} focus={focus} />
          </Canvas>
        )}
        {mode === 'game' && bundle && bundle.choreography.tracks.length === dance.dancers.length && (
          <div className="game-frame">
            <Canvas key={dance.song.stage} frameloop="demand" dpr={1} flat shadows={{ type: PCFShadowMap }}
              gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}>
              <GameDriver clock={clock} />
              <GameScene stage={dance.song.stage} bundle={bundle} timeMs={() => clock.now()} width={RENDER_WIDTH} height={RENDER_HEIGHT} aspect={16 / 9} />
            </Canvas>
          </div>
        )}
      </Boundary>
      {mode === 'game' && (compiling || !bundle) && <div className="pane-badge">Compiling the choreography…</div>}
      {mode === 'character' && <div className="pane-badge">{mirror ? 'Mirrored, as the game\'s coach' : 'As filmed'}</div>}
    </div>
  );
}
