// A 2D canvas parity page: the game's own UI drawing kit (apps/web/src/ui/draw.ts) and the
// primitives it relies on, drawn on a 1600x900 canvas and shown full screen through WebGL, so a
// browser and the JavaScriptCore host can be screenshotted side by side.
import * as THREE from 'three';
import { drawCaps, drawDisc, drawGlassCircle, drawGlassPanel, drawHeadline, drawPill, drawProgress, drawShadowText, drawStatusDot, drawTitle, paragraph } from '../../web/src/ui/draw.ts';

const W = 1600, H = 900;
const ui = document.createElement('canvas');
ui.width = W; ui.height = H;
const g = ui.getContext('2d') as CanvasRenderingContext2D;

function draw() {
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#2f7fe8'); sky.addColorStop(0.7, '#bfe6ff');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  drawTitle(g, { x: 80, y: 170, size: 150 });
  drawPill(g, { x: 80, y: 260, w: 460, h: 96 }, { label: 'Start', icon: 'play' });
  drawPill(g, { x: 80, y: 380, w: 460, h: 96 }, { label: 'Settings', sub: 'Sound and camera', icon: 'gear', hover: 1 });
  drawDisc(g, 680, 320, 50);
  drawGlassCircle(g, { x: 820, y: 320, r: 50 }, 0.5);
  drawGlassPanel(g, { x: 940, y: 240, w: 560, h: 280 });
  drawCaps(g, 'Now playing', 980, 300);
  drawHeadline(g, 'Demo Track 1', 980, 380, 64, ['#ffffff', '#ffffff', '#d5f3ff']);
  paragraph(g, 'Dance along with the ghost; every move scores points and keeps the streak going.', 980, 430, 480, { size: 24 });
  drawShadowText(g, 'Shadow text 700', 80, 560, { size: 44 });
  drawStatusDot(g, 600, 548, 'connected');
  drawProgress(g, { x: 80, y: 620, w: 600, h: 24 }, 0.6, { knob: true });
  // Primitives: arcs, ellipses, compositing, clipping, dashes, round rects, alignment.
  g.save();
  g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(800, 700, 60, 0.3, Math.PI * 1.6); g.lineTo(800, 700); g.closePath(); g.fill();
  g.strokeStyle = '#120d08'; g.lineWidth = 6; g.setLineDash([12, 8]); g.stroke(); g.setLineDash([]);
  g.fillStyle = 'rgba(42,123,255,0.7)'; g.beginPath(); g.ellipse(980, 700, 90, 40, 0.4, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(1000, 700, 25, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'source-over';
  g.beginPath(); g.roundRect(1120, 640, 180, 120, [30, 10, 50, 0]); g.clip();
  const rg = g.createRadialGradient(1180, 680, 5, 1210, 700, 110);
  rg.addColorStop(0, '#ffe14d'); rg.addColorStop(1, '#2a7bff');
  g.fillStyle = rg; g.fillRect(1100, 620, 220, 160);
  g.restore();
  g.font = '700 28px Nunito, sans-serif'; g.fillStyle = '#0c2f52';
  for (const [i, a] of (['left', 'center', 'right'] as CanvasTextAlign[]).entries()) {
    g.textAlign = a; g.fillText(`${a} Nunito`, 1450, 620 + i * 40);
  }
  g.textAlign = 'left';
  for (const [i, b] of (['top', 'middle', 'alphabetic', 'bottom'] as CanvasTextBaseline[]).entries()) {
    g.textBaseline = b; g.font = '900 27px Nunito, sans-serif'; g.fillText(b, 80 + i * 150, 760);
  }
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ff3b3b'; g.fillRect(80, 760, 600, 1);
  g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.font = '800 40px "Inter"'; g.strokeText('stroke text', 80, 850);
  g.save(); g.translate(560, 820); g.rotate(-0.2); g.scale(1.2, 0.8); g.fillStyle = '#6ff3d6'; g.fillText('rotated', 0, 0); g.restore();
}

draw();
const canvas = (document.querySelector('canvas') ?? document.createElement('canvas')) as HTMLCanvasElement;
if (!canvas.parentNode) document.body.appendChild(canvas);
canvas.width = W; canvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
const tex = new THREE.CanvasTexture(ui);
tex.colorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex })));
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
renderer.setAnimationLoop(() => renderer.render(scene, cam));
