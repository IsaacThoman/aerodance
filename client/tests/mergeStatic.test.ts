import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, BoxGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mergeStatic } from '../src/aero/mergeStatic.ts';

const freeze = (o: { traverse: (f: (x: { matrixAutoUpdate: boolean; updateMatrix(): void }) => void) => void }) => o.traverse((x) => { x.updateMatrix(); x.matrixAutoUpdate = false; });
const bounds = (o: Group) => { o.updateMatrixWorld(true); return new Box3().setFromObject(o, true); };

test('static meshes sharing a material become one, in place; moving, transparent and instanced ones stay', () => {
  const root = new Group(), red = new MeshBasicMaterial({ color: 'red' }), blue = new MeshBasicMaterial({ color: 'blue' });
  const glass = new MeshBasicMaterial({ transparent: true });
  const a = new Mesh(new BoxGeometry(), red); a.position.set(10, 0, 0);
  const holder = new Group(); holder.position.set(0, 5, 0); holder.rotation.y = 1;
  const b = new Mesh(new BoxGeometry(2, 1, 1), red); b.position.set(0, 0, 3); holder.add(b);
  const c = new Mesh(new BoxGeometry(), blue);
  const d = new Mesh(new BoxGeometry(), blue); d.position.x = -4;
  // Two materials in one mesh: split between the red and blue batches.
  const both = new Mesh(mergeGeometries([new BoxGeometry(), new BoxGeometry().translate(0, 3, 0)], true), [red, blue]);
  both.position.z = -6;
  const clear = new Mesh(new BoxGeometry(), glass), clear2 = new Mesh(new BoxGeometry(), glass);
  const many = new InstancedMesh(new BoxGeometry(), red, 3);
  root.add(a, holder, c, d, both, clear, clear2, many);
  freeze(root);
  const mover = new Mesh(new BoxGeometry(), red); root.add(mover);
  const before = bounds(root);
  const kept = mergeStatic(root, [...root.children]);
  const meshes = root.children.filter((o): o is Mesh => o instanceof Mesh);
  assert.equal(meshes.filter((m) => m.material === red && !(m instanceof InstancedMesh)).length, 2, 'one red batch, plus the mover');
  assert.equal(meshes.filter((m) => m.material === blue).length, 1);
  assert.equal(meshes.filter((m) => m.material === glass).length, 2);
  assert.ok(root.children.includes(many) && root.children.includes(mover));
  assert.ok(!kept.includes(a) && !kept.includes(both) && kept.includes(holder));
  assert.equal(holder.children.length, 0);
  assert.ok(bounds(root).equals(before) || bounds(root).min.distanceTo(before.min) + bounds(root).max.distanceTo(before.max) < 1e-5);
  const redBatch = meshes.find((m) => m.material === red && m !== mover && !(m instanceof InstancedMesh));
  assert.ok(redBatch);
  // a, b and both's red half, at their world positions.
  assert.ok(new Box3().setFromObject(redBatch).containsPoint(new Vector3(10, 0, 0)));
  assert.equal(redBatch.geometry.attributes.position.count, 36 * 3);
});

test('meshes keep still relative to a moving parent', () => {
  const sail = new Group(), mat = new MeshBasicMaterial();
  for (let k = 0; k < 4; k++) { const arm = new Group(); arm.rotation.x = (k * Math.PI) / 2; const m = new Mesh(new BoxGeometry(0.3, 13, 0.4), mat); m.position.y = 6.5; arm.add(m); sail.add(arm); }
  sail.position.set(3, 17, 0); sail.rotation.x = 0.3;
  for (const arm of sail.children) freeze(arm);
  const before = bounds(sail as Group);
  mergeStatic(sail, [...sail.children]);
  sail.updateMatrixWorld(true);
  const merged = sail.children.filter((o) => o instanceof Mesh);
  assert.equal(merged.length, 1);
  const after = bounds(sail as Group);
  assert.ok(after.min.distanceTo(before.min) < 1e-4 && after.max.distanceTo(before.max) < 1e-4);
});
