import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_GRACE_MS, watchInterruptions } from '../src/game/interruptions.ts';
import type { InterruptionCause } from '../src/game/interruptions.ts';
import { hostState, onHostChange } from '../src/host.ts';
import { CameraSetup } from '../src/connect/cameraSetup.ts';
import type { CameraInput, CameraInputView } from '../src/pose/CameraInput.ts';

// An AudioContext's state and statechange event, as WebKit changes them during a phone call.
class FakeAudio extends EventTarget {
  state: string = 'running';
  set(state: string) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
// The camera's view, published to subscribers (the current one on subscribing, like CameraInput).
function fakeCamera() {
  const listeners = new Set<(view: { interrupted?: boolean }) => void>();
  let view = { interrupted: false };
  return {
    subscribe(fn: (view: { interrupted?: boolean }) => void) { listeners.add(fn); fn(view); return () => { listeners.delete(fn); }; },
    set(interrupted: boolean) { view = { interrupted }; for (const fn of listeners) fn(view); },
    get listeners() { return listeners.size; },
  };
}
const hostEvent = (detail: unknown) => new CustomEvent('aerodance-host', { detail });

function watch(t: TestContext) {
  const audio = new FakeAudio();
  const camera = fakeCamera();
  const host = new EventTarget();
  const pauses: InterruptionCause[] = [];
  const off = watchInterruptions((cause) => pauses.push(cause), { audio: audio as unknown as AudioContext, camera, host });
  t.after(off);
  return { audio, camera, host, pauses, off };
}

test('a camera that stalls for less than the grace period (Chrome mutes a stall too) does not pause', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(t);
  w.camera.set(true);
  t.mock.timers.tick(CAMERA_GRACE_MS - 1);
  w.camera.set(false);
  t.mock.timers.tick(CAMERA_GRACE_MS);
  assert.deepEqual(w.pauses, []);
  w.camera.set(true);
  w.off();
  t.mock.timers.tick(CAMERA_GRACE_MS);
  assert.deepEqual(w.pauses, [], 'nor once the screen has gone');
});

test('the audio stopping (WebKit interrupted or suspended, or the app saying so) pauses, and coming back does not', (t) => {
  const w = watch(t);
  w.audio.set('interrupted');
  w.audio.set('running');
  w.audio.set('suspended');
  assert.deepEqual(w.pauses, ['audio', 'audio']);
  w.host.dispatchEvent(hostEvent({ multitasking: false, interrupted: true }));
  w.host.dispatchEvent(hostEvent({ multitasking: false, interrupted: false }));
  w.host.dispatchEvent(hostEvent({ multitasking: true, interrupted: false }));
  assert.deepEqual(w.pauses, ['audio', 'audio', 'audio']);
  w.audio.set('closed');
  assert.equal(w.pauses.length, 3, 'a closed context is the page going, not an interruption');
});

test('the camera being taken away pauses once; an already interrupted camera does not pause again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(t);
  assert.deepEqual(w.pauses, [], 'subscribing is not an interruption');
  w.camera.set(true);
  t.mock.timers.tick(CAMERA_GRACE_MS);
  assert.deepEqual(w.pauses, ['camera']);
  // Resumed while iOS still has it: the song plays on.
  w.camera.set(true);
  t.mock.timers.tick(CAMERA_GRACE_MS);
  w.camera.set(false);
  assert.deepEqual(w.pauses, ['camera']);
  w.camera.set(true);
  t.mock.timers.tick(CAMERA_GRACE_MS);
  assert.deepEqual(w.pauses, ['camera', 'camera']);
  w.off();
  assert.equal(w.camera.listeners, 0);
  w.audio.set('interrupted');
  w.host.dispatchEvent(hostEvent({ interrupted: true }));
  assert.equal(w.pauses.length, 2, 'nothing is heard after unsubscribing');
});

test('the host state reads only booleans, and is all false in a browser', () => {
  assert.deepEqual(hostState(), { multitasking: false, interrupted: false });
  const page = globalThis as { __aerodanceHost?: unknown };
  page.__aerodanceHost = { multitasking: true, interrupted: 'yes' };
  try {
    assert.deepEqual(hostState(), { multitasking: true, interrupted: false });
  } finally { delete page.__aerodanceHost; }
  const target = new EventTarget();
  const seen: unknown[] = [];
  const off = onHostChange((state) => seen.push(state), target);
  target.dispatchEvent(hostEvent(null));
  target.dispatchEvent(hostEvent({ interrupted: true }));
  off();
  target.dispatchEvent(hostEvent({ interrupted: true }));
  assert.deepEqual(seen, [{ multitasking: false, interrupted: false }, { multitasking: false, interrupted: true }]);
});

test('the calibration and pause screens say why the camera stopped: full screen on iPad multitasking, else interrupted', () => {
  const connection = { status: 'initializing', message: 'The camera was interrupted.', sourceKind: 'webcam', interrupted: true } as CameraInputView;
  const setup = new CameraSetup(() => ({ source: {} as CameraInput, connection }));
  assert.equal(setup.interrupted(), true);
  assert.equal(setup.active(), true, 'no Start camera button while it is only interrupted');
  assert.match(setup.message(), /^The camera was interrupted/);
  const page = globalThis as { __aerodanceHost?: unknown };
  page.__aerodanceHost = { multitasking: true, interrupted: false };
  try {
    assert.match(setup.message(), /full screen/);
  } finally { delete page.__aerodanceHost; }
  connection.interrupted = false;
  connection.message = 'Lite · CPU · Measuring tracking speed…';
  assert.equal(setup.message(), connection.message);
});
