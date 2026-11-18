// Reads the beat and the sections from a song's audio, off the page's thread.
import { analyzeSong } from '../../../../../../packages/dance/beats.ts';
import type { SongAnalysis } from '../../../../../../packages/dance/beats.ts';

export interface AnalyzeRequest { pcm: Float32Array; sampleRate: number; durationMs: number; }
export type AnalyzeReply = { ok: true; analysis: SongAnalysis } | { ok: false; error: string };

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { pcm, sampleRate, durationMs } = event.data;
  let reply: AnalyzeReply;
  try { reply = { ok: true, analysis: analyzeSong(pcm, sampleRate, durationMs) }; }
  catch (e) { reply = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  (self as unknown as { postMessage(message: AnalyzeReply): void }).postMessage(reply);
};
