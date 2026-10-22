import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import RemoteScreen, { BACK_LABELS, KEYS, statusLine } from './RemoteScreen.tsx';
import { backAction, listen, post } from './bridge.ts';
import type { GamePage, RemoteKey } from './bridge.ts';
import { remoteLayout } from './layout.ts';
import type { RemoteButton } from './layout.ts';
import { phoneDesign } from '../phone/layout.ts';
import { Background, PhoneRenderResolution } from '../phone/pageCanvas.tsx';
import { MIN_TOUCH_PX } from '../ui/hit.ts';
import type { Circle, Rect } from '../ui/draw.ts';

/*
 * The TV remote (/remote/): the iPhone/iPad app shows this page on the phone while the game is
 * on a TV, and passes its buttons on to the game (bridge.ts). The whole page is one canvas like
 * the game's and the phone camera page's: the in-engine remote (RemoteScreen) at the same low
 * resolution, on the same plain background, drawn only when something changes.
 *
 * Over the canvas: where the app's own AirPlay picker goes (sent to the app, which lays it there,
 * invisible), and a label for each button for VoiceOver (and the app's UI tests), which lets
 * touches through to the canvas.
 */

const LABELS: Record<Exclude<RemoteButton, 'back'>, string> = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'OK' };

// A circle's or rect's box, from design units to the page's CSS pixels.
const box = (shape: Circle | Rect, scale: number) => ('r' in shape
  ? { left: (shape.x - shape.r) * scale, top: (shape.y - shape.r) * scale, width: shape.r * 2 * scale, height: shape.r * 2 * scale }
  : { left: shape.x * scale, top: shape.y * scale, width: shape.w * scale, height: shape.h * scale });

export default function RemoteApp() {
  const [page, setPage] = useState<GamePage>({});
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => listen((state) => setPage(state.page)), []);

  const L = remoteLayout(phoneDesign(size.w || 1, size.h || 1));
  const scale = size.w / L.w;

  // The AirPlay picker goes over the AirPlay button, at least a fingertip across.
  const air = size.w ? box(L.airplay, scale) : null;
  const pickerSize = air ? Math.max(air.width, MIN_TOUCH_PX) : 0;
  const picker = air && { x: air.left + air.width / 2 - pickerSize / 2, y: air.top + air.height / 2 - pickerSize / 2, w: pickerSize, h: pickerSize };
  const pickerKey = JSON.stringify(picker);
  useEffect(() => { post({ airplay: JSON.parse(pickerKey) }); }, [pickerKey]);

  const send = (key: RemoteKey, repeat: boolean) => post({ key, repeat });
  const back = BACK_LABELS[backAction(page)].label;
  return (
    <div className="canvas-frame phone" ref={frame}>
      <Canvas dpr={1} flat frameloop="demand" camera={{ fov: 66, near: 0.3, far: 6500 }}>
        <PhoneRenderResolution />
        <Background />
        <RemoteScreen page={page} onKey={send} />
      </Canvas>
      {size.w > 0 && (
        <>
          <div className="remote-label" role="status" style={{ left: L.status.x * scale, top: (L.status.y - 14) * scale, width: L.status.w * scale, height: 28 * scale }}>
            {statusLine(page)}
          </div>
          {(['up', 'left', 'ok', 'right', 'down', 'back'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className="remote-label"
              aria-label={id === 'back' ? back : LABELS[id]}
              tabIndex={-1}
              onClick={() => send(KEYS[id], false)}
              style={box(id === 'back' ? L.back : L[id], scale)}
            />
          ))}
        </>
      )}
    </div>
  );
}
