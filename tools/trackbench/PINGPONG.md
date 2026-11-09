# Ping-pong tracking: the meter and a first baseline

The Table Tennis minigame turns each tracked player into a first-person paddle: `arms.ts handPose`
puts the wrist in the room from the pose, its world landmarks and the Hand Landmarker, the hand's
axes give the paddle's turn, a one-euro filter smooths it, and Game.tsx draws the blade
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
```

`--detail` takes `none | world | hands | hands:<left|right|both>/... | minigame:<id>`. The
harness sends the worker the game's own `detail` message (`WebcamPoseSource.detailRequest`),
waits for the hand model's answer, sends `lined` with every frame, records `world` and `hands`
per detection, passes them through `GameLoop` into `PlayerTracker.update` as
`WebcamPoseSource.extras` does, and drops two players' hands as `watchHands` does when tracking
is too slow. `--input-size` scales frames as they're decoded. The worker's `initialize` settings
come from `WebcamPoseSource.workerSettings`, which `connect` uses too (a test fails if either side
stops sharing them).

## What pingpong.ts measures

Everything is computed from `tracked.jsonl` with the game's own code: `handPose`, `flatWorld`,
`OneEuro` with `HAND_FILTERS`, and `REACH`, `MITT`, `BLADE_UP` and `RAISED` (moved from Game.tsx
into arms.ts so the harness can import them). Arrival times feed the filter, as in the game. GT
joints go to camera space through meta.json's per-frame `camera_to_world` (checked: 0.02 px
reprojection, 0.1 mm depth on the pinhole scenes). Frame: the player's, as `handPose` reports it
(x their right, y up, z back, so **bias z < 0 means the paddle is read nearer the camera than
the hand is**). Each record's poses are matched to GT people per frame, as metrics.ts does.

- **Wrist**: `handPose(...).wrist` (from its shoulder) minus the GT's. Per axis: **bias** (signed
  mean), **sd** (the scatter left after the bias is removed), median and p90 of the size; for the
  length, its median and p90, and `unbiased_median` (the length once each axis's bias is gone).
  The same at the camera's true FOV instead of the assumed 65° (`wrist_true_fov`), and after the
  game's filter.
- **Blade**: the blade centre Game.tsx draws, from tracked and GT wrist and `dir`. It leaves out
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
  as forward (it takes every bone as forward unless the model says back by `SURELY_BACK`, 12 cm),
  and the reverse.
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
