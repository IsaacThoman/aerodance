// Instead of the camera: a video of the dance. Its dancers are tracked and become each dancer's
// motion, placed as filmed; where the video starts in the song can be set to line it up.
import { useEffect, useRef, useState } from 'react';
import { measureTake } from '../../../../../../packages/dance/takes.ts';
import { clock } from '../../core/format.ts';
import { useProject, useSession } from '../../core/hooks.ts';
import { Button, Field, FileButton, Meter, Note, Panel } from '../../core/ui.tsx';
import { trackVideo } from './video.ts';

const VIDEO_FILES = 'video/*,.mp4,.mov,.webm,.m4v';
const list = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';

export function VideoPanel() {
  const session = useSession(), { dance } = useProject();
  const video = dance.sources.video, people = dance.dancers.length;
  const [progress, setProgress] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<{ kind: 'good' | 'warning'; text: string } | null>(null);
  const [startText, setStartText] = useState<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  const tracked = dance.sources.takes.filter(t => t.origin === 'video');

  const track = async () => {
    const file = await session.videoBlob();
    if (!file) return session.fail('The video\'s file is missing from this dance. Choose it again.');
    const controller = new AbortController();
    stop.current = controller;
    setProgress(0); setOutcome(null);
    await session.busy('Tracking the dancers in the video…', async () => {
      try {
        let shown = 0;
        const result = await trackVideo(file, people, fraction => { if (fraction - shown >= 0.005 || fraction >= 1) { shown = fraction; setProgress(fraction); } }, controller.signal);
        const take = await session.addTake(result.frames, { width: result.width, height: result.height, slots: people },
          { label: tracked.length ? `Video ${tracked.length + 1}` : 'Video', origin: 'video', clock: 'video', fps: result.fps });
        if (!take) return;
        const data = session.state.takes(take.id), dancers = session.state.dance.dancers;
        const found = dancers.filter((_, person) => data && measureTake(data, person)), missed = dancers.filter(d => !found.includes(d)).map(d => d.label);
        if (!found.length) return setOutcome({ kind: 'warning', text: 'The dancers were never clear enough in that video to use. It needs to show them whole, from head to toe.' });
        if (!await session.apply(found.map(d => ({ op: 'clip', dancer: d.id, take: take.id, slot: dancers.indexOf(d), place: 'frame' })), 'bring in the video')) return;
        const share = Math.round(Math.min(...found.map(d => result.seen[dancers.indexOf(d)])) * 100);
        setOutcome(missed.length ? { kind: 'warning', text: `Only ${found.length} of ${people} dancers could be followed: ${list(missed)} ${missed.length > 1 ? 'have' : 'has'} nothing from the video.` }
          : { kind: share < 70 ? 'warning' : 'good', text: `${people > 1 ? 'The dancers are' : 'The dancer is'} in the dance, found in ${share}% of the video${share < 70 ? ': expect gaps to fix or record over' : ''}. Play it to check it's in time with the music.` });
      } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) throw e; }
    });
    stop.current = null;
    setProgress(null);
  };
  /** Moves the video (and the motion already placed from it) to start at a different point of the song. */
  const setStart = (seconds: number) => {
    if (!video || !Number.isFinite(seconds)) return;
    const startMs = Math.round(seconds * 1000), delta = startMs - video.startMs;
    if (!delta) return;
    const moves = dance.dancers.flatMap(d => d.clips.filter(c => c.kind === 'take' && tracked.some(t => t.id === c.take)).map(c => ({ op: 'clip', action: 'update', dancer: d.id, id: c.id, move: delta })));
    void session.apply([{ op: 'video', startMs }, ...moves], 'line the video up with the song');
  };
  const tracking = progress !== null;
  return (
    <Panel title="From a video" aside={video && !tracking && <FileButton kind="quiet" accept={VIDEO_FILES} onFile={file => void session.attachVideo(file)} title="Use a different video">Replace…</FileButton>}>
      <div className="rec-video" data-video={video ? 'ready' : 'none'} data-tracking={tracking} data-progress={progress ?? ''} data-tracked={tracked.length}>
        {!video ? (
          <>
            <p className="muted">Bring in a video of the dance instead of dancing it here. The dancers need to be in view from head to toe; the video stays in this browser.</p>
            <FileButton icon="video" accept={VIDEO_FILES} onFile={file => void session.attachVideo(file)}>Choose a video</FileButton>
          </>
        ) : (
          <>
            <p className="muted">A video is in this dance: {video.width}×{video.height}, {clock(video.durationMs, false)} long. Tracking finds {people > 1 ? `its ${people} dancers` : 'its dancer'} and puts what they do into the dance{people > 1 ? ', the dancer on the right as Dancer 1' : ''}.</p>
            {tracking ? (
              <div className="rec-video-progress">
                <Meter value={progress} label="Tracking the dancers" />
                <span>{Math.round(progress * 100)}%</span>
                <Button onClick={() => stop.current?.abort()}>Cancel</Button>
              </div>
            ) : <Button kind={tracked.length ? 'default' : 'primary'} icon="person" onClick={() => void track()}>{tracked.length ? 'Track the dancers again' : 'Track the dancers'}</Button>}
            {outcome && !tracking && <Note kind={outcome.kind}>{outcome.text}</Note>}
            {tracked.length > 0 && !tracking && (
              <Field label="The video starts this far into the song (seconds)" hint="If the dance is early or late against the music, change this: a video that begins before the music does starts below zero.">
                <input type="number" inputMode="decimal" step={0.05} value={startText ?? video.startMs / 1000}
                  onChange={e => setStartText(e.target.value)} onBlur={() => { if (startText !== null && startText.trim() !== '') setStart(Number(startText)); setStartText(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
              </Field>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
