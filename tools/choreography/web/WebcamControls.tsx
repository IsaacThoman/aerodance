import { useEffect, useRef } from 'react';
import { MODELS } from '../../../packages/pose/browser/models.ts';
import { drawWebcamPreview } from '../../../packages/pose/browser/preview.ts';
import type { PoseSourceController, PoseSourceView } from '../../../packages/pose/browser/PoseSourceController.ts';
import type { WebcamConfigureOptions } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import { detectionCount, soloPlayer } from './captureMode.ts';
import type { CaptureMode } from './captureMode.ts';

export interface WebcamControlsProps { source: PoseSourceController; connection: PoseSourceView; disabled: boolean; captureMode?: CaptureMode; dancers?: number; }
export default function WebcamControls({ source, connection, disabled, captureMode = 'all', dancers = 2 }: WebcamControlsProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ source, connection, captureMode, dancers }); state.current = { source, connection, captureMode, dancers };
  useEffect(() => {
    let frame: number;
    const draw = () => {
      const { source, connection, captureMode, dancers } = state.current;
      const g = canvas.current?.getContext('2d');
      if (g) drawWebcamPreview(g, source.video, connection.snapshot, { x: 0, y: 0, w: 320, h: 180 }, detectionCount(captureMode, dancers), undefined, { soloPlayerId: soloPlayer(captureMode) ?? 0 });
      frame = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(frame);
  }, []);
  const configure = (options: WebcamConfigureOptions) => { void source.configure(options).catch(() => {}); };
  return <div className="webcam-controls">
    <label>Camera<select aria-label="Webcam camera" value={connection.cameraId || ''} disabled={disabled}
      onChange={e => configure({ cameraId: e.target.value })}>
      <option value="">Default camera</option>
      {(connection.cameras || []).map(camera => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
    </select></label>
    <label>Pose model<select aria-label="Webcam pose model" value={connection.model || 'lite'} disabled={disabled}
      onChange={e => configure({ modelId: e.target.value })}>
      {MODELS.map(model => <option key={model.id} value={model.id}>{model.label} · {model.description}</option>)}
    </select></label>
    <canvas ref={canvas} width="320" height="180" aria-label="Mirrored webcam setup preview" />
    <small>Video stays in this browser. {soloPlayer(captureMode) !== null ? 'One dancer can use the whole frame. Keep your full body visible.'
      : dancers === 2 ? 'Keep full bodies in separate camera halves.' : `Stand side by side, ${dancers} full bodies in view.`}</small>
  </div>;
}
