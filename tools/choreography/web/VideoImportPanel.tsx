import { useEffect, useRef, useState } from 'react';
import { MODELS } from '../../../packages/pose/browser/models.ts';
import { CONNECTIONS } from '../../../packages/pose/choreography.ts';
import { VideoImporter } from './videoImport.ts';
import type { DetectedPose, ImportProgress } from './videoImport.ts';
import { isObject } from '../../../packages/pose/choreography.ts';
import type { CalibrationFrame } from '../core.ts';
import { errorMessage } from './api.ts';
import type { ApiRequest } from './api.ts';
import { capturePlayers } from './captureMode.ts';
import type { CaptureMode } from './captureMode.ts';
import { extractVideoAudio } from './videoAudio.ts';
import type { VideoAudio } from './videoAudio.ts';

export interface VideoImportPanelProps {
  file: File;
  projectId: string;
  request: ApiRequest;
  /** Receives the saved take as the server returned it. */
  onImported: (take: unknown, audio?: VideoAudio) => void | Promise<void>;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}
const aborted = (e: unknown) => isObject(e) && e.name === 'AbortError';
export default function VideoImportPanel({ file, projectId, request, onImported, onClose, onBusy }: VideoImportPanelProps) {
  const [url] = useState(() => URL.createObjectURL(file));
  const [model, setModel] = useState('heavy'), [fps, setFps] = useState('30');
  const [cleanup, setCleanup] = useState(true);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('both');
  const [useAudio, setUseAudio] = useState(false), [committing, setCommitting] = useState(false);
  const commitRef = useRef(false), extractedAudio = useRef<VideoAudio | null>(null), finalizedTake = useRef<unknown>(null);
  const rate = /^\d+$/.test(fps) && +fps >= 1 && +fps <= 30 ? +fps : null;
  const [ready, setReady] = useState(false), [working, setWorking] = useState(false);
  const [processed, setProcessed] = useState(false), [calibration, setCalibration] = useState<CalibrationFrame | null>(null);
  const [detections, setDetections] = useState<DetectedPose[]>([]);
  const [error, setError] = useState(''), [progress, setProgress] = useState<ImportProgress | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null),
    importer = useRef<VideoImporter | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    dialog.current?.showModal();
    return () => { active.current = false; importer.current?.abort(); URL.revokeObjectURL(url); onBusy(false); };
  }, [url, onBusy]);
  const close = () => { if (commitRef.current) return; active.current = false; importer.current?.abort(); onClose(); };
  const getImporter = () => {
    const element = video.current;
    if (!element || !rate) throw Error('Choose a video and a sample rate first');
    importer.current ||= new VideoImporter({ video: element, file, modelId: model, cleanup, captureMode, sampleRate: rate, projectId, request, onProgress: setProgress });
    return importer.current;
  };
  const run = async (action: () => Promise<void>) => {
    setWorking(true); onBusy(true); setError('');
    try { await action(); }
    catch (e) { if (active.current && !aborted(e)) setError(errorMessage(e)); }
    finally { if (active.current) { setWorking(false); onBusy(false); } }
  };
  const selectFrame = () => run(async () => {
    setProgress({ fraction: 0, message: `Checking calibration with ${model}…` });
    const frame = await getImporter().calibrate();
    setProgress(null);
    setCalibration({ mediaTimeMs: frame.mediaTimeMs, poses: frame.poses });
    setDetections(frame.detectedPoses);
    const c = canvas.current, g = c?.getContext('2d'), v = video.current;
    if (!c || !g || !v) return;
    c.width = 480; c.height = Math.round(480 * v.videoHeight / v.videoWidth);
    g.drawImage(v, 0, 0, c.width, c.height);
    for (const pose of frame.detectedPoses) {
      g.strokeStyle = pose.ready ? pose.playerId ? '#be9cff' : '#51daf0' : '#ffc66d'; g.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        g.beginPath(); g.moveTo(pose.landmarks[a].x * c.width, pose.landmarks[a].y * c.height);
        g.lineTo(pose.landmarks[b].x * c.width, pose.landmarks[b].y * c.height); g.stroke();
      }
      g.fillStyle = g.strokeStyle; g.font = 'bold 16px sans-serif';
      g.fillText(`P${pose.playerId + 1}`, pose.landmarks[0].x * c.width, Math.max(20, pose.landmarks[0].y * c.height - 15));
    }
  });
  const process = () => run(async () => {
    video.current?.pause();
    const job = getImporter();
    if (useAudio && !extractedAudio.current) {
      setProgress({ fraction: 0, message: 'Reading video audio…' });
      extractedAudio.current = await extractVideoAudio(file, video.current!.duration * 1000, job.controller.signal, setProgress);
    }
    if (!job.processed) {
      await job.process(file.name);
      setProcessed(true);
    }
    setProgress({ fraction: 1, message: 'Saving video take…' });
    const take = finalizedTake.current ?? await job.finalize(calibration);
    finalizedTake.current = take;
    if (!active.current) return;
    commitRef.current = true; setCommitting(true);
    try { await onImported(take, useAudio ? extractedAudio.current ?? undefined : undefined); }
    finally { commitRef.current = false; if (active.current) setCommitting(false); }
    close();
  });
  return <dialog ref={dialog} className="video-import" aria-labelledby="video-import-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="video-import-heading">
      <div><h2 id="video-import-title">Import video</h2><p className="muted">{file.name}</p></div>
      <button onClick={close} disabled={committing} aria-label="Close video import">×</button>
    </div>
    <p className="muted">Choose a model, then pause on a frame with the dancers standing clearly in view. Import creates a new take; assign it to player tracks from the take menu.</p>
    <label>Players<select aria-label="Video players" value={captureMode} disabled={working} onChange={event => {
      importer.current?.abort(); importer.current = null; finalizedTake.current = null;
      setCaptureMode(event.target.value as CaptureMode); setCalibration(null); setDetections([]); setProcessed(false); setProgress(null); setError('');
    }}><option value="both">Both players</option><option value="p1">P1 only</option><option value="p2">P2 only</option></select></label>
    <label className="check"><input type="checkbox" checked={useAudio} disabled={working} onChange={event => setUseAudio(event.target.checked)} /> Use video audio as song audio</label>
    <p className="muted">Selecting video audio replaces existing song audio after the import succeeds.</p>
    <label>Pose model
      <select aria-label="Video pose model" value={model} disabled={working} onChange={event => {
        importer.current?.abort(); importer.current = null; finalizedTake.current = null;
        setModel(event.target.value); setCalibration(null); setDetections([]); setProcessed(false); setProgress(null); setError('');
      }}>{MODELS.map(m => <option key={m.id} value={m.id}>{m.label} · {m.description}</option>)}</select>
    </label>
    <label className="check"><input type="checkbox" checked={cleanup} disabled={working || processed} onChange={event => {
      importer.current?.abort(); importer.current = null; finalizedTake.current = null;
      setCleanup(event.target.checked); setCalibration(null); setDetections([]); setProgress(null); setError('');
    }} /> Clean up poses after detection</label>
    <p className="muted">Removes isolated spikes, repairs supported gaps up to 200 ms, and smooths motion. Repaired joints need review before scoring. Heavy and continuous two-player tracking take longer to process.</p>
    <label>Sample rate
      <input type="number" aria-label="Video sample rate" min={1} max={30} step={1} value={fps} disabled={working}
        aria-invalid={rate === null} onChange={event => {
          importer.current?.abort(); importer.current = null; finalizedTake.current = null;
          setFps(event.target.value); setProcessed(false); setProgress(null); setError('');
        }} /> fps{rate === null && ' · enter a whole number from 1 to 30'}
    </label>
    <video ref={video} src={url} controls={!working} muted playsInline preload="auto" aria-label="Source video"
      onLoadedData={() => {
        const v = video.current;
        if (!v) return;
        const valid = v.duration > 0 && v.duration <= 3600 && v.videoWidth > 0 && v.videoHeight > 0;
        setReady(valid);
        if (!valid) setError('Choose a video between zero and one hour long');
      }} onError={() => { setReady(false); setError('This browser could not decode the video. Try MP4 or WebM with a supported codec.'); }} />
    <button disabled={!ready || !rate || working || finalizedTake.current !== null} onClick={selectFrame}>Use current frame for calibration</button>
    <div className="video-calibration" hidden={!calibration}>
      <canvas ref={canvas} aria-label="Selected calibration frame" />
      {calibration && <p role="status">Calibration at {(calibration.mediaTimeMs / 1000).toFixed(2)}s · {calibration.poses.length
        ? `${calibration.poses.map(p => `P${p.playerId + 1}`).join(' and ')} ready` : 'choose a clearer frame'}</p>}
      {detections.map((pose, index) => <p role="status" key={index}>P{pose.playerId + 1} detected · {pose.reason}</p>)}
      {calibration && capturePlayers(captureMode).filter(id => !detections.some(p => p.playerId === id)).map(id =>
        <p role="status" key={`missing-${id}`}>P{id + 1} not detected in this frame · try another frame or Full / Heavy</p>)}
    </div>
    {progress && <div className="video-progress" role="status"><progress value={progress.fraction} max="1" /><p>{progress.message}</p></div>}
    {error && <p role="alert" className="video-import-error">{error}</p>}
    <p className="muted">{captureMode === 'both' ? 'Two dancers use separate left/right regions.' : `One dancer can use the whole frame for ${captureMode === 'p1' ? 'P1' : 'P2'}.`} {useAudio ? 'Video audio will replace song audio.' : 'Song audio stays unchanged.'} The source video is available only for this session; poses and calibration are saved.</p>
    <div className="video-import-actions">
      <button onClick={close} disabled={committing}>{committing ? 'Saving import…' : working ? 'Cancel import' : 'Cancel'}</button>
      <button disabled={!ready || !rate || !calibration?.poses.length || detections.some(p => !p.ready) || working} onClick={process}>{processed ? 'Save take' : 'Process video'}</button>
    </div>
  </dialog>;
}
