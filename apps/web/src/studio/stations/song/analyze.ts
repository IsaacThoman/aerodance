import type { SongAnalysis } from '../../../../../../packages/dance/beats.ts';
import type { AnalyzeReply, AnalyzeRequest } from './analyze.worker.ts';

/** The beat grid and section guesses for the song in `pcm` (mono), worked out in a worker. */
export function analyze(pcm: Float32Array, sampleRate: number, durationMs: number): Promise<SongAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<AnalyzeReply>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.analysis); else reject(Error(event.data.error));
    };
    worker.onerror = e => { worker.terminate(); reject(Error(e.message || 'The song couldn\'t be analysed')); };
    // A copy goes to the worker: the transport keeps drawing its waveform from the original.
    const copy = pcm.slice();
    worker.postMessage({ pcm: copy, sampleRate, durationMs } satisfies AnalyzeRequest, [copy.buffer]);
  });
}
/** Section guesses as ops: every phrase the dance has is replaced. */
export function sectionOps(existing: readonly { id: string }[], sections: SongAnalysis['sections']): unknown[] {
  return [...existing.map(p => ({ op: 'phrase', action: 'remove', id: p.id })),
    ...sections.map((s, i) => ({ op: 'phrase', id: `s${i + 1}`, label: s.label, start: s.startMs, end: s.endMs }))];
}
