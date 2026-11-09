# Session replay tools

The v1 JSONL starts with `aerodance.session`: game, players, options, requested tracking detail,
camera size/rate/label (no device id), user agent, optional `VITE_APP_COMMIT`/`VITE_COMMIT_SHA`,
`performance.timeOrigin`, video MIME type, native-to-tracking rotation and `videoStartTime`.
Every line has `t` in `performance.now()` milliseconds. `pose` contains the whole WebcamRecord,
source receive/capture timing and tracker's `lined` state; `frame` taps the existing rVFC loop
for **every delivered frame**, including frames not tracked. Its metadata keeps browser-provided
mediaTime (seconds), presentedFrames, capture/receive/presentation time and expectedDisplayTime.
Browsers without rVFC cannot supply frame lines. Use videoStartTime and frame metadata to align
video-relative time with capture/result times; camera captureTime is only available in some
browsers, so observed frame time is not a sensor exposure timestamp. `video-start` (MediaRecorder's start event), `stats`, `phase`, changed
`report` fields, `options` changes and `end` complete the log. Large pose JSON is serialized in
a worker in 250 ms batches. Slow/failing disk writes stop recording and report an incomplete save
rather than allowing an unbounded write queue.

Games can add local events with `ctx.record?.('paddle-contact', { player: 0 })`; the hook is
absent without recording. Use event names other than the host's reserved line types above;
keep payloads small and structured-cloneable. Table Tennis currently adds no extra events.

```sh
node tools/replay/cli.ts summary /path/to/aerodance-table-tennis-20261109-120000.jsonl
node tools/replay/cli.ts frames /path/to/session.mp4 /path/to/new-scene
```

`readSession(path)` from `tools/replay/session.ts` returns typed header/records and rejects
unsupported versions, broken lines and timestamps out of order. Summary reports duration,
players, pose Hz (total intervals/span and p5 instantaneous interval rate), latency (median/p95),
hand found fractions per player/side, silence over 200 ms (including start/end), and frame count.
Hand fractions use **all pose results** as the denominator, including missing players and
unrequested/dropped hands. Frame extraction needs `ffmpeg`/`ffprobe`; it resamples variable-rate
video to constant fps, keeps native orientation, and writes `frames/000001.jpg` and `meta.json`
(fps, resolution, count). Frame n is `(n-1)*1000/fps` ms from video start, plus the log's
videoStartTime on the performance clock. It creates no ground truth. Use an empty output folder.

`node apps/web/tests/session-recording.browser.ts` uses `PLAY_SESSION=recorder` and the puppet
to test real video, streamed files, phases, report deduplication, quit/results/hidden saves,
folder reuse and download fallback, and measures 20 seconds of pose Hz with and without
recording. Its captures and measurements stay under `.cache/session-recording/`.
