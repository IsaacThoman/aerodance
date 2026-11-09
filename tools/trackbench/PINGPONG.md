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
per detection, passes them through `GameLoop` into `PlayerTracker.update` as
`WebcamPoseSource.extras` does, and drops two players' hands as `watchHands` does when tracking
is too slow. `--input-size` scales frames as they're decoded. The worker's `initialize` settings
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

## Results: tracking changes (2026-11-09, branch feat-pingpong-tracking)

The new ping-pong scenes (`pp-*`, 1280x960, 21-point hand GT; SUITE.md on
feat-trackbench-pingpong-scenes) are the benchmark: 10 one-player tuning scenes had rendered
(pp1-backlit, -base, -bystander, -clutter, -dim, -far-tv, -fast, -gentle, -lefty, -lefty-paddle;
**several share one rally's motion**, so they're less independent than the cluster bootstrap
assumes) and the 4 held-out ones (`pp-held-1..4`, two of them two-player), run once at the end.
Recordings: `ppt-tt` (the game's 640x480) and `ppt-tt-native`; each game-code variant is
`pingpong.ts <id> --from <recording>` (the worker never changed: every recording comes from the
baseline worker, pose.worker-yE2vCQ3b). All comparisons are paired, cluster bootstrap 95%.

### The ping-pong scenes against the dance-scene baseline

At the original code (`ppt-F0`), the tuning scenes read wrist 13.5 cm (dance 21.0), depth bias
−15 cm, forward-stance wrist 9.4 cm, blade (filtered) 15.4 cm (dance 30.7), hand found 0.85
(dance 0.53), wrong side 2.4% (8%), and `across` from the hand **12° median** against the
21-point GT. The dance scenes' 55-66° `across` was mostly their GT: from the body's index and
pinky points, which the hand's own axes are 78° from; the real problem is the pose-sourced
`across` (70°). The pp scenes' errors are depth, almost all of it from serves and backswings
(the elbow behind the shoulder), where the paddle read 25-40 cm nearer the camera.

### Kept

| change | commit | tuning (10 scenes, 640x480) | held-out (4) | worse |
|---|---|---|---|---|
| leave out a found hand nearer the other wrist or > 1.5 of its lengths from its own | 5a579474 | wrist −0.24 cm [−0.4, −0.1], blade p90 −0.7, swings −0.5 cm; dance: x sd 11.4 → 7.6, rest jitter 1.19 → 0.50 cm, false swings 5.1 → 2.8/min, false raises 1.55 → 0.63/min | wrist −0.19 [−0.4, −0.0], false swings at rest −3.5/min [−5.4, −2.0], rest jitter −0.23 (n.s.) | swing speed ratio 0.97 → 0.93 (dance), drawn lag +1.6 ms |
| keep the hand's `across` 0.5 s when it's lost | 17b06951 | filtered `across` p90 89 → 72° (2 scenes at the time), median −0.6° | no measurable change | dance `across` worse against its (unusable) GT |
| filter by capture time, not arrival | e7de0f2e | offline: none (they're equal); realtime (pp-rt-tt, 3 dance scenes): blade −0.13 cm [−0.22, −0.06], jitter −0.03 | – | simulation: 1 hit in 56 balls for two idle players under rough tracking (0 before) |
| lean the upper arm as far as the model does: −tanh(dz ÷ 0.16) | 152ae9de | wrist 13.2 → 7.3 cm [−7.3, −4.1], forward stance 9.3 → 6.0 [−4.5, −1.8], blade 15.3 → 9.3 [−7.5, −4.1], p90 36 → 21, swings 17.9 → 14.5, false swings −1.2/min [−2.1, −0.2], false serves −1.1/min; GT-backward bones read forward 100% → 78% | blade 15.9 → 11.1 [−9.7, −2.2], p90 −8.2, swings −2.9; wrist −2.8 [−9.0, +0.8] | drawn lag +2.3 ms (held-out +5.0), swing misses 5 → 6-7%; dance forward-reach 11.6 → 14.4 cm, dance rest jitter +0.1 cm; real clip jitter 0.31 → 0.35 cm; held-1 (left-handed, laptop) forward-stance wrist 4.6 → 6.7 cm, held-4 (two players, low phone, TV glow) wrist 12.1 → 13.1 |

**All together** (`ppt-F0` → `ppt-F4`, the original game code against this branch's):

| | tuning 640x480 | tuning native | held-out 640x480 | held-out native |
|---|---|---|---|---|
| wrist cm | 13.5 → 7.3 [−7.5, −4.4] | 13.3 → 7.3 | 11.7 → 8.6 [−9.3, +0.6] | 11.8 → 8.6 |
| forward-stance wrist | 9.4 → 6.0 [−4.7, −1.9] | 9.2 → 5.9 | 8.5 → 7.5 (n.s.) | 8.6 → 7.5 |
| blade (filtered) | 15.4 → 9.3 [−7.4, −4.4] | 15.5 → 9.2 | 16.3 → 11.1 [−9.8, −2.6] | 16.4 → 11.1 |
| blade p90 | 37.0 → 21.4 | 36.8 → 21.8 | 41.5 → 32.3 | 41.6 → 31.7 |
| blade in swings | 18.4 → 14.5 | 18.5 → 14.4 | 25.8 → 22.9 | 25.7 → 22.7 |
| false swings /min | 3.5 → 2.3 [−2.1, −0.2] | 3.5 → 2.0 | 5.7 → 3.4 [−5.0, −0.4] | 4.1 → 3.7 |
| false swings at rest /min | 6.0 → 4.0 (n.s.) | 5.2 → 4.6 | 4.7 → 1.2 [−4.8, −2.3] | 2.7 → 1.2 |
| rest jitter (filtered) | 0.66 → 0.57 (n.s.) | 0.60 → 0.55 | 0.85 → 0.56 (n.s.) | 1.07 → 0.66 |
| drawn lag at swing speed | 79 → 83 ms [+2, +6] | 81 → 84 | 88 → 94 [+3, +10] | 85 → 92 |
| swing misses | 4 → 6% | 6 → 6% | 3 → 1% | 10 → 8% |

On the dance scenes: wrist 21.0 → 11.4 cm, blade 30.7 → 18.2, with the forward-reach frames
worse (11.6 → 14.4). Play simulation (agency.ts --rounds 24): unchanged by the hand, `across`
and lean changes (it feeds rig.ts takeHand directly); the capture-time change moved hit rates
within ±1-3 points (one player good 96 → 97%, two players good 96 → 97%, rough 86 → 86%; rough
standing still 16 → 13%; the one idle hit above).

### Tried and dropped

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

Native 1280x960 against the game's 640x480 on the 10 tuning scenes, same code: overall the same
(wrist +0.05 cm, blade −0.2, hand found +2.7 points n.s., wrong side 2.4 → 1.5%, `across` p90
86 → 77°). Per scene it matters only for the far player: **pp1-far-tv** (a TV camera) hand found
0.73 → 0.92, wrong side 3.9 → 1.6%, `across` 17 → 10°, rest jitter 0.47 → 0.39 cm; dim light
gains nothing (found 0.66 → 0.61). Offline inference +1.5 ms. Realtime cost could not be
measured: with two Blender renders running, native came out *faster* than 640x480 (36 vs 43 ms,
pp1-far-tv), i.e. inside the noise. Recommendation: request 1280x720/960 when the players are far
(the torso under ~1/4 of the picture's height, or a TV setup), keep 640x480 otherwise; re-take the
realtime cost on a quiet machine (`--realtime`, one at a time) before doing it.

### Noise profile of the tracked blade (item 7)

`pp-noise.ts ppt-F4-pp` (this branch's code; `pingpong.json` `noise`). cm, the player's frame
(x right, y up, z back); bias: mean of scene biases ± their spread between scenes; slow: sd of a
±250 ms average (correlated over ~0.5 s and slower); fast: frame to frame. Raw is what the game's
filter is given, which is what tableTennisSim.ts's cameras should model.

| | state | bias x | bias y | bias z | slow x / y / z | fast x / y / z |
|---|---|---|---|---|---|---|
| 1 player, 11 pp scenes | rest | 0.5 ± 1.3 | −1.6 ± 0.6 | −1.9 ± 2.8 | 2.6 / 2.6 / 6.5 | 1.3 / 1.7 / 2.3 |
| | swing | 0.9 ± 1.9 | −5.9 ± 1.4 | −4.7 ± 4.2 | 2.4 / 3.8 / 8.6 | 4.5 / 4.4 / 9.2 |
| 2 players, pp-held-2/4 (descriptive only) | rest | 2.5 ± 0.6 | −1.6 ± 2.4 | 1.7 ± 1.1 | 6.7 / 4.1 / 7.6 | 1.8 / 2.1 / 3.0 |
| | swing | 0.7 ± 2.6 | −10.7 ± 6.0 | −7.6 ± 5.2 | 8.8 / 6.7 / 9.8 | 9.4 / 9.4 / 13.0 |
| 2 players, 19 dance duo scenes | rest | 1.0 ± 1.8 | 6.7 ± 2.4 | −8.8 ± 2.5 | 4.3 / 3.5 / 8.6 | 2.5 / 1.8 / 3.6 |

Wild raw poses (over 15 cm from their own ±200 ms median; includes swing-time misreads): one
player 4.3% of poses, median 19 cm (6.3%, 21 cm with the original code); two players 16%, 22 cm
(pp-held) and 23%, 24 cm (dance duos). Lost stretches (no pose > 100 ms): one player 1.1 a
minute, 0.7% of the time, median 0.4 s; two players 1.6 a minute (pp-held), 21 a minute and 11%
of the time on the dance duos (occlusion, identity). Rate and delay (realtime, provisional): one
player with hands 29 Hz, 30 ms latency; two players 20-25 Hz, 47-62 ms. Versus TRACKING today:
`good`'s across 1.5 cm and depth 5 cm white noise are about right frame to frame, but the real
error is mostly slow (depth 6.5 cm sd over half-seconds), with an up bias of −6 cm in swings;
`rough`'s wild rate (3%) is low for two players (16-23%), and dropouts come in ~0.25-0.4 s
stretches, not single poses.

### Unfinished

- 2-player tuning scenes (pp2-*) and 11 more pp1 scenes hadn't rendered; the watcher
  run ends here. Re-run once they exist:
  `node tools/trackbench/harness/run-game.ts <scene> --id ppt-tt --detail minigame:table-tennis --input-size 640x480`
  (and without `--input-size` as `ppt-tt-native`), then `pingpong.ts ppt-F4-pp --from ppt-tt`.
- DRAW_LAG (above), the screen easing with SWING retuned, and the realtime resolution cost.
