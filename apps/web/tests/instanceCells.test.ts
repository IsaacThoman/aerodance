import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { IndexCellBatch, InstanceCellBatch, splitIntoCells, type IndexCell } from '../src/aero/instanceCells.ts';

type Point = [number, number, number];

// Interleaved cells, including both sides of zero, repeated cells and spare mesh capacity.
const positions: Point[] = [
  [-4, 0, -14], [24, 0, -14], [-4, 0, -44], [4, 0, 14], [-24, 0, -14],
  [4, 0, -14], [-4, 0, -84], [-0.25, 0, -14], [4, 0, -4], [24.5, 0, -13],
  [0.25, 0, -14], [-4.5, 0, -43], [-4, 0, -0.25], [-4, 0, 0.25], [-14, 0, -24],
];

function field(withColors = true, points = positions) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 1.2, 0.4), new THREE.MeshBasicMaterial(), points.length + 3);
  const transform = new THREE.Object3D();
  points.forEach((p, i) => {
    transform.position.set(...p);
    transform.rotation.set(i * 0.03, i * 0.17, -i * 0.02);
    transform.scale.set(0.7 + i * 0.01, 0.8 + i * 0.03, 0.6 + i * 0.02);
    transform.updateMatrix();
    mesh.setMatrixAt(i, transform.matrix);
    if (withColors) mesh.setColorAt(i, new THREE.Color((i + 1) / 20, (20 - i) / 20, (i % 4) / 4));
  });
  mesh.count = points.length;
  return mesh;
}

function frustumFor(camera: THREE.Camera) {
  camera.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}

function view(x: number, z: number, lookX = x, lookZ = z - 30) {
  const camera = new THREE.PerspectiveCamera(60, 1.5, 3, 65);
  camera.position.set(x, 2, z);
  camera.lookAt(lookX, 2, lookZ);
  return frustumFor(camera);
}

function cameraPath(): [string, THREE.Frustum][] {
  return [
    ['initially empty', view(1000, 1000)],
    ['front', view(0, 10)],
    ['same view', view(0, 10)],
    ['small camera move', view(0.001, 10)],
    ['left', view(-24, 0)],
    ['right', view(24, 0)],
    ['far negative cells', view(-4, -60)],
    ['turned back', view(-10, -30, 10, 15)],
    ['empty', view(1000, 1000)],
    ['still empty', view(1000, 1000)],
    ['return', view(0, 10)],
  ];
}

// Use the same object culling that the renderer uses for the original separate meshes.
const visibleCells = (cells: THREE.InstancedMesh[], frustum: THREE.Frustum) => cells.filter((cell) => frustum.intersectsObject(cell));
const sameCells = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((cell, i) => cell === b[i]);

function assertInstances(mesh: THREE.InstancedMesh, cells: THREE.InstancedMesh[], label: string) {
  const count = cells.reduce((n, cell) => n + cell.count, 0);
  assert.equal(mesh.count, count, `${label}: instance count`);
  assert.deepEqual(Array.from(mesh.instanceMatrix.array.slice(0, count * 16)), cells.flatMap((cell) => Array.from(cell.instanceMatrix.array.slice(0, cell.count * 16))), `${label}: complete matrices in cell and instance order`);
  if (mesh.instanceColor) {
    assert.deepEqual(Array.from(mesh.instanceColor.array.slice(0, count * 3)), cells.flatMap((cell) => Array.from(cell.instanceColor!.array.slice(0, cell.count * 3))), `${label}: colors follow their matrices`);
  }
}

for (const withColors of [true, false]) {
  test(`instance batches match splitIntoCells across moving cameras ${withColors ? 'with' : 'without'} colors`, () => {
    const source = field(withColors), reference = splitIntoCells(source, 10);
    const matrix = source.instanceMatrix, color = source.instanceColor;
    const batch = new InstanceCellBatch(source, 10), path = cameraPath();
    assert.equal(batch.mesh, source);
    assert.equal(batch.mesh.frustumCulled, false, 'the whole-field bound must not cull the packed draw');
    assert.equal(batch.mesh.count, 0, 'nothing is selected before the first update');
    assert.deepEqual(visibleCells(reference, path[1][1]), visibleCells(reference, path[3][1]), 'small movement retains a nonempty visibility set');
    const front = visibleCells(reference, path[1][1]);
    assert.ok(front.length > 0 && front.length < reference.length, 'front view actually culls part of the field');
    assert.ok(!sameCells(front, visibleCells(reference, path[4][1])), 'moving sideways changes the selection');
    let previous: THREE.InstancedMesh[] = [];
    for (const [label, frustum] of path) {
      const expected = visibleCells(reference, frustum), matrixVersion = matrix.version, colorVersion = color?.version;
      batch.update(frustum);
      assertInstances(batch.mesh, expected, label);
      assert.equal(batch.mesh.instanceMatrix, matrix, `${label}: retain the GPU matrix attribute`);
      assert.equal(batch.mesh.instanceColor, color, `${label}: retain optional colors`);
      if (sameCells(previous, expected) || expected.length === 0) {
        assert.equal(matrix.version, matrixVersion, `${label}: no matrix upload`);
        assert.equal(color?.version, colorVersion, `${label}: no color upload`);
      } else {
        assert.ok(matrix.version > matrixVersion, `${label}: changed matrices are uploaded`);
        if (color) assert.ok(color.version > colorVersion!, `${label}: changed colors are uploaded`);
      }
      previous = expected;
    }
  });
}

test('instance culling retains spheres crossing near, far and side planes, including negative cells', () => {
  const points: Point[] = [[0, 0, -1], [0, 0, -4], [0, 0, -15], [0, 0, -26], [0, 0, -30], [-12, 0, -15], [-11, 0, -15]];
  const source = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial(), points.length);
  points.forEach((p, i) => source.setMatrixAt(i, new THREE.Matrix4().makeTranslation(...p)));
  const reference = splitIntoCells(source, 1), batch = new InstanceCellBatch(source, 1);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 5, 25);
  let frustum = frustumFor(camera);
  let expected = visibleCells(reference, frustum);
  assert.deepEqual(expected.map((cell) => reference.indexOf(cell)), [1, 2, 3, 6], 'sphere intersections count even when their centers lie outside a clip plane');
  batch.update(frustum);
  assertInstances(batch.mesh, expected, 'initial near/far planes');
  camera.position.z = -10;
  frustum = frustumFor(camera);
  expected = visibleCells(reference, frustum);
  assert.deepEqual(expected.map((cell) => reference.indexOf(cell)), [2, 3, 4, 6], 'moving the camera moves both clipping planes');
  batch.update(frustum);
  assertInstances(batch.mesh, expected, 'moved near/far planes');
});

test('all-cells shadow selection restores every instance and then reculls the same camera', () => {
  const source = field(), reference = splitIntoCells(source, 10), batch = new InstanceCellBatch(source, 10);
  for (const frustum of [view(0, 10), view(1000, 1000)]) {
    batch.update(frustum);
    assertInstances(batch.mesh, visibleCells(reference, frustum), 'before shadows');
    batch.update(frustum, true);
    assertInstances(batch.mesh, reference, 'all cells for shadows');
    assert.equal(batch.mesh.count, positions.length, 'spare capacity is not an instance');
    const matrixVersion = batch.mesh.instanceMatrix.version, colorVersion = batch.mesh.instanceColor!.version;
    batch.update(view(24, 0), true);
    assertInstances(batch.mesh, reference, 'all cells remain selected for another shadow view');
    assert.equal(batch.mesh.instanceMatrix.version, matrixVersion, 'unchanged shadow selection does not upload matrices');
    assert.equal(batch.mesh.instanceColor!.version, colorVersion, 'unchanged shadow selection does not upload colors');
    batch.update(frustum);
    assertInstances(batch.mesh, visibleCells(reference, frustum), 'recull after shadows');
  }
  batch.update(view(0, 10));
  assertInstances(batch.mesh, visibleCells(reference, view(0, 10)), 'return after empty shadow recull');
});

function bladeIndices(blades: number[]) {
  const corners = [0, 1, 2, 1, 3, 2, 2, 3, 4];
  return new Uint32Array(blades.flatMap((blade) => corners.map((corner) => blade * 5 + corner)));
}

function indexCells(): IndexCell[] {
  const cells: { center: Point; blades: number[] }[] = [
    { center: [-4, 1, -14], blades: [25000, 3] },
    { center: [24, 1, -14], blades: [17, 119999] },
    { center: [-4, 1, -44], blades: [65537] },
    { center: [4, 1, 14], blades: [0, 75] },
    { center: [-24, 1, -14], blades: [256, 65536] },
    { center: [4, 1, -4], blades: [1] },
    { center: [-4, 1, -84], blades: [18000, 11] },
  ];
  return cells.map(({ center, blades }) => ({ sphere: new THREE.Sphere(new THREE.Vector3(...center), 1.5), indices: bladeIndices(blades) }));
}

function assertIndices(batch: IndexCellBatch, expected: number[], label: string) {
  assert.deepEqual(batch.geometry.drawRange, { start: 0, count: expected.length }, `${label}: draw only the active index prefix`);
  assert.deepEqual(Array.from(batch.geometry.index!.array.slice(0, expected.length)), expected, `${label}: exact original gl_VertexID sequence, including repeated triangle corners`);
}

test('index batches preserve original vertex IDs through moving, empty and returning views without redundant uploads', () => {
  const cells = indexCells(), originals = cells.map((cell) => cell.indices.slice());
  const batch = new IndexCellBatch(cells), index = batch.geometry.index!;
  assert.ok(index.array instanceof Uint32Array, 'grass vertex IDs exceed 16 bits');
  assert.equal(index.count, originals.reduce((n, indices) => n + indices.length, 0));
  assertIndices(batch, [], 'before update');
  const path = cameraPath();
  const selected = (frustum: THREE.Frustum) => cells.filter((cell) => frustum.intersectsSphere(cell.sphere));
  assert.ok(selected(path[1][1]).length > 0 && selected(path[1][1]).length < cells.length);
  assert.deepEqual(selected(path[1][1]), selected(path[3][1]), 'small camera movement leaves index visibility unchanged');
  let previous: IndexCell[] = [];
  for (const [label, frustum] of path) {
    const visible = selected(frustum), version = index.version;
    const expected = cells.flatMap((cell, i) => visible.includes(cell) ? Array.from(originals[i]) : []);
    batch.update(frustum);
    assertIndices(batch, expected, label);
    assert.equal(batch.geometry.index, index, `${label}: retain the GPU index attribute`);
    if (sameCells(previous, visible) || expected.length === 0) assert.equal(index.version, version, `${label}: no index upload`);
    else assert.ok(index.version > version, `${label}: changed indices are uploaded`);
    previous = visible;
  }
  cells.forEach((cell, i) => assert.deepEqual(cell.indices, originals[i], 'packing must not overwrite source indices'));
});

test('equal-sized visibility swaps repack instance data and original index sequences', () => {
  const points: Point[] = [[-24, 0, -14], [24, 0, -14], [-24.5, 0, -13], [24.5, 0, -13]];
  const source = field(true, points), reference = splitIntoCells(source, 10), instances = new InstanceCellBatch(source, 10);
  const cells = indexCells().filter((_, i) => i === 1 || i === 4), indices = new IndexCellBatch(cells);
  let matrixVersion = 0, colorVersion = 0, indexVersion = 0;
  for (const x of [-24, 24, -24]) {
    const frustum = view(x, 0);
    instances.update(frustum);
    assertInstances(instances.mesh, visibleCells(reference, frustum), `camera at x=${x}`);
    assert.equal(instances.mesh.count, 2, 'same instance count, different cell');
    assert.ok(instances.mesh.instanceMatrix.version > matrixVersion);
    assert.ok(instances.mesh.instanceColor!.version > colorVersion);
    matrixVersion = instances.mesh.instanceMatrix.version;
    colorVersion = instances.mesh.instanceColor!.version;
    indices.update(frustum);
    const expected = Array.from(cells[x < 0 ? 1 : 0].indices);
    assertIndices(indices, expected, `camera at x=${x}`);
    assert.equal(indices.geometry.drawRange.count, 18, 'same index count, different original vertex IDs');
    assert.ok(indices.geometry.index!.version > indexVersion);
    indexVersion = indices.geometry.index!.version;
  }
});

test('empty instance and index fields remain empty without uploads, including shadow mode', () => {
  for (const withColors of [true, false]) {
    const source = field(withColors, []);
    if (withColors) source.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(source.instanceMatrix.count * 3), 3);
    const batch = new InstanceCellBatch(source, 10), matrixVersion = source.instanceMatrix.version, colorVersion = source.instanceColor?.version;
    for (const includeAll of [false, true, false]) {
      batch.update(view(0, 10), includeAll);
      assertInstances(batch.mesh, [], 'empty field');
      assert.equal(source.instanceMatrix.version, matrixVersion);
      assert.equal(source.instanceColor?.version, colorVersion);
    }
  }
  const batch = new IndexCellBatch([]), index = batch.geometry.index!, version = index.version;
  for (const frustum of [view(0, 10), view(-24, 0), view(0, 10)]) {
    batch.update(frustum);
    assertIndices(batch, [], 'empty index field');
    assert.equal(index.array.length, 0);
    assert.equal(index.version, version);
  }
});
