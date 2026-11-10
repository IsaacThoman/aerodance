import { useRef } from 'react';
import useCanvasUI from '../ui/useCanvasUI.ts';
import { drawDarkGlassPanel, drawShadowText, ellipsize, FONT } from '../ui/draw.ts';
import { recordingStatus } from './sessionRecording.ts';

/** Stays mounted across quit/results so the save confirmation survives the round. */
export default function SessionRecordingOverlay() {
  const last = useRef('');
  useCanvasUI({
    priority: 2.8,
    active: () => false,
    opacity: () => recordingStatus.active || performance.now() < recordingStatus.noticeUntil ? 1 : 0,
    update: (_, s) => {
      const { active, startedAt, notice, noticeUntil } = recordingStatus;
      const key = active ? String(Math.floor((performance.now() - startedAt) / 1000)) : performance.now() < noticeUntil ? notice : '';
      if (key !== last.current) { last.current = key; s.invalidate(); }
    },
    draw: (g, s) => {
      const now = performance.now(), { active, startedAt, notice, noticeUntil } = recordingStatus;
      if (!active && now >= noticeUntil) return;
      const seconds = Math.floor((now - startedAt) / 1000);
      const text = active ? `● REC  ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : notice;
      const width = active ? 180 : s.w - 80;
      drawDarkGlassPanel(g, { x: 40, y: 832, w: width, h: 44 }, 18);
      g.font = `700 22px ${FONT}`;
      drawShadowText(g, ellipsize(g, text, width - 28), 54, 861, { size: 22, weight: 700, color: active ? '#ffb3b3' : '#fff' });
    },
  });
  return null;
}
