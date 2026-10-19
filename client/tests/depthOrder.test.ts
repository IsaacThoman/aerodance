import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthOrder } from '../src/aero/depthOrder.ts';
import { createWorldRandom } from '../src/aero/random.ts';

// What three.js does for separate transparent objects: farther first, ties in creation order.
function expected(positions: number[], eye: number[], dir: number[]) {
  const depth = (i: number) => (positions[i * 3] - eye[0]) * dir[0] + (positions[i * 3 + 1] - eye[1]) * dir[1] + (positions[i * 3 + 2] - eye[2]) * dir[2];
  return Array.from({ length: positions.length / 3 }, (_, i) => i).sort((a, b) => depth(b) - depth(a) || a - b);
}

test('instances come out farthest first, like separately sorted transparent objects', () => {
  const { R } = createWorldRandom(7);
  const positions = Array.from({ length: 300 * 3 }, () => Math.round(R(-50, 50)));
  const order = new DepthOrder(300);
  // A camera turning and moving: each update starts from the last order.
  for (let step = 0; step < 40; step++) {
    const a = step * 0.3, eye = [step * 2, 1, -step], dir = [Math.sin(a), 0, -Math.cos(a)];
    order.update(positions, 3, 0, eye[0], eye[1], eye[2], dir[0], dir[1], dir[2]);
    assert.deepEqual([...order.order], expected(positions, eye, dir), `step ${step}`);
  }
});

test('reports whether the order changed', () => {
  const order = new DepthOrder(3);
  const positions = [0, 0, 1, 0, 0, 3, 0, 0, 2];
  assert.equal(order.update(positions, 3, 0, 0, 0, 0, 0, 0, 1), true);
  assert.deepEqual([...order.order], [1, 2, 0]);
  assert.equal(order.update(positions, 3, 0, 0, 0, 0, 0, 0, 1), false);
  assert.equal(order.update(positions, 3, 0, 0, 0, 0, 0, 0, -1), true);
  assert.deepEqual([...order.order], [0, 2, 1]);
});
