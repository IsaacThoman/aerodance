import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraSetup, cameraWidgets } from '../src/connect/cameraSetup.ts';
import { NO_CAMERA, PHONE_CAMERA } from '../src/pose/CameraInput.ts';
import type { CameraInput, CameraInputView } from '../src/pose/CameraInput.ts';
import type { CameraInfo } from '../../packages/pose/browser/WebcamPoseSource.ts';
import { WebcamPoseSource } from '../../packages/pose/browser/WebcamPoseSource.ts';

const RECT = { x: 0, y: 0, w: 10, h: 10 };
const [prev, next] = cameraWidgets({ prev: RECT, next: RECT });

// The camera picker over these cameras (then the phone and No camera, as CameraInput lists them). resolve stands in
// for a running camera: the default one takes on the id of the camera the browser opened.
function picker(webcams: CameraInfo[], resolve = (id: string) => id) {
  const connection = { cameraId: '', cameras: [...webcams, PHONE_CAMERA, NO_CAMERA] } as unknown as CameraInputView;
  const source = { configure: async ({ cameraId = '' }) => { connection.cameraId = resolve(cameraId); } } as unknown as CameraInput;
  const setup = new CameraSetup(() => ({ source, connection }));
  return (arrow: typeof prev, presses: number) => Array.from({ length: presses }, () => {
    setup.activate(arrow);
    return connection.cameraId;
  });
}

test('the camera arrows go round every camera both ways before the browser names them', () => {
  assert.deepEqual(picker([])(next, 6), ['phone', 'none', '', 'phone', 'none', '']);
  assert.deepEqual(picker([])(prev, 6), ['none', 'phone', '', 'none', 'phone', '']);
});

test('the camera arrows go round every camera both ways while the default camera is running', () => {
  const webcams = [{ deviceId: 'facetime', label: 'FaceTime HD Camera' }, { deviceId: 'desk', label: 'Desk View Camera' }];
  const running = (id: string) => id || 'facetime';
  assert.deepEqual(picker(webcams, running)(next, 8), ['facetime', 'desk', 'phone', 'none', 'facetime', 'desk', 'phone', 'none']);
  assert.deepEqual(picker(webcams, running)(prev, 8), ['none', 'phone', 'desk', 'facetime', 'none', 'phone', 'desk', 'facetime']);
});

test('cameras the browser lists without an id (before permission) are left out', async () => {
  const devices = [{ kind: 'videoinput', deviceId: '', label: '' }, { kind: 'audioinput', deviceId: 'mic', label: 'Mic' }] as MediaDeviceInfo[];
  const source = new WebcamPoseSource({ mediaDevices: { getUserMedia: async () => { throw Error('unused'); }, enumerateDevices: async () => devices } });
  await source.refreshCameras();
  assert.deepEqual(source.view.cameras, []);
  devices.push({ kind: 'videoinput', deviceId: 'facetime', label: 'FaceTime HD Camera' } as MediaDeviceInfo);
  await source.refreshCameras();
  assert.deepEqual(source.view.cameras, [{ deviceId: 'facetime', label: 'FaceTime HD Camera' }]);
});

test("iOS's multi-lens cameras are left out, its real lenses kept", async () => {
  const labels = ['Front Camera', 'Back Triple Camera', 'Back Dual Wide Camera', 'Back Ultra Wide Camera', 'Back Dual Camera', 'Back Camera', 'Back Telephoto Camera'];
  const devices = labels.map((label, i) => ({ kind: 'videoinput', deviceId: `camera-${i}`, label })) as MediaDeviceInfo[];
  const source = new WebcamPoseSource({ mediaDevices: { getUserMedia: async () => { throw Error('unused'); }, enumerateDevices: async () => devices } });
  await source.refreshCameras();
  assert.deepEqual(source.view.cameras.map(camera => camera.label), ['Front Camera', 'Back Ultra Wide Camera', 'Back Camera', 'Back Telephoto Camera']);
});
