// Score fidelity: a song whose choreography is the GT 2D poses of each player's own person,
// scored by the game's scorer (createScorer) with live poses fed the way GameSession feeds them.
import { buildFrames, encodePoseFile } from '../../../packages/pose/binary.ts';
import type { Landmark, PlayerCount, Pose } from '../../../packages/pose/choreography.ts';
import { validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import type { Song, SongBundle } from '../../../packages/pose/song.ts';
import { createScorer, INTERVAL_MS, WINDOW_INTERVALS } from '../../../packages/score/scorer.ts';
import type { JudgementEvent, PlayerResult, WindowJudgement } from '../../../packages/score/scorer.ts';
import { LATE_ALLOWANCE_MS } from '../../../apps/web/src/game/GameSession.ts';
import type { GtPerson, Scene } from './common.ts';

/** GameSession accepts live poses from this long before the song (LEAD_MS there). */
const LEAD_MS = 1000;

/**
 * The reference: every GT player's 2D pose at every frame of the dance window, as the track of
 * the player number they should have (mapping[playerId] = GT person id). The reference is what
 * the player dances, so every joint counts (confidence 1), including ones outside the picture.
 * It goes through the binary format and the game's loader, as a published song does.
 */
export function referenceBundle(scene: Scene, mapping: readonly string[], window: [number, number]): SongBundle {
  const [startMs, endMs] = window;
  const frames = scene.gt.filter(f => f.t_ms >= startMs - 1e-6 && f.t_ms <= endMs + 1e-6);
  if (frames.length < 2) throw Error('Dance window has fewer than two frames');
  const playableStartMs = frames[0].t_ms, playableEndMs = frames[frames.length - 1].t_ms;
  const players = mapping.length as PlayerCount;
  const input = { width: scene.width, height: scene.height };
  const calibration = { inputWidth: input.width, inputHeight: input.height, torsoLength: 0.25, baseHip: { x: 0.5, y: 0.55, z: 0 }, floorY: 0.9, profileVersion: 1 };
  const song: Song = validateSong({
    schema: 'aerodance.song', schemaVersion: 1, songId: `trackbench-${scene.id}`.slice(0, 80).replace(/[^a-z0-9-]/g, '-'), bundleRevision: 1,
    title: scene.id, artist: 'trackbench', songwriters: ['trackbench'], choreographers: ['AIST++'],
    durationMs: playableEndMs + 1000, playableStartMs, playableEndMs,
    supportedPlayerCounts: Array.from({ length: Math.max(2, players) }, (_, i) => i + 1), dancers: players,
    coachMode: 'mirror-player', rigProfile: 'frutiger-seven-bone-v1',
    audio: { path: 'audio.m4a', mimeType: 'audio/mp4' }, choreography: { path: 'choreography.adpose', schemaVersion: 2 },
    rights: { audio: { license: 'none', attribution: '' }, choreography: { license: 'CC-BY-4.0', attribution: 'AIST++' } },
    createdAt: '2026-11-01T00:00:00Z', publishedAt: '2026-11-01T00:00:00Z', build: { compilerVersion: 'trackbench', projectRevision: 0 },
  });
  const inputs = frames.map(f => ({
    timeMs: f.t_ms,
    poses: mapping.flatMap((id, playerId): Pose[] => {
      const p = f.people.find(q => q.id === id);
      return p ? [{ playerId, landmarks: p.kp.map(([x, y]) => ({ x, y, z: 0, confidence: 1 })) }] : [];
    }),
  }));
  const choreography = buildFrames({
    kind: 'choreography', playerSlots: players, input, modelId: null,
    song: { songId: song.songId, durationMs: song.durationMs, playableStartMs, playableEndMs, maxInterpolationGapMs: 200, confidenceThreshold: 127 },
    tracks: mapping.map((id, playerId) => ({ slot: playerId, playerId, label: id, calibration, exclusions: [] })),
  }, inputs);
  return { song, choreography: validateSongChoreography(song, encodePoseFile(choreography)) };
}

/** A live record as GameSession's onRecord sees it: capture time (song time here) and arrival time. */
export interface LiveRecord { captureMs: number; receivedMs: number; poses: { playerId: number; landmarks: Landmark[] }[]; }

export interface ScoreRun { results: PlayerResult[]; judgements: JudgementEvent[]; }

/**
 * Scores live records exactly as GameSession does while the song plays: each record's poses at
 * the song time of its capture (the song's clock is the scene's, so song time = capture time),
 * from LEAD_MS before the song to LATE_ALLOWANCE_MS after it; the scorer advanced to
 * LATE_ALLOWANCE_MS behind the arrivals; then finished.
 */
export function scoreRecords(bundle: SongBundle, playerCount: number, records: readonly LiveRecord[], aspect: number): ScoreRun {
  const scorer = createScorer(bundle, playerCount as PlayerCount);
  const judgements: JudgementEvent[] = [];
  scorer.onJudgement(e => judgements.push(e));
  const { playableStartMs, playableEndMs } = bundle.song;
  const acceptFromMs = playableStartMs - LEAD_MS;
  for (const r of [...records].sort((a, b) => a.receivedMs - b.receivedMs)) {
    const songMs = r.captureMs;
    if (songMs > acceptFromMs && songMs <= playableEndMs + LATE_ALLOWANCE_MS) {
      for (const pose of r.poses) if (pose.playerId < playerCount) scorer.addSample(pose.playerId, songMs, pose.landmarks, aspect);
    }
    scorer.advance(Math.min(r.receivedMs, playableEndMs) - LATE_ALLOWANCE_MS);
  }
  scorer.finish();
  return { results: scorer.results(), judgements };
}

/** GT as live input: each mapped person's GT pose, with the joints outside the picture unseen (confidence 0). */
export function gtLandmarks(p: GtPerson): Landmark[] {
  return p.kp.map(([x, y, , vis]) => ({ x, y, z: 0, confidence: vis === 3 ? 0 : 1 }));
}

const RANK: Record<WindowJudgement, number> = { perfect: 4, good: 3, ok: 2, miss: 1, lost: 0 };

/** Per-window judgement changes from a reference run (GT live) to a tracked run. */
export function judgementChanges(reference: readonly JudgementEvent[], tracked: readonly JudgementEvent[]) {
  const key = (e: JudgementEvent) => `${e.playerId}@${Math.round(e.songTimeMs)}`;
  const theirs = new Map(tracked.map(e => [key(e), e]));
  const matrix: Record<string, number> = {};
  let windows = 0, downgraded = 0, levels = 0, toLost = 0;
  for (const r of reference) {
    const t = theirs.get(key(r));
    if (!t) continue;
    windows++;
    const k = `${r.judgement}->${t.judgement}`;
    matrix[k] = (matrix[k] ?? 0) + 1;
    const drop = RANK[r.judgement] - RANK[t.judgement];
    if (drop > 0) { downgraded++; levels += drop; }
    if (t.judgement === 'lost' && r.judgement !== 'lost') toLost++;
  }
  return { windows, downgraded, downgraded_frac: windows ? downgraded / windows : null, mean_levels_lost: windows ? levels / windows : null, to_lost: toLost, matrix };
}

export const WINDOW_MS = INTERVAL_MS * WINDOW_INTERVALS;
