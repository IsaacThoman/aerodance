import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAND_MODEL, MODEL_ASSETS, MODELS, isPoseModelId, poseModel } from '../browser/models.ts';
import { WebcamPoseSource } from '../browser/WebcamPoseSource.ts';
import { isRetiredModel } from '../../../scripts/poseAssets.ts';

test('only Lite is available for inference and downloads', () => {
  assert.deepEqual(MODELS.map(model => model.id), ['lite']);
  assert.equal(poseModel('lite').file, 'pose_landmarker_lite.task');
  for (const id of ['full', 'heavy', 'unknown']) {
    assert.equal(isPoseModelId(id), false);
    assert.throws(() => poseModel(id), /Only the Lite pose model is supported/);
  }
});

test('the hand model is a pinned asset beside the pose model, which the retired models\' cleanup leaves alone', () => {
  assert.deepEqual(MODEL_ASSETS.map(asset => asset.file), ['pose_landmarker_lite.task', 'hand_landmarker.task']);
  assert.deepEqual(HAND_MODEL, { label: 'Hand Landmarker', bytes: 7819105, sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
    file: 'hand_landmarker.task', url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task' });
  assert.equal(isPoseModelId('hand_landmarker'), false, 'not a pose model');
  // The asset pipeline removes cached pose models that aren't current, and keeps the rest.
  for (const file of ['pose_landmarker_full.task', 'pose_landmarker_heavy.task']) assert.equal(isRetiredModel(file), true, file);
  for (const asset of MODEL_ASSETS) assert.equal(isRetiredModel(asset.file), false, asset.file);
  // Docker builds take every cached .task file in with them.
  assert.match(readFileSync(new URL('../../../.dockerignore', import.meta.url), 'utf8'), /^!\.cache\/pose-assets\/\*\/\*\.task$/m);
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
