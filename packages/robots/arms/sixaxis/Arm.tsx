import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import * as THREE from 'three';
import { Paddle } from '../../shared/Paddle.tsx';
import type { ArmProps } from '../../shared/arm.ts';
import { useRobotFrame } from '../../shared/clock.ts';
import type { StationDriver } from '../../shared/station.ts';
import { makeTarget } from '../../shared/rally.ts';
import type { Vec3 } from '../../../stages/catalog.ts';
import { CableBundle } from './CableBundle.tsx';
import type { CableRun } from './CableBundle.tsx';
import { cabinetParts } from './cabinet.ts';
import { DIM, makePose, paddleInFlange, solve } from './kinematics.ts';
import type { Pose } from './kinematics.ts';
import type { Baked } from './kit.ts';
import {
  BALANCER, DRESS, GRIPPER_PORTS, HOSE_DIR, balancerBodyParts, balancerRodParts, flangeParts, gripperParts, housingParts,
  tubeParts, turretParts, upperArmParts, wristParts,
} from './links.ts';
import { armMaterials } from './materials.ts';
import { TRACK, baseParts, bellowsGeometry, carriageCables, carriageParts, chainLinkGeometry, trackParts } from './track.ts';

// The hero of the centre table: a heavy six-axis articulated arm (the made-up Torven TR-30/1.9,
// 30 kg class, 1.9 m reach) on a floor track across its station, a seventh axis. Each frame the
// carriage takes a smoothed, anticipating share of the paddle's movement across the table (a
// kernel average of the target over the moment, so a paused or jumped clock poses it the same),
// and the arm solves in closed form for the rest (kinematics.ts): J1–J3 put the wrist centre
// where the paddle needs it, J4–J6 turn the paddle onto the target's face.

/** Draws a link's baked meshes. */
function Link({ baked }: { baked: Baked }) {
  const materials = armMaterials();
  return (
    <>
      {baked.painted && <mesh geometry={baked.painted} material={materials.painted} castShadow receiveShadow />}
      {baked.palette && <mesh geometry={baked.palette} material={materials.palette} castShadow receiveShadow />}
      {baked.stripes && <mesh geometry={baked.stripes} material={materials.stripes} castShadow receiveShadow />}
    </>
  );
}

function buildAll() {
  return {
    // The track and the cabinet don't move: one link.
    still: trackParts().include(cabinetParts()).build(),
    carriage: carriageParts().include(baseParts(), { position: [0, DIM.mountY, 0] }).include(carriageCables()).build(),
    turret: turretParts().build(),
    upper: upperArmParts().build(),
    housing: housingParts().build(),
    tube: tubeParts().build(),
    wrist: wristParts().build(),
    tool: flangeParts().include(gripperParts(), new THREE.Matrix4().makeTranslation(DIM.d6, 0, 0).multiply(paddleInFlange())).build(),
    balancerBody: balancerBodyParts().build(),
    balancerRod: balancerRodParts().build(),
    bellows: bellowsGeometry(),
    chainLink: chainLinkGeometry(),
  };
}

// The carriage's place on the track: a share of the paddle target's z, averaged by a Gaussian
// kernel over samples on a fixed grid of times (cached), so it glides ahead of each stroke
// instead of jerking with it, and is the same whenever the clock lands on the same time.
const GRID_S = 0.05;
const SIGMA_S = 0.17;
const FOLLOW = 0.8;

class CarriagePlanner {
  private readonly cache = new Map<number, number>();
  private readonly scratch = makeTarget();
  private readonly driver: StationDriver;

  constructor(driver: StationDriver) {
    this.driver = driver;
  }

  private zAt(k: number): number {
    let z = this.cache.get(k);
    if (z === undefined) {
      z = this.driver.sample(k * GRID_S, this.scratch).position.z;
      this.cache.set(k, z);
      if (this.cache.size > 400) {
        for (const key of this.cache.keys()) {
          if (Math.abs(key - k) > 40) this.cache.delete(key);
        }
      }
    }
    return z;
  }

  at(t: number): number {
    const span = Math.ceil((SIGMA_S * 3) / GRID_S);
    const centre = Math.round(t / GRID_S);
    let sum = 0;
    let weight = 0;
    for (let k = centre - span; k <= centre + span; k++) {
      const d = (k * GRID_S - t) / SIGMA_S;
      const w = Math.exp(-0.5 * d * d);
      sum += w * this.zAt(k);
      weight += w;
    }
    // Soft limits short of the end stops.
    const z = (FOLLOW * sum) / weight;
    return DIM.travel * Math.tanh(z / DIM.travel);
  }
}

// The paddle's frame in the J6 frame: past the flange face, the wedge and the gripper.
const TOOL = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
paddleInFlange().premultiply(new THREE.Matrix4().makeTranslation(DIM.d6, 0, 0)).decompose(TOOL.position, TOOL.quaternion, new THREE.Vector3());

// placeChain's scratch, as it runs every frame.
const _chainTangent = new THREE.Vector3();
const _chainNormal = new THREE.Vector3();
const _chainX = new THREE.Vector3(1, 0, 0);
const _chainAt = new THREE.Vector3();

/** Where each link of the chain goes, its pivot pitch apart along the carrier's path. */
function placeChain(mesh: THREE.InstancedMesh, moving: number, m: THREE.Matrix4) {
  const { chainFixed: F, chainBend: R, chainY: y0, chainPitch: pitch, chainLinks: n, chainX: x } = TRACK;
  const length = n * pitch;
  // The bend's apex: the lower run from the fixed end, the upper back to the moving end.
  const straight = length - Math.PI * R;
  const B = (F + moving + straight) / 2;
  const L1 = B - F;
  const t = _chainTangent, nIn = _chainNormal, xAxis = _chainX, p = _chainAt;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * pitch;
    if (s < L1) {
      p.set(x, y0, F + s);
      t.set(0, 0, 1);
      nIn.set(0, 1, 0);
    } else if (s < L1 + Math.PI * R) {
      const phi = -Math.PI / 2 + (s - L1) / R;
      p.set(x, y0 + R + R * Math.sin(phi), B + R * Math.cos(phi));
      t.set(0, Math.cos(phi), -Math.sin(phi));
      nIn.set(0, -Math.sin(phi), -Math.cos(phi));
    } else {
      p.set(x, y0 + 2 * R, B - (s - L1 - Math.PI * R));
      t.set(0, 0, -1);
      nIn.set(0, -1, 0);
    }
    m.makeBasis(xAxis, nIn, t).setPosition(p);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * The arm. `trackAt`, if given, places the carriage on the track each frame instead of the
 * planner (which looks ahead along the rally's scripted targets): for a host whose paddle target
 * isn't known ahead, such as Table Tennis's opponent.
 */
export default function Arm({ driver, trackAt }: ArmProps & { trackAt?: (time: number, delta: number) => number }) {
  const geo = useMemo(buildAll, []);
  useEffect(() => () => {
    for (const parts of Object.values(geo)) {
      if (parts instanceof THREE.BufferGeometry) parts.dispose();
      else for (const g of Object.values(parts)) (g as THREE.BufferGeometry | undefined)?.dispose();
    }
  }, [geo]);
  const materials = armMaterials();
  const planner = useMemo(() => new CarriagePlanner(driver), [driver]);
  const state = useMemo(() => ({ pose: makePose(), prev: null as Pose | null, m: new THREE.Matrix4() }), []);

  const carriage = useRef<THREE.Group>(null);
  const j1 = useRef<THREE.Group>(null);
  const j2 = useRef<THREE.Group>(null);
  const j3 = useRef<THREE.Group>(null);
  const j4 = useRef<THREE.Group>(null);
  const j5 = useRef<THREE.Group>(null);
  const j6 = useRef<THREE.Group>(null);
  const balBody = useRef<THREE.Group>(null);
  const balRod = useRef<THREE.Group>(null);
  const bellowsNeg = useRef<THREE.Mesh>(null);
  const bellowsPos = useRef<THREE.Mesh>(null);
  const chain = useRef<THREE.InstancedMesh>(null);

  useRobotFrame((time, delta) => {
    const track = trackAt ? trackAt(time, delta) : planner.at(time);
    const { pose } = state;
    solve(driver.target, track, pose, state.prev ?? undefined);
    state.prev ??= makePose();
    state.prev.track = pose.track;
    for (let i = 0; i < 6; i++) state.prev.q[i] = pose.q[i];
    const [q1, q2, q3, q4, q5, q6] = pose.q;
    if (!carriage.current || !j1.current || !j2.current || !j3.current || !j4.current || !j5.current || !j6.current) return;
    carriage.current.position.z = track;
    j1.current.rotation.y = q1;
    j2.current.rotation.z = -q2;
    j3.current.rotation.z = -q3;
    j4.current.rotation.x = q4;
    j5.current.rotation.z = q5;
    j6.current.rotation.x = q6;
    // The balancer: its cylinder pivots on the turret and its rod on the upper arm's pin.
    const [ax, ay] = BALANCER.pivot;
    const bx = DIM.a1 + BALANCER.pin * Math.sin(q2);
    const by = DIM.h1 + BALANCER.pin * Math.cos(q2);
    if (balBody.current && balRod.current) {
      balBody.current.rotation.z = -Math.atan2(bx - ax, by - ay);
      balRod.current.position.set(bx, by, BALANCER.z);
      balRod.current.rotation.z = -Math.atan2(ax - bx, ay - by);
    }
    // The way covers stretch and fold between the carriage and the end stops.
    const c = TRACK.carriage - 0.01;
    if (bellowsNeg.current && bellowsPos.current) {
      bellowsNeg.current.position.z = -TRACK.stop;
      bellowsNeg.current.scale.z = Math.max(0.01, track - c + TRACK.stop);
      bellowsPos.current.position.z = track + c;
      bellowsPos.current.scale.z = Math.max(0.01, TRACK.stop - track - c);
    }
    if (chain.current) placeChain(chain.current, track, state.m);
  });

  // Anchors for the dress pack, on the links, and its runs between them.
  const a = {
    turret: useRef<THREE.Object3D>(null), upperLow: useRef<THREE.Object3D>(null), upperHigh: useRef<THREE.Object3D>(null),
    housingRear: useRef<THREE.Object3D>(null), housingFront: useRef<THREE.Object3D>(null), tube: useRef<THREE.Object3D>(null),
    junction: useRef<THREE.Object3D>(null), j0: useRef<THREE.Object3D>(null), j1: useRef<THREE.Object3D>(null), j2: useRef<THREE.Object3D>(null),
    air0: useRef<THREE.Object3D>(null), air1: useRef<THREE.Object3D>(null), sensor: useRef<THREE.Object3D>(null),
  };
  const runs = useMemo<CableRun[]>(() => {
    const conduit = { radius: 0.018, finish: 'conduit', ribs: 130, radial: 12 } as const;
    const out: THREE.Vector3Tuple = [1, 0, 0];
    return [
      { ...conduit, from: a.turret, to: a.upperLow, fromDir: DRESS.turret.dir, toDir: DRESS.upperLow.dir, stiffness: 0.5, sag: 0.03 },
      { ...conduit, from: a.upperLow, to: a.upperHigh, fromDir: DRESS.upperLow.dir, toDir: DRESS.upperHigh.dir, stiffness: 0.33, sag: 0, segments: 8 },
      { ...conduit, from: a.upperHigh, to: a.housingRear, fromDir: DRESS.upperHigh.dir, toDir: DRESS.housingRear.dir, stiffness: 0.55, sag: 0.02 },
      { ...conduit, from: a.housingRear, to: a.housingFront, fromDir: DRESS.housingRear.dir, toDir: DRESS.housingFront.dir, stiffness: 0.33, sag: 0, segments: 8 },
      { ...conduit, from: a.housingFront, to: a.tube, fromDir: DRESS.housingFront.dir, toDir: DRESS.tube.dir, stiffness: 0.4, sag: 0.01, segments: 16 },
      { ...conduit, from: a.tube, to: a.junction, fromDir: DRESS.tube.dir, toDir: DRESS.junctionIn.dir, stiffness: 0.4, sag: 0, segments: 10 },
      { from: a.j0, to: a.air0, fromDir: out, toDir: HOSE_DIR, radius: 0.004, finish: 'blue', stiffness: 0.45, sag: 0.02, radial: 6 },
      { from: a.j1, to: a.air1, fromDir: out, toDir: HOSE_DIR, radius: 0.004, finish: 'sheath', stiffness: 0.45, sag: 0.02, radial: 6 },
      { from: a.j2, to: a.sensor, fromDir: out, toDir: HOSE_DIR, radius: 0.0025, finish: 'grey', stiffness: 0.45, sag: 0.025, radial: 5 },
    ];
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- the anchors' refs are stable
  const anchor = (ref: RefObject<THREE.Object3D | null>, at: Vec3) => <object3D ref={ref} position={at} />;

  return (
    <>
      <Link baked={geo.still} />
      <mesh ref={bellowsNeg} geometry={geo.bellows} material={materials.palette} position={[DIM.trackX, 0, 0]} castShadow receiveShadow />
      <mesh ref={bellowsPos} geometry={geo.bellows} material={materials.palette} position={[DIM.trackX, 0, 0]} castShadow receiveShadow />
      <instancedMesh ref={chain} args={[geo.chainLink, materials.palette, TRACK.chainLinks]} castShadow receiveShadow frustumCulled={false} />
      <group ref={carriage} position={[DIM.trackX, 0, 0]}>
        <Link baked={geo.carriage} />
        <group ref={j1} position={[0, DIM.mountY, 0]}>
          <Link baked={geo.turret} />
          {anchor(a.turret, DRESS.turret.at)}
          <group ref={balBody} position={[BALANCER.pivot[0], BALANCER.pivot[1], BALANCER.z]}>
            <Link baked={geo.balancerBody} />
          </group>
          <group ref={balRod}>
            <Link baked={geo.balancerRod} />
          </group>
          <group ref={j2} position={[DIM.a1, DIM.h1, 0]}>
            <Link baked={geo.upper} />
            {anchor(a.upperLow, DRESS.upperLow.at)}
            {anchor(a.upperHigh, DRESS.upperHigh.at)}
            <group ref={j3} position={[0, DIM.a2, 0]}>
              <Link baked={geo.housing} />
              {anchor(a.housingRear, DRESS.housingRear.at)}
              {anchor(a.housingFront, DRESS.housingFront.at)}
              <group ref={j4} position={[0, DIM.a3, 0]}>
                <Link baked={geo.tube} />
                {anchor(a.tube, DRESS.tube.at)}
                {anchor(a.junction, DRESS.junctionIn.at)}
                {anchor(a.j0, DRESS.junction[0])}
                {anchor(a.j1, DRESS.junction[1])}
                {anchor(a.j2, DRESS.junction[2])}
                <group ref={j5} position={[DIM.d4, 0, 0]}>
                  <Link baked={geo.wrist} />
                  <group ref={j6}>
                    <Link baked={geo.tool} />
                    <group position={TOOL.position} quaternion={TOOL.quaternion}>
                      {anchor(a.air0, GRIPPER_PORTS.air[0])}
                      {anchor(a.air1, GRIPPER_PORTS.air[1])}
                      {anchor(a.sensor, GRIPPER_PORTS.sensor)}
                      <Paddle driver={driver} />
                    </group>
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
      <CableBundle runs={runs} material={materials.cable} />
    </>
  );
}
