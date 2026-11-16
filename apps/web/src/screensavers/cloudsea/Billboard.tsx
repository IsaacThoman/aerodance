import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { viewPoint } from '../../../../../packages/backdrops/cloudsea/palette.ts';
import { backdropClock } from '../../../../../packages/backdrops/shared/frame.ts';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { FONT } from '../../ui/draw.ts';
import { clockText, useClockTexture } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * The Clock setting's In scene for Cloud Sea: the time in LED lights on the big airship's flank,
 * like a blimp's billboard, wrapped round its envelope on the side the camera sees. It rides
 * along with the airship, so it repeats Fleet.tsx's cruise for it exactly.
 */

// The big airship (packages/backdrops/cloudsea/Fleet.tsx AIRSHIPS[0]) and its cruise.
const BASE = viewPoint(-0.56, 0.64, 185);
const SIZE = 34;
const YAW = 3.6;
const _pos = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(SIZE, SIZE, SIZE);

function airshipMatrix(t: number, out: THREE.Matrix4) {
  const heading = YAW + Math.sin(t * 0.061) * 0.05;
  const surge = Math.sin(t * 0.047) * SIZE * 0.18;
  _pos.copy(BASE);
  _pos.x += Math.cos(heading) * surge;
  _pos.z -= Math.sin(heading) * surge;
  _pos.y += Math.sin(t * 0.29) * SIZE * 0.035;
  _euler.set(Math.sin(t * 0.23 + 1) * 0.02, heading, Math.sin(t * 0.19) * 0.025);
  return out.compose(_pos, _quat.setFromEuler(_euler), _scale);
}

// The envelope's radius along its length, 0 at the tail to 1 at the nose (models.ts airshipGeometry).
const R = 0.165;
const envelope = (s: number) => {
  const u = 2 * Math.pow(s, 1.36) - 1;
  return R * Math.pow(Math.max(0, 1 - u * u), 0.52);
};

// The panel: from a little behind the middle to near the nose, from just above the flank's
// pinstripe two-fifths of the way up, standing just proud of the envelope. Its flank is the
// envelope's -z side, which the airship's heading turns towards the camera.
const ALONG: readonly [number, number] = [0.3, 0.8];
const UP: readonly [number, number] = [0.06, 0.92];

function panelGeometry() {
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const s = ALONG[0] + ((ALONG[1] - ALONG[0]) * i) / 24;
    profile.push(new THREE.Vector2(envelope(s) * 1.02, s - 0.5));
  }
  // Lathed about y as the envelope is, then laid along x; its angles run from the flank up.
  const g = new THREE.LatheGeometry(profile, 16, Math.PI + UP[0], UP[1] - UP[0]);
  g.rotateZ(-Math.PI / 2);
  return g;
}

const W = 512, H = 128;

/** The board: dark glass with a grid of dim LEDs, the time lit up in them. */
function paintBoard(g: CanvasRenderingContext2D, now: Date) {
  g.clearRect(0, 0, W, H);
  const glass = g.createLinearGradient(0, 0, 0, H);
  glass.addColorStop(0, '#163b63');
  glass.addColorStop(1, '#071a30');
  g.fillStyle = glass;
  g.fillRect(0, 0, W, H);
  // The lit time, drawn once to find which LEDs are on.
  const { time, period } = clockText(now);
  const text = document.createElement('canvas');
  text.width = W;
  text.height = H;
  const t = text.getContext('2d');
  if (!t) return;
  t.fillStyle = '#fff';
  t.textAlign = 'center';
  t.textBaseline = 'middle';
  t.font = `800 ${H * 0.78}px ${FONT}`;
  const timeWidth = t.measureText(time).width;
  t.font = `800 ${H * 0.3}px ${FONT}`;
  const periodWidth = period ? t.measureText(period).width + H * 0.12 : 0;
  const left = (W - timeWidth - periodWidth) / 2;
  t.textAlign = 'left';
  t.font = `800 ${H * 0.78}px ${FONT}`;
  t.fillText(time, left, H * 0.54);
  if (period) { t.font = `800 ${H * 0.3}px ${FONT}`; t.fillText(period, left + timeWidth + H * 0.12, H * 0.68); }
  const lit = t.getImageData(0, 0, W, H).data;
  // LEDs on a 4-pixel pitch: dim where unlit, aqua-white where the time covers them.
  const pitch = 4;
  for (let y = pitch / 2; y < H; y += pitch) {
    for (let x = pitch / 2; x < W; x += pitch) {
      const on = lit[(Math.floor(y) * W + Math.floor(x)) * 4 + 3] / 255;
      g.fillStyle = on > 0.4 ? '#c8fbff' : 'rgba(80, 170, 220, 0.22)';
      g.beginPath();
      g.arc(x, y, on > 0.4 ? 1.7 : 1.2, 0, Math.PI * 2);
      g.fill();
    }
  }
  // A rim, and the glass's shine across its top.
  g.strokeStyle = 'rgba(190, 240, 255, 0.85)';
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, W - 5, H - 5);
  const shine = g.createLinearGradient(0, 0, 0, H * 0.5);
  shine.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
  shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = shine;
  g.fillRect(4, 4, W - 8, H * 0.45);
}

export function AirshipBillboard({ ctx }: { ctx: ScreensaverContext }) {
  const board = useClockTexture(W, H, paintBoard);
  const parts = useDisposable(() => {
    const geometry = panelGeometry();
    // Lathe u runs round the envelope (up this flank) and v along it (towards the nose). Seen
    // from this side the nose is on the left, so the board reads from the nose back, and up.
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 1 - uv.getY(i), uv.getX(i));
    // Bright enough for the lit LEDs to bloom a little; the dark glass stays dark.
    const material = new THREE.MeshBasicMaterial({ map: board, color: new THREE.Color(1.7, 1.7, 1.7) });
    return { geometry, material };
  }, [board]);
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    m.visible = ctx.clock() === 'scene';
    if (m.visible) airshipMatrix(backdropClock.time, m.matrix);
  });
  return <mesh ref={mesh} geometry={parts.geometry} material={parts.material} matrixAutoUpdate={false} frustumCulled={false} />;
}
