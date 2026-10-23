import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { ICONS, drawGlassCircle } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import { MIN_TOUCH_PX } from '../ui/hit.ts';
import { canPickAirPlay, hostState, placeAirPlayPicker } from '../host.ts';
import type { PickerRect } from '../host.ts';
import { SLIDE_SECONDS, smooth } from './FullscreenButton.tsx';
import { cornerBubble } from './layout.ts';

/**
 * The main menu's AirPlay bubble in the iPhone/iPad app, drawn in-engine in the bottom-right
 * corner where a browser shows the fullscreen bubble (the app has no fullscreen, so that one
 * isn't drawn there). It slides off and back like that bubble. The bubble is only a picture:
 * the app lays its own AirPlay picker, invisible, over it (host.ts placeAirPlayPicker), so a tap
 * opens the system's AirPlay menu. It's drawn only while the game is on the phone itself, and
 * nowhere outside the app.
 *
 * <AirPlayButton visible={() => isMainScreen} />
 */

export interface AirPlayButtonProps {
  /** Read every frame: whether the bubble should be on screen. */
  visible?: () => boolean;
}

export default function AirPlayButton({ visible = () => true }: AirPlayButtonProps) {
  const gl = useThree((state) => state.gl);
  const props = useRef({ visible });
  props.current = { visible };
  const st = useRef<{ slide: number; shown: boolean | null; placed: string }>({ slide: 1, shown: null, placed: 'null' }).current;
  const shown = () => props.current.visible() && canPickAirPlay() && hostState().screen === 'phone';

  // The picker goes over the bubble once it has come to rest, and away as soon as it moves off.
  const place = (rect: PickerRect | null) => {
    const key = JSON.stringify(rect);
    if (key === st.placed) return;
    st.placed = key;
    placeAirPlayPicker(rect);
  };

  useCanvasUI({
    priority: 3.5,
    // Only a picture: the touches go to the app's picker over it.
    active: () => false,
    update: (dt, s) => {
      const on = shown();
      if (on !== st.shown) { st.shown = on; s.invalidate(); }
      const slide = Math.max(0, Math.min(1, st.slide + (on ? -1 : 1) * dt / SLIDE_SECONDS));
      if (slide !== st.slide) { st.slide = slide; s.invalidate(); }
      if (!on || slide > 0) { place(null); return; }
      // The bubble in the page's CSS pixels, at least a fingertip across.
      const frame = gl.domElement.getBoundingClientRect();
      const B = cornerBubble(s.w);
      const scale = frame.width / s.w;
      const size = Math.max(B.r * 2 * scale, MIN_TOUCH_PX);
      const round = (v: number) => Math.round(v * 10) / 10;
      place({ x: round(frame.left + B.x * scale - size / 2), y: round(frame.top + B.y * scale - size / 2), w: round(size), h: round(size) });
    },
    opacity: () => (st.slide === 1 ? 0 : 1),
    draw: (g, s) => {
      const B = cornerBubble(s.w);
      g.save();
      g.translate(smooth(st.slide) * (s.w - B.x + B.r + 24), 0);
      drawGlassCircle(g, B, 0);
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#ffffff';
      ICONS.airplay(g, B.x, B.y, B.r);
      g.restore();
    },
  });

  return null;
}
