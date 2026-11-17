import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { drawGlassButton, drawHeader, glassCorner } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import { displayDesign } from '../display.ts';
import { screensaverLayout } from './layout.ts';
import { scenes } from './catalog.ts';

export default function SceneList({ scene, keyboard, onChoose, onBack }: {
  scene: number; keyboard: boolean; onChoose: (index: number) => void; onBack: () => void;
}) {
  const size = useThree(s => s.size);
  const layout = screensaverLayout(displayDesign(size.width, size.height).w);
  const cards = scenes.map((entry, i) => ({
    id: entry.id, rect: layout.saverScene(i), corner: glassCorner(layout.saverScene(i).h), primary: i === scene,
  }));
  const ui = useCanvasUI({
    priority: 3.1,
    keyNav: true,
    // Up and Down visit a column. Left and Right go to its neighbouring card.
    widgets: () => [...cards.filter((_, i) => i % 2 === 0), ...cards.filter((_, i) => i % 2 === 1), { id: 'back', circle: layout.SAVER_BACK }],
    onStep: ({ id }, dir, s) => {
      const i = scenes.findIndex(entry => entry.id === id);
      if (i < 0) return false;
      const next = i + dir;
      if (Math.floor(next / 2) === Math.floor(i / 2) && cards[next]) s.focus(cards[next]);
      return true;
    },
    onActivate: ({ id }) => {
      if (id === 'back') onBack();
      else onChoose(scenes.findIndex(entry => entry.id === id));
    },
    onKey: e => {
      if (e.key === 'Escape' && !e.repeat && !e.defaultPrevented) { e.preventDefault(); onBack(); }
    },
    draw: (g, s) => {
      g.fillStyle = 'rgba(6, 29, 50, 0.75)';
      g.fillRect(0, 0, s.w, s.h);
      drawHeader(g, layout.SAVER_BACK, 'ALL SCENES', s.hover.back ?? 0);
      scenes.forEach((entry, i) => drawGlassButton(g, cards[i].rect, {
        label: entry.title, sub: entry.views.join('  ·  '),
        icon: i === scene ? 'check' : entry.icon, hover: s.hover[entry.id], chevron: false,
      }));
    },
  });
  useLayoutEffect(() => {
    if (keyboard) ui.focus(cards[scene]);
    // Set the initial selection when the list opens. Resizing preserves navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
