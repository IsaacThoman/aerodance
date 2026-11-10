// A new dance, for a Studio opened on a folder with none yet (`dance studio <new folder>`): the
// song details, how many dancers, and the video to animate to and the song, as `dance init`.
// Without a video, the dance starts from the song and you record yourself in the Song tab.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createDance, projectFolder, upload } from './data.ts';

export default function NewDance({ onCreated }: { onCreated(): void }) {
  const [folder, setFolder] = useState('');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [dancers, setDancers] = useState(1);
  const [video, setVideo] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [videoSound, setVideoSound] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { projectFolder().then(setFolder, () => {}); }, []);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setBusy(video ? 'Sending the video…' : audio ? 'Sending the song…' : 'Making the dance…');
      const videoUpload = video ? await upload(video, video.name) : undefined;
      if (audio) setBusy('Sending the song…');
      const audioUpload = audio ? await upload(audio, audio.name) : undefined;
      // A video that isn't WebM gets a browser-playable copy made, which takes a while.
      setBusy(video && !/\.webm$/i.test(video.name) ? 'Making the dance (and a browser-playable copy of the video)…' : 'Making the dance…');
      await createDance({ title, artist, dancers, video: videoUpload, audio: audioUpload, audioFromVideo: videoSound });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(''); }
  };
  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand"><span className="brand-orb" /><div>aerodance<strong>Dance Studio</strong></div></div>
        <div className="song-title"><strong>New dance</strong><span>{folder}</span></div>
      </header>
      <form className="new-dance card" onSubmit={e => void create(e)} aria-label="New dance">
        <header><h3>New dance</h3></header>
        <p className="hint">There's no dance in this folder yet. Start from a video to animate to, or from the song and record yourself dancing to it.</p>
        <div className="fields">
          <label className="field wide"><span>Title</span><input value={title} onChange={e => setTitle(e.target.value)} aria-label="Title" /></label>
          <label className="field wide"><span>Artist</span><input value={artist} onChange={e => setArtist(e.target.value)} aria-label="Artist" /></label>
          <label className="field"><span>Dancers</span>
            <select value={dancers} onChange={e => setDancers(Number(e.target.value))} aria-label="Dancers">
              <option value={1}>1 · solo</option><option value={2}>2 · duet</option><option value={3}>3 · trio</option><option value={4}>4 · crew</option>
            </select></label>
          <label className="field wide"><span>Video to animate to</span>
            <input type="file" accept="video/*,.mkv,.mov" aria-label="Video" onChange={e => setVideo(e.target.files?.[0] ?? null)} /></label>
          <label className="field wide"><span>Song</span>
            <input type="file" accept="audio/*" aria-label="Song" onChange={e => setAudio(e.target.files?.[0] ?? null)} /></label>
        </div>
        {video && !audio && <label className="check"><input type="checkbox" checked={videoSound} onChange={e => setVideoSound(e.target.checked)} /> Use the video&apos;s sound as the song</label>}
        <p className="hint">The game plays WAV, MP3, OGG, M4A or FLAC songs. You can add or replace the video and song later in the Song tab.</p>
        <div className="button-row">
          <button type="submit" className="primary" disabled={!!busy}>{busy ? 'Creating…' : 'Create the dance'}</button>
        </div>
        {busy && <p className="hint" role="status">{busy}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </div>
  );
}
