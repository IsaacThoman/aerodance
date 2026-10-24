import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, isPoseModelId, poseModel } from '../browser/models.ts';
import { WebcamPoseSource } from '../browser/WebcamPoseSource.ts';

test('only Lite is available for inference and downloads', () => {
  assert.deepEqual(MODELS.map(model => model.id), ['lite']);
  assert.equal(poseModel('lite').file, 'pose_landmarker_lite.task');
  for (const id of ['full', 'heavy', 'unknown']) {
    assert.equal(isPoseModelId(id), false);
    assert.throws(() => poseModel(id), /Only the Lite pose model is supported/);
  }
});

test('saved retired model preferences fall back to Lite while keeping the camera', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  for (const retired of ['full', 'heavy']) {
    const values = new Map([['aerodance-webcam-model', retired], ['aerodance-webcam-camera', 'saved-camera']]);
    const storage: Storage = {
      get length() { return values.size; },
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); },
      clear: () => values.clear(),
      key: index => [...values.keys()][index] ?? null,
    };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    const source = new WebcamPoseSource();
    assert.equal(source.view.model, 'lite');
    assert.equal(source.view.cameraId, 'saved-camera');
  }
});
