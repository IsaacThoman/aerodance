import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VideoWave, extractVideoAudio } from '../web/videoAudio.ts';

test('video audio WAV preserves delayed starts, stereo channels, gaps and video duration', () => {
  const wave = new VideoWave(8000, 2, 10);
  const buffer = { sampleRate: 8000, numberOfChannels: 2, length: 2,
    getChannelData: (channel: number) => new Float32Array(channel ? [-1, -.5] : [1, .5]) };
  wave.write(buffer, .0025);
  const view = new DataView(wave.bytes.buffer);
  assert.equal(new TextDecoder().decode(wave.bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(40, true), 80 * 4);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getInt16(44 + 19 * 4, true), 0);
  assert.equal(view.getInt16(44 + 20 * 4, true), 32767);
  assert.equal(view.getInt16(44 + 20 * 4 + 2, true), -32768);
  assert.equal(view.getInt16(44 + 21 * 4, true), 16384);
  assert.equal(view.getInt16(44 + 22 * 4, true), 0);
  assert.equal(view.getInt16(44 + 79 * 4, true), 0);
  wave.write(buffer, -.000125);
  assert.equal(view.getInt16(44, true), 16384, 'negative timestamps clip rather than shifting the audio');
  wave.write(buffer, .009875);
  assert.equal(view.getInt16(44 + 79 * 4, true), 32767, 'audio beyond the video duration is clipped');
});

test('video audio bounds are checked before allocating, and cancellation stops before decoding', async () => {
  assert.throws(() => new VideoWave(48000, 2, 3600000), /exceeds 128 MiB/);
  assert.throws(() => new VideoWave(0, 2, 1000), /Unsupported/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractVideoAudio(new File([], 'video.webm'), 1000, controller.signal), { name: 'AbortError' });
});
