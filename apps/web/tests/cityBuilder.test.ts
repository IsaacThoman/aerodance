import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, Uint8BufferAttribute } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CityBuilder } from '../src/aero/cityBuilder.ts';
import { facadeBox, facadeCylinderUVs, type CityMaterialKey, type CityMaterials } from '../src/aero/facades.ts';
import { createWorldRandom } from '../src/aero/random.ts';

/** The previous merge path, including its original triangle/vertex order. */
function referenceMerge(parts: BufferGeometry[]) {
  const expanded = parts.map((part) => part.index ? part.toNonIndexed() : part);
  try {
    return mergeGeometries(expanded);
  } finally {
    expanded.forEach((part, i) => { if (part !== parts[i]) part.dispose(); });
  }
}

function expectedIndices(parts: BufferGeometry[]) {
  const indices: number[] = [];
  let offset = 0;
  for (const part of parts) {
    const count = part.index?.count ?? part.attributes.position.count;
    for (let i = 0; i < count; i++) indices.push(offset + (part.index ? part.index.getX(i) : i));
    offset += part.attributes.position.count;
  }
  return indices;
}

function assertExpandedEqual(actual: BufferGeometry, reference: BufferGeometry) {
  const expanded = actual.index ? actual.toNonIndexed() : actual;
  try {
    assert.deepEqual(Object.keys(expanded.attributes), Object.keys(reference.attributes));
    for (const name of Object.keys(reference.attributes)) {
      const a = expanded.attributes[name], b = reference.attributes[name];
      assert.equal(a.itemSize, b.itemSize, name);
      assert.equal(a.normalized, b.normalized, name);
      assert.deepEqual(a.array, b.array, `${name}: every triangle vertex must match in order`);
    }
  } finally {
    if (expanded !== actual) expanded.dispose();
  }
}

function geometryBytes(geometry: BufferGeometry) {
  return Object.values(geometry.attributes).reduce((bytes, attribute) => bytes + attribute.array.byteLength, geometry.index?.array.byteLength ?? 0);
}

function colored(geometry: BufferGeometry) {
  const colors = new Uint8Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i++) colors[i] = (i * 37) % 256;
  geometry.setAttribute('color', new Uint8BufferAttribute(colors, 3, true));
  return geometry;
}

function cityMaterials(material = new MeshBasicMaterial()): CityMaterials {
  return {
    blue: material, white: material, teal: material, silver: material, deep: material,
    trim: material, podium: material, capglass: material, lobby: material, units: material,
    dark: material, red: material, bridge: material, deck: material, helipad: material,
    roofgrass: material, solar: material,
  };
}

test('city batches preserve indexed vertices, seams, material order and every expanded attribute', (t) => {
  const random = createWorldRandom(123), untouchedRandom = createWorldRandom(123);
  const builder = new CityBuilder(random, []), root = new Group();
  const materials = cityMaterials();
  materials.trim = new MeshBasicMaterial(); materials.red = new MeshBasicMaterial();
  const facade = colored(facadeBox(24, 80, 18, 3).rotateY(0.31).translate(-14, 40, 9));
  const cylinder = new CylinderGeometry(9, 12, 60, 8, 1);
  facadeCylinderUVs(cylinder, 12, 60, 8);
  colored(cylinder.rotateY(Math.PI / 8).translate(20, 30, -8));
  const batches = new Map<CityMaterialKey, BufferGeometry[]>([
    // Identical overlapping geometry must retain its separate vertices and triangles.
    ['blue', [facade, cylinder, facade.clone()]],
    ['trim', [new BoxGeometry(1, 2, 3), new BoxGeometry(1, 2, 3).translate(4, 5, 6)]],
    ['red', [new SphereGeometry(0.7, 8, 6)]],
  ]);
  const references = new Map([...batches].map(([key, parts]) => [key, referenceMerge(parts)]));
  const indices = new Map([...batches].map(([key, parts]) => [key, expectedIndices(parts)]));
  const disposed = new Map<BufferGeometry, number>();
  for (const parts of batches.values()) for (const part of parts) {
    disposed.set(part, 0);
    part.addEventListener('dispose', () => disposed.set(part, disposed.get(part)! + 1));
    t.mock.method(part, 'toNonIndexed', () => { throw new Error('merge must retain indexed input'); });
  }
  // Interleave additions; output order must still follow the first use of each material.
  builder.add('blue', facade);
  builder.add('trim', batches.get('trim')![0]);
  builder.add('blue', cylinder);
  builder.add('red', batches.get('red')![0]);
  builder.add('trim', batches.get('trim')![1]);
  builder.add('blue', batches.get('blue')![2]);
  builder.merge(root, materials);

  assert.equal(root.children.length, batches.size);
  let i = 0;
  for (const [key, parts] of batches) {
    const mesh = root.children[i++];
    assert.ok(mesh instanceof Mesh);
    assert.equal(mesh.material, materials[key]);
    assert.equal(mesh.castShadow, key !== 'red');
    assert.equal(mesh.receiveShadow, key !== 'red');
    assert.equal(mesh.geometry.attributes.position.count, parts.reduce((sum, part) => sum + part.attributes.position.count, 0));
    assert.ok(mesh.geometry.index?.array instanceof Uint16Array);
    assert.deepEqual(Array.from(mesh.geometry.index.array), indices.get(key));
    assertExpandedEqual(mesh.geometry, references.get(key)!);
    assert.ok(geometryBytes(mesh.geometry) < geometryBytes(references.get(key)!), `${key}: indexed buffers use fewer bytes`);
    for (const part of parts) assert.equal(disposed.get(part), 1, 'each consumed source is disposed once');
  }
  assert.equal(random.rnd(), untouchedRandom.rnd(), 'merging must not consume the world random stream');
  builder.merge(root, materials);
  assert.equal(root.children.length, batches.size, 'a second merge has no consumed geometry left');
  for (const count of disposed.values()) assert.equal(count, 1);
  for (const child of root.children) (child as Mesh).geometry.dispose();
  for (const reference of references.values()) reference.dispose();
  for (const material of new Set(Object.values(materials))) material.dispose();
});

for (const order of ['nonindexed first', 'nonindexed middle', 'nonindexed last', 'all nonindexed'] as const) {
  test(`city merge preserves attributes and triangle order: ${order}`, () => {
    const parts: BufferGeometry[] = [
      colored(new BoxGeometry(2, 3, 4).rotateY(0.6)),
      colored(new CylinderGeometry(1, 2, 5, 8).translate(7, 8, 9)),
      colored(new BoxGeometry(3, 1, 2).translate(-4, 2, -3)),
    ];
    const flatAt = order === 'nonindexed first' ? 0 : order === 'nonindexed middle' ? 1 : 2;
    for (let i = 0; i < parts.length; i++) if (order === 'all nonindexed' || i === flatAt) {
      const indexed = parts[i];
      parts[i] = indexed.toNonIndexed();
      indexed.dispose();
    }
    const reference = referenceMerge(parts), indices = expectedIndices(parts);
    const vertices = parts.reduce((sum, part) => sum + part.attributes.position.count, 0);
    const disposed = parts.map(() => 0);
    const material = new MeshBasicMaterial(), root = new Group();
    const builder = new CityBuilder(createWorldRandom(45), []);
    parts.forEach((part, i) => {
      part.addEventListener('dispose', () => disposed[i]++);
      builder.add('trim', part);
    });
    builder.merge(root, cityMaterials(material));
    assert.equal(root.children.length, 1);
    const merged = (root.children[0] as Mesh).geometry;
    assert.equal(merged.attributes.position.count, vertices, 'no source vertices are welded');
    if (order === 'all nonindexed') {
      assert.equal(merged.index, null, 'a fully nonindexed batch needs no extra index buffer');
      assert.equal(geometryBytes(merged), geometryBytes(reference));
    } else {
      assert.ok(merged.index);
      assert.deepEqual(Array.from(merged.index.array), indices);
    }
    assertExpandedEqual(merged, reference);
    assert.deepEqual(disposed, [1, 1, 1]);
    merged.dispose(); reference.dispose(); material.dispose();
  });
}

test('merging Uint16 city inputs promotes indices to Uint32 without changing triangle order', () => {
  const parts = [new PlaneGeometry(20, 30, 182, 182), new PlaneGeometry(10, 40, 182, 182).rotateY(0.4).translate(5, 6, 7)];
  for (const part of parts) assert.ok(part.index?.array instanceof Uint16Array);
  const reference = referenceMerge(parts), indices = expectedIndices(parts);
  const material = new MeshBasicMaterial(), root = new Group();
  const builder = new CityBuilder(createWorldRandom(67), []);
  for (const part of parts) builder.add('trim', part);
  builder.merge(root, cityMaterials(material));
  const merged = (root.children[0] as Mesh).geometry;
  assert.equal(merged.attributes.position.count, 2 * 183 * 183);
  assert.ok(merged.index?.array instanceof Uint32Array);
  assert.ok(merged.index.array[merged.index.count - 1] > 65535);
  assert.deepEqual(Array.from(merged.index.array), indices);
  assertExpandedEqual(merged, reference);
  assert.ok(geometryBytes(merged) < geometryBytes(reference) * 0.3);
  merged.dispose(); reference.dispose(); material.dispose();
});

test('large nonindexed city input receives Uint32 identity indices without truncation', () => {
  const plane = new PlaneGeometry(20, 30, 105, 105);
  const flat = plane.toNonIndexed(); plane.dispose();
  const parts = [flat, new BoxGeometry(1, 2, 3).translate(40, 50, 60)];
  assert.ok(flat.attributes.position.count > 65535);
  const reference = referenceMerge(parts), indices = expectedIndices(parts);
  const material = new MeshBasicMaterial(), root = new Group();
  const builder = new CityBuilder(createWorldRandom(89), []);
  for (const part of parts) builder.add('trim', part);
  builder.merge(root, cityMaterials(material));
  const merged = (root.children[0] as Mesh).geometry;
  assert.ok(merged.index?.array instanceof Uint32Array);
  assert.deepEqual(Array.from(merged.index.array), indices);
  assertExpandedEqual(merged, reference);
  merged.dispose(); reference.dispose(); material.dispose();
});
