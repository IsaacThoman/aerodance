import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { ReflectionRefresh } from '../src/aero/reflectionRefresh.ts';

test('reflection cadence averages 30 FPS across different display rates', () => {
  for (const hz of [30, 59, 60, 90, 120, 144]) {
    const refresh = new ReflectionRefresh(30), camera = new PerspectiveCamera();
    let captures = 0;
    for (let frame = 0; frame < hz * 10; frame++) {
      camera.position.x = frame / hz * 10;
      if (refresh.shouldRefresh(frame / hz, camera)) captures++;
    }
    assert.ok(Math.abs(captures - 300) <= 1, `${hz} Hz: ${captures} captures`);
  }
});

test('initial view, camera cuts, projection changes and clock resets refresh immediately', () => {
  const refresh = new ReflectionRefresh(30), camera = new PerspectiveCamera();
  assert.equal(refresh.shouldRefresh(1, camera), true);
  assert.equal(refresh.shouldRefresh(1.001, camera), false);
  camera.position.x = 10;
  assert.equal(refresh.shouldRefresh(1.002, camera), true);
  camera.rotation.y = 0.4;
  assert.equal(refresh.shouldRefresh(1.003, camera), true);
  camera.aspect = 16 / 9; camera.updateProjectionMatrix();
  assert.equal(refresh.shouldRefresh(1.004, camera), true);
  assert.equal(refresh.shouldRefresh(1.005, new PerspectiveCamera()), true);
  assert.equal(refresh.shouldRefresh(0, camera), true);
});

test('long invisibility gaps capture once on return without a catch-up burst', () => {
  const refresh = new ReflectionRefresh(15), camera = new PerspectiveCamera();
  assert.equal(refresh.shouldRefresh(0, camera), true);
  assert.equal(refresh.shouldRefresh(20, camera), true);
  assert.equal(refresh.shouldRefresh(20.01, camera), false);
  assert.equal(refresh.shouldRefresh(20.07, camera), true);
});
