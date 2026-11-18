import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import * as THREE from 'three';
import { useRobotFrame } from '../../shared/clock.ts';
import { swatchUV } from './palette.ts';
import type { SwatchName } from './palette.ts';

// Every flexible line on the arm in one mesh: the dress pack's corrugated conduit, joint by joint,
// and the air lines and sensor cable to the gripper. Each run is a curve (a
// cubic Bézier out of each anchor along its direction, sagging a little, framed by parallel
// transport), but they're all written into one buffer and coloured from the swatch atlas, so the
// whole dress pack is a single draw call.

export interface CableRun {
  from: RefObject<THREE.Object3D | null>;
  to: RefObject<THREE.Object3D | null>;
  /** Each end leaves along its anchor's local direction. */
  fromDir: THREE.Vector3Tuple;
  toDir: THREE.Vector3Tuple;
  radius: number;
  finish: SwatchName;
  /** How far it bows out of each end, as a share of the gap. */
  stiffness?: number;
  sag?: number;
  segments?: number;
  radial?: number;
  /** Corrugation ribs a metre (0: a smooth hose). */
  ribs?: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _da = new THREE.Vector3();
const _db = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _bn = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _axis = new THREE.Vector3();
// The corrugation texture has four ribs a tile.
const RIBS_PER_TILE = 4;

export function CableBundle({ runs, material }: { runs: readonly CableRun[]; material: THREE.Material }) {
  const mesh = useRef<THREE.Mesh>(null);
  const built = useMemo(() => {
    const offsets: number[] = [];
    let count = 0;
    const index: number[] = [];
    const uv1: number[] = [];
    const uv: number[] = [];
    for (const run of runs) {
      const seg = run.segments ?? 24;
      const rad = run.radial ?? 10;
      offsets.push(count);
      const [u, v] = swatchUV(run.finish);
      for (let j = 0; j <= seg; j++) {
        for (let i = 0; i <= rad; i++) {
          uv1.push(u, v);
          uv.push(i / rad, 0);
          if (j < seg && i < rad) {
            const a = count + j * (rad + 1) + i;
            const b = a + rad + 1;
            index.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
      }
      count += (seg + 1) * (rad + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const dirs = runs.map((r) => [new THREE.Vector3(...r.fromDir).normalize(), new THREE.Vector3(...r.toDir).normalize()]);
    // Each run's ribs are laid out along its length the first time it's drawn, then kept.
    const lengths = runs.map(() => 0);
    return { g, offsets, dirs, lengths, centres: new Float32Array(65 * 3) };
  }, [runs]);
  useEffect(() => () => built.g.dispose(), [built]);

  useRobotFrame(() => {
    const m = mesh.current;
    if (!m || !m.parent) return;
    m.parent.updateWorldMatrix(true, false);
    _inv.copy(m.parent.matrixWorld).invert();
    const position = built.g.getAttribute('position') as THREE.BufferAttribute;
    const normal = built.g.getAttribute('normal') as THREE.BufferAttribute;
    const uv = built.g.getAttribute('uv') as THREE.BufferAttribute;
    const c = built.centres;
    runs.forEach((run, r) => {
      const from = run.from.current;
      const to = run.to.current;
      if (!from || !to) return;
      from.updateWorldMatrix(true, false);
      to.updateWorldMatrix(true, false);
      _a.setFromMatrixPosition(from.matrixWorld).applyMatrix4(_inv);
      _b.setFromMatrixPosition(to.matrixWorld).applyMatrix4(_inv);
      from.getWorldQuaternion(_q);
      _da.copy(built.dirs[r][0]).applyQuaternion(_q).transformDirection(_inv);
      to.getWorldQuaternion(_q);
      _db.copy(built.dirs[r][1]).applyQuaternion(_q).transformDirection(_inv);
      const seg = run.segments ?? 24;
      const rad = run.radial ?? 10;
      const bow = _a.distanceTo(_b) * (run.stiffness ?? 0.45);
      const sag = run.sag ?? 0.03;
      const c1x = _a.x + _da.x * bow;
      const c1y = _a.y + _da.y * bow;
      const c1z = _a.z + _da.z * bow;
      const c2x = _b.x - _db.x * bow;
      const c2y = _b.y - _db.y * bow;
      const c2z = _b.z - _db.z * bow;
      let length = 0;
      for (let j = 0; j <= seg; j++) {
        const s = j / seg;
        const u = 1 - s;
        const w0 = u * u * u;
        const w1 = 3 * u * u * s;
        const w2 = 3 * u * s * s;
        const w3 = s * s * s;
        c[j * 3] = w0 * _a.x + w1 * c1x + w2 * c2x + w3 * _b.x;
        c[j * 3 + 1] = w0 * _a.y + w1 * c1y + w2 * c2y + w3 * _b.y - sag * 4 * s * u;
        c[j * 3 + 2] = w0 * _a.z + w1 * c1z + w2 * c2z + w3 * _b.z;
        if (j > 0) length += Math.hypot(c[j * 3] - c[j * 3 - 3], c[j * 3 + 1] - c[j * 3 - 2], c[j * 3 + 2] - c[j * 3 - 1]);
      }
      if (!built.lengths[r]) built.lengths[r] = length;
      const ribs = ((run.ribs ?? 0) * built.lengths[r]) / RIBS_PER_TILE;
      const base = built.offsets[r];
      for (let j = 0; j <= seg; j++) {
        const k = Math.min(j + 1, seg);
        const h = Math.max(j - 1, 0);
        _t.set(c[k * 3] - c[h * 3], c[k * 3 + 1] - c[h * 3 + 1], c[k * 3 + 2] - c[h * 3 + 2]);
        if (_t.lengthSq() < 1e-12) _t.set(0, 1, 0);
        _t.normalize();
        if (j === 0) {
          _n.set(0, 1, 0).cross(_t);
          if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0).cross(_t);
          _n.normalize();
        } else {
          _axis.crossVectors(_prev, _t);
          const sin = _axis.length();
          if (sin > 1e-6) {
            _q.setFromAxisAngle(_axis.divideScalar(sin), Math.asin(Math.min(1, sin)));
            _n.applyQuaternion(_q).normalize();
          }
        }
        _prev.copy(_t);
        _bn.crossVectors(_t, _n);
        for (let i = 0; i <= rad; i++) {
          const angle = (i / rad) * Math.PI * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const nx = _n.x * cos + _bn.x * sin;
          const ny = _n.y * cos + _bn.y * sin;
          const nz = _n.z * cos + _bn.z * sin;
          const v = base + j * (rad + 1) + i;
          normal.setXYZ(v, nx, ny, nz);
          position.setXYZ(v, c[j * 3] + nx * run.radius, c[j * 3 + 1] + ny * run.radius, c[j * 3 + 2] + nz * run.radius);
          uv.setY(v, (j / seg) * ribs);
        }
      }
    });
    position.needsUpdate = true;
    normal.needsUpdate = true;
    uv.needsUpdate = true;
  }, 0.2);

  return <mesh ref={mesh} geometry={built.g} material={material} castShadow receiveShadow frustumCulled={false} userData={{ walkThrough: true }} />;
}
