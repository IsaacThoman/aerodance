# trackbench harness

Runs the game's real webcam tracking pipeline (and any other pose estimator's output) over
trackbench scenes and measures what players would feel. Scenes, detections and the formats
are in [`../CONTRACT.md`](../CONTRACT.md); data lives in `$TRACKBENCH_DATA`
(default `/Volumes/development/aerodance-trackbench`). Everything here is TypeScript run with
plain `node`, importing the game's own modules (tracker, worker, calibration, scorer) rather
than copying them.

## Commands

```sh
H=tools/trackbench/harness
# The game's own pipeline: the built pose worker in Chromium on the GPU, tracker in the loop.
node $H/run-game.ts <scene> [--model lite|full|heavy] [--realtime] [--busy-scale k | --busy-ms N] [--strip-width W | --no-strips] [--no-search] [--no-zoom] [--id <estimator-id>] [--no-session] [--running-mode IMAGE]
# The same over every ready scene (or those with these prefixes), several at once, then metrics.
node $H/run-suite.ts --id <estimator-id> [--jobs N] [--browsers N] [--force] [--no-metrics] [prefix...] [-- run-game flags]
# Whether two runs' detections and tracking are the same, scene by scene (timing left out).
node $H/compare-runs.ts <run-a> <run-b> [scene...]
# Any estimator's detections.jsonl through the game's tracker (and setup) to tracked.jsonl.
node $H/track.ts <estimator> <scene> [--no-session] [--no-looks]
# Metrics: learns the estimator's per-joint offsets over every scene it ran, then writes each metrics.json.
node $H/metrics.ts <estimator> [scene...] [--jobs N]
# Report across scenes and estimators: $TRACKBENCH_DATA/reports/<name>.md and .json.
node $H/report.ts [--estimators a,b] [--baseline mp-lite-game] [--scenes <prefix>[,<prefix>...]] [--name <name>] [--worst 5]
# Tests (synthetic fixtures, no frames or browser needed).
node --test $H/*.test.ts
```

A typical pass over one scene: `run-game.ts s` (writes `runs/mp-lite-game/s/`), then for the
other estimators `track.ts <est> s`, then `metrics.ts <est>` for each, then `report.ts`.

**Using the machine.** A scene's frames go one after another (the game's tracker feeds each
result into the next frame, and MediaPipe's video mode follows people from frame to frame), but
scenes are independent. `run-suite.ts` runs `--jobs` scenes at once (default 8, or half the
cores on a smaller machine), each in a fresh page and pose worker, with a browser for each job:
pages of one browser share its GPU process, which serialised their work. On an M5 Pro, 17 mixed
scenes took 236 s one at a time, 191 s four at a time in one browser, and 42 s eight at a time in
eight browsers; the whole suite (133 scenes) takes 4.4 minutes instead of 29. It also decodes
each scene's next frame while the current one is with the model, and launches the longest scenes
first. Results are identical however many jobs run (`compare-runs.ts`), except the measured
inference times in `metrics.json`'s `cost`, which run longer while scenes share the GPU: measure
those with `--jobs 1`. `--realtime` runs alone, since it measures timing. The CPU analyses (`metrics.ts`, `studies/retrack.ts`,
`studies/calibration.ts`, `studies/score-robustness.ts`) spread scenes over `--jobs` processes
(default: all cores but one; `pool.ts`), with the same outputs: metrics over 133 scenes take 3 s
instead of 13, the scoring study 16 s instead of 71.

`npm run build` first: `run-game.ts` copies `dist/` to `$TRACKBENCH_DATA/dist-snapshot-<git
short sha>` (with the worker's content hash added if `dist/` was rebuilt at the same commit)
and serves the copy, so rebuilding can't change a running eval. `run.json` records which.

## How the game's pipeline is reproduced

`run-game.ts` loads the built `pose.worker-*.js` from the snapshot in Playwright's Chromium with
`--use-angle=metal --enable-gpu --ignore-gpu-blocklist` (headless Chromium otherwise falls back
to SwiftShader). It fails unless the WebGL renderer is a GPU and the worker reports the `GPU`
delegate (`--allow-cpu` overrides); `run.json` records both.

- **Worker settings**: exactly `WebcamPoseSource.connect`'s for the scene's `players`: one or two
  players ask for that many people on the whole picture; three or four get `evenTiles(players)`
  strips (and `players + 1` for the fallback), and the run fails if the strips don't start;
  two players also get `search: true`, and one player gets `zoom: true`. Looks when
  `players > 1`. VIDEO running mode; the model's SHA-256 is checked by the worker.
- **Frames**: each JPEG decoded with `createImageBitmap` and transferred to the worker, as
  `WebcamPoseSource` transfers a bitmap of the video. VIDEO timestamps are the frame's `t_ms`
  plus 1000: before the scene the model is warmed up on frame 1 and then shown four grey frames,
  so the GPU programs are compiled (the first result otherwise takes ~0.6-0.8 s) and it starts
  the scene following nobody.
- **Tracker in the loop** (`gameloop.ts`): each result goes to `PlayerTracker.update(landmarks,
  input, frameBrowserTime, looks)`, and the next frame's `players` is the record's pose count,
  as in `WebcamPoseSource.handleResult`. A result whose frame is 500 ms old or more when it
  arrives is dropped before the tracker, as the game drops it.
- **Setup** (`gameloop.ts`, on by default, `--no-session` off): `WebcamCalibration.accept` on
  every record (capture time = frame time, now = arrival), and GameSession's line-up retry: a
  fresh tracker (and `players = 0`) after `SETUP_TRACKING_REFRESH_MS` (4 s) without a
  calibration hold, clearing calibration holds too, until calibration completes. The retry stops
  at the start of the scene's dance phase, when the song would be playing (the scene's timeline
  is fixed, so the harness assumes the song starts then whether or not calibration finished; `calibration.
  complete_before_dance` says whether it did).
- **Offline** (default): every frame is processed; each result "arrives" the moment its frame
  was taken (so the frame-age drop never applies and results don't depend on machine speed).
- **`--realtime`**: frames arrive every `1000 / fps` ms; one is in flight at a time; frames
  that arrive meanwhile wait, the newest replacing older ones (counted as camera frames
  dropped), and the waiting one is sent the moment the result is in, as `WebcamPoseSource`
  does. The busy time is the measured round trip (postMessage to result, which includes the
  worker's looks sampling) times `--busy-scale` (default 1; the game also renders the stage
  on the same GPU, so real inference can be slower). Results 500 ms old are dropped. The id
  gets `-rt`. A frame's capture time is its arrival time (the game uses the video frame
  callback's time); camera latency before that isn't modelled.
- **`--running-mode IMAGE`** (a diagnostic; the game never does this): a fresh person
  detection on every frame, no strips; id `mp-<model>-game-image`. Comparing it with the VIDEO
  run tells a detector that can't see somebody from tracking that never looks for them again.
- **Models**: `lite` is the snapshot's; `full` and `heavy` come from
  `$TRACKBENCH_DATA/models/pose_landmarker_<id>.task`, downloaded from the MediaPipe model URLs
  if missing, SHA-256 checked (`POSE_MODELS` in `run-game.ts`).

`track.ts` runs the same `GameLoop` over saved detections (in arrival order, honouring
`received_ms` when a realtime run recorded it). Replaying `mp-lite-game`'s own detections
reproduces its in-loop `tracked.jsonl` byte for byte. Detections without `looks` get them from
the frames: each JPEG drawn into a 128-pixel-wide `willReadFrequently` 2D canvas in Chromium,
exactly as the worker draws it, and `describeLooks` (the game's `appearance.ts`) on its pixels,
with each joint's `conf` standing for both visibility and presence (the game only uses their
minimum). On the worker's own detections this gives identical looks (max difference 0).
Pixels are cached in `$TRACKBENCH_DATA/cache/looks128/<scene>.bin`.

## Outputs

`runs/<estimator>/<scene>/`:

- `detections.jsonl` (contract format). `run-game.ts` adds `roundtrip_ms` and, in realtime
  runs, `sent_ms`, `received_ms` and `dropped`. `conf` is `min(visibility, presence)`; `score`
  is null (MediaPipe gives none per person). Coordinates are full precision.
- `tracked.jsonl`: per record `{frame, t_ms, received_ms, poses: [{playerId, kp}], lined,
  calib: {progress, complete, hold, players}, reset?, dropped?}`. `kp` joints keep the
  tracker's confidence (null when unknown). `lined` is `PlayerTracker.lined` (the players have
  been numbered); `reset` marks a setup line-up retry before this record.
- `run.json` (run-game), `track.json` (track.ts), `metrics.json` (metrics.ts).
- `runs/<estimator>/_offsets.json`: the estimator's mean per-joint offsets over the suite.

## Metrics

Shared definitions:

- **Torso length** (the unit of every joint error): a GT person's 3D torso (shoulder
  midpoint to hip midpoint, from `kp3d`) projected at their torso's depth: `f * L / Z` picture
  heights, where `f` is the focal length in picture heights (from `meta.json` intrinsics if
  present, else the spec's `hfov_deg`: `f = (W / H) / (2 tan(hfov / 2))`, except above 90°
  where the generator adds lens distortion; then, or without either, the GT's own estimate:
  the 95th percentile of projected torso length × depth / 3D torso length. `metrics.json`
  says which, and gives the GT estimate as `focal_from_gt` to check the GT against the spec). Unlike a 2D torso it doesn't shrink when the person bends or turns. Distances are in
  aspect-corrected picture units (x times W/H).
- **Pose distance**: mean, over the 12 body joints (11-16, 23-28) that are inside the picture
  in GT (vis ≠ 3) and present in the pose, of the joint distance in torso lengths; with left
  and right exchanged if that's nearer (a side swap is still that person). Fewer than 3 joints:
  no match.
- **Matching**: per frame, Hungarian (minimum total pose distance) between poses and all GT
  people, gate 1.0 torso lengths.
- **Present** (a GT person the game should find): ≥ 3 torso joints inside the picture and, if
  the GT says, `visible_frac` ≥ 0.25. **Fully visible**: all 12 body joints inside and
  `visible_frac` ≥ 0.9.
- **Dance-only**: frames whose GT segment for that person is `dance`; the score's dance window
  is the spec's `dance` phase (else the span of frames where any player dances).

### Detection (`detection`)

- `recall.players`: matched present player-frames / present player-frames; also `dance`,
  `fully_visible`, and `bystanders` (the same for GT bystanders).
- `false_positives_per_100_frames`: unmatched detections per 100 frames, by kind: `duplicate`
  (torso centre inside the bbox of a GT person who is matched to another detection: a ghost
  copy), `mislocated` (inside the bbox of an unmatched GT person: them, too wrong to match),
  `distractor` (elsewhere, in a scene with mirrors/TVs/posters/coat racks/windows in
  `room.features`), `noise` (elsewhere otherwise). Detections of bystanders are not false
  positives; see `recall.bystanders`.
- `detections_per_frame`.

### Keypoints on matched players (`detection.keypoints`, `detection.keypoints_dance`)

- `body.error`: per-joint error in torso lengths (mean/median/p90) over body joints inside the
  picture. `body.error_corrected`: the same after subtracting the estimator's **mean
  per-joint offset** (learnt over every scene it ran, from matched players' joints that are visible or
  self-occluded,
  in the GT torso frame: v from hip midpoint to shoulder midpoint, u perpendicular toward the
  person's left), so a model whose "hip" sits higher than the anatomical joint isn't counted
  wrong for it. `_offsets.json` holds the offsets.
- `pck10`/`pck20` (raw), `pck10_corrected`/`pck20_corrected`: share of body joints within 0.1 /
  0.2 torso lengths.
- `by_vis`: the same per GT visibility code (0 visible, 1 self-occluded, 2 occluded by
  another), all 33 joints. `groups`: face, shoulders, elbows, wrists, hands, hips, knees,
  ankles, feet. `per_joint`: [raw, corrected] mean per joint.
- `limbs`: angle between the pose's and the GT's direction of each of the scorer's 10 limbs
  (`features.ts limbDirections`, aspect-corrected), the GT's limbs inside the picture, the
  pose's where the scorer would use them (`liveUsable`: both ends pass the 0.1 gate in the
  recording format's quantised steps, or have null confidence): `mean_deg_weighted` (by the
  scorer's limb weights), `mean_deg`, `over30_frac`, `usable_frac` (GT limbs the pose makes
  usable), `per_limb`.
- `swaps`: share of frames where exchanging the pose's left and right labels brings it nearer
  the GT (the swapped error under 0.6 of the labelled error, which is over 0.25 torso), for the
  whole body, the arms (13-16) and the legs (25-28), among frames where those joints are in the
  picture and the GT's left and right are over 0.3 torso lengths apart.
- `confidence`: `sure_wrong` = joints with conf ≥ 0.5 (the calibration and character threshold)
  more than 0.2 torso lengths off (offset-corrected) / joints with conf ≥ 0.5; `correct_unsure` = joints
  within 0.2 with conf < 0.5 / joints within 0.2; `outside_sure` = share of GT joints outside
  the picture the pose reports with conf ≥ 0.5 (a guess calibration and the character would trust).
- `detection.jitter.accel_error`: for body joints matched on three consecutive frames,
  `|a_pose - a_gt|` with `a = p(n+1) - 2 p(n) + p(n-1)`, in torso lengths per frame² at the
  scene's fps; `accel_rms_pose`/`accel_rms_gt` for scale.

### Tracked players (`tracking`)

- **Expected numbering** (`expected_numbering`): P1 is the player on the left of the
  *mirrored* preview, i.e. the GT players ordered by torso x descending in the raw frame, at
  the record where the tracker first numbers everyone (`lined`); if it never does, at the first
  frame where all are present. `mapping[k]` is player k's GT person from then on.
- Each record's poses are matched to GT people (as above). For each player k and record where
  their person is present, the player-frame is `correct` (k's pose is their person),
  `wrong_player` (another player's person), `bystander` (a bystander), `ghost` (a pose matching
  nobody) or `lost` (no pose for k). `identity_accuracy` = correct / present player-frames, and
  `lost`, `wrong_player`, `bystander`, `ghost` likewise; over `after_numbering` (records from
  the first `lined` one), `whole_scene` and `dance`. `phantom_frames`: k has a pose while their
  person isn't present.
- `numbering`: at the first lined record, whether each player's pose is their expected person.
- `identity_switches`: per player, changes of the GT person behind their pose (ignoring
  records where it matches nobody), summed.
- `bystander_takeovers`: runs (`events`) and records (`frames`) where a player's pose is a
  bystander.
- `all_in_view_ms` (first GT frame with every player present), `all_tracked_ms` (first record
  with a pose for every player) and `all_correct_ms` (first lined record with every player
  correct), with `_delay_ms` from all in view.

### Calibration (`calibration`)

Replays `WebcamCalibration` in the loop (above). `complete_ms`: capture time of the record that
completed it; `holds_started` and `hold_resets` (holds that ended without completing) during
setup (before the dance window) until then; `gt_hold_ms`, how long the GT players all hold
still (the game needs `WEBCAM_STILL_MS`, 2.5 s, of it); `tracking_refreshes` (setup line-up retries); `complete_after_hold_ms` from the first GT
frame where every player is in a `hold` segment; `complete_before_dance`.

### Score fidelity (`score`), the north star

- **Reference**: a SongBundle (through the binary format and the game's loader) whose dancer
  track k is GT person `mapping[k]`'s 2D pose at every frame of the dance window, every joint
  with confidence 1 (the routine the player dances, including joints the camera can't see), so
  the default cast scores player k against their own person. `playableStartMs`/`EndMs` are the
  window's first and last frame times; song time is the scene's time.
- **Live input**, fed as `GameSession.onRecord` does: each record's poses at song time = their
  capture time, accepted from 1 s before the song to `LATE_ALLOWANCE_MS` (750) after it, in
  arrival order, `scorer.advance(min(arrival, end) - 750)` after each record, then `finish()`.
  The tracked joints' confidences go in unchanged. The scorer's 0.1 gate compares confidence
  in the recording format's quantised steps and trusts null. A lost limb keeps its last
  direction for 300 ms (`HOLD_MS` in `scorer.ts`).
- `gt_score`: the GT itself as live input at every frame (joints outside the picture conf 0,
  others 1): the most a player could get with this framing. `gt_same_times_score`: the GT at
  the tracked records' times (isolates dropped frames and the pose rate). `tracked_score`: the
  tracked poses. **`score_lost` = gt_score - tracked_score** (mean over players, of 1,000,000),
  `score_lost_frac` of the GT score; per player in `players` (grades, coverage, judgements).
- `judgements`: per one-second window, the GT run's judgement against the tracked run's:
  `downgraded` (windows judged lower; order perfect > good > ok > miss > lost),
  `mean_levels_lost`, `to_lost`, and the `matrix` of transitions.

### Cost (`cost`)

`inference_ms` (the worker's own timing: model plus strips, not looks) and `roundtrip_ms`
(postMessage to result, the realtime busy time), mean and p95; `processed` frames,
`dropped_results`, `pose_rate_hz` (records the game kept per second of scene; in realtime runs
the effective pose rate), `camera_fps`.

## Reports

`report.ts` reads every `metrics.json`, and writes the mean of each column per estimator (with
deltas against the baseline over the scenes both ran), per category, a per-scene table of
score lost (identity accuracy, recall), per-scene score-lost deltas against the baseline, and
the worst scenes per headline metric. The JSON has the same plus every row.

## Files

| File | |
|---|---|
| `common.ts` | paths, contract types, scene loading, torso scale, pose distance, Hungarian matching |
| `gameloop.ts` | the game's per-result steps: tracker, frame-age drop, calibration, setup retry |
| `run-game.ts` | the game's worker in Chromium/Metal over a scene (offline or realtime) |
| `track.ts` | any detections through `gameloop.ts` |
| `looks.ts`, `browser.ts` | 128-wide frame pixels for looks; GPU Chromium and the static server |
| `score.ts` | reference SongBundle from GT; GameSession-style scoring |
| `metrics.ts` | every metric above |
| `report.ts` | aggregation |
| `fixtures.ts`, `harness.test.ts` | synthetic scenes (pinhole-projected stick dancers) and the tests |
