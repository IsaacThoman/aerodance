// How well someone dancing exactly like the video would score against the dance: the game's own
// scorer (packages/score), with the tracked video poses as the player. A high score says the
// animation's limb directions and timing follow the video where the scorer looks; the
// per-second judgements show where they don't.
import { createScorer } from '../../packages/score/scorer.ts';
import type { JudgementEvent, PlayerResult } from '../../packages/score/scorer.ts';
import { decodePoseFile, encodePoseFile } from '../../packages/pose/binary.ts';
import type { PlayerCount } from '../../packages/pose/choreography.ts';
import type { Song, SongBundle, SongChoreography } from '../../packages/pose/song.ts';
import { choreographyOf, compileDance } from './compile.ts';
import type { CompiledDance } from './compile.ts';
import { aspectOf } from './format.ts';
import type { Dance } from './format.ts';
import { videoToSong } from './time.ts';
import type { TrackingData } from './tracking.ts';

export interface DancerScore {
  dancer: string;
  result: PlayerResult;
  /** One judgement per second of song. */
  seconds: { songTimeMs: number; judgement: JudgementEvent['judgement']; score: number }[];
}
/** The compiled dance as the game loads it (encoded and decoded, so quantization is included). */
export function gameBundle(dance: Dance, compiled: CompiledDance = compileDance(dance)): SongBundle {
  const bytes = encodePoseFile(choreographyOf(compiled, 'preview'));
  const choreography = decodePoseFile(bytes) as SongChoreography;
  const song = {
    schema: 'aerodance.song', schemaVersion: 1, songId: 'preview', bundleRevision: 1, title: dance.song.title || 'Preview', artist: dance.song.artist || 'Preview',
    songwriters: [], choreographers: [], durationMs: dance.song.durationMs, playableStartMs: compiled.timeline.playableStartMs,
    playableEndMs: compiled.timeline.playableEndMs, supportedPlayerCounts: [1, 2, 3, 4], dancers: dance.dancers.length as PlayerCount,
    coachMode: 'mirror-player', rigProfile: 'frutiger-seven-bone-v1', audio: { path: 'audio.wav', mimeType: 'audio/wav' },
    choreography: { path: 'choreography.adpose', schemaVersion: 2 },
    rights: { audio: { license: 'unknown', attribution: '' }, choreography: { license: 'unknown', attribution: '' } },
    createdAt: dance.createdAt, publishedAt: dance.updatedAt, build: { compilerVersion: 'preview', projectRevision: dance.revision },
  } satisfies Song;
  return { song, choreography };
}
/**
 * Scores each dancer that a tracking source follows: the tracked person is the player and the
 * dancer the reference, over the part of the playable song the tracking covers. Returns one
 * entry per scored dancer.
 */
export function scoreAgainstTracking(dance: Dance, tracking: (id: string) => TrackingData, compiled?: CompiledDance): DancerScore[] {
  const pairs: { dancer: number; data: TrackingData; slot: number }[] = [];
  dance.dancers.forEach((d, i) => {
    for (const source of dance.sources.tracking) {
      const slot = source.dancers.indexOf(d.id);
      if (slot >= 0) { pairs.push({ dancer: i, data: tracking(source.id), slot }); return; }
    }
  });
  if (!pairs.length) throw Error('No tracking follows any dancer; run `dance track` and assign its slots');
  // Score only the part of the song the tracking covers; the rest has no player to score.
  const from = Math.max(dance.song.playableStartMs, Math.min(...pairs.map(p => videoToSong(dance, p.data.times[0]))));
  const to = Math.min(dance.song.playableEndMs, Math.max(...pairs.map(p => videoToSong(dance, p.data.times[p.data.times.length - 1]))));
  if (!(to - from >= 1000)) throw Error('The tracking covers less than a second of the playable song');
  const bundle = gameBundle(dance, compiled ?? compileDance(dance, { range: [from, to] }));
  const aspect = aspectOf(dance);
  return pairs.map(({ dancer, data, slot }) => {
    // One player following this dancer.
    const scorer = createScorer(bundle, 1, [dancer]);
    const seconds: DancerScore['seconds'] = [];
    scorer.onJudgement(e => { seconds.push({ songTimeMs: e.songTimeMs, judgement: e.judgement, score: Math.round(e.score * 1000) / 1000 }); });
    for (let i = 0; i < data.times.length; i++) {
      const landmarks = data.poseAtFrame(slot, i);
      if (landmarks) scorer.addSample(0, videoToSong(dance, data.times[i]), landmarks, aspect);
    }
    scorer.finish();
    return { dancer: dance.dancers[dancer].id, result: scorer.result(0), seconds };
  });
}
