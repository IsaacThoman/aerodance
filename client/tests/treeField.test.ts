import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, PerspectiveCamera } from 'three';
import { TreeField, type FieldTree } from '../src/aero/treeField.ts';

// A row of trees every 20 m along +x, from x = 10 to 1990.
function row() {
  const trees: FieldTree[] = Array.from({ length: 100 }, (_, i) => ({ x: 10 + i * 20, y: 3, z: 0, radius: 4 }));
  const matrices = new Float32Array(trees.length * 16), colors = new Float32Array(trees.length * 3);
  trees.forEach((t, i) => { new Matrix4().makeTranslation(t.x, 0, t.z).toArray(matrices, i * 16); colors.set([i / 100, 0.5, 1], i * 3); });
  const geometry = new BoxGeometry(), material = new MeshBasicMaterial();
  // Trunks without colours, canopies with.
  const parts = [0, 1].map((part) => [0, 1, 2].map(() => {
    const m = new InstancedMesh(geometry, material, trees.length);
    if (part) m.instanceColor = new InstancedBufferAttribute(new Float32Array(trees.length * 3), 3);
    return m;
  }));
  return { trees, matrices, colors, parts };
}

function camera(x: number, lookX: number) {
  const c = new PerspectiveCamera(66, 4 / 3, 0.3, 6500);
  c.position.set(x, 10, 0);
  c.lookAt(lookX, 10, 0);
  c.updateMatrixWorld();
  return c;
}

const xs = (m: InstancedMesh) => Array.from({ length: m.count }, (_, i) => m.instanceMatrix.array[i * 16 + 12]);

test('trees in view are drawn once, at the detail their distance calls for; trees behind are not', () => {
  const group = row();
  const field = new TreeField(100, { near: 150, far: 600 });
  field.add({ trees: group.trees, matrices: group.matrices, colors: group.colors, levels: [0, 1, 2].map((l) => group.parts.map((p) => p[l])) });
  field.update(camera(1000, 2000));
  const [trunks, canopies] = group.parts;
  for (let level = 0; level < 3; level++) assert.deepEqual(xs(canopies[level]), xs(trunks[level]));
  const drawn = trunks.flatMap(xs).sort((a, b) => a - b);
  // Everything ahead of the camera (and the cell it stands in); nothing well behind it.
  for (const t of group.trees) {
    if (t.x >= 1000) assert.ok(drawn.includes(t.x), `${t.x} ahead is drawn`);
    if (t.x < 850) assert.ok(!drawn.includes(t.x), `${t.x} behind is culled`);
  }
  assert.equal(new Set(drawn).size, drawn.length, 'no tree twice');
  const near = xs(trunks[0]), mid = xs(trunks[1]), far = xs(trunks[2]);
  assert.ok(near.every((x) => x < 1300) && near.includes(1010));
  assert.ok(mid.every((x) => x >= 1100 && x < 1800) && mid.length > 0);
  assert.ok(far.every((x) => x >= 1500) && far.includes(1990));
  for (const levels of group.parts) for (const m of levels) assert.equal(m.visible, m.count > 0);
});

test('groups can share a mesh at a detail level', () => {
  const a = row(), b = row();
  const shared = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 200);
  const field = new TreeField(100, { near: 150, far: 600 });
  for (const g of [a, b]) field.add({ trees: g.trees, matrices: g.matrices, colors: null, levels: [[g.parts[0][0]], [g.parts[0][1]], [shared]] });
  field.update(camera(0, 2000));
  const far = xs(shared);
  assert.ok(far.length > 0 && far.length % 2 === 0);
  assert.deepEqual(far.slice(0, far.length / 2), far.slice(far.length / 2), 'both groups, one after the other');
  assert.ok(far.includes(1990));
});

test('colours follow their trees, and a cell only gets coarser past some slack', () => {
  const group = row();
  const field = new TreeField(100, { near: 150, far: 600 });
  const { parts } = group;
  field.add({ trees: group.trees, matrices: group.matrices, colors: group.colors, levels: [0, 1, 2].map((l) => parts.map((p) => p[l])) });
  field.update(camera(0, 2000));
  for (const canopy of parts[1]) {
    assert.ok(canopy.count > 0);
    for (let i = 0; i < canopy.count; i++) {
      const x = canopy.instanceMatrix.array[i * 16 + 12];
      assert.equal(canopy.instanceColor?.array[i * 3], Math.fround((x - 10) / 20 / 100));
    }
  }
  // The cell at x 100..200 is detailed from x = 0; just past the near boundary it stays so.
  assert.ok(xs(parts[0][0]).includes(110));
  const repacks = field.repacks;
  field.update(camera(-45, 2000));
  assert.ok(xs(parts[0][0]).includes(110), 'within the slack');
  field.update(camera(-80, 2000));
  assert.ok(!xs(parts[0][0]).includes(110) && xs(parts[0][1]).includes(110), 'past it');
  assert.ok(field.repacks > repacks);
  const settled = field.repacks;
  field.update(camera(-80, 2000));
  assert.equal(field.repacks, settled, 'no change, no repack');
});
