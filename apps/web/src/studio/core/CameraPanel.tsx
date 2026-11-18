// The camera, as every station that needs it shows it: a panel to turn it on, pick which one
// and see whether the people in front of it are being tracked; and a small mirror-like preview
// of its picture with their skeletons drawn over it.
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { drawWebcamPreview } from '../../../../../packages/pose/browser/preview.ts';
import type { PlayerCount } from '../../../../../packages/pose/choreography.ts';
import { camera, cameraOn, startCamera, stopCamera } from './camera.ts';
import { useCamera, useSession } from './hooks.ts';
import type { LivePeople } from './live.ts';
import { Button, Field, Note, Panel } from './ui.tsx';

export interface CameraPanelProps {
  /** How many people to track (1 to 4). */
  people?: PlayerCount;
  /** The tracked people (useLivePeople), to say whether each has been seen head to toe. */
  live?: LivePeople;
  /** More controls for the panel (how many people, who is who). */
  children?: ReactNode;
}
export function CameraPanel({ people = 1, live, children }: CameraPanelProps) {
  const session = useSession(), view = useCamera(), on = cameraOn(view);
  const start = () => { void startCamera(people).catch(e => session.fail(e instanceof Error ? e.message : String(e))); };
  // A change in how many people to track restarts tracking for that many.
  const count = useRef(people);
  useEffect(() => {
    if (count.current === people) return;
    count.current = people;
    if (cameraOn(camera().view)) void startCamera(people).catch(() => {});
  }, [people]);
  const seen = live ? Array.from({ length: people }, (_, slot) => !!live.calibrations[slot]) : [];
  const tracked = view.snapshot?.poses.length ?? 0;
  return (
    <Panel title="Camera" aside={on && <Button kind="quiet" onClick={stopCamera}>Turn off</Button>}>
      {!on && (
        <>
          <p className="muted">Stand the camera where it can see you head to toe, with room to move. The picture never leaves this device: only your poses are kept.</p>
          <Button kind="primary" icon="camera" onClick={start}>Turn the camera on</Button>
          {view.status === 'error' && <Note kind="error">{view.message}</Note>}
        </>
      )}
      {on && (
        <>
          {view.status !== 'connected' && <Note>{view.message || 'Starting the camera…'}</Note>}
          {view.status === 'connected' && live && (seen.every(Boolean)
            ? <Note kind="good" action={<Button kind="quiet" onClick={() => live.recalibrate()} title="Measure again after moving the camera or stepping back">Measure again</Button>}>
              {people > 1 ? 'Everyone is in view.' : 'You\'re in view.'} Ready when you are.</Note>
            : <Note kind="warning">{tracked < people ? (people > 1 ? `Looking for ${people} people: ${tracked} found so far.` : 'Looking for you…') : 'Step back until the camera sees you from head to toe, and stand still a moment.'}</Note>)}
          {view.cameras.length > 1 && (
            <Field label="Which camera">
              <select value={view.cameraId} onChange={e => void camera().configure({ cameraId: e.target.value })}>
                {view.cameras.map((c, i) => <option key={c.deviceId || i} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
              </select>
            </Field>
          )}
          {children}
        </>
      )}
    </Panel>
  );
}
/** The camera's picture as a mirror, with the tracked skeletons over it. */
export function CameraPreview({ people = 1, className = '' }: { people?: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), view = useCamera(), latest = useRef(view);
  latest.current = view;
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const el = canvas.current;
      if (!el) return;
      const dpr = window.devicePixelRatio || 1, width = el.clientWidth, height = el.clientHeight;
      if (el.width !== Math.round(width * dpr) || el.height !== Math.round(height * dpr)) { el.width = Math.round(width * dpr); el.height = Math.round(height * dpr); }
      const g = el.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawWebcamPreview(g, camera().picture, latest.current.snapshot, { x: 0, y: 0, w: width, h: height }, people, 'Camera off');
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [people]);
  return <canvas ref={canvas} className={`camera-preview ${className}`} aria-label="Camera preview" />;
}
