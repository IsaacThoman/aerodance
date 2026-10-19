import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, IcosahedronGeometry, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mergeTreeGeometry } from '../src/aero/treeGeometry.ts';

test('indexed tree batches preserve every rendered vertex attribute and triangle order', () => {
  const parts = [new IcosahedronGeometry(2, 2), new BoxGeometry(1, 3, 1)];
  parts[1].translate(3, 2, 1);
  for (const part of parts) {
    const position = part.attributes.position;
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) colors.set([position.getY(i) / 8 + 0.5, 0.6, 0.2], i * 3);
    part.setAttribute('color', new Float32BufferAttribute(colors, 3));
  }
  const referenceParts = parts.map((part) => part.index ? part.toNonIndexed() : part);
  const original = mergeGeometries(referenceParts);
  let disposedInputs = 0;
  parts.forEach((part) => part.addEventListener('dispose', () => { disposedInputs++; }));
  const indexed = mergeTreeGeometry(parts);
  assert.equal(disposedInputs, 0, 'input geometry remains owned by the caller');
  assert.ok(indexed.index);
  assert.ok(indexed.attributes.position.count < original.attributes.position.count * 0.6);
  const expanded = indexed.toNonIndexed();
  for (const name of Object.keys(original.attributes)) {
    assert.deepEqual(expanded.attributes[name].array, original.attributes[name].array, name);
  }
  for (const geometry of [...parts, original, indexed, expanded]) geometry.dispose();
  referenceParts.forEach((part, i) => { if (part !== parts[i]) part.dispose(); });
});
