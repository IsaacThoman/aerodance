import * as THREE from 'three';
import { extrude, lathe, loft, place, roundedRectShape, tube } from '../../shared/geometry.ts';
import { decal } from './decals.ts';
import { DIM } from './kinematics.ts';
import { Parts, block, box, disc, eyeBolt, greaseNipple, heavyConnector, hexBolt, loftZ, motor, puck, screw, toNegX } from './kit.ts';

// The seventh axis: a floor-mounted linear track across the station, behind the end line. A
// welded steel beam on levelling feet, two profile rails on its machined top under way-cover
// bellows, a helical-look rack on its front face, end stops with polyurethane buffers, and a
// tray behind it for the cable carrier. The carriage rides four rail blocks; a servo and
// planetary gearbox on its front drive a pinion in the rack, a felt pinion oils the rack. The
// arm's base is bolted to the carriage's riser.

/** Half the beam's length, and where its end stops' faces are. */
export const TRACK = {
  half: 1.3,
  stop: 1.19,
  /** The carriage's half-length along the track. */
  carriage: 0.42,
  /** The cable carrier: its tray's x (station frame), fixed end, bend radius, pitch and length. */
  chainX: DIM.trackX - 0.39,
  chainFixed: 0,
  chainBend: 0.1,
  chainY: 0.03,
  chainPitch: 0.045,
  chainLinks: 22,
  /** The rails' tops. */
  railTop: 0.342,
  beamTop: 0.31,
} as const;

/** The track's fixed parts, in the station frame. */
export function trackParts(): Parts {
  const p = new Parts();
  const X = DIM.trackX;
  const L = TRACK.half;
  // Levelling feet, each side, anchored to the floor.
  for (const z of [-1.12, -0.38, 0.38, 1.12]) {
    for (const s of [-1, 1]) {
      p.add('graphite', box(0.12, 0.018, 0.19, 0.004, [X + s * 0.31, 0.009, z]));
      p.add('graphite', box(0.07, 0.1, 0.014, 0.003, [X + s * 0.285, 0.068, z]));
      for (const dz of [-0.065, 0.065]) p.add('oxide', hexBolt(0.02), { position: [X + s * 0.33, 0.018, z + dz] });
      p.add('steel', puck(0.012, 0.03, 0.002, 8), { position: [X + s * 0.31, 0.03, z] });
    }
  }
  // The beam: a welded box section with a machined top plate and T-slots down its sides.
  p.add('graphite', box(0.5, 0.26, 2 * L, 0.012, [X, 0.16, 0], [0, 0, 0], 2));
  p.add('graphite', box(0.54, 0.02, 2 * L, 0.004, [X, 0.3, 0]));
  for (const s of [-1, 1]) {
    for (const y of [0.1, 0.2]) p.add('black', box(0.006, 0.018, 2 * L - 0.04, 0.001, [X + s * 0.25, y, 0]));
    // End plates.
    p.add('graphite', box(0.52, 0.28, 0.018, 0.004, [X, 0.155, s * (L + 0.009)]));
    for (const [dx, y] of [[-0.2, 0.06], [0.2, 0.06], [-0.2, 0.25], [0.2, 0.25]]) p.add('oxide', screw(0.016, s > 0 ? 'z' : '-z', [X + dx, y, s * (L + 0.018)]));
  }
  // Two profile rails, their bolt holes plugged.
  const rail = new THREE.Shape();
  rail.moveTo(-0.0145, 0);
  for (const [x, y] of [[0.0145, 0], [0.0145, 0.014], [0.011, 0.017], [0.011, 0.02], [0.0145, 0.023], [0.0145, 0.032], [-0.0145, 0.032], [-0.0145, 0.023], [-0.011, 0.02], [-0.011, 0.017], [-0.0145, 0.014]]) rail.lineTo(x, y);
  for (const s of [-1, 1]) {
    p.add('steel', extrude(rail, 2 * L - 0.06, 0, 1), { position: [X + s * 0.19, 0.31, 0] });
  }
  // The rack on the front face: teeth facing out (+X), along Z.
  p.add('steel', rack(2 * L - 0.1), { position: [X + 0.25, 0.2225, 0] });
  p.add('steel', box(0.012, 0.012, 2 * L - 0.1, 0.002, [X + 0.256, 0.192, 0]));
  for (let i = 0; i < 13; i++) p.add('oxide', screw(0.011, 'x', [X + 0.262, 0.192, -L + 0.1 + i * ((2 * L - 0.2) / 12)]));
  // End stops: a bracket across the beam at each end, two buffers facing the carriage.
  for (const s of [-1, 1]) {
    const z = s * (TRACK.stop + 0.03);
    p.add('graphite', box(0.52, 0.19, 0.06, 0.008, [X, 0.405, z]));
    p.add('graphite', box(0.08, 0.1, 0.1, 0.006, [X - 0.2, 0.36, z + s * 0.05]));
    p.add('graphite', box(0.08, 0.1, 0.1, 0.006, [X + 0.2, 0.36, z + s * 0.05]));
    p.add('stripes', box(0.44, 0.07, 0.004, 0.001, [X, 0.455, z - s * 0.031]));
    for (const dx of [-0.14, 0.14]) {
      p.add('steel', disc(0.034, 0.008, s > 0 ? '-z' : 'z', [X + dx, 0.41, z - s * 0.034]));
      p.add('yellow', place(lathe([[0, 0], [0.028, 0], [0.028, 0.035], [0.024, 0.048], [0.012, 0.052], [0, 0.052]], 18), { rotation: s > 0 ? [-Math.PI / 2, 0, 0] : [Math.PI / 2, 0, 0], position: [X + dx, 0.41, z - s * 0.038] }));
    }
    for (const dx of [-0.21, -0.07, 0.07, 0.21]) p.add('oxide', hexBolt(0.016), { position: [X + dx, 0.5, z] });
  }
  // The cable carrier's tray behind the beam.
  const cx = TRACK.chainX;
  p.add('alu', box(0.18, 0.006, 2.06, 0.002, [cx, 0.003, -0.28]));
  for (const s of [-1, 1]) p.add('alu', box(0.006, 0.08, 2.06, 0.002, [cx + s * 0.087, 0.04, -0.28]));
  // The cables in the tray, from the cabinet's duct to the carrier's fixed end.
  for (const [dx, r] of [[-0.035, 0.014], [0, 0.017], [0.036, 0.012]] as const) {
    p.add('sheath', tube([[cx + dx, r + 0.006, -1.36], [cx + dx, r + 0.006, -0.8], [cx + dx * 0.7, r + 0.006, -0.2], [cx + dx * 0.5, 0.03, -0.03]], r, 24, 8));
  }
  // The carrier's fixed end bracket.
  p.add('graphite', box(0.15, 0.05, 0.06, 0.004, [cx, 0.03, TRACK.chainFixed - 0.035]));
  // Labels: the track's plate and the axis tag.
  p.add('decal', decal('track', 0.3, { position: [X + 0.2512, 0.1, -0.75], rotation: [0, Math.PI / 2, 0] }));
  p.add('decal', decal('crush', 0.06, { position: [X + 0.2511, 0.12, -0.6], rotation: [0, Math.PI / 2, 0] }));
  p.add('decal', decal('crush', 0.06, { position: [X + 0.2511, 0.12, 0.9], rotation: [0, Math.PI / 2, 0] }));
  return p;
}

/** A straight rack, `length` along Z, teeth towards +X from x = 0, centred in Y. */
function rack(length: number): THREE.BufferGeometry {
  const pitch = 0.0157;
  const n = Math.floor(length / pitch);
  const half = (n * pitch) / 2;
  const s = new THREE.Shape();
  // In the shape's plane: u along the rack (z), v out of the beam (x).
  s.moveTo(-half, 0);
  s.lineTo(half, 0);
  for (let i = n - 1; i >= 0; i--) {
    const u = -half + (i + 0.5) * pitch;
    s.lineTo(u + 0.5 * pitch, 0.02);
    s.lineTo(u + 0.26 * pitch, 0.02);
    s.lineTo(u + 0.12 * pitch, 0.031);
    s.lineTo(u - 0.12 * pitch, 0.031);
    s.lineTo(u - 0.26 * pitch, 0.02);
  }
  s.lineTo(-half, 0.02);
  const g = extrude(s, 0.04, 0, 1);
  // u → z, v → x, the extrusion → y.
  g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
  return g;
}

/** A spur pinion, along +Y, `teeth` teeth of module `m`, `width` thick. */
function pinion(teeth: number, m: number, width: number): THREE.BufferGeometry {
  const rp = (teeth * m) / 2;
  const ra = rp + m;
  const rf = rp - 1.25 * m;
  const s = new THREE.Shape();
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const t = (Math.PI * 2) / teeth;
    const pts: [number, number][] = [[rf, a - t * 0.5], [rf, a - t * 0.28], [ra, a - t * 0.12], [ra, a + t * 0.12], [rf, a + t * 0.28]];
    pts.forEach(([r, ang], k) => (i === 0 && k === 0 ? s.moveTo(r * Math.cos(ang), r * Math.sin(ang)) : s.lineTo(r * Math.cos(ang), r * Math.sin(ang))));
  }
  s.closePath();
  return place(extrude(s, width, 0, 1), { rotation: [-Math.PI / 2, 0, 0] });
}

/** The carriage and the arm's base, in the carriage frame: on the track's axis at the floor. */
export function carriageParts(): Parts {
  const p = new Parts();
  const C = TRACK.carriage;
  // Four rail blocks with their end seals and grease points.
  for (const x of [-0.19, 0.19]) {
    for (const z of [-0.27, 0.27]) {
      p.add('steel', box(0.078, 0.034, 0.13, 0.004, [x, 0.358, z]));
      p.add('graphite', box(0.07, 0.03, 0.012, 0.003, [x, 0.356, z - 0.071]));
      p.add('graphite', box(0.07, 0.03, 0.012, 0.003, [x, 0.356, z + 0.071]));
      p.add('rubber', box(0.066, 0.028, 0.006, 0.002, [x, 0.355, z - 0.08]));
      p.add('rubber', box(0.066, 0.028, 0.006, 0.002, [x, 0.355, z + 0.08]));
      p.add('brass', greaseNipple(0.01), { position: [x, 0.36, z + Math.sign(z) * 0.083], rotation: [Math.sign(z) * Math.PI / 2, 0, 0] });
    }
  }
  // The plate, a riser for the arm, strikers for the end stops' buffers.
  p.add('graphite', box(0.62, 0.065, 2 * C, 0.01, [0, 0.4075, 0], [0, 0, 0], 2));
  p.add('graphite', loft([
    { y: 0.44, w: 0.56, d: 0.56, r: 0.05 },
    { y: 0.48, w: 0.545, d: 0.545, r: 0.045 },
    { y: 0.5, w: 0.54, d: 0.54, r: 0.044 },
  ], 4));
  for (const s of [-1, 1]) {
    for (const x of [-0.14, 0.14]) p.add('steel', box(0.07, 0.045, 0.03, 0.004, [x, 0.41, s * (C + 0.012)]));
    // The way covers' end frames.
    p.add('black', box(0.54, 0.072, 0.012, 0.003, [0, 0.346, s * (C - 0.004)]));
    for (const x of [-0.27, -0.09, 0.09, 0.27]) p.add('oxide', screw(0.012, s > 0 ? 'z' : '-z', [x, 0.42, s * C]));
  }
  for (const [x, z] of [[-0.24, -0.34], [0.24, -0.34], [-0.24, 0.34], [0.24, 0.34], [-0.24, 0], [0.24, 0]]) p.add('oxide', screw(0.02, 'y', [x, 0.44, z]));
  // The drive: pinion, planetary gearbox, bracket, servo, standing on the carriage's front.
  const dx = 0.314;
  const dz = 0.345;
  p.add('steel', pinion(16, 0.005, 0.038), { position: [dx, 0.2225, dz] });
  p.add('steel', puck(0.016, 0.03, 0.003, 12), { position: [dx, 0.255, dz] });
  p.add('alu', lathe([[0, 0.268], [0.05, 0.268], [0.052, 0.272], [0.052, 0.36], [0.058, 0.365], [0.058, 0.392], [0, 0.392]], 28), { position: [dx, 0, dz] });
  p.add('graphite', box(0.14, 0.022, 0.16, 0.005, [dx + 0.005, 0.403, dz]));
  p.include(motor({ size: 0.1, length: 0.25, box: Math.PI / 2 }), { position: [dx, 0.414, dz] });
  p.add('decal', decal('axisE1', 0.075, { position: [0.3105, 0.405, 0], rotation: [0, Math.PI / 2, 0] }));
  // The felt lubricating pinion and its grease cartridge, at the other end of the front.
  p.add('graphite', box(0.07, 0.012, 0.08, 0.003, [0.3, 0.37, -0.34]));
  p.add('graphite', box(0.012, 0.13, 0.05, 0.003, [0.33, 0.31, -0.34]));
  p.add('felt', pinion(12, 0.005, 0.03), { position: [0.307, 0.2225, -0.34] });
  p.add('white', lathe([[0, 0], [0.022, 0], [0.022, 0.09], [0.016, 0.1], [0, 0.1]], 16), { position: [0.36, 0.25, -0.34] });
  p.add('red', puck(0.017, 0.012, 0.002, 12), { position: [0.36, 0.355, -0.34] });
  // The cable carrier's moving end: a bracket down from the carriage's back.
  p.add('graphite', box(0.1, 0.014, 0.13, 0.004, [-0.345, 0.37, 0]));
  p.add('graphite', box(0.014, 0.15, 0.13, 0.004, [-0.39, 0.3, 0]));
  return p;
}

/** The arm's base (the fixed half of J1), in its own frame: the mounting face at y = 0. */
export function baseParts(): Parts {
  const p = new Parts();
  // The foot, bolted down at its corners.
  p.add('graphite', box(0.56, 0.042, 0.56, 0.035, [0, 0.021, 0]));
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) p.add('oxide', hexBolt(0.024), { position: [x * 0.235, 0.042, z * 0.235] });
  // A cast body, square at the foot, round at the J1 bearing.
  p.add('graphite', loft([
    { y: 0.04, w: 0.5, d: 0.5, r: 0.09 },
    { y: 0.06, w: 0.49, d: 0.49, r: 0.1 },
    { y: 0.13, w: 0.468, d: 0.468, r: 0.13 },
    { y: 0.19, w: 0.452, d: 0.452, r: 0.2 },
    { y: 0.225, w: 0.45, d: 0.45, r: 0.225 },
    { y: 0.24, w: 0.45, d: 0.45, r: 0.225 },
  ], 8));
  // The J1 bearing: a machined ring and its seal.
  p.add('alu', lathe([[0.222, 0.238], [0.231, 0.24], [0.231, 0.25], [0.226, 0.253]], 48));
  p.add('rubber', lathe([[0.226, 0.25], [0.24, 0.252], [0.24, 0.258], [0.226, 0.258]], 48));
  // Lifting eyes on the sides.
  for (const s of [-1, 1]) {
    p.add('graphite', box(0.07, 0.06, 0.02, 0.006, [0.05, 0.13, s * 0.233]));
    p.add('steel', eyeBolt(0.032), { position: [0.05, 0.13, s * 0.243], rotation: [s * Math.PI / 2, 0, 0] });
  }

  // The connector panel at the back.
  p.add('graphite', box(0.032, 0.15, 0.32, 0.006, [-0.243, 0.12, 0]));
  for (const z of [-0.08, 0.08]) p.include(heavyConnector(0.085), { position: [-0.259, 0.125, z], rotation: toNegX });
  p.add('alu', hexBolt(0.014), { position: [-0.259, 0.07, 0.138], rotation: toNegX });
  p.add('decal', decal('cableTag', 0.1, { position: [-0.2595, 0.065, -0.07], rotation: [0, -Math.PI / 2, 0] }));
  // Plates on the body's drafted faces (they lean in DRAFT as they rise): the rating plate on the
  // right, the model on the left, the maker's mark on the front.
  const DRAFT = 0.157;
  const face = (y: number) => 0.245 - DRAFT * (y - 0.06) + 0.0006;
  const onFace = (g: THREE.BufferGeometry, side: 'x' | 'z' | '-z', along: number, y: number) => {
    if (side === 'x') g.rotateY(Math.PI / 2).rotateZ(DRAFT).translate(face(y), y, along);
    else if (side === 'z') g.rotateX(-DRAFT).translate(along, y, face(y));
    else g.rotateY(Math.PI).rotateX(DRAFT).translate(along, y, -face(y));
    return g;
  };
  p.add('decal', onFace(decal('rating', 0.17), 'z', -0.03, 0.1));
  p.add('decal', onFace(decal('modelWhite', 0.15), '-z', -0.04, 0.09));
  p.add('decal', onFace(decal('logoOrange', 0.22), 'x', 0, 0.105));
  p.add('decal', onFace(decal('lift', 0.024), 'z', 0.1, 0.13));
  p.add('decal', onFace(decal('lift', 0.024), '-z', 0.1, 0.13));
  return p;
}

/** The cables from the cable carrier's moving end up into the base's connectors (carriage frame). */
export function carriageCables(): Parts {
  const p = new Parts();
  const y0 = DIM.mountY;
  for (const [z, r, lift] of [[-0.08, 0.016, 0], [0.08, 0.014, 0.01]] as const) {
    p.add('sheath', tube([[-0.39, 0.24, z * 0.3], [-0.42, 0.3, z * 0.6], [-0.43, 0.42, z], [-0.38, y0 + 0.14 + lift, z], [-0.33, y0 + 0.2, z], [-0.29, y0 + 0.125 + 0.1, z]], r, 36, 10));
  }
  return p;
}

/** One cable-carrier link, along +Z, centred: two side plates, two crossbars and the pins. */
export function chainLinkGeometry(): THREE.BufferGeometry {
  const p = new Parts();
  const pitch = TRACK.chainPitch;
  for (const s of [-1, 1]) {
    p.add('plastic', extrude(roundedRectShape(pitch * 1.12, 0.036, 0.014), 0.008, 0, 3), { position: [s * 0.062, 0, 0], rotation: [0, Math.PI / 2, 0] });
    p.add('plastic', puck(0.0075, 0.012, 0.001, 8), { position: [s * 0.068, 0, pitch / 2], rotation: [0, 0, Math.PI / 2] });
  }
  for (const y of [-0.0155, 0.0155]) p.add('plastic', block(0.124, 0.006, 0.014, [0, y, 0]));
  return p.build().palette as THREE.BufferGeometry;
}

/** A way-cover bellows over both rails, one unit long along +Z (scaled to its gap). */
export function bellowsGeometry(): THREE.BufferGeometry {
  const pleats = 30;
  const sections = [];
  for (let i = 0; i <= pleats * 2; i++) {
    const crest = i % 2 === 1;
    const w = crest ? 0.54 : 0.505;
    const h = crest ? 0.062 : 0.05;
    sections.push({ z: i / (pleats * 2), w, h, r: 0.006, y: TRACK.beamTop + h / 2 });
  }
  return new Parts().add('rubber', loftZ(sections, 1)).build().palette as THREE.BufferGeometry;
}

