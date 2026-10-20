import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audibleTime, drawClock } from '../src/audio/songPlayer.ts';
import type { AudioClock } from '../src/audio/songPlayer.ts';

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} ≠ ${expected}`);

test('a timestamp that already trails rendering by the output latency (Chrome, Firefox) is used as it is', () => {
  // 40 ms rendered but not yet heard; the device reports 30 ms of it as output latency.
  const ctx: AudioClock = { state: 'running', currentTime: 10.04, baseLatency: 0.01, outputLatency: 0.03,
    getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }) };
  close(audibleTime(ctx, 5000, 5010), 10);
  close(audibleTime(ctx, 5100, 5010), 10.1, 'extrapolated along performance time');
});

test('WebKit\'s timestamp is the rendered position, so the output latency it leaves out (AirPods) is taken off', () => {
  // WebKit: contextTime is what was just rendered (never past currentTime), and outputLatency
  // includes the Bluetooth route's 200 ms.
  const ctx: AudioClock = { state: 'running', currentTime: 10.005, baseLatency: 0.01, outputLatency: 0.2,
    getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }) };
  close(audibleTime(ctx, 5000, 5000), 10 - 0.195);
  // A pose captured at 5100 ms is placed at what the player was hearing then.
  close(audibleTime(ctx, 5100, 5100), 10.1 - 0.195);
});

test('the Apple TV app\'s timestamp already trails by its latency, so nothing more is taken off', () => {
  // client-tvos/src/Audio.mm: a render of 10.0 s starts at host time 5000 ms and is heard 210 ms
  // later (Bluetooth), so it reports 9.79 s at 5000 ms; one 512-frame block is rendered past it.
  const ctx: AudioClock = { state: 'running', currentTime: 10 + 512 / 48000, baseLatency: 0.005, outputLatency: 0.21,
    getOutputTimestamp: () => ({ contextTime: 10 - 0.21, performanceTime: 5000 }) };
  close(audibleTime(ctx, 5000, 5000), 9.79);
  close(audibleTime(ctx, 5210, 5000), 10, 'the 10 s render is heard 210 ms after it started');
});

test('without a timestamp, the clock is the context time less its latency', () => {
  const ctx: AudioClock = { state: 'running', currentTime: 10, baseLatency: 0.01, outputLatency: 0 };
  close(audibleTime(ctx, 5000, 5000), 9.99);
  close(audibleTime({ ...ctx, outputLatency: 0.2 }, 4900, 5000), 9.7);
});

test('a suspended or interrupted context holds its time instead of running on from the last timestamp', () => {
  // A phone call stopped the context at 10 s; the last timestamp is from then.
  for (const state of ['suspended', 'interrupted']) {
    const ctx = { state, currentTime: 10.04, baseLatency: 0.01, outputLatency: 0.03,
      getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }) } as unknown as AudioClock;
    close(audibleTime(ctx, 5000, 5000), 10, 'up to the stop it is as before');
    close(audibleTime(ctx, 9000, 9000), 10.01, 'four seconds later it has not moved past what was rendered');
  }
});

test('on a TV, what is drawn follows the rendered position, since the TV delays the picture with the sound', () => {
  // WebKit through AirPlay Screen Mirroring: 250 ms of output latency, left out of the timestamp.
  const ctx: AudioClock = { state: 'running', currentTime: 10.005, baseLatency: 0.01, outputLatency: 0.25,
    getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }) };
  close(audibleTime(ctx, 5000, 5000, false), 10, 'drawn: the timestamp as it is (the TV shows it 250 ms later, with its sound)');
  close(audibleTime(ctx, 5000, 5000), 10 - 0.245, 'judged: what the player was hearing and seeing then');
  // The Apple TV app's and Chrome's timestamps already trail, so they are the same either way.
  const trailing: AudioClock = { ...ctx, currentTime: 10.26, getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }) };
  close(audibleTime(trailing, 5000, 5000, false), audibleTime(trailing, 5000, 5000));
});

test('the drawn clock takes the latency off only off the TV, and never steps back when the TV comes or goes', () => {
  let tv = false;
  let perf = 5000;
  const since = () => (perf - 5000) / 1000;
  const ctx: AudioClock = { state: 'running', get currentTime() { return 10.005 + since(); }, baseLatency: 0.01, outputLatency: 0.25,
    getOutputTimestamp: () => ({ contextTime: 10 + since(), performanceTime: perf }) };
  const clock = drawClock(ctx, () => tv);
  const at = (ms: number) => { perf = ms; return clock.at(ms, ms); };
  close(at(5000), 9.755, 'off the TV it is the audible time');
  // Mirroring starts: the picture jumps ahead by the latency once, to stay with the delayed sound.
  tv = true;
  close(at(5100), 10.1);
  close(at(5200), 10.2);
  // Mirroring stops: rather than going back 250 ms, it holds until the song catches up.
  tv = false;
  const held = [5300, 5400, 5500, 5600].map(at);
  held.forEach((t, i) => assert.ok(t >= (held[i - 1] ?? 10.2), `${t} never steps back`));
  close(held[0], 10.2); close(held[1], 10.2);
  close(held[2], 10.255, 'running again once the audible time passes it');
  close(held[3], 10.355);
  // A new play starts from wherever the clock says.
  clock.reset();
  close(at(5000), 9.755);
});
