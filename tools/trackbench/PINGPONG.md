# Ping-pong tracking: the meter and a first baseline

The Table Tennis minigame turns each tracked player into a first-person paddle: `arms.ts handPose`
puts the wrist in the room from the pose, its world landmarks and the Hand Landmarker, the hand's
axes give the paddle's turn, a one-euro filter smooths it, and rig.ts puts the blade
`REACH × wrist + (MITT + BLADE_UP) × dir` from the shoulder. This file is how to measure that
against ground truth, and what the existing (dance) scenes say about it today.

## How to run

```sh
H=tools/trackbench/harness
npm run build && git commit ...      # run-game serves dist/ snapshotted by commit
# The game's worker with the detail Table Tennis asks for (one player: 'hands'; two: 'hands:right/right'):
node $H/run-suite.ts --id pp-tt --jobs 4 base-solo cam- mp2- -- --detail minigame:table-tennis
#   (run-suite then runs metrics.ts on scenes with GT and pingpong.ts on every scene)
# One scene, or a resolution experiment (a 1280x960 render fed as the game's 640x480 webcam):
node $H/run-game.ts <scene> --id pp-tt-640 --detail minigame:table-tennis --input-size 640x480
# Timing: realtime, alone, on a quiet machine (ps -Ao pcpu,comm | sort -rn | head):
node $H/run-game.ts <scene> --realtime --id pp-rt-tt --detail minigame:table-tennis
# A real clip without GT: frames in $TRACKBENCH_DATA/clips/<id>/frames, a spec.json with fps and players.
node $H/run-game.ts real-pp-user --id pp-tt --detail minigame:table-tennis --input-size 640x360
# Metrics (pingpong.json beside metrics.json), the report, and a paired comparison of two runs:
node $H/pingpong.ts pp-tt
node $H/pp-report.ts pp-tt --exclude real-
node $H/pp-report.ts pp-world --compare pp-tt --exclude real-     # pp-tt − pp-world, cluster bootstrap
node --test $H/pingpong.test.ts
# A change to arms.ts or rig.ts, without the worker: re-read another run's recordings into a new run id.
node $H/pingpong.ts ppt-mychange --from ppt-tt --jobs 8
# The blade's noise profile (bias, slow and frame-to-frame per axis, wild poses, lost stretches) per player count:
node $H/pp-noise.ts ppt-mychange --exclude pp-held
```

`--detail` takes `none | world | hands | hands:<left|right|both>/... | minigame:<id>`. The
harness sends the worker the game's own `detail` message (`WebcamPoseSource.detailRequest`),
waits for the hand model's answer, sends `lined` with every frame, records `world` and `hands`
per detection, and passes them through `GameLoop` into `PlayerTracker.update` as
`WebcamPoseSource.extras` does (hands stay on however slow tracking is, as on a webcam).
`--input-size` scales frames as they're decoded. The worker's `initialize` settings
come from `WebcamPoseSource.workerSettings`, which `connect` uses too (a test fails if either side
stops sharing them).

## What pingpong.ts measures

Everything is computed from `tracked.jsonl` with the game's own code: `handPose`, `flatWorld`,
`OneEuro` with `HAND_FILTERS`, and `REACH`, `MITT`, `BLADE_UP` and `RAISED` (in rig.ts). Capture times feed the filter, as in the game (rig.ts takeHand). GT
joints go to camera space through meta.json's per-frame `camera_to_world` (checked: 0.02 px
reprojection, 0.1 mm depth on the pinhole scenes). Frame: the player's, as `handPose` reports it
(x their right, y up, z back, so **bias z < 0 means the paddle is read nearer the camera than
the hand is**). Each record's poses are matched to GT people per frame, as metrics.ts does.

- **Wrist**: `handPose(...).wrist` (from its shoulder) minus the GT's. Per axis: **bias** (signed
  mean), **sd** (the scatter left after the bias is removed), median and p90 of the size; for the
  length, its median and p90, and `unbiased_median` (the length once each axis's bias is gone).
  The same at the camera's true FOV instead of the assumed 65° (`wrist_true_fov`), and after the
  game's filter.
- **Blade**: the blade centre rig.ts gives, from tracked and GT wrist and `dir`. It leaves out
  the screen-rate easing, the aim assist's slide and the paddle calibration's x/y shift. GT `dir`
  runs from the wrist to the middle knuckle: hand point 9 when the GT has 21 hand points, else
  midway between the index and pinky knuckles, as arms.ts does from the pose.
- **Splits**: motion state, by the GT wrist's speed relative to its shoulder (rest < 0.15 m/s,
  swing ≥ 1 m/s, peak = a swing's local maximum ≥ 1.5 m/s); GT visibility of the wrist; source
  (`from`: hand or pose); GT phase; player; and **reach**: `forward` when the GT wrist is ≥ 20 cm
  in front of its shoulder, as a ping-pong stance holds the paddle.
- **Velocity**: wrist-velocity error between consecutive records, and the swing speed ratio
  (|v tracked| / |v GT| while the GT moves ≥ 1 m/s), raw and filtered.
- **Lag**: the shift (ms) that best lines up the tracked wrist path with the GT's (mean-removed
  least squares, 5 ms steps, parabola-refined), raw and filtered, against capture times. The
  felt lag is `latency` (arrival − capture, realtime runs only) plus this.
- **Jitter at rest**: RMS distance from a centred ±200 ms moving average over GT-rest stretches
  (without GT, over stretches where the filtered wrist moves < 0.15 m/s), raw, filtered, and for
  the filtered blade.
- **Hand Landmarker**: found rate per wanted hand (where the GT wrist is in the picture), wrong
  side (the found hand's wrist nearest the person's other GT wrist), wrong person (nearest
  another person's), the hand's wrist error in px against the pose's on the same frames, the
  knuckles, the 21-point error when GT has it (absolute, and relative to wrist-to-middle-knuckle),
  and the `dir` / `across` angle errors. Without GT, a side flip is a hand nearer the pose's
  other wrist.
- **World landmarks**: root-aligned arm MPJPE (11-16), and for upper arms and forearms whose GT
  depth changes by ≥ 8 cm: the sign error rate, the share of GT-backward bones that arms.ts takes
  as forward (a forearm is forward unless the model says back by `SURELY_BACK`, 12 cm; an upper
  arm leans the way the model leans it, `upperArmForward`; until 2026-11-09 every bone went by
  `SURELY_BACK`), and the reverse.
- **Serve raise** (the free hand; both hands when no paddle hand is known): the game's state
  from the filtered wrist height with `RAISED`'s hysteresis, and the hand lost after 500 ms,
  against the same rule on the GT: false triggers per minute, the share of GT raises missed
  (matched within 500 ms), onset delay, and per-frame false-up and missed-up shares.
- **Cost**: inference and round-trip ms, pose Hz, dropped results and camera frames, the hand
  model's state and whether it was dropped, and whether the worker completed.

The paddle hand is the GT's `paddle.hand`, else the detail's single hand for that player, else
both (one player's `hands`). Report tables are means over scenes of per-scene medians. Paired
comparisons resample render clusters (post-only variants share `render_key`).

## Baseline (2026-11-09; dist snapshots c2ed93f7 for pp-tt, 59dd3eb3 for pp-world: the same worker and game code)

Run `pp-tt`: 53 existing scenes (base-solo, base-genre-*, cam-*, light-*, base-duo, mp2-*), the
game's settings (Lite, 640x480, `minigame:table-tennis`), offline. Report:
`$TRACKBENCH_DATA/reports/pp-tt.md`.

| class | scenes | paddle tracked | wrist cm | bias x | bias y | bias z | sd x | sd y | sd z | blade filt | wrist fwd cm | fwd bias z | lag filt ms | jitter filt cm | hand found | wrong side | back read fwd | raise false/min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline/1p | 11 | 0.961 | 20.6 | 0.4 | -3.6 | -20.5 | 11.0 | 6.8 | 17.3 | 28.6 | 12.3 | -6.4 | 23 | 0.20 | 0.656 | 0.059 | 0.903 | 2.73 |
| camera/1p | 14 | 0.975 | 21.1 | 0.6 | -4.1 | -21.1 | 12.7 | 6.0 | 22.6 | 31.1 | 12.3 | -0.6 | 23 | 1.99 | 0.507 | 0.104 | 0.938 | 0.29 |
| lighting/1p | 9 | 0.965 | 22.3 | 0.5 | -3.1 | -22.0 | 12.8 | 6.7 | 22.4 | 33.2 | 12.3 | -1.1 | 26 | 2.06 | 0.310 | 0.153 | 0.943 | 0.61 |
| baseline/2p | 1 | 0.945 | 18.0 | 0.1 | -0.5 | -18.1 | 8.9 | 7.5 | 17.7 | 28.3 | 10.2 | 2.8 | 19 | 0.39 | 0.606 | 0.030 | 0.881 | 2.61 |
| multiplayer/2p | 17 | 0.877 | 20.9 | -0.6 | 0.0 | -19.5 | 10.4 | 8.6 | 17.7 | 30.7 | 11.3 | 0.7 | 21 | 0.79 | 0.571 | 0.042 | 0.890 | 2.34 |
| bystander/2p | 1 | 0.824 | 16.6 | 1.1 | -0.7 | -16.1 | 7.6 | 5.9 | 15.8 | 27.2 | 11.6 | -3.2 | 25 | 0.78 | 0.436 | 0.023 | 0.894 | 0.00 |
| **all** | 53 | 0.935 | 21.0 | 0.2 | -2.4 | -20.5 | 11.4 | 7.2 | 19.7 | 30.7 | 11.9 | -1.5 | 23 | 1.19 | 0.526 | 0.080 | 0.914 | 1.55 |

Forward-reaching frames only (18% of paddle samples; every scene has some), means over scenes:

| | median | p90 | bias x / y / z | sd x / y / z |
|---|---|---|---|---|
| wrist | 11.9 cm | 28.0 | 0.5 / -3.9 / -1.5 | 11.4 / 7.4 / 12.0 |
| blade (filtered) | 16.1 cm | 35.7 | 1.1 / -3.0 / 1.3 | 13.9 / 12.0 / 13.9 |
| not forward: wrist | 22.4 cm | | 0.0 / -2.1 / **-24.8** | 11.3 / 6.9 / 18.4 |

**Hands on vs off** (`pp-world` = `--detail world`, same scenes; `pp-tt − pp-world`, 95% cluster
bootstrap): blade −3.0 cm [−3.6, −2.3] (better, from `dir`: 36° → 30°); wrist length no change
(−0.3 [−0.7, 0.1]); x scatter +3.7 cm [2.7, 4.7] (worse); `across` +11° (worse); jitter at rest
0.40 → 1.19 cm filtered (worse); false serve raises 0.55 → 1.55 a minute (worse); paddle tracked
+0.7 pts. The pose model's own outputs are identical in both runs (world arm error and depth
signs: Δ 0.000), as they should be.

**Cost, realtime** (`--realtime`, one at a time, **provisional**: three Blender renders were
running on the machine):

| scene | detail | inference ms (mean / p95) | pose Hz | latency ms | camera frames dropped | hands |
|---|---|---|---|---|---|---|
| base-solo | hands | 25.2 / 45.9 | 28.7 | 30 | 30 / 675 | on |
| base-solo | world | 9.5 / 17.9 | 30.0 | 10 | 0 | – |
| base-duo | hands:right/right | 37.5 / 73.9 | 24.5 | 47 | 126 / 690 | on, kept |
| base-duo | world | 17.7 / 30.3 | 30.0 | 18 | 0 | – |
| mp2-close-far | hands:right/right | 49.2 / 95.3 | 19.9 | 62 | 243 / 720 | on, kept |
| mp2-close-far | world | 30.8 / 54.6 | 28.0 | 39 | 48 | – |

With two players' hands the worker (two pose landmarkers + two hand landmarkers, at Chrome's
four-contexts-per-worker limit) survived both scenes, and the game's 15 Hz drop never triggered.
Felt lag (latency + filtered lag) on mp2-close-far with hands: about 62 + 80 ms.

**Real clip** (`real-pp-user`: the owner playing the old demo, 69 s, no GT, 640x360 as the game
would get it; and at its native 1280x720 as `pp-tt-native`): hand found 0.756 (native 0.728),
side flips 2.8% (2.7%), filtered wrist jitter while still 0.32 cm (0.29), filtered blade jitter
0.90 cm, 76% of paddle poses from the hand, 30 Hz offline. (Inference ms on this clip ran while
the suite was running, so it isn't comparable.)

## Reading it honestly

**What the existing scenes can tell us.** They're full-body dance at 2-6.5 m, 640x480: arms
everywhere, often down, back or overhead, rarely held out in front at ping-pong distance, with
no paddle and only wrist + 3 knuckles of hand GT. They do measure the parts of the pipeline that
don't care what the dance is: arms.ts's geometry, the world landmarks' depth directions, the
filter's lag and jitter, the hand model's found rate and side errors by camera, distance and
light, two-player hand assignment, and cost. They can't tell us how the paddle does in a real
ping-pong stance (arms forward, close framing, fast short swings), the 21-point hand and `across`
accuracy against real hand GT, or anything about holding a paddle. The new scenes are for that,
and the forward-reach split is the nearest stand-in until they land.

1. **The overall −20 cm depth bias is mostly arms pointing back.** arms.ts takes each bone as
   pointing forward unless the world landmarks say back by 12 cm, and the world landmarks almost
   never do: 91% of GT-backward bones are read forward, 0.4% the other way, and 23% of clearly
   inclined bones have the wrong depth sign. Not-forward frames carry −25 cm of bias. With the
   wrist really in front (forward-reach frames) the bias is under 4 cm on every axis. For
   ping-pong this matters on backswings and low wrists by the hip, less in the ready stance.
2. **Where the hand really is in front, the error is scatter, not bias**: 11-12 cm sd in x and z
   and 7 cm in y at the wrist, 12-14 cm at the blade. The game's paddle calibration (x and y
   shifts, calibrate.ts) can only remove bias, and depth isn't calibrated at all. This scatter is
   what to attack.
3. **FOV error is not the problem.** At the true 90° FOV instead of 65° the wrist gets slightly
   *worse* (cam-fov-90: 20.7 → 21.6 cm). Depth (f × metres ÷ pixels) and the rays' spread change
   together, and the arm-length constraints keep the wrist near the shoulder. (The 120° scenes are
   barrel-distorted, so their true-FOV numbers are only indicative.)
4. **The Hand Landmarker helps the hand's direction and hurts its position stability.** `dir`
   improves (pose 38° → hand 24°), so the blade gains 3 cm. But hand-sourced wrists have heavy
   x tails (sd 13.5 cm, median 3.5 cm, against the pose's 7.8 and 3.5), jitter at rest
   triples, and false serve raises triple. The likely cause is the 8% of found hands on the
   wrong side (15% in the lighting scenes). arms.ts then puts the wrist ray through the other
   hand while the elbow comes from the pose, plus switching between the hand and pose wrists
   frame to frame (55% of paddle poses came from the hand). Found rate collapses with distance
   and light: 0.66 at 3 m bright, 0.44 at 5 m, 0.11 at 6.5 m, 0.02 at 120° FOV, 0.05-0.11 in TV
   glow, dim evening and party light.
5. **`across` (the paddle face's turn) is unreliable from either source**: 66° median error from
   the hand, 55° from the pose. It's bimodal: roughly half right, half nearly reversed. That looks
   like the 3D hand's palm/back (depth) ambiguity, so the paddle's face would flip. It needs the
   21-point hand GT to confirm against, but it's the biggest orientation error.
6. **Timing is fine offline and dominated by latency live.** Lag from the model is about 6 ms and
   from the filter about 23 ms; at swing speeds the filtered speed is right (ratio 0.97). Live,
   the hands push latency to 30-60 ms and drop pose Hz to 20-25 with two players. The game's ball
   compensation (`lagOf`: latency + 50 ms) leaves out the filter's ~20-80 ms.
7. **Serve raise**: 21% of GT raises are missed or late beyond 500 ms (dance raises are often
   brief, so this overstates real misses); false triggers are 1.5 a minute with hands, 0.55
   without.
8. **Two players**: hands found 0.57 (one player: 0.50, pulled down by the far, wide and dim single-player scenes; the duo scenes have none),
   wrong person 1.7% (17% on mp2-tight, 11% on mp2-close-offcentre, about 0 elsewhere), paddle
   tracked 0.88 against 0.97 for one player (identity and occlusion losses).

Verified vs assumed: the GT transform, the plumbing (world and hands recorded, reaching
tracked.jsonl, dropped by the game's rule in a unit test) and every metric's arithmetic (unit
tests with known answers, including an exactly tracked synthetic player at 0.3 cm and a 3-frame
delay measured as 100 ms) are verified. Also verified: arms.ts on exact input still errs about
1 cm median, 3 cm p90, on a forearm sweeping across the body (its flat-at-near-depth
approximation). Assumed: that the GT `dir` from the body knuckles matches what the game means by
the hand's axis; that the dance scenes' 18% forward-reach frames stand in for a ping-pong stance;
the cause of the `across` bimodality and of the hand x tails (point 4 is an inference from the
numbers); and the realtime timings, which are provisional.

## What I'd test next, ranked

1. **Run the new ping-pong scenes** (swings, close framings, 1 and 2 players, 1280x960) through
   `pp-tt` and `--input-size 640x480` vs native: the real stance numbers, and whether a higher
   capture resolution buys hand found rate and scatter for its cost.
2. **Depth direction**: replace "forward unless the model says back by 12 cm" (91% of backward
   bones read forward) with something that can say back: a lower threshold, the hand's apparent
   size, or temporal continuity through the backswing. Measure `back_read_forward`, the
   not-forward bias and the forward-reach scatter together.
3. **Reject a hand that disagrees with the pose's wrist** (on the other wrist, or far from its
   own) before arms.ts uses its wrist, and stop wrist-ray switching from adding a step. Measure
   x sd, jitter, false raises and `hand_wrong_side`.
4. **The paddle face (`across`)**: with the new 21-point GT, find whether the hand's world
   landmarks flip palm and back, and use the pose's or a temporally consistent sign.
5. **Scatter in the forward stance**: smoothing tuned on swing data (the filter costs ~20 ms
   and keeps the speed), and a per-player bone-length calibration in place of the fixed torso
   ratios (`UPPER_ARM`, `FOREARM`).
6. **Ball compensation**: add the measured filter lag to `lagOf`, and re-take the realtime cost
   table on a quiet machine (`--jobs 1`), with the game's rendering load (`--busy-scale`).

## Results: tracking changes (2026-11-09, branch feat-pingpong-tracking; full-set remeasurement)

All 34 ping-pong scenes are now measured: **22 one-player tuning** (`pp1-*`), **8 two-player
tuning** (`pp2-*`), and **4 held-out** (`pp-held-*`, two one-player and two two-player).
All are 600 frames at 1280x960 with 21-point hand and paddle GT. SUITE.md on
feat-trackbench-pingpong-scenes describes the factors and shared rallies. The held-out set
stays separate; nothing was tuned in this pass.

Recordings: `ppt-tt` (640x480) and `ppt-tt-native` (1280x960). Sixteen scenes were already
complete in each; the missing 18 in each ran offline with `run-suite.ts --jobs 8`,
`--detail minigame:table-tennis`, and `--input-size 640x480` only for `ppt-tt`.
All 68 recordings have a completed, error-free run.json, detections and tracking for all
600 GT frames, and the same GPU worker (`pose.worker-yE2vCQ3b.js`, verified by SHA-256).
The new dist snapshot is 5732133e; the earlier recordings' snapshots are unchanged.

The original code (`ppt-F0` in the earlier tables) is remeasured as `ppt-remeasure-F0-pp`
and `ppt-remeasure-F0-ppn`; this branch at 5732133e (`ppt-F4`) as `ppt-remeasure-F4-pp`
and `ppt-remeasure-F4-ppn`. All use `pingpong.ts <id> --from ppt-tt` (or `ppt-tt-native`)
over exactly the same recordings. Original arms.ts and rig.ts are loaded from 05e23491
(the parent of 5a579474), without editing game files. The loader only supplies the old
hard direction rule to the new metric export and adapts the newer harness's extra swing-age
argument to the original API. Original and intermediate summaries reproduce every saved
summary on their overlapping scenes. This branch also includes the merge's later swing
corroboration rule; that changes a few swing/serve counts from the saved F4 results.
Loader, recording audit and measurement logs are under `$TRACKBENCH_DATA/reports/ppt-remeasure/`.
Earlier run outputs are preserved. A concurrent GT-only refresh completed before the final
metrics pass; GT, meta and spec checksums stayed fixed throughout it (`input-checksums.json`).
It did not change the report summaries.

**Intervals below are the report's paired 95% cluster bootstrap, not rally-independent
intervals.** `pp-report.ts` uses only meta.json's `render_key`: 22/8/4 scenes become 21/8/4
render clusters. It joins `pp1-base` with its post-only `pp1-sensor-cheap`, but does **not**
join separately rendered scenes sharing a rally: the one-factor pp1-base variants,
pp1-lefty/-lefty-paddle, or pp1-sleeves-dark/-sleeves-wall. The requested
report was run without changing its clustering; its intervals can overstate independence.
The held-out splits have only two scenes each, so the report returns no interval for them.

Reports: `$TRACKBENCH_DATA/reports/ppt-remeasure-{pp,ppn}-{1p,2p,held,held1p,held2p}.md`
and `.json`; native-minus-640 reports are `ppt-remeasure-resolution-{1p,2p,held,held1p,held2p}`.
For example:

```sh
node tools/trackbench/harness/pp-report.ts ppt-remeasure-F0-pp --compare ppt-remeasure-F4-pp --scenes pp2- --name ppt-remeasure-pp-2p
node tools/trackbench/harness/pp-report.ts ppt-remeasure-F4-pp --compare ppt-remeasure-F4-ppn --scenes pp2- --name ppt-remeasure-resolution-2p
node tools/trackbench/harness/pp-noise.ts ppt-remeasure-F4-pp --scenes pp1-
```

### The ping-pong scenes against the dance-scene baseline

At the original code, means over tuning scenes at 640x480:

| | scenes | wrist cm | depth bias cm | forward-stance wrist cm | blade median, filtered cm | hand found | wrong side |
|---|---|---|---|---|---|---|---|
| one player | 22 | 13.02 | −12.94 | 9.03 | 15.30 | 0.863 | 2.11% |
| two players | 8 | 10.14 | −10.73 | 7.04 | 15.50 | 0.665 | 0.67% |

The dance baseline was wrist 21.0 cm, blade 30.7 cm, hand found 0.53 and wrong side 8%.
The pp scenes' depth errors are largest in serves and backswings, with the elbow behind the
shoulder. The earlier 10-scene tuning wrist result was 13.5 → 7.3 cm; the full one-player
set is 13.02 → 7.13. The dance scenes' 55-66° `across` was mostly their GT: the body's index
and pinky points do not give the hand's own axis; pp's 21-point hand GT measures it directly.

### Kept

The stages are remeasured over the full 640x480 set, one change at a time (`ppt-remeasure-F0`
through F3, then F4-premerge, then this branch). Each cell gives the change and its paired
interval. cm unless stated; the clustering limitation above applies throughout.

| change | commit | one-player tuning (22) | two-player tuning (8) | held-out (4) |
|---|---|---|---|---|
| leave out a found hand nearer the other wrist or > 1.5 of its lengths from its own | 5a579474 | wrist −0.17 [−0.27, −0.08]; blade p90 −0.64 [−0.96, −0.34] | wrist −0.16 [−0.44, 0.00]; blade p90 −0.08 [−0.32, 0.08] | wrist −0.19 [−0.36, −0.03]; blade p90 −1.07 [−2.11, −0.03] |
| keep the hand's `across` 0.5 s when it's lost | 17b06951 | filtered across p90 ° −6.81 [−12.35, −0.78] | filtered across p90 ° −12.11 [−19.52, −5.15] | filtered across p90 ° +3.50 [−3.40, 14.75] |
| filter by capture time, not arrival | e7de0f2e | no offline change (capture = arrival) | no offline change (capture = arrival) | no offline change (capture = arrival) |
| lean the upper arm as far as the model does: −tanh(dz ÷ 0.16) | 152ae9de | wrist −5.72 [−6.74, −4.50]; forward wrist −3.06 [−3.85, −2.14]; blade −5.92 [−6.99, −4.62]; false swings /min −1.18 [−2.13, −0.21] | wrist −2.52 [−4.59, −0.57]; forward wrist +0.32 [−1.38, 2.03]; blade −4.25 [−5.54, −2.82]; false swings /min +0.19 [−0.95, 1.52] | wrist −2.84 [−8.97, 0.83]; forward wrist −0.87 [−5.31, 2.00]; blade −4.80 [−9.68, −2.17]; false swings /min −0.77 [−1.53, 0.00] |
| later swing corroboration rule included by the merge | 8ec129bc | false swings /min +0.07 [0.00, 0.22] | false swings /min −0.76 [−2.27, 0.00] | false swings /min 0.00 [0.00, 0.00] |

The hand gate's one-player wrist improvement remains, but the earlier partial-set false-swing
reduction from the combined changes (−1.2/min [−2.1, −0.2]) is now −1.10/min [−2.16, +0.01]:
it no longer excludes zero. The upper-arm change alone reduces one-player false swings,
but its two-player change is +0.19/min [−0.96, +1.52], rather than a reduction. Across-holding's
held-out p90 changes by +3.50° [−3.40, +14.75], also inconclusive.

**All together**, original → this branch. Parentheses contain Δ and its paired interval.
Blade median is filtered; blade p90 is raw, as `pingpong.json.summary.blade_p90_cm` reports it.
Lag is the drawn blade at swing speed, offline (latency zero).

**640x480:**

| measure | one-player tuning (22) | two-player tuning (8) | held-out (4) |
|---|---|---|---|
| wrist cm | 13.02 → 7.13 (−5.89 [−6.91, −4.67]) | 10.14 → 7.46 (−2.68 [−4.84, −0.62]) | 11.69 → 8.65 (−3.04 [−9.32, 0.60]) |
| forward-stance wrist cm | 9.03 → 5.86 (−3.18 [−4.00, −2.24]) | 7.04 → 7.27 (+0.23 [−1.55, 2.01]) | 8.46 → 7.51 (−0.95 [−5.50, 1.96]) |
| blade median, filtered cm | 15.30 → 9.27 (−6.03 [−7.03, −4.81]) | 15.50 → 11.22 (−4.28 [−5.62, −2.81]) | 16.29 → 11.05 (−5.24 [−9.83, −2.58]) |
| blade p90, raw cm | 35.52 → 21.01 (−14.51 [−15.57, −13.37]) | 41.67 → 30.32 (−11.35 [−15.71, −6.45]) | 41.53 → 32.31 (−9.22 [−14.18, −4.86]) |
| blade in swings, filtered cm | 18.65 → 14.38 (−4.27 [−5.13, −3.39]) | 21.76 → 17.88 (−3.88 [−5.21, −2.47]) | 25.79 → 22.88 (−2.92 [−4.71, −1.13]) |
| false swings /min | 3.62 → 2.52 (−1.10 [−2.16, 0.01]) | 14.29 → 11.04 (−3.25 [−8.21, −0.18]) | 5.67 → 3.35 (−2.32 [−5.04, −0.38]) |
| false swings at rest /min | 5.58 → 3.29 (−2.29 [−3.50, −1.08]) | 6.12 → 2.87 (−3.25 [−10.32, 0.76]) | 4.74 → 1.16 (−3.58 [−4.83, −2.29]) |
| rest jitter, filtered cm | 0.68 → 0.57 (−0.12 [−0.25, −0.01]) | 0.97 → 0.67 (−0.30 [−1.03, 0.16]) | 0.85 → 0.56 (−0.29 [−0.58, 0.01]) |
| drawn lag at swing speed ms | 77.0 → 81.3 (+4.3 [3.1, 5.5]) | 86.6 → 91.1 (+4.5 [2.5, 6.8]) | 87.7 → 94.1 (+6.4 [3.0, 9.9]) |
| swing misses (share) | 0.046 → 0.066 (+0.020 [0.008, 0.034]) | 0.024 → 0.022 (−0.002 [−0.019, 0.020]) | 0.034 → 0.015 (−0.019 [−0.058, 0.000]) |

**Native 1280x960:**

| measure | one-player tuning (22) | two-player tuning (8) | held-out (4) |
|---|---|---|---|
| wrist cm | 12.91 → 7.16 (−5.76 [−6.76, −4.54]) | 10.12 → 7.46 (−2.66 [−4.68, −0.69]) | 11.75 → 8.59 (−3.17 [−9.70, 0.81]) |
| forward-stance wrist cm | 8.86 → 5.85 (−3.00 [−3.78, −2.12]) | 6.91 → 7.28 (+0.37 [−1.31, 1.97]) | 8.57 → 7.49 (−1.08 [−5.68, 1.87]) |
| blade median, filtered cm | 15.37 → 9.27 (−6.10 [−7.20, −4.76]) | 15.36 → 11.23 (−4.14 [−5.81, −2.49]) | 16.43 → 11.07 (−5.36 [−9.80, −2.29]) |
| blade p90, raw cm | 35.27 → 21.27 (−14.00 [−15.10, −12.78]) | 41.84 → 30.18 (−11.66 [−16.07, −6.57]) | 41.56 → 31.71 (−9.85 [−14.89, −4.65]) |
| blade in swings, filtered cm | 18.67 → 14.43 (−4.24 [−5.10, −3.35]) | 21.14 → 17.24 (−3.89 [−5.34, −2.61]) | 25.69 → 22.68 (−3.01 [−4.59, −1.43]) |
| false swings /min | 4.12 → 2.16 (−1.95 [−2.87, −1.16]) | 11.99 → 10.28 (−1.71 [−3.62, 0.00]) | 4.08 → 3.70 (−0.38 [−1.15, 0.00]) |
| false swings at rest /min | 5.79 → 4.19 (−1.60 [−2.78, −0.45]) | 3.07 → 2.49 (−0.58 [−2.30, 0.77]) | 2.73 → 1.15 (−1.58 [−2.83, −0.38]) |
| rest jitter, filtered cm | 0.63 → 0.54 (−0.09 [−0.18, 0.00]) | 0.63 → 0.60 (−0.03 [−0.13, 0.06]) | 1.07 → 0.67 (−0.41 [−1.27, 0.18]) |
| drawn lag at swing speed ms | 77.7 → 82.1 (+4.5 [3.2, 5.9]) | 85.8 → 90.1 (+4.3 [2.5, 6.6]) | 84.9 → 91.5 (+6.7 [4.8, 9.1]) |
| swing misses (share) | 0.060 → 0.063 (+0.003 [−0.014, 0.018]) | 0.027 → 0.026 (−0.001 [−0.025, 0.017]) | 0.099 → 0.083 (−0.017 [−0.056, 0.007]) |

The two-player tuning forward-stance wrist goes slightly the other way from one-player
tuning: 7.04 → 7.27 cm, Δ +0.23 [−1.55, +2.01], not a clear change. The new two-player
tuning false-swing rate is 11.04/min after the changes; the held-out two-player rate is
6.71/min, so the held-out pair did not describe the tuning pair's full range.
Held-out wrist and forward-wrist intervals still include zero; blade improves, with more
drawn lag. One-player rest jitter now excludes zero at 640x480 (−0.115 cm [−0.252, −0.007]);
at native it does not (−0.090 [−0.180, +0.003]).

**Held-out, split by players, 640x480** (descriptive; two scenes per row, no bootstrap interval):

| measure | one player (held-1/3) | two players (held-2/4) |
|---|---|---|
| wrist cm | 12.67 → 6.53 | 10.71 → 10.78 |
| forward-stance wrist cm | 8.44 → 5.54 | 8.47 → 9.47 |
| blade median, filtered cm | 16.81 → 8.91 | 15.78 → 13.20 |
| blade p90, raw cm | 40.16 → 26.69 | 42.91 → 37.93 |
| blade in swings, filtered cm | 23.16 → 20.31 | 28.42 → 25.44 |
| false swings /min | 3.87 → 0.00 | 7.47 → 6.71 |
| false swings at rest /min | 4.63 → 2.31 | 4.83 → 0.00 |
| rest jitter, filtered cm | 0.82 → 0.55 | 0.89 → 0.57 |
| drawn lag at swing speed ms | 85.7 → 92.5 | 89.8 → 95.7 |
| swing misses (share) | 0.038 → 0.000 | 0.029 → 0.029 |

The native split is in the paired reports: wrist 12.98 → 6.42 cm / 10.52 → 10.75,
forward wrist 8.79 → 5.59 / 8.36 → 9.39, filtered blade 17.54 → 9.10 / 15.32 → 13.04
(one player / two players). No intervals are available for either two-scene split.

**Scenes worse at the wrist or blade.** Positive changes only; a dash means that measure
did not get worse. Includes forward stance and raw blade p90, not just overall medians;
every scene is paired on the same recording. cm, original → this branch (+Δ).

| scene | input | wrist | forward wrist | blade median, filtered | blade p90, raw |
|---|---|---|---|---|---|
| pp-held-1 | 640x480 | 7.42 → 7.62 (+0.20) | 4.61 → 6.73 (+2.12) | – | – |
| pp-held-2 | 640x480 | – | 7.83 → 8.03 (+0.20) | – | – |
| pp-held-4 | 640x480 | 12.07 → 13.08 (+1.01) | 9.12 → 10.92 (+1.80) | – | – |
| pp1-lefty-paddle | 640x480 | 7.48 → 8.45 (+0.97) | 5.85 → 8.26 (+2.41) | 10.03 → 10.83 (+0.80) | – |
| pp1-near-phone | 640x480 | 8.03 → 8.25 (+0.22) | – | 10.03 → 10.38 (+0.35) | – |
| pp2-base | 640x480 | – | 3.09 → 5.20 (+2.11) | – | – |
| pp2-bystander | 640x480 | – | 9.01 → 9.10 (+0.09) | – | 54.79 → 55.63 (+0.84) |
| pp2-close | 640x480 | 8.05 → 9.61 (+1.56) | 6.00 → 10.28 (+4.28) | – | – |
| pp2-crossing | 640x480 | 6.83 → 6.92 (+0.09) | 3.96 → 6.25 (+2.29) | – | – |
| pp2-depths | 640x480 | – | 6.29 → 6.95 (+0.66) | – | – |
| pp-held-1 | native | – | 5.10 → 6.85 (+1.75) | – | – |
| pp-held-2 | native | – | 7.87 → 7.96 (+0.09) | – | – |
| pp-held-4 | native | 11.54 → 12.92 (+1.38) | 8.84 → 10.83 (+1.99) | – | – |
| pp1-lefty-paddle | native | 6.70 → 8.14 (+1.44) | 5.68 → 8.05 (+2.37) | 9.37 → 11.35 (+1.98) | – |
| pp2-base | native | – | 3.04 → 5.07 (+2.03) | – | – |
| pp2-bystander | native | – | 9.09 → 10.02 (+0.93) | – | 58.30 → 59.69 (+1.39) |
| pp2-close | native | 7.95 → 9.29 (+1.34) | 5.88 → 9.89 (+4.01) | – | – |
| pp2-crossing | native | – | 4.23 → 6.01 (+1.78) | – | – |
| pp2-depths | native | – | 6.01 → 7.25 (+1.24) | – | – |

On the dance scenes (the earlier measurements): wrist 21.0 → 11.4 cm, blade 30.7 → 18.2,
with forward reach worse (11.6 → 14.4). Play simulation (agency.ts --rounds 24) was unchanged
by the hand, `across` and lean changes (it feeds rig.ts takeHand directly); the capture-time
change moved hit rates within ±1-3 points. Those experiments were not re-run here.

### Tried and dropped

These are the original exploratory trials on the first 10 tuning scenes (and the dance
scenes where stated), not full-suite re-tests of the dropped changes.

- **A hard lower threshold** for the bone direction (0.08, 0.05, 0.03, 0 m): every one traded the
  forward stance (up to +3 cm) and rest jitter and false swings (frames near the threshold flip
  the depth by twice the bone's reach) for the backswing. Soft widths below 0.12 did the same,
  more mildly; 0.16 and 0.25 were best, 0.16 kept.
- **The soft rule on the forearm too** (θ 0.06, width 0.16): wrist −0.9 cm, blade −1.0 more, but
  false swings +0.7/min [+0.2, +1.3] at native size and the dance forward-reach +1.4 cm.
- **Measured arm lengths** (a running 80-90th percentile of each bone's flat length in torso
  lengths, both arms pooled): the GT bones are 0.53-0.56 (upper) and 0.47-0.52 (forearm) of
  the torso, not UPPER_ARM 0.62 / FOREARM 0.5, and the percentile is within ±4% for the upper
  arm, but the paddle forearm is foreshortened most of the time in a ping-pong stance (its
  percentile comes out 15-25% short). With the hard rule they cut the depth bias (pp −14 → −4 cm)
  but raised rest jitter 0.6 → 0.9 cm (a right-length bone hanging straight sits where
  √(L² − flat²) is steepest); a forearm at 0.91 of the measured upper arm and one-euro smoothing
  of each bone's flat share before the square root took the jitter back down at +3-5 ms. With the
  soft lean in place they add nothing (pp wrist +0.3, blade +0.5, forward stance +1.0, jitter
  +0.14 cm), so the fixed ratios stay.
- **An innovation gate** before the filter (hold a pose more than the gate from a constant-
  velocity prediction unless the next one bears it out): never fired on the pp scenes (no single
  wild poses there; their false swings come from backswings read the wrong way, and the walk-in);
  on the dance scenes a depth-only 0.2 m gate cut false swings 0.4/min for +3 ms and slower
  swings, and 0.1-0.2 m on all axes added 8-50 ms of lag.
- **Separate, heavier depth smoothing** (one-euro 0.3-0.6 Hz on z): rest jitter −0.03 to −0.09 cm
  for +1.7 to +3.6 ms, worse swing speed and +0.1-0.3 cm blade.
- **Faster screen easing** (followHands 24/s → 40/s, 70/s): −15 / −24 ms of drawn lag, but the
  swing detector's thresholds were tuned at 24/s (70/s: false serves +2.8/min on the dance scenes).
  Worth doing together with retuning SWING; not done here.
- **DRAW_LAG = the measured lag**: the paddle as drawn trails the GT blade by 77-79 ms offline
  (latency 0) at swing speed (model 2-7 ms, one-euro ~20, holding each 30 Hz pose ~17, the 24/s
  easing the rest), ~160 ms live with 46 ms latency, against lagOf's latency + 50 ms. In the play
  simulation 0.075 and 0.1 helped one player (good 96 → 97-98%) and hurt two (good 96 → 93 /
  89%; 0.035 was best for two), so DRAW_LAG stays 0.05 until the simulation's two-player round
  says why.
- **Carrying the hand's wrist offset** onto the pose's wrist while the hand is lost (the source
  switch steps 3.5 cm median, against 0.45 cm frame to frame on the hand, ~2.7 times a second):
  no change in jitter, accuracy or false swings (the filter absorbs it), −1 ms lag.
- **The worker without its handedness swap** (`sorted`, pose.worker.ts; run `ppt-nosort`): more
  hands kept (+2.6 points pp, +7 dance) but nothing downstream better, `across` p90 +5.5° on pp
  and false swings +0.3/min on the dance scenes. Kept as is.

### Resolution (item 6: measured, not changed)

Native minus 640x480, this branch, paired on every scene in each group. Δ [95% interval];
cm except found/side shares, degrees, false swings/min and lag ms. Offline inference cost
from parallel recordings is not a resolution timing measurement; realtime cost is below.

| measure | one-player tuning (22) | two-player tuning (8) | held-out (4) |
|---|---|---|---|
| wrist cm | +0.03 [−0.06, 0.10] | +0.01 [−0.21, 0.25] | −0.06 [−0.23, 0.10] |
| forward-stance wrist cm | 0.00 [−0.11, 0.09] | +0.02 [−0.25, 0.33] | −0.01 [−0.08, 0.07] |
| blade median, filtered cm | 0.00 [−0.16, 0.18] | +0.01 [−0.70, 0.90] | +0.02 [−0.47, 0.36] |
| blade p90, raw cm | +0.25 [−0.06, 0.69] | −0.15 [−1.16, 1.22] | −0.60 [−1.61, 0.01] |
| blade in swings, filtered cm | +0.05 [−0.29, 0.35] | −0.64 [−0.90, −0.33] | −0.20 [−1.02, 0.62] |
| false swings /min | −0.36 [−0.87, 0.19] | −0.76 [−2.48, 0.38] | +0.34 [−1.26, 2.29] |
| false swings at rest /min | +0.90 [−0.21, 2.07] | −0.38 [−1.52, 0.58] | −0.01 [−2.33, 3.05] |
| rest jitter, filtered cm | −0.03 [−0.07, 0.02] | −0.07 [−0.22, 0.06] | +0.11 [0.05, 0.17] |
| drawn lag at swing speed ms | +0.8 [−0.5, 2.2] | −1.0 [−2.6, 0.4] | −2.6 [−5.0, 1.8] |
| hand found (share) | +0.0056 [−0.0101, 0.0282] | +0.0642 [0.0316, 0.1010] | +0.0224 [−0.0416, 0.1092] |
| wrong side (share) | −0.0047 [−0.0077, −0.0022] | −0.0054 [−0.0100, −0.0016] | −0.0048 [−0.0102, −0.0010] |
| filtered across p90 ° | −5.66 [−12.10, 1.40] | −9.17 [−16.21, −1.90] | −6.70 [−24.47, 4.38] |
| swing misses (share) | −0.0030 [−0.0175, 0.0100] | +0.0033 [−0.0093, 0.0154] | +0.0681 [0.0135, 0.1317] |

The original partial-set blade resolution change was −0.2 cm; over all one-player tuning
scenes it is 0.00 [−0.16, +0.18]. Their hand-found gain is now only 0.6 points (interval includes
zero), rather than the earlier 2.7. Two-player tuning gains 6.4 found points [3.2, 10.1] and
0.64 cm in swings [0.33, 0.90], with no clear overall wrist or blade median change.
The far-TV scene still gains hand detection (0.73 → 0.92); resolution is not uniformly better:
held-out jitter rises 0.108 cm [0.050, 0.165] and swing misses rise 6.8 points [1.4, 13.2].

**Cost, realtime** (`--realtime --jobs 1`, each scene serially, Apple M5 Pro / Metal GPU):

The final pass started after 11.1 minutes waiting for a quiet window;
no Blender, active competing Chromium benchmark, Python scene check or ffmpeg workload was
detected during it (5 s process samples). PerfPowerServices still used background CPU.
An earlier pass overlapped restarted hand checks and is excluded.
Run ids: `ppt-remeasure-cost-final-{640,native}-{tt,world}`. Each suite used the four requested
scene prefixes; `pp1-near-laptop-paddle` also ran because the harness matches prefixes, but is
excluded here. No timings ran in parallel. Latency is mean arrival − capture; dropped camera
frames are out of 600, and dropped results are shown separately. This is the worker benchmark,
without an added game-rendering load (`busyScale = 1`).

| scene | input | detail | inference ms (mean / p95) | pose Hz | latency ms | camera frames dropped | results dropped | hands |
|---|---|---|---|---|---|---|---|---|
| pp1-base | 640x480 | table-tennis | 17.7 / 32.2 | 29.8 | 18.3 | 5 / 600 | 0 | on, kept |
| pp1-base | 640x480 | world | 7.7 / 11.4 | 30.0 | 7.8 | 0 / 600 | 0 | – |
| pp1-base | 1280x960 | table-tennis | 18.5 / 34.3 | 29.6 | 19.4 | 8 / 600 | 0 | on, kept |
| pp1-base | 1280x960 | world | 7.8 / 12.3 | 30.0 | 7.9 | 0 / 600 | 0 | – |
| pp1-near-laptop | 640x480 | table-tennis | 18.4 / 35.0 | 29.6 | 19.3 | 7 / 600 | 0 | on, kept |
| pp1-near-laptop | 640x480 | world | 7.6 / 10.7 | 30.0 | 7.7 | 0 / 600 | 0 | – |
| pp1-near-laptop | 1280x960 | table-tennis | 18.0 / 35.4 | 29.7 | 19.6 | 6 / 600 | 0 | on, kept |
| pp1-near-laptop | 1280x960 | world | 7.9 / 11.9 | 30.0 | 8.0 | 0 / 600 | 0 | – |
| pp2-base | 640x480 | table-tennis | 25.2 / 47.4 | 28.4 | 28.0 | 33 / 600 | 0 | on, kept |
| pp2-base | 640x480 | world | 12.8 / 19.5 | 30.0 | 13.1 | 0 / 600 | 0 | – |
| pp2-base | 1280x960 | table-tennis | 25.6 / 48.4 | 28.6 | 28.8 | 29 / 600 | 0 | on, kept |
| pp2-base | 1280x960 | world | 13.1 / 19.0 | 30.0 | 13.4 | 0 / 600 | 0 | – |
| pp2-close | 640x480 | table-tennis | 24.2 / 44.1 | 29.0 | 26.4 | 20 / 600 | 0 | on, kept |
| pp2-close | 640x480 | world | 12.9 / 19.6 | 30.0 | 13.1 | 0 / 600 | 0 | – |
| pp2-close | 1280x960 | table-tennis | 28.0 / 52.7 | 27.6 | 32.4 | 48 / 600 | 0 | on, kept |
| pp2-close | 1280x960 | world | 13.7 / 20.2 | 30.0 | 14.0 | 0 / 600 | 0 | – |

### Noise profile of the tracked blade (item 7)

`pp-noise.ts ppt-remeasure-F4-pp --scenes pp1-` (and `pp2-`, `pp-held-`), this branch at
640x480. The paddle-hand selection is unchanged: without GT paddle metadata or a single-hand
detail, both hands enter the profile, as described above. cm, the player's frame (x right, y up, z back). Bias is the sample-weighted mean of
scene biases ± their unweighted spread between scenes; slow is the sd of a ±250 ms average;
fast is what remains frame to frame. Raw is what the game's filter receives. Held-out rows
stay separate from tuning. Filtered and all-motion rows are in the saved noise profiles.

| | state | bias x | bias y | bias z | slow x / y / z | fast x / y / z |
|---|---|---|---|---|---|---|
| 1 player, 22 tuning scenes | rest | −0.1 ± 2.0 | −1.7 ± 0.8 | −1.7 ± 2.8 | 2.9 / 2.5 / 6.5 | 1.4 / 1.7 / 2.2 |
|  | swing | 1.0 ± 1.7 | −5.8 ± 1.3 | −4.5 ± 3.7 | 2.6 / 3.6 / 8.4 | 4.7 / 4.5 / 9.5 |
| 2 players, 8 tuning scenes | rest | 1.7 ± 2.1 | −2.0 ± 2.4 | 0.8 ± 3.9 | 5.0 / 2.8 / 6.3 | 1.4 / 1.4 / 2.6 |
|  | swing | 1.7 ± 2.1 | −4.9 ± 1.4 | −5.7 ± 4.4 | 4.8 / 4.2 / 10.3 | 6.4 / 5.1 / 13.3 |
| 1 player, 2 held-out scenes | rest | 0.4 ± 0.3 | −2.0 ± 1.6 | 0.4 ± 1.4 | 3.7 / 2.1 / 5.6 | 1.3 / 1.2 / 2.5 |
|  | swing | 2.0 ± 1.6 | −6.3 ± 2.6 | −5.8 ± 6.0 | 2.7 / 4.2 / 12.1 | 6.7 / 4.8 / 14.1 |
| 2 players, 2 held-out scenes | rest | 2.5 ± 0.6 | −1.6 ± 2.4 | 1.7 ± 1.1 | 6.7 / 4.1 / 7.6 | 1.8 / 2.1 / 3.0 |
|  | swing | 0.7 ± 2.6 | −10.7 ± 6.0 | −7.6 ± 5.2 | 8.8 / 6.7 / 9.8 | 9.4 / 9.4 / 13.0 |

Wild raw poses are more than 15 cm from their own ±200 ms median (including swing-time
misreads). Lost stretches have no pose for > 100 ms. Size and duration are event-weighted
means of scene medians, as `pp-noise.ts` reports them; lost rate and share are scene means.

| | wild share | wild size cm | lost /min | lost time | lost length ms |
|---|---|---|---|---|---|
| 1-player tuning | 4.38% | 19.6 | 1.05 | 0.71% | 391 |
| 2-player tuning | 9.24% | 21.5 | 1.73 | 0.50% | 174 |
| 1-player held-out | 8.36% | 21.6 | 5.42 | 3.87% | 392 |
| 2-player held-out | 15.92% | 22.1 | 1.61 | 0.65% | 250 |

The earlier two-player pp noise rows described only held-2/4 (16% wild poses); the tuning
set is 9.24%, with different rest and swing scatter. At rest, one-player depth's slow sd is
6.5 cm against 2.2 fast; two-player tuning is 6.3 against 2.6. In swings the two-player depth
fast sd is 13.3 cm. All offline recordings are 30 Hz; realtime rates and latency are in the
cost table. These are measurements for comparing the simulation's camera model, not changes
to that model.

### Unfinished

- DRAW_LAG (above), and the screen easing with SWING retuned. (Settled in the second round, below.)
- Rally-aware intervals: the report still clusters only shared renders. The full recording,
  accuracy, noise and realtime-resolution measurements above are complete.

## Second round (2026-11-09, branch feat-pingpong-tracking-2)

Every arms.ts/rig.ts experiment re-read the `ppt-tt` recordings (`pingpong.ts <id> --from
ppt-tt`, offline, deterministic). Base: `pp2r-base` (this branch before any change; it
reproduces `ppt-remeasure-F4-pp` exactly). Intervals are pp-report's paired cluster bootstrap
(the same clustering caveat as above: shared rallies are not joined, so one-player intervals are
optimistic). Play simulation: `tableTennisSim.ts` with the measured cameras, 24 rounds of 120 s at
Normal, hit rates of balls that came; `agency.ts` (6 rounds) and the agency tests were run for each
kept change too.

### New measures (kept, 48a5b5c4)

- **Overshoot** (`overshoot_cm`, `overshoot_p90_cm`): at each GT blade-speed peak, how much further
  along the stroke the drawn paddle gets (from 150 ms before, within 350 ms, at its own lag) than
  the raw tracked blade did. Positive is a predictor carrying the paddle past where the hand
  stopped. Base: −2.6 cm (p90 0.7) one player, −3.3 (p90 0.4) two.
- **Swings against exact GT** (`swing_exact_*`, `serve_exact_*`): the swing rule on the GT blade
  where it really is each screen frame, held to the thresholds as they are now (`TRUE_SWING`).
  The old false-swing count runs the GT through the game's own easing, so it moved whenever the
  drawing or SWING did. Base: false swings 2.0 / 8.5 a minute, misses 7.9% / 2.1%.

### Lag and DRAW_LAG (kept: DRAW_LAG 75 ms alone, 30 ms with two, 6dfa6615)

Offline drawn lag at swing speed is 81 / 91 ms (one / two players). Snapping the drawing to the
filtered pose leaves 50 / 61 ms (filter about 20, holding each 30 Hz pose about 17, the rest model
and timing). Easing at 24/s is the largest single part.

**Why the simulation disagreed between one and two players.** With two, a hit judged L ago is
replayed L forward, so the ball reaches the other player L sooner. Give the receiver a perfect
camera (no lag of its own) and raise the hitter's DRAW_LAG from 25 to 100 ms: the receiver's hits
fall from 98.9% to 73.6%, while the hitter's stay at 98%. Seen by the one-player camera, a pair
still prefers a small DRAW_LAG; one player seen by the two-player camera prefers a large one. So
the cause is the mode, not the camera. Alone, the robot's shots aren't replayed, so full
compensation is free. DRAW_LAG sweep, base drawing (novice / casual / good):

| DRAW_LAG | alone | two players |
|---|---|---|
| 0 | 62.7 / 82.3 / 87.3 | 74.1 / 92.0 / 96.7 |
| 25 ms | 64.3 / 84.6 / 90.2 | 74.7 / 92.1 / 97.9 |
| 35 ms | 63.7 / 85.7 / 91.3 | 75.8 / 91.9 / 97.3 |
| 50 ms (was) | 64.6 / 85.3 / 92.7 | 73.9 / 90.8 / 94.1 |
| 65 ms | 66.5 / 87.1 / 93.8 | 72.1 / 85.9 / 87.2 |
| 75 ms | 66.0 / 87.9 / 95.4 | 70.9 / 82.9 / 85.5 |
| 90 ms | 65.2 / 87.3 / 95.8 | 70.3 / 82.8 / 82.9 |
| 100 ms | 63.5 / 88.6 / 94.4 | 66.3 / 79.2 / 82.0 |

Kept (`DRAW_LAG = { one: 0.075, two: 0.03 }`): alone 64.6 / 85.3 / 92.7 → 66.0 / 87.9 / 95.4%,
two 73.9 / 90.8 / 94.1 → 75.8 / 92.5 / 97.8%. A paddle held still is hit 0.8% either way, a
still or idle pair still serves once in 48 minutes and nobody hits, and flailing goes 30.8 →
30.4% alone and 12.9 → 13.8% together. Two players seen by the one-player camera: 79.2 / 94.7 /
97.9 → 77.4 / 94.1 / 98.1 (within the noise). The bench has no hit test, so this change doesn't
move its numbers.

**Tried and dropped (drawing).** All rows are bench offline, one / two players; "sim" is the
simulation at DRAW_LAG 50 ms unless stated.

| variant | drawn lag ms | rest jitter, drawn, cm | overshoot p90 cm | false swings /min (exact) | misses (exact) | sim |
|---|---|---|---|---|---|---|
| base (24/s easing) | 81.3 / 91.1 | 0.73 / 0.89 | 0.70 / 0.36 | 2.03 / 8.55 | 0.079 / 0.021 | alone 92.7 good, two 94.1 |
| easing 40/s | 66.8 / 77.6 | 0.76 / 0.96 | 0.86 / 0.77 | 2.24 / 9.13 | 0.075 / 0.016 | two: 71.3 / 88.5 / 91.8 |
| hold prediction (filtered velocity) + easing up to 100/s with speed | 49.9 / 57.9 | 0.74 / 0.94 | 1.75 / 3.53 | 3.43 / 9.51 | 0.058 / 0.016 | two good 88.0; a still pair served 109 times, an idle pair 57 |
| the same, SWING travel 0.14 | " | " | " | 2.09 / 9.32 | 0.072 / 0.021 | two good 88.2, still pair served 111 |
| minmod-limited velocity, +30 ms lead, full above 2 m/s, at most 70 ms ahead | 68.2 / 76.6 | 0.73 / 0.89 | 1.32 / 1.87 | 2.38 / 8.74 | 0.080 / 0.021 | alone good 92.3-93.7 at any DRAW_LAG (base 93.8-95.8); still pair served 4-5 (base 1) |
| CV Kalman per axis, R from the noise profile, speed-adaptive Q (best low-jitter setting) | 74.5 | 0.83 | 2.76 | 1.95 | 0.066 | (one player only) |
| CV Kalman, high Q (q 1 + 200 v² m²/s³) | 54.4 | 0.97 | 1.60 | 3.42 (old count) | | |

- **Kalman.** Constant velocity per axis, with measurement noise per axis blended between the
  rest and swing rows of the noise profile. Process noise rose with the estimated speed, tried
  with and without a dead zone (0.3, 0.6 m/s), at measurement noise ×1-3. It tracks swings better
  than the one-euro (swing speed ratio 0.83 → 1.0, blade in swings 14.4 → 13.2 cm), but no setting
  brought rest jitter below 0.83 cm against the one-euro's 0.73. That fails the "no more jitter at
  rest" bar. A constant-acceleration model would be noisier still and wasn't run.
- **Naive velocity extrapolation is the owner's jumpiness.** Extrapolating the filtered
  velocity carries an isolated wild pose straight into the drawn paddle, so the simulation's
  pretend players got served while standing still. A minmod slope limiter (per axis: zero unless
  the last two steps agree in sign, else the smaller) removes that, and with prediction gated by
  speed it adds no rest jitter. It still costs lone simulated players about 2 points of hits
  (their camera's iid 9.5 cm depth noise per pose in swings becomes velocity noise), so it isn't
  kept. Hit timing doesn't need it: the hit compensates lag anyway. It would only buy the look of
  the paddle.
- **A swing speed over one pose interval** (33 ms) instead of one screen frame. It fixes the
  30/60 Hz beat that makes fast easing fire false swings (easing 60/s: false swings 7.6 → 2.3 a
  minute on the old count), but with 24/s easing it changes nothing. Not kept.
- **SWING retuned** with each drawing (minSpeed 1-1.4, travel 0.12-0.15, serve minSpeed 1.3-1.5,
  travel 0.25-0.28): the faster drawings sit on the same false-swing/miss trade-off as the base
  (base 2.0 a minute at 7.9% missed; hold prediction at travel 0.15: 1.8 at 9.0%). No gain beyond
  the lag.

### The swing-time bias (diagnosed; nothing kept)

In swings the wrist is only −2.3 cm low and −2.1 cm near (one player), against the blade's
−5.6 / −4.9. The difference is `dir`: the Hand Landmarker finds the hand in only 50% of swing
frames (35% with two), and the pose's fallback direction (wrist to the index and pinky
knuckles) points 0.28 too low and 0.34 too near in swings, 45° off at the median. The hand's own
direction in swings is 15-18° off. Tried on the dumped samples:
- holding the hand's last direction when it's lost (no better within 0.25 s, worse after);
- the forearm's direction (37-45° off);
- a fixed ping-pong prior blended in (−6° in swings but +12° when moving);
- a bias correction gated on tracked speed (−2° in swings, worse at rest with two).
None is worth a code change. The fix is finding the hand mid-swing (motion blur); see next steps.

### Forward stance with two players and pp1-lefty-paddle (diagnosed; nothing kept)

In the forward stance:
- **The woman with two players.** Her elbow reads 3.5-7.5 cm behind where it is, relative to
  the shoulder. The pose model leans her upper arm less in the two-player framings (world dz
  −0.06 to −0.085 m, against −0.10 alone and a GT −0.11).
- **The man, and the left-hander.** His forearm is too short: GT 0.25-0.28 m against FOREARM's
  0.24, so his wrist reads 5-10 cm behind.
- **What the first round's "always forward" upper arm had been doing.** It hid both.

The scenes' three bodies have forearms of 0.45, 0.52 and 0.59 of the torso. The pose model's
world landmarks give 0.44-0.50 for all three (p50; p90 0.49-0.57), so nothing the tracker
sends tells them apart. Global changes trade one player for two:

| change | wrist cm (1p / 2p) | forward wrist | blade, filtered |
|---|---|---|---|
| base (UPPER_ARM 0.62, FOREARM 0.5, lean width 0.16) | 7.13 / 7.46 | 5.86 / 7.27 | 9.27 / 11.22 |
| FOREARM 0.55 | 8.18 / 6.50 | 6.34 / 5.70 | 10.20 / 10.80 |
| FOREARM 0.6 | 10.02 / 6.63 | 8.02 / 5.32 | 11.99 / 11.48 |
| UPPER_ARM 0.55, FOREARM 0.55 | 7.79 / 8.71 | 6.97 / 8.50 | 9.86 / 12.30 |
| the same, lean width 0.1, at −0.03 | 7.65 / 8.61 | 6.97 / 8.57 | 9.74 / 12.28 |

The GT upper arm's forward share against the model's depth is also offset: −0.25 where the model
says flat, and 0.15-0.2 where tanh gives 0.5. But the too-long upper arm offsets that, and every
reshaped lean tried (width 0.06-0.1, at −0.03 to +0.03, with shorter bones) was worse. Next step:
measure each player's forearm while the game knows the pose (the setup hold).

### Two players' false swings and wild poses (diagnosed)

Of the 45 false swings (exact GT) on the eight two-player tuning scenes, 35 are pp2-bystander.
There the player tracker (`packages/pose/browser/tracker.ts`, out of bounds here) takes the
seated bystander as Player 1's slot for the whole scene, and the second player is never
tracked. What's counted is the bystander's fidgeting read through tracking noise. The other seven
scenes average 2.2 a minute, the same as one player.
- There are no identity swaps between the two players in any two-player scene, held-out
  included (except pp-held-4's bystander, again).
- Wild poses are 8.2% without pp2-bystander (9.2% with it). They are mostly swing-time depth
  misreads (the swing-time fast depth sd is 13 cm), not the other player's arm.
- There was nothing for a pre-filter gate to reject that wasn't real swing data, so none was
  added.

### Dark hand cuts (kept, a7d151df)

pose.worker.ts brightens a hand cut whose brightest 2% is below 160 before the Hand Landmarker
looks at it: that level is lifted to white (gain at most 4), then a gamma of 0.45 is applied. Any
other cut goes in unchanged. Recordings are deterministic (the old worker re-recorded nine scenes
identically), so every difference is the change. Variants on five dark scenes plus controls:

| variant | pp2-dim found | pp1-dim | pp1-tv-glow | pp1-sleeves-dark | bright scenes |
|---|---|---|---|---|---|
| base | 0.251 | 0.662 | 0.625 | 0.780 | – |
| contrast stretch of any dull cut (2-98% range under 80%) | 0.366 | 0.634 | 0.652 | 0.788 | pp2-base 0.769 → 0.698, pp1-base −0.02 |
| that stretch, dark cuts only | 0.366 | 0.634 | 0.652 | 0.788 | identical |
| gain only | 0.348 | 0.647 | 0.643 | 0.788 | identical |
| gain from the black point, gamma 0.7 | 0.430 | 0.661 | 0.656 | 0.794 | identical |
| gain, gamma 0.6 | 0.517 | 0.663 | 0.652 | 0.798 | identical |
| **gain, gamma 0.45 (kept)** | **0.592** | **0.671** | **0.649** | **0.801** | identical |

Full re-recording, run `pp2r-tt` (640x480, all 34 scenes), against `pp2r-base`:

| measure | one-player tuning (22) | two-player tuning (8) | held-out (4) |
|---|---|---|---|
| hand found | +0.0025 [0, 0.0057] | +0.043 [0, 0.128] | +0.048 [0.0004, 0.108] better |
| wrist cm | 0.00 [0, 0.01] | −0.11 [−0.32, 0] | −0.02 [−0.06, 0.01] |
| blade, filtered cm | −0.14 [−0.33, 0] better | −0.75 [−2.25, 0] | +0.29 [−0.16, 1.06] |
| blade p90 cm | +0.04 [0, 0.12] worse | −0.04 [−0.11, 0] | −1.03 [−2.86, 0.01] |
| rest jitter, drawn cm | +0.004 [−0.013, 0.028] | +0.036 [0, 0.109] | +0.023 [0, 0.045] |
| false swings /min (exact) | 0 [−0.21, 0.21] | +0.19 [0, 0.57] | +2.40 [0, 4.81] |
| false raises /min | +0.07 [0, 0.22] | 0 | +0.76 [0, 2.29] |
| across p90, filtered ° | +0.36 [−0.32, 1.51] | −2.86 [−8.36, 0] | +5.05 [0.35, 12.02] worse |

Held-out by scene:
- **pp-held-4 (TV glow).** Hands found 0.39 → 0.53, blade 14.3 → 14.1 cm.
- **pp-held-1 (dim, dark sleeves, a left-handed player with a paddle).** Found 0.50 → 0.55, but
  the blade gets worse (9.8 → 11.2 cm), with 2 more false swings and 1 more false raise in its
  0.32 minutes. The brightened hands it finds are worse ones.
- **pp-held-2 and -3.** Unchanged.

Kept for the tuning gains and the held-out found rate. pp-held-1 is the case to watch: a paddle
in dim light was not among the tuning scenes. The blade's noise profile is unchanged to 0.1 cm in
swings, so the simulation's cameras stay.

**Dance.** compare-runs on base-solo, base-duo, base-quad, cam-far-5.0, light-backlit_window and
light-ceiling_only with no detail, old worker (yE2vCQ3b) against new (CMCelfy_): 6/6 identical.

**Cost, realtime (three takes).** Before: `6dfa6615` (`pose.worker-yE2vCQ3b.js`); after:
`a7d151df` (`pose.worker-CMCelfy_.js`). Each scene ran before, after, before, after, before,
after, one worker at a time on the Apple M5 Pro / Metal GPU. Every take used:

```sh
node tools/trackbench/harness/run-game.ts <scene> --realtime --id pp2t-<before|after>-<1|2|3> --detail minigame:table-tennis --input-size 640x480
```

These direct `run-game.ts` calls are serial (`--jobs 1` for a suite); `busyScale = 1`, with no
added game-rendering load. Both commits were checked out detached and rebuilt before their
runs, so each run.json records the right worker snapshot. Latency is mean arrival − capture;
pose Hz counts kept results over their capture-time span. Each cell is the **median of three
takes [min–max]**; Δ is after minus before, computed before rounding.

The pass started after an iOS Hermes compile finished. No Blender, competing active
Chromium/Playwright benchmark or Xcode/iOS build appeared in the retained runs' 5 s process
samples. An existing Chromium session and an iOS test-without-building runner were idle
(0% CPU). Background load remained: PerfPowerServices at 191% CPU median (up to 210%),
host/simulator diagnosticd up to 126% / 151%, simulator locationd up to 102%, and T3 Code up to
85%. The first pp2-close pair is excluded because its after take caught an unrelated
`opencode` spike at 162% CPU; both sides were repeated as `pp2t-{before,after}-1-recheck`.
All original outputs are preserved. Logs, process samples and per-take aggregates:
`$TRACKBENCH_DATA/reports/pp2t-20261109-194905/`; retained recordings:
`runs/pp2t-{before,after}-{1,2,3}/` (with the replacement pair above).

| scene | worker | inference mean ms | inference p95 ms | pose Hz | latency ms | camera frames dropped / 600 |
|---|---|---|---|---|---|---|
| pp2-dim | before | 33.2 [31.3–35.1] | 54.0 [53.6–55.3] | 26.54 [25.84–26.79] | 41.1 [37.6–44.8] | 69 [64–83] |
|  | after | 29.5 [29.4–30.0] | 50.7 [49.5–51.4] | 28.05 [27.70–28.15] | 35.1 [34.7–35.2] | 39 [37–46] |
| | Δ | -3.7 | -3.3 | +1.50 | -6.0 | -30 |
| pp1-dim | before | 21.1 [20.6–23.4] | 39.3 [38.3–39.7] | 29.50 [29.40–29.50] | 23.2 [22.8–25.1] | 10 [10–12] |
|  | after | 21.1 [20.5–22.3] | 40.2 [38.5–40.3] | 29.30 [29.25–29.30] | 22.9 [22.3–24.4] | 14 [14–15] |
| | Δ | 0.0 | +0.9 | -0.20 | -0.3 | +4 |
| pp1-tv-glow | before | 21.4 [21.3–23.6] | 40.2 [35.8–40.6] | 29.25 [29.20–29.50] | 23.7 [22.4–26.6] | 15 [10–16] |
|  | after | 21.0 [20.9–23.0] | 38.1 [36.9–40.4] | 29.40 [29.40–29.45] | 22.5 [22.1–25.4] | 12 [11–12] |
| | Δ | -0.4 | -2.1 | +0.15 | -1.2 | -3 |
| pp1-sleeves-dark | before | 22.3 [21.9–22.5] | 38.0 [38.0–40.1] | 29.35 [29.10–29.45] | 24.4 [23.5–25.7] | 13 [11–18] |
|  | after | 21.3 [20.0–22.1] | 39.3 [35.2–42.5] | 29.45 [29.15–29.60] | 22.8 [21.2–25.0] | 11 [8–17] |
| | Δ | -0.9 | +1.3 | +0.10 | -1.6 | -2 |
| pp1-base | before | 20.5 [19.8–21.0] | 36.5 [36.2–37.2] | 29.55 [29.50–29.55] | 22.3 [21.4–22.4] | 9 [9–10] |
|  | after | 19.4 [19.2–20.6] | 34.9 [33.5–36.3] | 29.60 [29.60–29.65] | 20.7 [19.9–21.4] | 8 [7–8] |
| | Δ | -1.1 | -1.5 | +0.05 | -1.6 | -1 |
| pp2-base | before | 27.2 [25.9–28.3] | 49.0 [45.4–49.6] | 28.25 [28.20–29.05] | 30.8 [28.8–32.6] | 35 [19–36] |
|  | after | 27.9 [26.8–29.0] | 48.5 [46.6–49.5] | 28.50 [28.30–28.55] | 32.8 [30.2–33.6] | 30 [29–34] |
| | Δ | +0.7 | -0.5 | +0.25 | +2.0 | -5 |
| pp2-close | before | 27.2 [25.4–27.6] | 48.7 [43.9–49.3] | 28.50 [27.95–28.60] | 31.6 [28.6–31.7] | 30 [28–41] |
|  | after | 27.1 [22.0–27.3] | 48.8 [36.1–52.5] | 28.50 [28.25–29.65] | 30.8 [23.4–31.1] | 30 [7–35] |
| | Δ | -0.1 | +0.1 | 0.00 | -0.9 | +0 |

Hands were on and kept in all 42 retained takes; all completed on the GPU without an error or
a stale result dropped. The cost fields were checked against `pingpong.ts`; scene spec, meta
and GT checksums stayed fixed.

On a machine quiet of competing builds and benchmarks, but with the background CPU above, the
change costs −1.1 to +0.7 ms of mean inference per frame in bright scenes and −3.7 to 0.0 ms in
dark ones; the provisional pp2-dim increase is not reproduced. These are whole-worker timings,
not an isolated measurement of the histogram/readback, and the take ranges show the remaining
variation.

### Where it stands (640x480; first round → second)

- One player: wrist 7.13 → 7.13 cm, blade 9.27 → 9.13 cm (p90 21.0 → 21.1), false swings 2.5 →
  2.5 a minute (exact GT 2.0 → 2.0), drawn lag 81 ms (unchanged; the hit now makes up 75 ms of it).
- Two players: wrist 7.46 → 7.35, blade 11.22 → 10.47 (p90 30.3 → 30.3), false swings 11.0 → 10.9
  (exact 8.5 → 8.7, three quarters of them the bystander), drawn lag 91 ms (the hit makes up 30).
- Simulation at Normal: alone good / casual / novice 92.7 / 85.3 / 64.6 → 95.4 / 87.9 / 66.0%; two
  94.1 / 90.8 / 73.9 → 97.8 / 92.5 / 75.8%; nobody standing still serves or hits.

### Next

1. **The player tracker's choice of a seated bystander** (pp2-bystander, pp-held-4). That is
   three quarters of two players' false swings, and a missing second player. It is tracker.ts's
   job: a standing-height or motion test before a player's slot is given away.
2. **Per-player forearm length** from the game's setup hold, where the arms' pose is known: it's
   what separates the two-player forward-stance and left-hander errors. No fixed ratio can.
3. **The hand mid-swing**: found only 35-50% of swing frames, and the pose's fallback direction is
   45° off. A cut following the wrist's motion (centred ahead of a fast wrist, larger with speed)
   is the next worker experiment. So is keeping the landmarker's tracking through a blurred frame.
4. **The dark-cut path's cost** is re-taken above; if it proves costly under the game's
   rendering load, try a smaller readback (a 64×64 copy for the histogram).
5. **The minmod predictor** for drawing only (the hit test on the unpredicted blade), if the
   owner wants the paddle to look 13 ms quicker. It needs a decision on hits judged against a
   paddle that isn't where it's drawn.
