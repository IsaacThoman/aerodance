import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, ICONS, drawCaps, drawGlassCircle, drawGlassPanel, drawPill, drawStatusDot, drawTitle, ellipsize, paragraph, roundRect, text,
} from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import { drawModelPicker } from '../connect/cameraSetup.ts';
import { phoneDesign, phoneLayout } from './layout.ts';
import type { PhoneLayout } from './layout.ts';
import type { PhoneLink, PhoneLinkView } from './PhoneLink.ts';
import { CODE_DIGITS, codeDigits } from '../../../packages/pairing/signals.ts';
import { MODELS } from '../../../packages/pose/browser/models.ts';
import type { PoseModelId } from '../../../packages/pose/browser/models.ts';
import { drawWebcamPreview } from '../../../packages/pose/browser/preview.ts';
import type { WebcamStatus, WebcamView } from '../../../packages/pose/browser/WebcamPoseSource.ts';

/**
 * The phone camera page, drawn in-engine like the game's menus:
 *
 *   code      a keypad for the code on the game's screen (a QR code's link skips it)
 *   joining / linking   what's happening, and Cancel
 *   linked    setup: the preview (the camera's picture with the tracked skeletons, or the
 *             players' glass characters as a mirror, drawn by PhoneReflection under this
 *             overlay), Video / Mirror / Flip camera, the tracking model, and Ready, which
 *             dims the screen to save battery while the phone tracks (tap to wake)
 *   ended     why, and a way to enter another code
 *
 * The canvas reports data-phone-stage / -ready / -camera-status / -dim / -mode / -video (sending
 * the game its picture) for tests.
 *
 * <PhoneScreen link view camera mode onMode dim onDim />
 */

export type PreviewMode = 'video' | 'mirror';
export interface PhoneScreenProps {
  link: PhoneLink;
  view: PhoneLinkView;
  camera: WebcamView;
  mode: PreviewMode;
  onMode: (mode: PreviewMode) => void;
  /** The screen is dimmed while the phone tracks. */
  dim: boolean;
  onDim: (dim: boolean) => void;
}
type PhoneWidget = Widget & { key?: string; modelId?: PoseModelId };

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'delete', '0', 'join'];
const ACTIVE: readonly WebcamStatus[] = ['connecting', 'initializing', 'connected'];

function drawKey(g: CanvasRenderingContext2D, rect: Rect, key: string, hover: number, press: number, enabled: boolean) {
  g.save();
  if (!enabled) g.globalAlpha *= 0.45;
  const lift = hover * 2 - press * 3;
  const r = { ...rect, y: rect.y - lift };
  drawGlassPanel(g, r, 22);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  g.strokeStyle = g.fillStyle = '#ffffff';
  g.lineWidth = 6;
  g.lineCap = g.lineJoin = 'round';
  if (key === 'delete') ICONS.left(g, cx, cy, r.h * 0.7);
  else if (key === 'join') text(g, 'Join', cx, cy + 2, { size: 34, weight: 800, align: 'center' });
  else text(g, key, cx, cy + 3, { size: 46, weight: 800, align: 'center' });
  g.restore();
}

// Six boxes, filled as the code is typed.
function drawDigits(g: CanvasRenderingContext2D, rect: Rect, code: string) {
  const gap = 12;
  const w = Math.min(84, (rect.w - gap * (CODE_DIGITS - 1) - 24) / CODE_DIGITS);
  const total = w * CODE_DIGITS + gap * (CODE_DIGITS - 1) + 24;
  let x = rect.x + (rect.w - total) / 2;
  for (let i = 0; i < CODE_DIGITS; i++) {
    if (i === 3) x += 24;
    roundRect(g, x, rect.y, w, rect.h, 16);
    g.fillStyle = i === code.length ? 'rgba(191, 244, 255, 0.35)' : 'rgba(0, 30, 70, 0.4)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    g.stroke();
    if (code[i]) text(g, code[i], x + w / 2, rect.y + rect.h / 2 + 3, { size: 52, weight: 800, align: 'center' });
    x += w + gap;
  }
}

// Text straight over the bright sky: the navy drop shadow the game's own titles use.
function shadowed(g: CanvasRenderingContext2D, draw: () => void) {
  g.save();
  g.shadowColor = 'rgba(0, 34, 84, 0.8)';
  g.shadowBlur = 5;
  g.shadowOffsetY = 2;
  draw();
  g.restore();
}

function drawHeader(g: CanvasRenderingContext2D, L: PhoneLayout, line: string, status: WebcamStatus | null) {
  drawTitle(g, L.title);
  const { x, y, w } = L.status;
  if (status) drawStatusDot(g, x + 10, y, status, 9);
  const tx = status ? x + 30 : x;
  g.font = `700 22px ${FONT}`;
  shadowed(g, () => text(g, ellipsize(g, line, w - (tx - x) - (L.landscape ? 0 : 70)), tx, y, { size: 22, weight: 700, color: '#e6f8ff' }));
}

export default function PhoneScreen({ link, view, camera, mode, onMode, dim, onDim }: PhoneScreenProps) {
  const gl = useThree((state) => state.gl);
  const props = useRef({ link, view, camera, mode, onMode, dim, onDim });
  props.current = { link, view, camera, mode, onMode, dim, onDim };
  const st = useRef({ typed: '', drawn: '', lastPreview: 0, reported: '' }).current;
  const layout = (s: { w: number; h: number }) => phoneLayout(s);

  const typeKey = (key: string) => {
    const p = props.current;
    if (p.view.stage !== 'code') return;
    if (key === 'delete') st.typed = st.typed.slice(0, -1);
    else if (key === 'join') { if (st.typed.length === CODE_DIGITS) void p.link.join(st.typed); }
    else st.typed = codeDigits(st.typed + key);
    // The sixth digit joins by itself.
    if (key !== 'join' && key !== 'delete' && st.typed.length === CODE_DIGITS) void p.link.join(st.typed);
  };

  const ui = useCanvasUI<PhoneWidget>({
    priority: 2,
    design: phoneDesign,
    keyNav: () => props.current.view.stage !== 'code',
    widgets: (s) => {
      const p = props.current;
      const L = layout(s);
      switch (p.view.stage) {
        case 'code': return L.keys.map((rect, i) => ({ id: `key-${KEYS[i]}`, rect, key: KEYS[i] }));
        case 'joining': case 'linking': case 'ended': return [{ id: 'primary', rect: L.primary }];
        case 'linked':
          if (p.dim) return [{ id: 'wake', rect: { x: 0, y: 0, w: L.w, h: L.h } }];
          return [
            { id: 'video', rect: L.video }, { id: 'mirror', rect: L.mirror }, { id: 'flip', rect: L.flip },
            ...MODELS.map((model, i) => ({ id: `model-${model.id}`, rect: L.models[i], modelId: model.id })),
            { id: 'primary', rect: L.primary },
            { id: 'leave', circle: L.leave },
          ];
      }
    },
    onActivate: (wdg, s) => {
      const p = props.current;
      const { stage } = p.view;
      if (wdg.key) typeKey(wdg.key);
      else if (wdg.id === 'wake') p.onDim(false);
      else if (wdg.id === 'video' || wdg.id === 'mirror') p.onMode(wdg.id);
      else if (wdg.id === 'flip') void p.link.setFacing(p.camera.facing === 'user' ? 'environment' : 'user').catch(() => {});
      else if (wdg.modelId) void p.link.setModel(wdg.modelId).catch(() => {});
      else if (wdg.id === 'leave') { st.typed = ''; p.link.leave(); }
      else if (wdg.id === 'primary') {
        if (stage === 'linked') {
          if (ACTIVE.includes(p.camera.status)) p.onDim(true);
          else p.link.resume();
        } else { st.typed = ''; p.link.leave(); }
      }
      s.invalidate();
    },
    onKey: (e, s) => {
      if (props.current.view.stage !== 'code' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) typeKey(e.key);
      else if (e.key === 'Backspace') typeKey('delete');
      else if (e.key === 'Enter') typeKey('join');
      else return;
      e.preventDefault();
      s.invalidate();
    },
    update: (_dt, s) => {
      const p = props.current;
      const { view, camera } = p;
      if (view.stage !== 'code') st.typed = '';
      const key = `${view.stage}|${view.message}|${view.error}|${view.playerCount}|${view.playing}|${camera.status}|${camera.message}|${camera.model}|${camera.facing}|${p.mode}|${p.dim}|${st.typed}`;
      if (key !== st.drawn) { st.drawn = key; s.invalidate(); }
      // The camera's picture and skeletons, a few times a second.
      if (view.stage === 'linked' && !p.dim && p.mode === 'video' && p.link.camera.video && s.time - st.lastPreview > 1 / 15) {
        st.lastPreview = s.time;
        s.invalidate();
      }
      const sending = p.link.sendingVideo;
      const report = JSON.stringify([view.stage, camera.status, p.dim, p.mode, sending]);
      if (report !== st.reported) {
        st.reported = report;
        Object.assign(gl.domElement.dataset, { phoneStage: view.stage, phoneReady: 'true', phoneCameraStatus: camera.status, phoneDim: String(p.dim), phoneMode: p.mode,
          phoneVideo: String(sending) });
      }
    },
    draw: (g, s) => {
      const p = props.current;
      const { view, camera } = p;
      const L = layout(s);
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);

      if (view.stage === 'linked' && p.dim) {
        // As dark as the screen goes: the phone keeps tracking underneath.
        g.fillStyle = '#000000';
        g.fillRect(0, 0, L.w, L.h);
        const cx = L.w / 2, cy = L.h / 2;
        g.font = `700 26px ${FONT}`;
        const label = view.playing ? 'Dancing · tracking you' : 'Tracking';
        const tw = g.measureText(label).width;
        drawStatusDot(g, cx - tw / 2 - 18, cy - 40, camera.status, 9);
        text(g, label, cx - tw / 2, cy - 40, { size: 26, weight: 700, color: 'rgba(230, 248, 255, 0.7)' });
        g.font = `600 20px ${FONT}`;
        text(g, ellipsize(g, camera.message, L.w - 80), cx, cy, { size: 20, align: 'center', color: 'rgba(230, 248, 255, 0.45)' });
        paragraph(g, 'Keep this page open. Tap anywhere to show the preview.', cx, cy + 44, Math.min(460, L.w - 80), { size: 20, lineH: 26, align: 'center', color: 'rgba(230, 248, 255, 0.45)' });
        return;
      }

      if (view.stage === 'code') {
        drawTitle(g, L.title);
        drawCaps(g, 'PHONE CAMERA', L.status.x, L.status.y, { size: 20 });
        const textBox = L.landscape ? { x: L.digits.x, y: 80, w: L.digits.w } : { x: L.status.x, y: 190, w: L.status.w };
        shadowed(g, () => paragraph(g, 'Type the code from the game’s screen to use this phone as its camera.', textBox.x, textBox.y, textBox.w, { size: 24, lineH: 31, color: '#ffffff' }));
        drawDigits(g, L.digits, st.typed);
        if (view.error) shadowed(g, () => paragraph(g, view.error, L.digits.x, L.digits.y + L.digits.h + 34, L.digits.w, { size: 21, lineH: 27, color: '#ffb38a' }));
        L.keys.forEach((rect, i) => {
          const key = KEYS[i];
          const enabled = key === 'join' ? st.typed.length === CODE_DIGITS : key === 'delete' ? st.typed.length > 0 : true;
          drawKey(g, rect, key, h[`key-${key}`] ?? 0, press(`key-${key}`), enabled);
        });
        return;
      }

      if (view.stage !== 'linked') {
        const ended = view.stage === 'ended';
        drawHeader(g, L, ended ? 'Not connected' : `Code ${view.code.slice(0, 3)} ${view.code.slice(3)}`, ended ? 'disconnected' : 'connecting');
        const box = L.landscape ? { x: L.preview.x, w: L.preview.w } : { x: L.message.x, w: L.message.w };
        const y = L.landscape ? 200 : L.h * 0.36;
        shadowed(g, () => {
          text(g, ended ? 'Pairing ended' : view.message, box.x, y, { size: 34, weight: 800 });
          paragraph(g, ended ? view.message : 'Keep this page open. Same Wi-Fi as the game works best.', box.x, y + 54, box.w, { size: 23, lineH: 30, color: '#ffffff' });
        });
        drawPill(g, L.primary, ended
          ? { label: 'Enter a code', icon: 'phone', hover: h.primary ?? 0, press: press('primary') }
          : { label: 'Cancel', icon: 'close', hover: h.primary ?? 0, press: press('primary') });
        return;
      }

      // Setup.
      const players = view.playerCount === 2 ? '2 players' : '1 player';
      drawHeader(g, L, `Connected · ${players}${view.playing ? ' · dancing' : ''}`, camera.status);
      drawGlassCircle(g, L.leave, h.leave ?? 0);
      g.save();
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.strokeStyle = '#ffffff';
      ICONS.close(g, L.leave.x, L.leave.y, L.leave.r * 1.1);
      g.restore();

      const r = L.preview;
      if (p.mode === 'video') {
        drawWebcamPreview(g, p.link.camera.video, camera.snapshot, r, view.playerCount, 'Starting camera…', { mirror: camera.facing === 'user' });
      } else if (!camera.snapshot?.poses.length) {
        // The mirror (PhoneReflection) shows nobody yet.
        shadowed(g, () => text(g, camera.status === 'connected' ? 'Step into view' : ACTIVE.includes(camera.status) ? 'Starting camera…' : 'Camera off', r.x + r.w / 2, r.y + r.h / 2, { size: 30, weight: 800, align: 'center' }));
      }
      roundRect(g, r.x, r.y, r.w, r.h, 18);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      g.stroke();

      const marked = (on: boolean, label: string) => `${on ? '● ' : ''}${label}`;
      drawPill(g, L.video, { label: marked(p.mode === 'video', 'Video'), icon: 'camera', hover: h.video ?? 0, press: press('video') });
      drawPill(g, L.mirror, { label: marked(p.mode === 'mirror', 'Mirror'), icon: 'solo', hover: h.mirror ?? 0, press: press('mirror') });
      drawPill(g, L.flip, { label: 'Flip', icon: 'replay', hover: h.flip ?? 0, press: press('flip') });
      drawModelPicker(g, { prev: L.video, next: L.flip, models: L.models }, camera, h);
      g.font = `600 20px ${FONT}`;
      shadowed(g, () => paragraph(g, camera.message, L.message.x + 4, L.message.y, L.message.w - 8, { size: 20, lineH: 25, color: camera.status === 'error' ? '#ffb38a' : '#ffffff' }));
      const running = ACTIVE.includes(camera.status);
      drawPill(g, L.primary, running
        ? { label: 'Ready', sub: 'dims the screen while it tracks', icon: 'play', hover: h.primary ?? 0, press: press('primary') }
        : { label: 'Start camera', icon: 'camera', hover: h.primary ?? 0, press: press('primary') });
    },
  });

  // The page's state changes between frames too (a song starting, the camera stopping).
  useEffect(() => { ui.invalidate(); }, [ui, view, camera, mode, dim]);

  return null;
}
