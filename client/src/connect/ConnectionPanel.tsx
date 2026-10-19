import { useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, ICONS, drawCaps, drawGlassCircle, drawGlassPanel, drawStatusDot, ellipsize, paragraph, text,
} from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import { CARD, CAMERA, CLOSE, COLUMN, PAIRING, PAIRING_CAMERA, PILL, STATUS, CAMERA_PREV, WEBCAM_PREVIEW } from './layout.ts';
import {
  CameraSetup, cameraWidgets, drawCameraButton, drawCameraPicker, drawModelPicker, modelDescription,
} from './cameraSetup.ts';
import type { CameraWidget } from './cameraSetup.ts';
import { drawPairing } from './pairing.ts';
import { drawWebcamPreview } from '../../../packages/pose/browser/preview.ts';
import type { WebcamStatus } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { CameraInput } from '../pose/CameraInput.ts';
import type { PoseInputView } from '../pose/PoseSource.ts';

/**
 * Connect Client, drawn in-engine: a status pill in the top-right corner of Settings
 * opens a card for the pose input. With this computer's webcam it runs the chosen MediaPipe
 * model locally; with a phone (the last camera) it shows the code to pair it, and the phone
 * runs the model. Either way it previews player placement in the card.
 *
 * While the card is open the rest of the menus are held (App passes them `blocked`).
 * The canvas reports data-connect-open / -ready / -status / -message / -model / -camera /
 * -pairing (the phone's code while pairing) for tests.
 *
 * <ConnectionPanel visible open onOpenChange={setOpen} source={source} connection={view} />
 */

export interface ConnectionPanelProps {
  visible?: boolean;
  /** The card is out (the pill toggles it through onOpenChange). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The camera the card configures. */
  source: CameraInput;
  /** What the game is playing with: the webcam, or a URL replay. */
  connection: PoseInputView;
}

const LABELS: Partial<Record<WebcamStatus, string>> = {
  connected: 'Client Connected',
  connecting: 'Connecting…',
  initializing: 'Camera starting…',
};
const PHONE_LABELS: Partial<Record<WebcamStatus, string>> = {
  connected: 'Phone Connected',
  connecting: 'Pairing phone…',
  initializing: 'Phone starting…',
};
const smooth = (k: number) => k * k * (3 - 2 * k);

export default function ConnectionPanel({ visible = true, open = false, onOpenChange, source, connection }: ConnectionPanelProps) {
  const gl = useThree((state) => state.gl);
  const props = useRef({ visible, open, onOpenChange, source, connection });
  props.current = { visible, open, onOpenChange, source, connection };
  // alpha: the whole overlay; k: how far the card is out (it grows from the pill).
  // refocus: the card closed under the keyboard cursor, which goes back to the pill.
  const st = useRef<{ alpha: number; k: number; drawn: string | null; lastPreview?: number; snapshot?: unknown; refocus?: boolean }>({ alpha: 0, k: 0, drawn: null }).current;
  const [camera] = useState(() => new CameraSetup(() => ({ source: props.current.source, connection: props.current.source.view })));
  const close = () => {
    st.refocus = props.current.visible && ui.keyboard;
    props.current.onOpenChange?.(false);
  };

  const ui = useCanvasUI<CameraWidget>({
    priority: 3.2,
    active: () => props.current.visible && st.alpha > 0.3,
    // Closed, the pill joins the screen's keyboard order; open, the card's controls.
    keyNav: true,
    widgets: () => {
      // The card takes input once it's mostly out (not while it whooshes from the pill).
      if (!props.current.open || st.k < 0.5) return [{ id: 'pill', rect: PILL }];
      return [
        { id: 'close', circle: CLOSE },
        // The pairing code takes the tracking buttons' place while it shows. Start camera is
        // the card's main action (Enter presses it); Disconnect isn't.
        ...cameraWidgets(camera.pairing() ? PAIRING_CAMERA : CAMERA).map((wdg) => (wdg.id === 'primary' ? { ...wdg, primary: !camera.active() } : wdg)),
        { id: 'pill', rect: PILL, nav: false },
      ];
    },
    onActivate: (wdg, s) => {
      const p = props.current;
      if (wdg.id === 'pill') p.onOpenChange?.(!p.open);
      else if (wdg.id === 'close') close();
      else camera.activate(wdg);
      s.invalidate();
    },
    onStep: (wdg, dir, _s, repeat) => camera.step(wdg, dir, repeat),
    onKey: (e, s) => {
      const p = props.current;
      if (!p.visible || !p.open || e.metaKey || e.ctrlKey || e.altKey || e.key !== 'Escape') return;
      if (!e.repeat) close();
      e.preventDefault();
      s.invalidate();
    },
    update: (_dt, s) => {
      const p = props.current;
      st.alpha = s.ease(st.alpha, p.visible ? 1 : 0, p.visible ? 3 : 6);
      if (!p.visible && p.open) close();
      st.k = s.ease(st.k, p.open && p.visible ? 1 : 0, p.open ? 8 : 10);
      // Once the card is closed (the props catch up a frame or more later).
      if (st.refocus && !p.open) {
        st.refocus = false;
        if (p.visible) s.focus({ id: 'pill', rect: PILL });
      }
      const { status } = p.connection;
      const ready = p.open && st.k >= 0.5 && st.alpha > 0.3;
      if (p.open && p.source.video && s.time - (st.lastPreview || 0) > 1 / 15) {
        st.lastPreview = s.time; s.invalidate();
      }
      // A phone's poses arrive without a video to redraw for.
      if (p.open && camera.phone() && p.source.view.snapshot !== st.snapshot) { st.snapshot = p.source.view.snapshot; s.invalidate(); }
      const pairing = camera.pairing()?.code ?? '';
      const video = !!p.source.video;
      const key = `${status}|${camera.message()}|${p.open}|${ready}|${p.connection.model}|${p.connection.cameraId}|${p.connection.cameras?.length}|${pairing}|${video}`;
      if (key !== st.drawn) {
        st.drawn = key;
        s.invalidate();
        Object.assign(gl.domElement.dataset, {
          connectOpen: String(p.open), connectReady: String(ready), connectStatus: status, connectMessage: camera.message(),
          connectModel: p.connection.model || '', connectCamera: p.connection.cameraId || '', connectPairing: pairing,
          connectVideo: String(video),
        });
      }
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      const p = props.current;
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      const { status } = p.connection;
      const k = smooth(st.k);

      if (k > 0.01) {
        // Dim the menus behind; they're on hold while the card is out.
        g.fillStyle = `rgba(0, 18, 48, ${0.35 * k})`;
        g.fillRect(0, 0, s.w, s.h);
        g.save();
        g.globalAlpha *= Math.min(1, k * 1.4);
        const ox = PILL.x + PILL.w / 2;
        const oy = PILL.y + PILL.h;
        g.translate(ox, oy);
        g.scale(k, k);
        g.translate(-ox, -oy);
        drawGlassPanel(g, CARD, 30);
        drawCaps(g, 'CONNECT CLIENT', CARD.x + 36, CARD.y + 46, { size: 24 });
        drawGlassCircle(g, CLOSE, h.close ?? 0);
        g.lineWidth = 4;
        g.lineCap = 'round';
        g.strokeStyle = '#ffffff';
        ICONS.close(g, CLOSE.x, CLOSE.y, CLOSE.r * 1.1);

        text(g, 'Camera · use arrows to choose', COLUMN.x + 4, CAMERA_PREV.y - 26, { size: 22, weight: 700, color: '#bff4ff' });
        // The card is the camera's, whatever the game is playing with (a URL replay included).
        const view = p.source.view;
        drawCameraPicker(g, CAMERA, view, h);
        const pairing = camera.pairing();
        if (pairing) drawPairing(g, PAIRING, pairing);
        else {
          drawModelPicker(g, CAMERA, view, h);
          drawWebcamPreview(g, p.source.video, p.connection.snapshot, WEBCAM_PREVIEW, p.source.playerCount,
            camera.phone() ? 'Pair your phone to preview' : undefined, { frame: view.frame });
          paragraph(g, modelDescription(view),
            WEBCAM_PREVIEW.x + WEBCAM_PREVIEW.w + 20, WEBCAM_PREVIEW.y + 20, 365, { size: 21, lineH: 27 });
          paragraph(g, camera.phone()
            ? 'Your phone runs the tracking and sends only your pose here. Prop it up where it can see your whole body.'
            : 'Keep your full body visible. Video stays in this browser. Camera access needs HTTPS or localhost.',
          WEBCAM_PREVIEW.x + WEBCAM_PREVIEW.w + 20, WEBCAM_PREVIEW.y + 78, 365, { size: 19, lineH: 24 });
        }

        paragraph(g, camera.message(), STATUS.x + 4, STATUS.y, STATUS.w - 8, { size: 21, lineH: 28, color: camera.failed() ? '#ffb38a' : '#ffffff' });
        drawCameraButton(g, CAMERA, camera, h.primary ?? 0, press('primary'));
        g.restore();
      }

      // The pill: status light and what the pose input is doing.
      const hv = h.pill ?? 0;
      g.save();
      g.globalAlpha *= 0.88 + hv * 0.12;
      drawGlassPanel(g, PILL, PILL.h / 2);
      g.restore();
      const cy = PILL.y + PILL.h / 2;
      drawStatusDot(g, PILL.x + 40, cy, status, 11);
      g.font = `700 28px ${FONT}`;
      const label = (p.connection.sourceKind === 'phone' ? PHONE_LABELS : LABELS)[status] ?? 'Connect Client';
      text(g, ellipsize(g, label, PILL.w - 130), PILL.x + 68, cy + 1, { size: 28, weight: 700 });
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#ffffff';
      (p.open ? ICONS.up : ICONS.down)(g, PILL.x + PILL.w - 38, cy, 40);
    },
  });

  return null;
}
