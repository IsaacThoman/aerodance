// Station 5, sharing: a last look at the song on its stage, a checklist of what's still open,
// and the ways out. The Studio is on the game's origin, so "Add to the game" saves the finished
// song straight into the game's library in this browser; from there the game's own transfer
// codes take it to a TV or another device, and it can be saved as a file.
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { exportIssues } from '../../../../../../packages/dance/bundle.ts';
import { encodePoseFile } from '../../../../../../packages/pose/binary.ts';
import { customSongsSupported } from '../../../songs/customSongs.ts';
import { useGameBundle } from '../../core/compile.ts';
import { DancerLanes } from '../../core/DancerLanes.tsx';
import { needsAttention, useFindings } from '../../core/findings.ts';
import { DANCER_COLORS, bytes, clock } from '../../core/format.ts';
import { useProject, useSession } from '../../core/hooks.ts';
import { exportProject } from '../../core/library.ts';
import { StationLayout } from '../../core/StationLayout.tsx';
import { Span, Timeline } from '../../core/Timeline.tsx';
import { TransportBar } from '../../core/TransportBar.tsx';
import { Button, Field, Icon, Meter, Note, Panel, Segmented } from '../../core/ui.tsx';
import type { IconName } from '../../core/ui.tsx';
import Viewport from '../../core/Viewport.tsx';
import { useView } from '../../core/view.ts';
import type { StationId } from '../index.ts';
import { addToGame, buildSong, builtSong, inGame } from './publish.ts';
import type { BuiltSong, InGame } from './publish.ts';
import { scoredParts } from './scored.ts';
import './share.css';

/** A checklist line: done, worth a look, must fix before sharing, or still being worked out. */
type Mark = 'done' | 'look' | 'must' | 'wait';
const MARKS: Record<Mark, { icon: IconName | null; words: string }> = {
  done: { icon: 'check', words: 'Done' }, look: { icon: 'eye', words: 'Worth a look' }, must: { icon: 'warning', words: 'Must fix' }, wait: { icon: null, words: 'Checking' },
};
const WORST: readonly Mark[] = ['must', 'look', 'wait', 'done'];
const DANCER_WORDS = ['', 'Solo', 'Duet', 'Trio', 'Crew of four'];
const KNOWN_BLOCKERS = ['Add song audio', 'Set the title', 'Set the artist'];
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A share as a whole percent that says 100 only for all of it, and 0 only for none. */
const percent = (share: number) => share >= 1 ? 100 : share <= 0 ? 0 : Math.max(1, Math.min(99, Math.round(share * 100)));
/** "Dancer 1 and Dancer 2 have": names with the verb that agrees. */
const named = (names: string[], one: string, many: string) => `${names.join(' and ')} ${names.length > 1 ? many : one}`;
const spaced = (digits: string) => digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
function save(name: string, data: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' })), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Check({ mark, title, link, children }: { mark: Mark; title: ReactNode; link?: { href: string; label: string } | null; children?: ReactNode }) {
  const { icon, words } = MARKS[mark];
  return (
    <li className={`ready-item ready-${mark}`} data-mark={mark}>
      <span className="ready-mark" role="img" aria-label={words} title={words}>{icon ? <Icon name={icon} size={13} /> : '…'}</span>
      <div className="ready-body">
        <div className="ready-head"><strong>{title}</strong>{link && <a href={link.href}>{link.label}</a>}</div>
        {children}
      </div>
    </li>
  );
}

export default function ShareStation() {
  const session = useSession(), { dance, attempts, busy } = useProject(), view = useView();
  const { song } = dance;
  const station = (id: StationId) => `#/p/${encodeURIComponent(session.id)}/${id}`;
  const [look, setLook] = useState<'floor' | 'stage'>('stage');

  // ---- Ready? ----
  // What stops a song being made at all (exportIssues): the three with a line of their own here, and any other as it words itself.
  const otherIssues = exportIssues(dance).filter(b => !KNOWN_BLOCKERS.includes(b.message));
  const noMusic = !dance.sources.audio, noTitle = !song.title.trim(), noArtist = !song.artist.trim();
  const game = useGameBundle(session);
  const parts = useMemo(() => game.bundle ? scoredParts(game.bundle) : null, [game.bundle]);
  const dancers = dance.dancers.map((dancer, i) => {
    // A dancer nobody has danced stands still for the whole song: nothing to follow, whatever the scorer makes of it.
    const empty = !dancer.clips.length && dancer.layers.every(l => Object.values(l.channels).every(keys => !keys.length));
    const share = empty ? 0 : game.compiling || game.error ? null : parts?.[i]?.share ?? null;
    const mark: Mark = share === null ? 'wait' : share <= 0 ? 'must' : share < 0.8 ? 'look' : 'done';
    return { dancer, i, empty, share, mark };
  });
  const idle = dancers.filter(d => d.empty), unscored = dancers.filter(d => !d.empty && d.mark === 'must');
  const dancersMark = game.error ? 'must' : WORST.find(m => dancers.some(d => d.mark === m)) ?? 'done';
  const dancersTitle = idle.length ? `${named(idle.map(d => d.dancer.label), 'has', 'have')} nothing to dance` : game.error ? 'The dance can\'t be put together yet'
    : unscored.length ? `${named(unscored.map(d => d.dancer.label), 'isn\'t', 'aren\'t')} scored at all` : dancersMark === 'look' ? 'Some of the dance isn\'t scored'
    : dancersMark === 'wait' ? 'Seeing how much of the dance is scored…' : dancers.length > 1 ? 'Every dancer has something to dance' : 'The dancer has something to dance';
  const findings = useFindings(), open = findings ? findings.findings.filter(needsAttention).length : null;
  const current = attempts.filter(a => a.revision === dance.revision).length;
  const danced = !attempts.length ? null : !current ? `${count(attempts.length, 'playtest')}, none since the last change`
    : attempts.length === 1 ? '1 playtest, on this version' : `${attempts.length} playtests, ${current === attempts.length ? 'all' : current} on this version`;
  const reasons = [
    ...(noMusic ? ['add the music'] : []), ...(noTitle ? ['give the song a title'] : []), ...(noArtist ? ['name the artist'] : []),
    ...otherIssues.map(b => b.message),
    ...idle.map(d => `give ${d.dancer.label} something to dance`), ...unscored.map(d => `score some of ${d.dancer.label}'s dance`),
    ...(game.error ? ['fix what stops the dance being put together'] : []),
  ];
  const blocked = reasons.length > 0;
  const looks = (dancers.some(d => d.mark === 'look') ? 1 : 0) + (open ? 1 : 0) + (current ? 0 : 1);
  const checking = dancersMark === 'wait' || open === null;
  const set = (fields: Record<string, unknown>, label: string) => void session.apply([{ op: 'song', set: fields }], label);

  // ---- Into the game ----
  const supported = customSongsSupported();
  /** The copy of the song this project last put in the game (null: none, or not looked up yet). */
  const [copy, setCopy] = useState<InGame | null>(null);
  const [made, setMade] = useState<BuiltSong | null>(() => builtSong(session));
  const [said, setSaid] = useState<{ revision: number; kind: 'good' | 'warning'; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    void inGame(session.id).then(found => { if (live) setCopy(found); });
    return () => { live = false; };
  }, [session]);
  const built = made && made.project === session.id && made.revision === dance.revision ? made : null;
  const behind = copy ? Math.max(0, dance.revision - copy.revision) : 0, upToDate = copy !== null && behind === 0;
  const add = async (): Promise<boolean> => {
    const result = await session.busy('Putting the song together…', () => addToGame(session));
    if (!result) return false;
    setMade(result.song); setCopy(result.copy);
    const kept = result.status === 'kept';
    setSaid({ revision: result.song.revision, kind: kept ? 'warning' : 'good', text: kept ? 'The game kept the copy of this song it already had.'
      : result.status === 'updated' ? 'The game has the new version on this device: Song Select lists it under Custom.' : 'It\'s in the game on this device: Song Select lists it under Custom.' });
    return !kept;
  };
  const told = said && said.revision === dance.revision ? said : null;

  // ---- On to another device ----
  const [code, setCode] = useState('');
  const [opened, setOpened] = useState<{ code: string; opened: boolean } | null>(null);
  const sent = opened && opened.code === code ? opened : null;
  const send = async () => {
    if (code.length !== 6 || blocked || busy || !supported) return;
    if (!upToDate && !await add()) return;
    // The game joins the code and shows its transfer screen (apps/web/src/songs/transferLink.ts).
    setOpened({ code, opened: !!window.open(`/?transfer=${code}`, '_blank') });
  };

  // ---- As files ----
  /** What was last saved as a file, and the revision it was saved at: said until the dance changes. */
  const [files, setFiles] = useState<{ song?: { revision: number; text: string }; project?: { revision: number; text: string } }>({});
  const savedSong = files.song?.revision === dance.revision ? files.song.text : null, savedProject = files.project?.revision === dance.revision ? files.project.text : null;
  const saveSong = async () => {
    const ready = built ?? await session.busy('Putting the song together…', () => buildSong(session));
    if (!ready) return;
    setMade(ready);
    save(ready.fileName, ready.zip);
    setFiles(f => ({ ...f, song: { revision: ready.revision, text: `${ready.fileName} · ${bytes(ready.zip.length)}` } }));
  };
  const saveProject = async () => {
    const { revision } = session.state.dance, out = await session.busy('Gathering your work…', () => exportProject(session.id));
    if (!out) return;
    save(out.name, out.zip);
    setFiles(f => ({ ...f, project: { revision, text: `${out.name} · ${bytes(out.zip.length)}` } }));
  };

  // ---- What's in it ----
  const frames = built ? built.bundle.compiled.stats.frames : !game.compiling && game.bundle ? game.bundle.choreography.times.length : null;
  // Before the song is put together its size is the music's plus the motion's, near enough.
  const motionBytes = useMemo(() => game.bundle ? encodePoseFile(game.bundle.choreography).length : 0, [game.bundle]);
  const size = built ? bytes(built.zip.length) : dance.sources.audio && frames !== null ? `about ${bytes(dance.sources.audio.bytes + motionBytes)}` : null;
  const playable = song.playableEndMs - song.playableStartMs, whole = song.playableStartMs === 0 && Math.abs(song.playableEndMs - song.durationMs) < 1;

  const scoredLine = (i: number) => dancers[i]?.empty ? null : parts?.[i]?.spans.map(([a, b]) =>
    <Span key={a} start={a} end={b} className={`scored-line${game.compiling ? ' stale' : ''}`} style={{ top: 'auto', bottom: 2, height: 3 }} />);

  return (
    <StationLayout wide
      stage={
        <Viewport view={look} mirror={view.mirror} focus={null}>
          <div className="viewport-tools">
            <Segmented<'floor' | 'stage'> label="Coach view" value={look} onChange={setLook}
              options={[{ value: 'floor', label: 'Practice floor' }, { value: 'stage', label: 'The stage', title: 'The song\'s stage, as players will see it' }]} />
          </div>
        </Viewport>
      }
      side={
        <div className="share-side" data-share={blocked ? 'blocked' : 'ready'} data-musts={reasons.length} data-looks={looks} data-checking={checking}
          data-scored={dancers.map(d => d.share === null ? '' : percent(d.share)).join('|')} data-in-game={!copy ? 'no' : upToDate ? 'current' : 'behind'} data-song-id={copy?.songId ?? ''}
          data-built={built?.bundle.songId ?? ''} data-sent={sent ? (sent.opened ? 'opened' : 'stopped') : ''} data-saved-song={savedSong ?? ''} data-saved-project={savedProject ?? ''}>
          <Panel title="Ready?" aside={<span className={`ready-chip ready-chip-${blocked ? 'must' : checking ? 'wait' : looks ? 'look' : 'done'}`}>
            {blocked ? `${reasons.length} to fix` : checking ? 'Checking…' : looks ? `Ready · ${looks} worth a look` : 'Ready'}</span>}>
            <ul className="ready-list">
              <Check mark={noMusic ? 'must' : 'done'} title={noMusic ? 'The song needs its music' : 'The music is in'} link={noMusic ? { href: station('song'), label: 'Add it in Song' } : null}>
                {dance.sources.audio && <span className="ready-detail">{dance.sources.audio.mimeType === 'audio/ogg' ? 'OGG' : 'MP3'} · {clock(dance.sources.audio.durationMs, false)} · {bytes(dance.sources.audio.bytes)}</span>}
              </Check>
              <Check mark={noTitle || noArtist ? 'must' : 'done'} title={noTitle && noArtist ? 'The song needs a title and an artist' : noTitle ? 'The song needs a title' : noArtist ? 'The song needs an artist' : 'It has a title and an artist'}>
                {noTitle || noArtist ? (
                  <div className="ready-fields">
                    <Field label="Title"><input defaultValue={song.title} key={`t${song.title}`} maxLength={120} data-share-field="title"
                      onBlur={e => { if (e.target.value.trim() !== song.title) set({ title: e.target.value.trim() }, 'rename the song'); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></Field>
                    <Field label="Artist"><input defaultValue={song.artist} key={`a${song.artist}`} maxLength={120} data-share-field="artist"
                      onBlur={e => { if (e.target.value.trim() !== song.artist) set({ artist: e.target.value.trim() }, 'set the artist'); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></Field>
                  </div>
                ) : <span className="ready-detail">{song.title} · {song.artist}</span>}
              </Check>
              {otherIssues.map(b => <Check key={b.message} mark="must" title={b.message} link={{ href: station('song'), label: 'Change it in Song' }} />)}
              <Check mark={dancersMark} title={dancersTitle}
                link={idle.length ? { href: station('record'), label: 'Record it' } : dancersMark === 'look' || dancersMark === 'must' ? { href: station('fix'), label: 'See why in Fix' } : null}>
                <ul className="dancer-shares">
                  {dancers.map(({ dancer, i, empty, share, mark }) => (
                    <li key={dancer.id} data-dancer={dancer.id}>
                      <span className="dancer-share-name"><i className="dancer-dot" style={{ background: DANCER_COLORS[i % 4] }} />{dancer.label}</span>
                      {empty ? <span className="ready-detail">Nothing recorded yet</span> : share === null ? <span className="ready-detail">{game.error ? 'Not known' : 'Checking…'}</span> : (
                        <>
                          <Meter value={share} label={`How much of the song ${dancer.label} is scored for`} tone={mark === 'done' ? 'good' : 'warning'} />
                          <span className="dancer-share-value">{percent(share)}% scored</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {game.error && <Note kind="error">{game.error}</Note>}
                {!game.error && (unscored.length > 0 || dancersMark === 'look') &&
                  <span className="ready-detail">Players earn points only where their dancer is scored: the green line under each dancer in the timeline.</span>}
              </Check>
              <Check mark={open === null ? 'wait' : open ? 'look' : 'done'} title={open === null ? 'Looking the dance over…' : open ? `${count(open, 'thing')} left to look at` : 'Nothing left to look at'}
                link={open ? { href: station('fix'), label: 'Go through them in Fix' } : null} />
              <Check mark={current ? 'done' : 'look'} title={!attempts.length ? 'Nobody has danced it yet' : current ? 'It\'s been danced' : 'Not danced since it last changed'}
                link={current ? null : { href: station('playtest'), label: attempts.length ? 'Dance it again' : 'Playtest it' }}>
                {danced && <span className="ready-detail">{danced}</span>}
              </Check>
            </ul>
          </Panel>

          <Panel title="Add to the game" aside={copy && <span className="muted">{upToDate ? 'Up to date' : `${count(behind, 'change')} behind`}</span>}>
            <p className="share-lead">Puts the song in the game's library in this browser, ready to play. There's no file to move.</p>
            {!supported && <Note kind="warning">This browser can't keep songs for the game. Save the song as a file instead.</Note>}
            {told && <Note kind={told.kind}>{told.text}</Note>}
            {!told && copy && (upToDate ? <Note kind="good">In the game: up to date. Song Select lists it under Custom.</Note>
              : <Note>In the game: as of {count(behind, 'change')} ago.</Note>)}
            <div className="button-row">
              {upToDate ? <a className="btn btn-primary big" href="/" data-share-action="play"><Icon name="play" size={20} />Play it now</a> : (
                <Button kind="primary" big icon="game" disabled={blocked || !!busy || !supported} onClick={() => void add()} data-share-action="add">{copy ? 'Update it' : 'Add to the game'}</Button>
              )}
            </div>
            {blocked && <p className="share-reasons">First: {reasons.join(', ')}.</p>}
          </Panel>

          <Panel title="Send it to a TV or another device">
            <ol className="share-steps">
              <li>In the game on the TV, open <strong>Settings → Songs → Transfer songs</strong>. It shows a six-digit code. (A phone or computer shows one with “Show this device’s code”.)</li>
              <li>Type the code here and send. The game opens in a new tab, connected to the TV.</li>
              <li>In that tab, press the arrow beside the song to send it.</li>
            </ol>
            <div className="share-code">
              <Field label="Code from the other device">
                <input inputMode="numeric" autoComplete="off" placeholder="123 456" maxLength={7} value={spaced(code)} data-share-field="code"
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={e => { if (e.key === 'Enter') void send(); }} />
              </Field>
              <Button icon="tv" disabled={code.length !== 6 || blocked || !!busy || !supported} onClick={() => void send()} data-share-action="send"
                title={blocked ? 'The song isn\'t ready to share yet' : code.length !== 6 ? 'Type the six-digit code first' : upToDate ? 'Open the game\'s transfer screen with this code' : 'Adds the song to the game, then opens its transfer screen with this code'}>Send</Button>
            </div>
            {sent && (sent.opened ? <Note kind="good">The game opened in a new tab, joining {spaced(sent.code)}. Send the song from there.</Note>
              : <Note kind="warning" action={<a className="btn btn-default" href={`/?transfer=${sent.code}`} target="_blank" rel="noreferrer">Open the game</a>}>The song is in the game, but the browser stopped the new tab from opening.</Note>)}
          </Panel>

          <Panel title="Save the song as a file">
            <p className="share-lead">A ZIP to import in any copy of the game: <strong>Settings → Songs → Import song</strong>.</p>
            <div className="button-row">
              <Button icon="download" disabled={blocked || !!busy} onClick={() => void saveSong()} data-share-action="save-song">Save the song file</Button>
              {savedSong && <span className="share-saved">Saved {savedSong}</span>}
            </div>
          </Panel>

          <Panel title="Keep your work">
            <p className="share-lead">The dance as you can keep working on it: the music, your recordings and every fix. The recordings live only in this browser until you save them.</p>
            <div className="button-row">
              <Button icon="folder" disabled={!!busy} onClick={() => void saveProject()} data-share-action="save-project">Save the project</Button>
              {savedProject && <span className="share-saved">Saved {savedProject}</span>}
            </div>
          </Panel>

          {(built || game.bundle || game.compiling) && (
            <Panel title="What's in it" aside={frames === null && <span className="muted">Checking…</span>}>
              <dl className="share-facts">
                <div><dt>Dancers</dt><dd>{DANCER_WORDS[dance.dancers.length] ?? dance.dancers.length}</dd></div>
                <div><dt>To dance</dt><dd>{clock(playable, false)}{whole ? '' : ` of ${clock(song.durationMs, false)}`}</dd></div>
                <div><dt>Tempo</dt><dd>{song.bpm ? `${song.bpm} BPM` : 'Not set'}</dd></div>
                <div><dt>Stage</dt><dd>{capital(song.stage)}</dd></div>
                <div><dt>Difficulty</dt><dd>{capital(song.difficulty)}</dd></div>
                <div><dt>Motion</dt><dd>{frames === null ? '…' : `${frames.toLocaleString()} frames`}</dd></div>
                <div><dt>File size</dt><dd>{size ?? '…'}</dd></div>
              </dl>
            </Panel>
          )}
        </div>
      }
      bar={<TransportBar><span className="scored-key" title="Under each dancer: where players following them earn points"><i />Scored</span></TransportBar>}
      timeline={<Timeline><DancerLanes extra={scoredLine} /></Timeline>}
    />
  );
}
