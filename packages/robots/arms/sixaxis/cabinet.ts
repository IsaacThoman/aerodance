import * as THREE from 'three';
import { extrude, lathe, place, tube } from '../../shared/geometry.ts';
import type { Vec3 } from '../../../stages/catalog.ts';
import { decal } from './decals.ts';
import { TRACK } from './track.ts';
import { Parts, block, box, eyeBolt, hexBolt, puck, toX, toZ } from './kit.ts';

// The arm's controller, at the back of its station: a floor-standing cabinet (door to the table,
// main switch, operator panel, emergency stop, louvred vents), a three-tier stack light on a mast
// showing green while the rally runs, the teach pendant hung on its holder with its cable, and a
// floor duct taking the cables to the track's cable carrier. Station frame.

export const CABINET = { x: -2.74, z: -1.86, depth: 0.5, width: 0.72, height: 1.2, plinth: 0.1 } as const;

/** A red mushroom stop button along +Y on a face. */
function mushroom(p: Parts, at: Vec3, rotation: Vec3, size: number) {
  p.add('yellow', place(lathe([[0, 0], [size * 0.95, 0], [size * 0.95, size * 0.35], [size * 0.7, size * 0.45], [0, size * 0.45]], 28), { rotation, position: at }));
  p.add('red', place(lathe([[0, size * 0.4], [size * 0.42, size * 0.4], [size * 0.42, size * 0.7], [size * 0.75, size * 0.78], [size * 0.78, size * 0.95], [size * 0.6, size * 1.08], [0, size * 1.12]], 28), { rotation, position: at }));
}

export function cabinetParts(): Parts {
  const p = new Parts();
  const { x, z, depth: D, width: W, height: H, plinth } = CABINET;
  const front = x + D / 2;
  const yc = plinth + H / 2;
  p.add('black', box(D - 0.03, plinth, W - 0.03, 0.006, [x, plinth / 2, z]));
  p.add('graphite', box(D, H, W, 0.014, [x, yc, z], [0, 0, 0], 2));
  // A roof with a drip edge, lifting eyes at its corners.
  p.add('graphite', box(D + 0.02, 0.025, W + 0.02, 0.006, [x, plinth + H + 0.0125, z]));
  for (const [dx, dz] of [[-1, -1], [1, 1]]) p.add('steel', eyeBolt(0.03), { position: [x + dx * (D / 2 - 0.05), plinth + H + 0.025, z + dz * (W / 2 - 0.05)] });
  // The door: proud of the front, hinged on the left, a swing-handle lock on the right.
  p.add('graphite', box(0.022, H - 0.05, W - 0.05, 0.006, [front + 0.008, yc, z]));
  p.add('black', box(0.004, H - 0.04, W - 0.04, 0.002, [front + 0.0005, yc, z]));
  for (const y of [plinth + 0.15, plinth + H - 0.15]) p.add('black', place(puck(0.012, 0.09, 0.003, 14), { position: [front + 0.016, y, z - W / 2 + 0.02] }));
  p.add('black', box(0.012, 0.16, 0.05, 0.006, [front + 0.024, yc - 0.05, z + W / 2 - 0.06]));
  p.add('alu', box(0.022, 0.12, 0.02, 0.006, [front + 0.036, yc - 0.06, z + W / 2 - 0.06]));
  p.add('alu', place(puck(0.008, 0.01, 0.002, 12), { rotation: toX, position: [front + 0.031, yc + 0.045, z + W / 2 - 0.06] }));
  // The main switch, top right: a yellow plate and the red rotary handle.
  const sw: Vec3 = [front + 0.0195, plinth + H - 0.2, z + W / 2 - 0.13];
  p.add('decal', decal('mainSwitch', 0.13, { position: sw, rotation: [0, Math.PI / 2, 0] }));
  p.add('black', place(lathe([[0, 0], [0.04, 0], [0.04, 0.012], [0.032, 0.022], [0, 0.022]], 28), { rotation: toX, position: [sw[0], sw[1], sw[2]] }));
  p.add('red', box(0.03, 0.03, 0.11, 0.008, [sw[0] + 0.035, sw[1], sw[2]], [0.6, 0, 0]));
  // The operator panel with its display, mode switch, lit buttons and the emergency stop.
  const panel: Vec3 = [front + 0.0195, plinth + H - 0.42, z - 0.06];
  p.add('decal', decal('cabinetPanel', 0.34, { position: panel, rotation: [0, Math.PI / 2, 0] }));
  const buttons: [number, 'green' | 'alu' | 'blue' | 'black'][] = [[-0.12, 'alu'], [-0.07, 'alu'], [-0.02, 'alu'], [0.03, 'green'], [0.08, 'blue'], [0.13, 'black']];
  for (const [dz, mat] of buttons) {
    p.add('black', place(puck(0.016, 0.01, 0.002, 18), { rotation: toX, position: [panel[0] + 0.005, panel[1] - 0.04, panel[2] + dz * 0.95 - 0.0] }));
    p.add(mat, place(puck(0.011, 0.014, 0.003, 18), { rotation: toX, position: [panel[0] + 0.012, panel[1] - 0.04, panel[2] + dz * 0.95] }));
  }
  mushroom(p, [panel[0], panel[1] + 0.03, panel[2] - 0.1], [0, 0, -Math.PI / 2], 0.03);
  p.add('decal', decal('logoOrange', 0.3, { position: [front + 0.0195, plinth + H - 0.07, z - 0.06], rotation: [0, Math.PI / 2, 0] }));
  p.add('decal', decal('danger', 0.14, { position: [front + 0.0195, plinth + 0.55, z - 0.12], rotation: [0, Math.PI / 2, 0] }));
  p.add('decal', decal('shock', 0.08, { position: [front + 0.0195, plinth + 0.66, z + 0.12], rotation: [0, Math.PI / 2, 0] }));
  p.add('decal', decal('serialTag', 0.12, { position: [front + 0.0195, plinth + 0.12, z + 0.17], rotation: [0, Math.PI / 2, 0] }));
  // Louvred vents low on both sides, a fan guard high on the left.
  for (const s of [-1, 1]) {
    const face = z + s * (W / 2 + 0.0006);
    p.add('decal', decal('ventGrille', 0.26, { position: [x + 0.04, plinth + 0.28, face], rotation: [0, s > 0 ? 0 : Math.PI, 0] }));
    for (let i = 0; i < 9; i++) p.add('graphite', block(0.23, 0.007, 0.012, [x + 0.04, plinth + 0.2 + i * 0.019, face + s * 0.005], [s * 0.5, 0, 0]));
  }
  p.add('black', place(puck(0.075, 0.012, 0.003, 32), { rotation: toZ, position: [x - 0.05, plinth + H - 0.25, z - W / 2 - 0.006] }));
  for (let i = 0; i < 5; i++) p.add('alu', place(new THREE.TorusGeometry(0.015 + i * 0.014, 0.0018, 4, 24), { position: [x - 0.05, plinth + H - 0.25, z - W / 2 - 0.013] }));
  // Cable glands along the bottom of the front, the floor duct away to the track.
  for (let i = 0; i < 3; i++) p.add('black', place(lathe([[0, 0], [0.02, 0], [0.02, 0.012], [0.016, 0.03], [0, 0.03]], 18), { rotation: toX, position: [front + 0.002, plinth + 0.05, z + 0.12 + i * 0.06] }));
  // A rubber cable protector on the floor, ramped both sides, yellow lines along its top.
  const duct = (from: Vec3, to: Vec3) => {
    const len = Math.hypot(to[0] - from[0], to[2] - from[2]);
    const yaw = Math.atan2(to[0] - from[0], to[2] - from[2]);
    const ramp = new THREE.Shape();
    ramp.moveTo(-0.11, 0);
    for (const [x, y] of [[0.11, 0], [0.06, 0.028], [-0.06, 0.028]]) ramp.lineTo(x, y);
    const mid: Vec3 = [(from[0] + to[0]) / 2, 0, (from[2] + to[2]) / 2];
    p.add('rubber', place(extrude(ramp, len, 0, 1), { rotation: [0, yaw, 0], position: mid }));
    for (const dx of [-0.045, 0.045]) p.add('yellow', place(new THREE.BoxGeometry(0.012, 0.002, len - 0.01), { position: [dx, 0.0285, 0] }).rotateY(yaw).translate(mid[0], 0, mid[2]));
  };
  const dz = z + 0.18;
  duct([front - 0.04, 0, dz], [TRACK.chainX + 0.08, 0, dz]);
  duct([TRACK.chainX, 0, dz - 0.1], [TRACK.chainX, 0, -TRACK.half - 0.02]);
  for (const dx of [-0.03, 0, 0.03]) {
    p.add('sheath', tube([[front + 0.02, plinth + 0.05, z + 0.18 + dx * 2], [front + 0.07, 0.04, dz + dx], [front + 0.12, 0.03, dz + dx]], 0.012, 12, 8));
  }
  // The stack light on its mast: green lit (running), amber and red dark.
  const sx = x - D / 2 + 0.07;
  const sz = z + W / 2 - 0.07;
  let y = plinth + H + 0.025;
  p.add('black', lathe([[0, y], [0.035, y], [0.035, y + 0.012], [0.024, y + 0.03], [0, y + 0.03]], 24), { position: [sx, 0, sz] });
  y += 0.03;
  p.add('alu', lathe([[0, y], [0.011, y], [0.011, y + 0.3], [0, y + 0.3]], 16), { position: [sx, 0, sz] });
  y += 0.3;
  p.add('black', lathe([[0, y], [0.032, y], [0.032, y + 0.025], [0, y + 0.025]], 28), { position: [sx, 0, sz] });
  y += 0.025;
  for (const mat of ['green', 'amberLens', 'redLens'] as const) {
    p.add(mat, lathe([[0, y], [0.03, y], [0.031, y + 0.008], [0.031, y + 0.054], [0.03, y + 0.062], [0, y + 0.062]], 28), { position: [sx, 0, sz] });
    p.add('black', lathe([[0.031, y + 0.062], [0.033, y + 0.062], [0.033, y + 0.068], [0.031, y + 0.068]], 28), { position: [sx, 0, sz] });
    y += 0.068;
  }
  p.add('black', lathe([[0, y], [0.032, y], [0.032, y + 0.02], [0.022, y + 0.032], [0, y + 0.034]], 28), { position: [sx, 0, sz] });
  // The teach pendant on its holder on the right side, facing the arm, its cable looped below.
  const side = z + W / 2;
  const px = x + 0.06;
  const py = plinth + 0.86;
  p.add('black', box(0.16, 0.05, 0.03, 0.008, [px, py - 0.17, side + 0.015]));
  p.add('black', box(0.03, 0.06, 0.07, 0.006, [px - 0.07, py - 0.14, side + 0.035]));
  p.add('black', box(0.03, 0.06, 0.07, 0.006, [px + 0.07, py - 0.14, side + 0.035]));
  const pz = side + 0.065;
  p.add('graphite', box(0.26, 0.34, 0.045, 0.016, [px, py, pz], [0, 0, 0], 3));
  p.add('black', box(0.27, 0.06, 0.05, 0.016, [px, py + 0.155, pz], [0, 0, 0], 2));
  for (const s of [-1, 1]) p.add('black', box(0.03, 0.2, 0.055, 0.012, [px + s * 0.135, py - 0.03, pz - 0.005], [0, 0, 0], 2));
  p.add('screen', box(0.196, 0.136, 0.004, 0.002, [px, py + 0.055, pz + 0.0225]));
  p.add('decal', decal('pendantScreen', 0.186, { position: [px, py + 0.055, pz + 0.0249] }));
  p.add('decal', decal('pendantKeys', 0.09, { position: [px - 0.04, py - 0.1, pz + 0.0228] }));
  p.add('black', box(0.06, 0.05, 0.004, 0.002, [px + 0.06, py - 0.1, pz + 0.0228]));
  mushroom(p, [px + 0.09, py + 0.152, pz + 0.025], [Math.PI / 2, 0, 0], 0.017);
  p.add('decal', decal('stopRing', 0.034, { position: [px + 0.09, py + 0.152, pz + 0.0255] }));
  p.add('sheath', tube([[px, py - 0.17, pz], [px + 0.02, py - 0.3, pz + 0.04], [px + 0.06, plinth + 0.25, pz + 0.07], [px + 0.04, plinth + 0.12, pz + 0.05], [px - 0.06, plinth + 0.16, side + 0.04], [px - 0.1, plinth + 0.3, side + 0.01]], 0.007, 48, 8));
  p.add('black', place(lathe([[0, 0], [0.014, 0], [0.014, 0.01], [0.01, 0.02], [0, 0.02]], 14), { rotation: toZ, position: [px - 0.1, plinth + 0.3, side] }));
  // Its anchor bolts.
  for (const [dx, dzz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) p.add('oxide', hexBolt(0.016), { position: [x + dx * (D / 2 - 0.04), 0, z + dzz * (W / 2 + 0.03)] });
  return p;
}
