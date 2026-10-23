import { useRef } from 'react';
import { ICONS, drawGlassCircle } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import { canOpenPhoneCamera, hostState, openPhoneCamera } from '../host.ts';
import { SLIDE_SECONDS, smooth } from './FullscreenButton.tsx';
import { leftCornerBubble } from './layout.ts';

/**
 * The main menu's camera bubble in the iPhone/iPad app, drawn in-engine in the bottom-left
 * corner, mirroring the AirPlay bubble in the bottom right. A tap turns the phone into another
 * game's camera: the app shows the phone camera page (/pair/) over the game, where the player
 * types that game's code, and closing it comes back here (host.ts openPhoneCamera). It slides
 * off to the left outside the main menu, and is drawn only while the game is on the phone
 * itself, and nowhere outside the app.
 *
 * <PhoneCameraButton visible={() => isMainScreen} />
 */

export interface PhoneCameraButtonProps {
  /** Read every frame: whether the bubble should be on screen. */
  visible?: () => boolean;
}

export default function PhoneCameraButton({ visible = () => true }: PhoneCameraButtonProps) {
  const props = useRef({ visible });
  props.current = { visible };
  const st = useRef<{ slide: number; shown: boolean | null }>({ slide: 1, shown: null }).current;
  const shown = () => props.current.visible() && canOpenPhoneCamera() && hostState().screen === 'phone';

  useCanvasUI({
    priority: 3.5,
    active: () => shown() && st.slide === 0,
    keyNav: true,
    widgets: (s) => (canOpenPhoneCamera() ? [{ id: 'phoneCamera', circle: leftCornerBubble(s.w) }] : []),
    onActivate: (_wdg, s) => {
      openPhoneCamera();
      s.invalidate();
    },
    update: (dt, s) => {
      const on = shown();
      if (on !== st.shown) { st.shown = on; s.invalidate(); }
      const slide = Math.max(0, Math.min(1, st.slide + (on ? -1 : 1) * dt / SLIDE_SECONDS));
      if (slide !== st.slide) { st.slide = slide; s.invalidate(); }
    },
    opacity: () => (st.slide === 1 ? 0 : 1),
    draw: (g, s) => {
      const B = leftCornerBubble(s.w);
      g.save();
      g.translate(-smooth(st.slide) * (B.x + B.r + 24), 0);
      drawGlassCircle(g, B, s.hover.phoneCamera ?? 0);
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#ffffff';
      ICONS.camera(g, B.x, B.y, B.r);
      g.restore();
    },
  });

  return null;
}
