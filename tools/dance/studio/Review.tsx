// Review: the same checks and scoring as `dance check` and `dance score`, and export.
import { useState } from 'react';
import type { Finding } from '../check.ts';
import type { Dance } from '../format.ts';
import type { DancerScore } from '../score.ts';
import { formatTime } from '../time.ts';
import { Section } from './Inspector.tsx';
import type { Selection } from './VideoPane.tsx';

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
export default function Review({ dance, onSeek, onSelect }: { dance: Dance; onSeek(ms: number): void; onSelect(s: Selection): void }) {
  const [findings, setFindings] = useState<{ revision: number; findings: Finding[] } | null>(null);
  const [scores, setScores] = useState<{ revision: number; scores: DancerScore[] } | null>(null);
  const [exported, setExported] = useState<{ songId: string; zip: string; installed: string | null; revision: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const stale = (r: { revision: number } | null) => r && r.revision !== dance.revision;
  return (
    <>
      <Section title="Check" aside={<button disabled={!!busy} onClick={() => run('check', async () => setFindings(await get('/api/check')))}>
        {busy === 'check' ? 'Checking…' : findings ? 'Check again' : 'Check'}</button>}>
        {!findings && <p className="hint">Looks for jumps, stretched limbs, sliding feet, moves the character can't show and differences from the tracked video.</p>}
        {findings && <p className="hint">{stale(findings) ? `From revision ${findings.revision}; the dance has changed since. ` : ''}
          {findings.findings.filter(f => f.severity === 'warning').length} warnings, {findings.findings.filter(f => f.severity === 'info').length} notes</p>}
        {findings && <ul className="findings">
          {findings.findings.map((f, i) => (
            <li key={i} className={f.severity}>
              <button className="finding" onClick={() => {
                onSeek(f.startMs);
                if (f.dancer) onSelect({ dancer: f.dancer, control: (f.control as Selection['control']) ?? null });
              }}>
                <span className="when">{formatTime(f.startMs)}{f.endMs > f.startMs + 1 ? `–${formatTime(f.endMs)}` : ''}</span>
                <span className="what">{f.message}</span>
              </button>
            </li>
          ))}
        </ul>}
      </Section>
      <Section title="Score against the video" aside={<button disabled={!!busy || !dance.sources.tracking.length}
        onClick={() => run('score', async () => setScores(await get('/api/score')))}>{busy === 'score' ? 'Scoring…' : 'Score'}</button>}>
        {!dance.sources.tracking.length && <p className="hint">Track the video first: <code>dance track &lt;project&gt;</code>. Scoring then plays the tracked dancers through the game's scorer against this dance.</p>}
        {scores && scores.scores.map(s => (
          <div key={s.dancer} className="score">
            <strong>{s.dancer}</strong> <span className="grade">{s.result.grade}</span> {(s.result.accuracy * 100).toFixed(1)}%
            <small> · timing {s.result.meanOffsetMs.toFixed(0)} ms · {s.result.judgements.perfect} perfect, {s.result.judgements.good} good, {s.result.judgements.ok} ok, {s.result.judgements.miss} miss</small>
            <div className="seconds">{s.seconds.map(x => <button key={x.songTimeMs} className={`second ${x.judgement}`} title={`${formatTime(x.songTimeMs - 1000)}: ${x.judgement} ${x.score}`}
              onClick={() => onSeek(x.songTimeMs - 1000)} aria-label={`${formatTime(x.songTimeMs - 1000)} ${x.judgement}`} />)}</div>
          </div>
        ))}
        {scores && stale(scores) && <p className="hint">From revision {scores.revision}; score again for the latest.</p>}
      </Section>
      <Section title="Export">
        <div className="button-row">
          <button disabled={!!busy} onClick={() => run('export', async () => setExported(await get('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })))}>Export song ZIP</button>
          <button disabled={!!busy} onClick={() => run('export', async () => setExported(await get('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"install":true}' })))}
            title="Writes the song into apps/web/public/songs so the game's Song Select lists it">Install in the game</button>
        </div>
        {exported && <p className="hint">Song {exported.songId}, revision {exported.revision}. <a href={`/api/export/${encodeURIComponent(exported.zip.split('/').pop()!)}`}>Download ZIP</a>
          {exported.installed && <> · installed in <code>{exported.installed.split('/').slice(-3).join('/')}</code></>}</p>}
      </Section>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
