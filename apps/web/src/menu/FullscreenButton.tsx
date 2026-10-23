import { useRef } from 'react';
import { ICONS, drawGlassCircle, drawShadowText } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import useFullscreen from './useFullscreen.ts';
import type { Fullscreen } from './useFullscreen.ts';
import { cornerBubble } from './layout.ts';

/**
 * The main menu's fullscreen bubble, drawn in-engine in the bottom-right corner (priority
 * 3.5). It slides off to the right outside the main menu and back in on return. Click it on
 * the display itself: browsers only enter fullscreen from the user's own input. It isn't
 * drawn at all where the page can't go fullscreen (iPhone Safari, the tvOS app, the iPhone/iPad
 * app, which turns element fullscreen off, and iframes without allowfullscreen).
 *
 * <FullscreenButton visible={() => isMainScreen} />
 */

const button = cornerBubble;
export const SLIDE_SECONDS = 0.3;

export const smooth = (k: number) => k * k * (3 - 2 * k);

export interface FullscreenButtonProps {
  /** Read every frame: whether the bubble should be on screen. */
  visible?: () => boolean;
}

export default function FullscreenButton({ visible = () => true }: FullscreenButtonProps) {
  const fullscreen = useFullscreen();
  const props = useRef({ fullscreen, visible });
  props.current = { fullscreen, visible };
  const st = useRef<{ slide: number; visible: boolean | null; drawn: Fullscreen | null }>({ slide: 0, visible: null, drawn: null }).current;

  useCanvasUI({
    priority: 3.5,
    active: () => props.current.visible() && st.slide === 0,
    // After the main menu's buttons in the keyboard order (it draws above them).
    keyNav: true,
    widgets: (s) => (props.current.fullscreen.supported ? [{ id: 'fullscreen', circle: button(s.w) }] : []),
    onActivate: (_wdg, s) => {
      props.current.fullscreen.toggle();
      s.invalidate();
    },
    update: (dt, s) => {
      const shown = props.current.visible();
      if (shown !== st.visible) { st.visible = shown; s.invalidate(); }
      const slide = Math.max(0, Math.min(1, st.slide + (shown ? -1 : 1) * dt / SLIDE_SECONDS));
      if (slide !== st.slide) { st.slide = slide; s.invalidate(); }
      if (props.current.fullscreen !== st.drawn) s.invalidate();
    },
    opacity: () => (st.slide === 1 || !props.current.fullscreen.supported ? 0 : 1),
    draw: (g, s) => {
      const fs = props.current.fullscreen;
      const BUTTON = button(s.w);
      st.drawn = fs;
      // Keep the bubble opaque while it travels beyond the frame's right edge.
      g.save();
      g.translate(smooth(st.slide) * (s.w - BUTTON.x + BUTTON.r + 24), 0);
      drawGlassCircle(g, BUTTON, s.hover.fullscreen ?? 0);
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#ffffff';
      ICONS.fullscreen(g, BUTTON.x, BUTTON.y, BUTTON.r, fs.active);
      g.restore();
      if (st.visible && fs.error) {
        drawShadowText(g, fs.error, BUTTON.x - BUTTON.r - 18, BUTTON.y, { size: 24, align: 'right' });
      }
    },
  });

  return null;
}
