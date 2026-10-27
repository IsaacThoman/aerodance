// The Song tab's sources: the song audio and the video (add or replace them), tracking the video
// and keying the dancers from it (as `dance attach`, `dance track` and the draft op), and
// recording yourself on the webcam as the video, dancing to the song.
import { useEffect, useRef, useState } from 'react';
import type { Dance } from '../format.ts';
import { formatTime } from '../time.ts';
import type { ChangeSummary } from '../ops.ts';
import type { SongClock } from './clock.ts';
import { attachSources, trackVideo, upload } from './data.ts';
import type { Progress } from './data.ts';
import { Section } from './Inspector.tsx';

type Apply = (ops: unknown[], label: string) => Promise<ChangeSummary | null>;
const fileName = (ref: string) => ref.split('/').pop() ?? ref;

/** A button that picks a file. */
function FileButton({ label, accept, disabled, onFile, children }: { label: string; accept: string; disabled?: boolean; onFile(file: File): void; children: string }) {
  return (
    <label className={`file-button${disabled ? ' disabled' : ''}`}>
      <input type="file" accept={accept} aria-label={label} disabled={disabled}
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onFile(file); }} />
      {children}
    </label>
  );
}

export function SourcesPanel({ dance, apply, progress, onChanged }: { dance: Dance; apply: Apply; progress: Progress | null; onChanged(): Promise<void> }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [fps, setFps] = useState(15);
  const { audio, video, tracking } = dance.sources;
  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what); setError(''); setNote('');
    try { setNote(await fn()); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const attach = (kind: 'audio' | 'video', file: File) => run(kind === 'audio' ? 'Sending the song…' : 'Sending the video…', async () => {
    const name = await upload(file, file.name);
    if (kind === 'video' && !/\.webm$/i.test(file.name)) setBusy('Making a browser-playable copy of the video…');
    await attachSources({ [kind]: name });
    return `${kind === 'audio' ? 'Song' : 'Video'} ${audio && kind === 'audio' || video && kind === 'video' ? 'replaced' : 'added'}: ${file.name}`;
  });
  const track = () => run('Tracking the video…', async () => {
    const result = await trackVideo(fps);
    return `Tracked ${result.frames} frames: ${result.coverage.map(c => `${c.dancer} in ${c.percent}%`).join(', ')}. Key the dancers from it next.`;
  });
  const followed = dance.dancers.filter(d => tracking.some(t => t.dancers.includes(d.id)));
  const draft = () => run('Keying the dancers…', async () => {
    const done: string[] = [];
    for (const d of followed) if (await apply([{ op: 'draft', dancer: d.id }], `draft ${d.id}`)) done.push(d.id);
    if (!done.length) throw Error('No dancer could be keyed from the tracking');
    return `Keyed ${done.join(', ')} from the tracking. Review the keys against the video.`;
  });
  const tracked = progress?.task === 'track' && busy.startsWith('Tracking') ? ` ${progress.done} of ${progress.total} frames` : '';
  return (
    <Section title="Music and video">
      <ul className="list sources">
        <li><span>Song<small>{audio ? ` · ${fileName(audio.path)} · ${formatTime(audio.durationMs)}` : ' · none yet (needed to export)'}</small></span>
          <FileButton label="Song audio file" accept="audio/*" disabled={!!busy} onFile={f => void attach('audio', f)}>{audio ? 'Replace…' : 'Add…'}</FileButton></li>
        <li><span>Video<small>{video ? ` · ${video.width}×${video.height} · ${formatTime(video.durationMs)} from ${formatTime(video.startMs)}` : ' · none yet'}</small></span>
          <FileButton label="Video file" accept="video/*,.mkv,.mov" disabled={!!busy} onFile={f => void attach('video', f)}>{video ? 'Replace…' : 'Add…'}</FileButton></li>
      </ul>
      <p className="hint">Tracking finds the dancers in the video with MediaPipe; keying turns what it found into editable keys, with each dancer&apos;s body fitted.</p>
      <div className="button-row">
        <label className="inline-select">Track at <select value={fps} onChange={e => setFps(Number(e.target.value))} aria-label="Tracking frame rate">
          {[10, 15, 30].map(f => <option key={f} value={f}>{f} fps</option>)}</select></label>
        <button disabled={!!busy || !video} onClick={() => void track()}>{tracking.length ? 'Track again' : 'Track the video'}</button>
        <button disabled={!!busy || !followed.length} onClick={() => void draft()}
          title="Adds keys from the newest tracking to each dancer it follows (undo takes them back)">Key dancers from tracking</button>
      </div>
      {tracking.length > 0 && <p className="hint">Tracked {tracking.length} time{tracking.length > 1 ? 's' : ''}; the newest is {tracking[tracking.length - 1].id} at {tracking[tracking.length - 1].fps} fps.</p>}
      {busy && <p className="hint" role="status">{busy}{tracked}</p>}
      {note && !busy && <p className="hint" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </Section>
  );
}

type Phase = 'off' | 'ready' | 'countdown' | 'recording' | 'saving';
const RECORDER_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/**
 * The webcam as the video: the song plays from the playhead while you dance and the camera
 * records, and the recording replaces the video, placed where the song was when it started.
 */
export function RecordPanel({ dance, clock, time, onChanged }: { dance: Dance; clock: SongClock; time: number; onChanged(): Promise<void> }) {
  const [phase, setPhase] = useState<Phase>('off');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [camera, setCamera] = useState('');
  const [delay, setDelay] = useState(3);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const stream = useRef<MediaStream | null>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const cancel = useRef<() => void>(() => {});
  const stopCamera = () => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
  };
  // The camera goes off with the Studio.
  useEffect(() => () => { cancel.current(); stopCamera(); }, []);
  const startCamera = async (deviceId = camera) => {
    setError('');
    try {
      stopCamera();
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (preview.current) preview.current.srcObject = stream.current;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      setCameras(devices);
      setCamera(stream.current.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'The browser wasn\'t allowed to use the camera' : e instanceof Error ? e.message : String(e));
      setPhase('off');
    }
  };
  const record = async () => {
    const source = stream.current;
    if (!source) return;
    setError(''); setNote('');
    clock.pause();
    // From the playhead, or from the start if the song has (nearly) ended.
    if (clock.now() >= dance.song.durationMs - 250) clock.seek(0);
    // A countdown to get into place, then the song.
    setPhase('countdown');
    const go = await new Promise<boolean>(resolve => {
      let left = delay;
      setCount(left);
      if (left <= 0) { resolve(true); return; }
      const timer = setInterval(() => { left--; setCount(left); if (left <= 0) { clearInterval(timer); resolve(true); } }, 1000);
      cancel.current = () => { clearInterval(timer); resolve(false); };
    });
    if (!go) { setPhase('ready'); return; }
    const mimeType = RECORDER_TYPES.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
    const recorder = new MediaRecorder(source, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    let stoppedAt = 0;
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    // The song plays first; the video's first frame is where the song is when recording starts.
    await clock.play();
    const started = new Promise<void>(resolve => { recorder.onstart = () => resolve(); });
    // Where the song is when recording starts, and when that is, to know how long it went on.
    // Recording starts with start(); its start event can come a while later on a busy page.
    const startMs = clock.now(), startedAt = performance.now();
    recorder.start(1000);
    await started;
    setPhase('recording');
    // Recording ends with the song, or when it's paused (Stop, or Space). The video stays lined up
    // with the song only while the song plays straight on, so seeking stops it too.
    const stop = () => { if (recorder.state === 'recording') { stoppedAt = performance.now(); recorder.stop(); } };
    const unsubscribe = clock.subscribe(stop);
    cancel.current = stop;
    await stopped;
    unsubscribe();
    clock.pause();
    setPhase('saving');
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      if (!blob.size) throw Error('The recording is empty');
      const fps = Math.round(source.getVideoTracks()[0]?.getSettings().frameRate ?? 30);
      const name = await upload(blob, 'recording.webm');
      const { dance: next } = await attachSources({ video: name, recording: { fps, startMs, durationMs: Math.round(stoppedAt - startedAt) } });
      setNote(`Recorded ${formatTime(next.sources.video?.durationMs ?? 0)} from ${formatTime(startMs)} as the video. Track it to key the dancers from it.`);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setPhase('ready'); }
  };
  const live = phase !== 'off';
  const canRecord = phase === 'ready' && !!dance.sources.audio && clock.rate === 1;
  return (
    <Section title="Record yourself" aside={live && phase !== 'recording' && phase !== 'saving'
      ? <button className="link" onClick={() => { cancel.current(); stopCamera(); setPhase('off'); }}>Camera off</button> : undefined}>
      <p className="hint">The song plays from the playhead ({formatTime(time)}) while the webcam records you, until it ends or you stop; the recording becomes the video, lined up with the song.</p>
      {!dance.sources.audio && <p className="hint">Add the song first, so there&apos;s something to dance to.</p>}
      {clock.rate !== 1 && <p className="hint">Set the speed to 1× to record.</p>}
      <div className={`camera${live ? '' : ' off'}`}>
        <video ref={preview} autoPlay muted playsInline aria-label="Camera preview" />
        {phase === 'countdown' && <span className="countdown" aria-live="assertive">{count}</span>}
        {phase === 'recording' && <span className="recording-badge">● Recording</span>}
      </div>
      <div className="fields">
        {cameras.length > 1 && <label className="field wide"><span>Camera</span>
          <select value={camera} aria-label="Camera" disabled={phase !== 'ready'} onChange={e => { setCamera(e.target.value); void startCamera(e.target.value); }}>
            {cameras.map((c, i) => <option key={c.deviceId || i} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
          </select></label>}
        <label className="field"><span>Countdown (s)</span>
          <input type="number" min={0} max={60} value={delay} aria-label="Countdown seconds" disabled={phase !== 'off' && phase !== 'ready'}
            onChange={e => setDelay(Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))))} /></label>
      </div>
      <div className="button-row">
        {phase === 'off' && <button onClick={() => void startCamera()}>Start the camera</button>}
        {phase === 'ready' && <button className="primary" disabled={!canRecord} onClick={() => void record()}>Record</button>}
        {phase === 'countdown' && <button onClick={() => cancel.current()}>Cancel</button>}
        {phase === 'recording' && <button className="danger" onClick={() => cancel.current()}>Stop</button>}
        {phase === 'saving' && <button disabled>Saving the recording…</button>}
      </div>
      {note && <p className="hint" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </Section>
  );
}
