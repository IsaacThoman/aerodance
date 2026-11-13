// A finished song (the bundle the game plays) opened as a dance to edit: its choreography
// becomes one take holding every dancer, placed where it was, with the song's details, music,
// unscored intervals and authored character performance carried over. What can't come back is
// what the bundle never held: the takes and edits it was compiled from.
import { framesToPoses } from '../pose/binary.ts';
import type { Landmark } from '../pose/choreography.ts';
import { validatePerformance } from '../pose/performance.ts';
import { validateSong, validateSongChoreography } from '../pose/song.ts';
import type { Song } from '../pose/song.ts';
import { replaceRemovedStage, isStageId, DEFAULT_STAGE } from '../stages/catalog.ts';
import type { DanceStore } from './store.ts';
import type { TrackedFrame } from './takes.ts';

/** The bundle's files by path (as in its ZIP, without the song's folder). */
export type SongFiles = ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
const decoder = new TextDecoder();

/** Reads and checks a bundle's song.json. */
export function songOf(files: SongFiles): Song {
  const json = files.get('song.json');
  if (!json) throw Error('That isn\'t a song file: it has no song.json');
  return validateSong(JSON.parse(decoder.decode(json)));
}
/** Fills an empty store with a dance made from a song bundle. */
export async function danceFromSong(store: DanceStore, files: SongFiles): Promise<void> {
  const song = songOf(files);
  const audio = files.get(song.audio.path), poses = files.get(song.choreography.path);
  if (!audio || !poses) throw Error('The song file is missing its music or its choreography');
  const choreography = validateSongChoreography(song, poses), dancers = choreography.tracks.length;
  const { inputWidth: width, inputHeight: height } = choreography.tracks[0].calibration;
  const stage = replaceRemovedStage(song.stage);
  await store.create({ title: song.title, artist: song.artist, dancers, durationMs: song.durationMs, frame: { width, height } });
  const ref = await store.addSource('audio', song.audio.path, audio);
  const performance = song.performance ? validatePerformance(JSON.parse(decoder.decode(files.get(song.performance.path) ?? new Uint8Array())), dancers) : null;
  await store.update('open the song', dance => {
    Object.assign(dance.song, { songwriters: song.songwriters, choreographers: song.choreographers, difficulty: song.difficulty ?? 'normal',
      stage: isStageId(stage) ? stage : DEFAULT_STAGE, tags: song.tags ?? [], description: song.description ?? '', bpm: song.bpm ?? null,
      playableStartMs: song.playableStartMs, playableEndMs: song.playableEndMs });
    dance.sources.audio = { ...ref, mimeType: song.audio.mimeType, durationMs: song.durationMs };
    choreography.tracks.forEach((track, i) => {
      dance.dancers[i].label = track.label || dance.dancers[i].label;
      if (performance) dance.dancers[i].performance = performance.tracks[i].clips;
    });
  });
  // The choreography as a take: a joint the song doesn't score reads as one the tracker was
  // unsure of, so it stays unscored (and shows up to be looked at); the rest as sure.
  const frames: TrackedFrame[] = [];
  for (let i = 0; i < choreography.times.length; i++) {
    const snapshot = framesToPoses(choreography, i), slots: (Landmark[] | null)[] = Array.from({ length: dancers }, () => null);
    snapshot.poses.forEach((pose, k) => {
      const eligible = snapshot.quality[k].scoreEligible;
      slots[pose.playerId] = pose.landmarks.map((l, j) => ({ ...l, confidence: eligible[j] ? Math.max(l.confidence ?? 0.9, 0.6) : 0.2 }));
    });
    frames.push({ videoMs: choreography.times[i], poses: slots });
  }
  if (!frames.length) throw Error('The song has no choreography to open');
  const { take } = await store.addTake(frames, { width, height, slots: dancers }, { label: 'From the song', origin: 'import', clock: 'song', fps: 30, cleanup: false });
  const ops: unknown[] = [];
  choreography.tracks.forEach((track, i) => {
    ops.push({ op: 'clip', dancer: `P${i + 1}`, take: take.id, slot: i, place: 'frame', fadeIn: 0, fadeOut: 0, label: song.title });
    for (const x of track.exclusions) ops.push({ op: 'exclude', dancer: `P${i + 1}`, start: x.startMs, end: x.endMs, reason: x.reason || 'Left unscored' });
  });
  await store.apply({ ops, label: 'place the song\'s dance' });
}
