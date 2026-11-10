import type { Vec3 } from '../stages/catalog.ts';

// The robot hall, in metres: plain data, no rendering code. World axes: +Y up, the hall's long
// side along X, the visitors' aisle along its south (+Z) wall. Three table cells stand in a row
// across the hall, each table's length running north–south, with a different arm at each end.

/** The six arms, one per kinematic family. */
export type ArmId = 'sixaxis' | 'cobot' | 'scara' | 'polar' | 'delta' | 'gantry';

export interface ArmMeta {
  id: ArmId;
  /** A short display name. */
  name: string;
  /** What it is, in a line. */
  kind: string;
}

export const ARM_METAS: readonly ArmMeta[] = [
  { id: 'sixaxis', name: 'Six-axis', kind: 'Heavy six-axis articulated arm on a floor track' },
  { id: 'cobot', name: 'Cobot', kind: 'Seven-axis collaborative arm' },
  { id: 'scara', name: 'SCARA', kind: 'SCARA arm with a tilting wrist' },
  { id: 'polar', name: 'Polar', kind: 'Polar arm with a telescoping boom' },
  { id: 'delta', name: 'Delta', kind: 'Ceiling-hung delta robot with a wrist' },
  { id: 'gantry', name: 'Gantry', kind: 'Overhead Cartesian gantry with a wrist' },
];

export const isArmId = (id: unknown): id is ArmId => ARM_METAS.some((arm) => arm.id === id);

/** A regulation table tennis table, in metres. */
export const TABLE = {
  length: 2.74,
  width: 1.525,
  /** The playing surface above the floor. */
  height: 0.76,
  top: 0.025,
  netHeight: 0.1525,
  /** How far the net's posts stand out past each side line. */
  netOverhang: 0.1525,
} as const;

export const BALL_RADIUS = 0.02;

/**
 * The paddle, in its own frame: the origin at the middle of the blade's hitting area (halfway
 * through its thickness), +Z out of the red face, +Y towards the blade's tip, the handle down -Y.
 */
export const PADDLE = {
  bladeWidth: 0.152,
  bladeHeight: 0.158,
  /** The blade's centre sits this far above the hitting-area origin (the area is a little low). */
  bladeLift: 0.004,
  /** Wood plus both rubbers: each face is half of this from the origin. */
  thickness: 0.01,
  /** Where the handle leaves the blade, and its butt end, along -Y. */
  handleTop: -0.062,
  handleEnd: -0.175,
  handleWidth: 0.03,
  handleDepth: 0.024,
} as const;

/** Which end of a table: A is the north (far from the aisle), B the south. */
export type End = 'A' | 'B';

export interface TableSpec {
  id: string;
  /** The floor under the table's centre. */
  center: Vec3;
  /** The arm at each end. */
  arms: Record<End, ArmId>;
  /** Seeds its rally. */
  seed: number;
  /** Rally pace: >1 is quicker. */
  pace: number;
}

const TABLE_Z = -3;

export const TABLES: readonly TableSpec[] = [
  { id: 'west', center: [-15, 0, TABLE_Z], arms: { A: 'scara', B: 'polar' }, seed: 11, pace: 0.95 },
  { id: 'centre', center: [0, 0, TABLE_Z], arms: { A: 'sixaxis', B: 'cobot' }, seed: 23, pace: 1 },
  { id: 'east', center: [15, 0, TABLE_Z], arms: { A: 'gantry', B: 'delta' }, seed: 37, pace: 1.08 },
];

/**
 * Where an arm stands. Its frame (the space every arm component is drawn in): the origin on the
 * floor under the middle of its end of the table, +X along the table towards the net and the
 * opponent, +Y up, +Z to the arm's right as it faces the table. The table's top is at
 * y = TABLE.height and spans x 0..TABLE.length, z ±TABLE.width / 2.
 */
export interface StationSpec {
  arm: ArmId;
  table: TableSpec;
  end: End;
  /** The frame's origin in the world. */
  position: Vec3;
  /** The frame's rotation about +Y in the world, in radians. */
  yaw: number;
}

export const STATIONS: readonly StationSpec[] = TABLES.flatMap((table): StationSpec[] => {
  const [x, , z] = table.center;
  const half = TABLE.length / 2;
  return [
    // A's +X points south (+Z), B's north (-Z): rotation.y = -90° and +90°.
    { arm: table.arms.A, table, end: 'A', position: [x, 0, z - half], yaw: -Math.PI / 2 },
    { arm: table.arms.B, table, end: 'B', position: [x, 0, z + half], yaw: Math.PI / 2 },
  ];
});

export const stationOf = (arm: ArmId): StationSpec => {
  const station = STATIONS.find((s) => s.arm === arm);
  if (!station) throw Error(`No station for arm "${arm}"`);
  return station;
};

/**
 * The room each arm has, in its station frame: everything an arm brings (base, track, frame,
 * controller cabinet, cables, stack light) stays inside it. Its x runs from `back` behind the end
 * line to `front`, a little over the table.
 */
export const STATION_BOX = { back: -3.1, front: 0.35, side: 2.9, height: 4.2 } as const;

/**
 * Where the ball is struck, in the station frame: its centre at contact, every time. The paddle
 * itself also swings back and follows through round it (PADDLE_ENVELOPE).
 */
export const HIT_ZONE = { x: [-0.4, -0.08], y: [0.93, 1.24], z: [-0.52, 0.52] } as const;

/** Every place the paddle's centre goes, in the station frame, swings included. */
export const PADDLE_ENVELOPE = { x: [-0.85, 0.25], y: [0.8, 1.5], z: [-0.75, 0.75] } as const;

/** Where the paddle waits between shots, in the station frame (its face towards the net). */
export const READY: Vec3 = [-0.42, 1.06, 0];

/** One table's cell on the floor, in world coordinates, for the hall's fences and markings. */
export interface CellSpec {
  table: TableSpec;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const CELLS: readonly CellSpec[] = TABLES.map((table) => {
  const [x, , z] = table.center;
  const half = TABLE.length / 2 - STATION_BOX.back;
  return { table, minX: x - STATION_BOX.side - 0.3, maxX: x + STATION_BOX.side + 0.3, minZ: z - half - 0.3, maxZ: z + half + 0.3 };
});

/** The hall's inside, in world coordinates. */
export const HALL = { minX: -27, maxX: 27, minZ: -16, maxZ: 15, height: 12 } as const;

/** Where a visitor comes in: the middle of the aisle, looking at the centre table. */
export const SPAWN = { position: [0, 1.65, 11] as Vec3, target: [0, 1.15, -3] as Vec3 } as const;
