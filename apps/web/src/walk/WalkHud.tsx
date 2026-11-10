import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import useCanvasUI from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { FONT, TAU, drawCaps, drawDarkGlassPanel, drawGlassButton, drawShadowText, glassCorner, roundRect, text } from '../ui/draw.ts';
import type { IconDraw, Rect } from '../ui/draw.ts';
import { CHIP, LEGEND_LINE, walkLayout } from './layout.ts';
import { WALK_SCENES } from './scenes.ts';
import type { WalkScene } from './scenes.ts';
import { resume } from './WalkControls.tsx';
import type { WalkStatus } from './WalkControls.tsx';

export interface WalkHudProps {
  status: WalkStatus;
  onChoose: (scene: WalkScene) => void;
}

type WalkWidget = { id: string; rect: Rect; corner?: number; nav?: boolean; primary?: boolean };

const TOAST_S = 3.2;
const PANEL_CORNER = 34;
// The mode on the chip: walking in the players' green, noclip in their purple.
const MODE_COLORS = { walk: 'rgba(31, 207, 114, 0.85)', noclip: 'rgba(184, 107, 255, 0.85)' } as const;

// The controls along the bottom of the menu: each key, then what it does.
const LEGEND: readonly (readonly [string, string][])[] = [
  [['WASD', 'move'], ['Mouse', 'look'], ['Space', 'jump'], ['Shift', 'run'], ['C', 'crouch'], ['R', 'back to the start']],
  [['Z', 'noclip (Space up, C down, wheel for speed)'], ['[ ]', 'change scene'], ['H', 'hide this'], ['Esc', 'menu']],
];

// A scene button's icon: a ring, filled for the scene showing.
const marker = (current: boolean): IconDraw => (g, cx, cy, r) => {
  g.beginPath();
  g.arc(cx, cy, r * 0.36, 0, TAU);
  g.lineWidth = 3;
  g.strokeStyle = '#ffffff';
  g.stroke();
  if (!current) return;
  g.beginPath();
  g.arc(cx, cy, r * 0.2, 0, TAU);
  g.fillStyle = '#ffffff';
  g.fill();
};

function drawLegend(g: CanvasRenderingContext2D, x: number, y: number) {
  LEGEND.forEach((line, row) => {
    let at = x;
    for (const [key, does] of line) {
      text(g, key, at, y + row * LEGEND_LINE, { size: 21, weight: 800 });
      at += g.measureText(key).width + 8;
      text(g, does, at, y + row * LEGEND_LINE, { size: 21, weight: 500, color: 'rgba(255,255,255,0.78)' });
      at += g.measureText(does).width + 28;
    }
  });
}

/**
 * Walk mode's overlay, in the game's canvas UI (ui/useCanvasUI.ts): the scene's name and the
 * walker's mode on a glass chip top left, a dot in the middle to aim by, a line now and then
 * (toasts, from WalkStatus), and while paused, the menu: Walk, a button for every scene, and the
 * controls. H hides all but the menu.
 *
 * <WalkHud status={status} onChoose={(scene) => ...} />
 */
export default function WalkHud({ status, onChoose }: WalkHudProps) {
  const gl = useThree((state) => state.gl);
  const choose = useRef(onChoose);
  choose.current = onChoose;
  const st = useRef({ panel: status.paused ? 1 : 0, chipW: 0, drawn: '' }).current;
  const paused = () => status.paused;

  const ui = useCanvasUI<WalkWidget>({
    priority: 2,
    active: paused,
    keyNav: true,
    widgets: (s) => {
      const layout = walkLayout(s.w);
      const scenes = WALK_SCENES.flatMap((scene, i) => {
        const rect = layout.sceneRect(i);
        return rect ? [{ id: scene.key, rect, corner: glassCorner(rect.h) }] : [];
      });
      return [
        ...scenes,
        { id: 'resume', rect: layout.RESUME, corner: glassCorner(layout.RESUME.h), primary: true },
        // Clicks on the panel between buttons do nothing; anywhere else walks on.
        { id: 'panel', rect: layout.PANEL, nav: false },
        { id: 'screen', rect: { x: 0, y: 0, w: s.w, h: s.h }, nav: false },
      ];
    },
    onActivate: ({ id }) => {
      if (id === 'panel') return;
      const scene = WALK_SCENES.find((s) => s.key === id);
      if (scene && scene.key !== status.scene.key) choose.current(scene);
      resume(status, gl.domElement);
    },
    update: (_, s) => {
      st.panel = s.ease(st.panel, status.paused ? 1 : 0, 10);
      // Redraw when what's shown changes, and every frame while a toast fades.
      const toast = status.toast && (performance.now() - status.toast.at) / 1000 < TOAST_S;
      const drawn = [status.scene.key, status.ready, status.failed, status.paused, status.hud, status.mode, status.toast?.at].join('|');
      if (drawn !== st.drawn || toast) {
        st.drawn = drawn;
        s.invalidate();
      }
      Object.assign(gl.domElement.dataset, {
        walkScene: status.scene.key, walkReady: String(status.ready), walkFailed: String(status.failed), walkPaused: String(status.paused), walkHud: String(status.hud),
      });
    },
    draw: (g, s) => {
      const { scene } = status;
      // The menu has the name itself.
      if (status.hud && st.panel < 0.5) {
        // The chip: the scene's name, then the mode.
        g.font = `800 28px ${FONT}`;
        const nameW = g.measureText(scene.name).width;
        const mode = status.mode === 'noclip' ? 'NOCLIP' : 'WALK';
        g.font = `800 16px ${FONT}`;
        const modeW = g.measureText(mode).width + mode.length * 4 + 28;
        st.chipW = Math.round(nameW + modeW + 62);
        const chip = { ...CHIP, w: st.chipW };
        drawDarkGlassPanel(g, chip, glassCorner(chip.h));
        drawShadowText(g, scene.name, chip.x + 24, chip.y + chip.h / 2 + 1, { size: 28, weight: 800 });
        const pill = { x: chip.x + 24 + nameW + 16, y: chip.y + 16, w: modeW, h: chip.h - 32 };
        roundRect(g, pill.x, pill.y, pill.w, pill.h, pill.h / 2);
        g.fillStyle = MODE_COLORS[status.mode];
        g.fill();
        drawCaps(g, mode, pill.x + pill.w / 2 + 2, pill.y + pill.h / 2 + 1, { size: 16, align: 'center' });

        if (!status.paused && status.ready) {
          g.save();
          g.shadowColor = 'rgba(0, 34, 84, 0.8)';
          g.shadowBlur = 4;
          g.beginPath();
          g.arc(s.w / 2, s.h / 2, 4, 0, TAU);
          g.fillStyle = '#ffffff';
          g.fill();
          g.restore();
        }
      }

      if (!status.ready && st.panel < 0.5) {
        drawShadowText(g, status.failed ? `${scene.name} couldn’t load` : `Loading ${scene.name}…`, s.w / 2, s.h / 2, { size: 36, weight: 800, align: 'center' });
      }

      const toast = status.toast;
      const age = toast ? (performance.now() - toast.at) / 1000 : Infinity;
      if (toast && age < TOAST_S && status.hud && st.panel < 0.5) {
        drawShadowText(g, toast.text, s.w / 2, s.h - 96, { size: 28, weight: 700, align: 'center', alpha: Math.min(1, (TOAST_S - age) / 0.6) });
      }

      if (st.panel < 0.005) return;
      g.save();
      g.globalAlpha *= st.panel;
      const layout = walkLayout(s.w);
      drawDarkGlassPanel(g, layout.PANEL, PANEL_CORNER);
      drawShadowText(g, scene.name, layout.TITLE.x, layout.TITLE.y - 15, { size: 40, weight: 800 });
      const subtitle = status.ready ? scene.subtitle : status.failed ? 'Couldn’t load' : 'Loading…';
      text(g, subtitle, layout.TITLE.x, layout.TITLE.y + 24, { size: 22, weight: 600, color: 'rgba(255,255,255,0.82)' });
      const hover = (id: string) => s.hover[id] ?? 0;
      drawGlassButton(g, layout.RESUME, { label: 'Walk', icon: 'play', hover: hover('resume'), press: s.press * hover('resume') });
      for (const section of layout.sections) drawCaps(g, section.label.toUpperCase(), layout.LEGEND.x, section.caps, { size: 18 });
      WALK_SCENES.forEach((each, i) => {
        const rect = layout.sceneRect(i);
        if (!rect) return;
        const current = each.key === scene.key;
        drawGlassButton(g, rect, { label: each.name, icon: marker(current), hover: Math.max(hover(each.key), current ? 0.5 : 0), press: s.press * hover(each.key) });
      });
      drawLegend(g, layout.LEGEND.x, layout.LEGEND.y);
      g.restore();
    },
  });

  useGlassBlur(() => {
    const layout = walkLayout(ui.w);
    const chip = status.hud && st.chipW && st.panel < 0.5 ? [panelPane({ ...CHIP, w: st.chipW }, glassCorner(CHIP.h))] : [];
    const menu = [panelPane(layout.PANEL, PANEL_CORNER), buttonPane(ui, 'resume', layout.RESUME)].map((pane) => ({ ...pane, alpha: st.panel }));
    return { panes: st.panel > 0.005 ? [...chip, ...menu] : chip, alpha: 1 };
  }, { priority: 1.9 });

  return null;
}
