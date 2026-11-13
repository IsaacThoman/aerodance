// Play, pause and where the song is; loop the selected stretch, slow it down, click on the beat.
// Space plays and pauses from anywhere outside a text field.
import { barBeat, clock } from './format.ts';
import { useKeys, useProject, useSession, useSongTime, useTransport } from './hooks.ts';
import { Button, Segmented } from './ui.tsx';
import { useView } from './view.ts';
import type { ReactNode } from 'react';

export function TransportBar({ children, keys = true }: { children?: ReactNode; /** Space/Home/arrow shortcuts (off while a station has its own). */ keys?: boolean }) {
  const { transport } = useSession(), { shown: dance } = useProject(), state = useTransport(), { selection } = useView();
  const time = useSongTime(12), bar = barBeat(dance, Math.max(0, time));
  const looping = state.loop !== null;
  const beat = dance.song.bpm ? 60000 / dance.song.bpm : 1000;
  useKeys(e => {
    if (!keys || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && !state.ready) { e.preventDefault(); return; }
    if (e.key === ' ') { e.preventDefault(); if (state.playing) transport.pause(); else transport.play({ loop: selection && looping ? selection : null }); }
    else if (e.key === 'Home') { e.preventDefault(); transport.seek(dance.song.playableStartMs); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = (e.shiftKey ? beat * 4 : beat) * (e.key === 'ArrowLeft' ? -1 : 1);
      transport.seek(transport.timeMs() + step);
    }
  });
  return (
    <div className="transport">
      <Button kind="primary" icon={state.playing ? 'pause' : 'play'} aria-label={state.playing ? 'Pause' : 'Play'} title="Play or pause (Space)" disabled={!state.ready}
        onClick={() => { if (state.playing) transport.pause(); else transport.play({ loop: looping && selection ? selection : null }); }} />
      <div className="transport-time" title="Where the song is: minutes and seconds, then bar and beat">
        <strong>{clock(Math.max(0, time))}</strong>
        <span>/ {clock(state.durationMs, false)}</span>
        {bar && <em>bar {bar}</em>}
      </div>
      <Button icon="loop" on={looping} disabled={!selection && !looping} title={selection ? 'Loop the selected stretch' : 'Select a stretch of the song to loop it (click a section, or shift-drag the ruler)'}
        onClick={() => transport.setLoop(looping ? null : selection)}>Loop</Button>
      <Button icon="metronome" on={state.metronome} disabled={!dance.song.bpm} title={dance.song.bpm ? 'Click on every beat' : 'Set the song\'s tempo to use the click'}
        onClick={() => transport.setMetronome(!state.metronome)} aria-label="Metronome" />
      <Segmented label="Speed" value={state.rate} onChange={rate => transport.setRate(rate)}
        options={[{ value: 0.5, label: '½×', title: 'Half speed' }, { value: 0.75, label: '¾×', title: 'Three-quarter speed' }, { value: 1, label: '1×', title: 'Full speed' }]} />
      <div className="transport-rest">{children}</div>
    </div>
  );
}
