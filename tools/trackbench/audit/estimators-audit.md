# trackbench estimator audit (2026-11-01)

An independent check of `tools/trackbench/estimators/`, and of the parts of the harness and
post pipeline that could bias the comparison between pose estimators. Everything below was
measured on the data in `$TRACKBENCH_DATA` (`/Volumes/development/aerodance-trackbench`) at
commit `caf1d149` plus the uncommitted `tools/trackbench/`. No original run, scene, or code
outside `tools/trackbench/audit/` was changed. Every derived run is a new estimator id.

| File (this directory) | What it does |
|---|---|
| `overlay.py` | contact sheets of each estimator's detections over the frame, with GT (`$DATA/audit/overlay-*.jpg`) |
| `confcal.py` | collects per-joint (conf, error) data, fits isotonic calibration on the fit split, and writes derived detection copies (`runs/<est>-<variant>/`) |
| `run-variants.sh` | `track.ts` + `metrics.ts` over every scene of the derived ids |
| `tables.py` | builds the tables below from `metrics.json` and `$DATA/audit/cal/` |

**Splits.** *Fit*: the 10 `base-genre-*` scenes. *Test*: the other 66 scenes that all seven
compared estimators ran (`mp-lite-game`, `mp-full-game`, `mp-heavy-game`, `rtmo-s`,
`rtmpose-s`, `movenet-multipose`, `apple-vision`). Means are taken over scenes, as
`report.ts` does. `report.ts` averages each model over its own scene set, so its headline
numbers (MoveNet 50%, Vision 31%, …) differ slightly from these.

**Harness version.** `harness/metrics.ts` and `common.ts` changed at 08:18–08:19 while this
audit ran, and another session re-ran `metrics.ts` on some original runs. Every number in the
results table therefore compares derived ids scored with the same harness: the *orig* column
is the `-fix` copy (confidences unchanged; Vision's placeholder joints nulled, see F3). Score
lost is unaffected by F3 (those joints have conf 0); scores of `-fix` and the original match
exactly wherever both used the same harness.

## Summary

1. **The 0.5 confidence gate, not position error, drives most of the gaps in the headline
   metric.** The scorer counts a limb it can't use as similarity 0, the same as a limb pointing
   90° the wrong way. So a joint that is roughly right but below 0.5 costs more than a wrong one
   kept. On the fit split, every model scores best with a gate at the lowest value tried (0.05),
   MediaPipe included. On the test split, with that gate fixed in advance, the gate explains
   **74% of MoveNet's score loss, 61% of Vision's, 59% of RTMPose-s's, 52% of MP Heavy's, 42%
   of MP Full's, 33% of MP Lite's and 28% of RTMO-s's**. Re-gated, MoveNet goes from 51.7% to 13.6% lost and
   Vision from 33.1% to 13.0%, while their PCK@0.2 is only 4–11 points below the others'
   (0.851 and 0.830 against 0.886–0.943) (F1).
2. **The runners aren't capped to the player count; the game's MediaPipe worker is.** The game
   asks MediaPipe for `num_poses = players`, but the candidate runners return everyone they
   find. In single-player scenes with a mannequin, TV, mirror or poster, the game's tracker then
   numbers the decoy as P1: RTMO-s loses 84% on bg-people-images, 86% on light-tv_glow and 79%
   on bg-studio. Keeping the top `players` people by person score cuts those to 5%, 4% and 1%
   (F2).
3. **Apple Vision writes undetected joints as `[0, 0, 0, 0]`** (top-left corner) instead of
   null. They skew Vision's learnt offsets (nose +0.23/+0.26 torso lengths, left ear −0.84),
   its PCK and its recall (F3).
4. The keypoint mappings are right for every runner: left/right, portrait, multi-person, the
   letterbox inverse and Vision's y flip all check out, visually and numerically. The one
   mapping defect is that the COCO-WholeBody hand slots point at fingertips, not the contract's
   knuckles (`rtmw-x` only, not scored) (F5).
5. The lens, rolling-shutter and fps-drop GT is consistent with the frames. In cam-fov-120
   (a small player), MediaPipe finds nobody (Lite, Full and Heavy, in the browser and in
   Python) and MoveNet and Vision lose 99% and 71%; only RTMO-s (15%) and RTMPose-s (23%)
   cope. That one scene moves each affected model's mean by about 1–1.3 points (F4).

## Findings

Severity is about bias in the *comparison between estimators*, not the game.

### F1. High: one fixed 0.5 gate on uncalibrated scores decides the ranking

**Evidence.**

- The scorer (`packages/score/scorer.ts:127-140`, `compare`) adds every reference limb's weight
  to the denominator but adds similarity only for live limbs it can use. A limb with either end
  below 0.5 (`features.ts:41`) therefore scores 0, the same as one about 90° off
  (`exp(-(θ/0.8)²)` is 0.02 at 90°). A joint that is roughly right is always worth more than a
  dropped one.
- The tracker also rejects a whole body with fewer than three reliable torso joints
  (`tracker.ts:146`), and calibration needs reliable joints (`webcamCalibration.ts:19`).
- Calibration on the test split (body joints of matched players inside the picture; *right* =
  within 0.2 torso lengths after the model's mean per-joint offset, learnt on the fit split):

| estimator | correct (≤0.2 torso) | kept at 0.5 | right but dropped | wrong but kept | median conf of right joints | ECE before → after | isotonic gate (raw conf ↦ P=0.5) |
|---|---|---|---|---|---|---|---|
| mp-lite-game | 90.0% | 97.5% | 1.5% | 9.0% | 0.99 | 0.059 → 0.054 | 0.126 |
| mp-full-game | 93.3% | 96.8% | 2.1% | 5.6% | 0.994 | 0.045 → 0.035 | 0.098 |
| mp-heavy-game | 95.2% | 95.5% | 3.5% | 3.9% | 0.989 | 0.059 → 0.032 | 0.068 |
| rtmo-s | 94.8% | 99.1% | 0.4% | 4.7% | 0.997 | 0.034 → 0.035 | 0.434 |
| rtmpose-s | 94.9% | 96.8% | 1.3% | 3.2% | 0.863 | 0.118 → 0.009 | 0.392 |
| movenet-multipose | 87.0% | 85.7% | 7.8% | 6.5% | 0.724 | 0.196 → 0.050 | 0.278 |
| apple-vision | 89.4% | 91.5% | 4.1% | 6.1% | 0.796 | 0.150 → 0.030 | 0.158 |

  MoveNet's scores are compressed: correct joints have a median conf of 0.72. It throws away
  22.8% of correct wrists and 11.1% of correct elbows (RTMO-s: 1.0% / 1.1%), so forearms go
  missing; limbs usable is 0.812 against 0.990 for RTMO-s. Vision is similar (median 0.80,
  limbs usable 0.868). RTMPose-s's SimCC values are clipped raw responses with a median of
  0.86. MediaPipe's scores sit near 1 but still drop 3–9% of correct elbows and wrists, mostly
  self-occluded ones (6–12% of correct self-occluded joints; MP Heavy drops 32% of correct
  joints hidden by other people).
- Gate sweep on the fit split (score lost %, every model; `thr<T>` maps raw conf T to 0.5
  piecewise-linearly):

| estimator | T=0.05 | T=0.1 | T=0.2 | T=0.3 | T=0.4 | T=0.5 | T=0.6 | T=0.7 | best T |
|---|---|---|---|---|---|---|---|---|---|
| mp-lite-game | **5.5** | 5.5 | 5.8 | 6.5 | 7.8 | 9.7 | 12.3 | 16.2 | 0.05 |
| mp-full-game | **4.0** | 4.1 | 4.7 | 5.5 | 6.8 | 8.9 | 11.9 | 16.3 | 0.05 |
| mp-heavy-game | **2.3** | 2.4 | 3.3 | 4.8 | 6.9 | 11.0 | 16.1 | 23.4 | 0.05 |
| rtmo-s | **1.7** | 1.8 | 2.0 | 2.4 | 2.9 | 3.5 | 4.1 | 4.8 | 0.05 |
| rtmpose-s | **4.8** | 4.8 | 4.8 | 5.1 | 6.2 | 9.5 | 16.2 | 27.3 | 0.05 |
| movenet-multipose | **8.5** | 8.7 | 9.7 | 13.7 | 23.8 | 40.7 | 66.1 | 92.0 | 0.05 |
| apple-vision | **9.5** | 9.5 | 11.7 | 14.5 | 18.4 | 22.4 | 27.3 | 44.8 | 0.05 |

  The optimum is the lowest gate for every model, and it is flat below about 0.1. Even MP Heavy
  loses 11.0% at the game's 0.5 against 2.3% at 0.05.
- *Drop-if-wrong* (conf 1 when within 0.2 torso lengths of GT, else 0; uses the GT) scores
  **worse** than the original for most models (MP Lite 34.2% against 14.9%). It is not an upper
  bound: under this scorer, a joint 0.2–0.5 torso lengths off still earns score, so
  correctness-targeted calibration (`cal`) sits above the score-optimal gate.

**Effect.** The headline "score lost to tracking" measures each model's confidence
convention against a threshold tuned for MediaPipe at least as much as it measures tracking.
The PCK spread between MoveNet and RTMO-s (0.851 against 0.939) explains far less than the
51.7% against 11.5% score-lost spread.

**Fix.**

- Report score lost per model at a gate chosen on a held-out split (the `thrbest` column; the
  fit-split optimum is 0.05 for every model), next to the as-shipped 0.5. When the game
  integrates a model, its gate becomes a per-model constant (`MIN_CONFIDENCE` and the tracker's
  `RELIABLE` both read it).
- The isotonic `cal` mapping is the principled way to give confidence one meaning across
  models (P(within 0.2 torso)). Use it for the *sure but wrong* / *correct but unsure* metrics
  and for cross-model calibration plots. For the score, the gate itself should come from the
  score.
- Separately, for the game: on this benchmark the 0.5 gate costs MediaPipe 4–9 points of score
  on clean scenes. It may still be right for real webcams (out-of-frame legs, clutter), so
  re-tune it on real footage; the synthetic data can't settle that.

### F2. High: candidate runners return every person; the game's MediaPipe returns `players`

**Evidence.** `run-game.ts` (and `run.py:46` for Python MediaPipe) asks for
`num_poses = players`. RTMO (`run.py:68`, score_thr 0.3, below rtmlib's default of 0.7),
RTMPose (YOLOX at 0.3), MoveNet (up to 6 people at 0.2, `run.py:132`) and Vision return
everybody. Single-player scenes with a person-like decoy (score lost %, test split):

| scene | rtmo-s orig → top | rtmpose-s | movenet | apple-vision | mp-lite-game (capped by the game) |
|---|---|---|---|---|---|
| bg-people-images (posters) | 84 → 5 | 6 → 6 | 42 → 42 | 15 → 15 | 5 |
| light-tv_glow (TV) | 86 → 4 | 22 → 22 | 76 → 76 | 57 → 57 | 11 |
| bg-studio (mirror wall) | 79 → 1 | 4 → 4 | 100 → 45 | 12 → 13 | 5 |
| bg-mannequin-coats | 75 → 76 | 74 → 73 | 37 → 37 | 75 → 44 | 5 |

Images: `$DATA/audit/overlay-bg-studio.jpg` and `overlay-bg-mannequin-coats.jpg`. The
mannequin and the reflection are detected as people, the tracker gives P1 to the decoy, and
identity accuracy drops to 0.

**Effect.** It inflates the non-MediaPipe models' losses in the background, bystander and
light categories by up to about 80 points per scene: RTMO-s's mean drops from 11.5% to 8.3%
with `top` alone. It also understates MediaPipe's real difficulty, since its detector picks the
top person for it.

**Fix.** In each runner, keep the top `players` people by the model's own person score (record
the detector or box score; RTMO/RTMPose currently store the mean joint score, `run.py:37`),
mirroring `num_poses`. Report uncapped runs separately as a bystander-robustness test. The
mannequin still fools RTMO, RTMPose and Vision even when capped, which is a genuine finding.
Also: `bg-studio`'s spec has no `room.features`, so its mirror detections count as `noise`,
not `distractor`, false positives (`metrics.ts` `DISTRACTOR_FEATURES`).

### F3. Medium: Apple Vision placeholders at (0, 0)

**Evidence.** `vision.swift:44` writes every recognised point, including those with
confidence 0, which Vision reports at the image origin. That gives 1,628 such joints in
mot-back and 1,678 in base-quad, all `[0, 0, 0, 0]`. Effects:

- `_offsets.json` learns them as offsets: nose +0.23/+0.26, left eye dv +0.37, left ear du
  −0.84 torso lengths. With them nulled (`apple-vision-fix`) these become −0.02/+0.05,
  +0.02, −0.05.
- They count in matching (`poseDistance` ignores conf), PCK and offsets. Nulling them raises
  test-split recall from 0.989 to 0.994 and PCK@0.2 from 0.828 to 0.830.
- Score lost is unchanged (conf 0).

**Fix.** In `vision.swift:44`, write `NSNull()` when `p.confidence == 0` (and the same for
3D). More generally, `metrics.ts` should not use joints with conf 0 for matching, offsets and
PCK, or should report coverage-aware PCK. MediaPipe never emits them, so they only penalise
Vision.

### F4. Medium (real, but outsized): cam-fov-120 is all-or-nothing

**Evidence.** In cam-fov-120 (3.2 m away, 120° hfov, barrel-distorted) the player is about
100 px tall. Lite, Full and Heavy in the browser find nobody in all 675 frames (score lost
999,844). Python Lite and Heavy (`zz-audit-mp-*-image-check`) find nobody in all 40 frames
tried, so it isn't the harness. MoveNet loses 99% and Vision 71% (Vision detects the player
in 653 of 675 frames, but at low confidence); RTMO-s loses 15% and RTMPose-s 23%.
cam-far-6.5 (larger in the picture) is fine for MediaPipe (recall 0.98).

**Effect.** One scene at 100% adds about 1.3 points to a model's 76-scene mean score lost.
It is a genuine model limitation (BlazePose's detector needs a larger person), but worth
reporting separately, for example with per-category or median columns, so that one
configuration doesn't swing the overall ranking.

### F5. Low: COCO-WholeBody hand slots are fingertips (`rtmw-x` only)

`run.py:31` maps 111/132 (pinky tip), 99/120 (index tip) and 95/116 (thumb tip) into
17–22. Contract v1.1 defines 17–22 as the MCP knuckles: pinky 108/129, index 96/117, thumb
MCP 93/114 (hand layout: 0 wrist, 1–4 thumb CMC/MCP/IP/tip, 5–8 index MCP…tip, …, 17–20
pinky). `test_mapping.py:22` encodes the old mapping. Hands aren't scored, so this affects
only the *hands* group metrics of `rtmw-x`, which has run only on the `proto/rt` stills.
The face (eye corners 59/62/65/68, mouth 71/77) and foot (Halpe 20/21/24/25; WholeBody
17/19/20/22) mappings are correct.

### F6. Verified correct (no bias found)

- **Mappings and coordinates**: checked visually (`$DATA/audit/overlay-{base-solo,mot-back,
  cam-portrait,base-quad}.jpg`; orange = subject-left, cyan = subject-right, white = GT) and
  numerically (learnt body offsets under 0.1 torso lengths for every model, sign patterns the
  same as MediaPipe's).
  - MoveNet's `resize_with_pad` inverse matches TF's centred integer padding for landscape
    (top 32) and portrait (left 32).
  - RTMO's top-left letterbox is undone by rtmlib (`/ratio`).
  - Vision's `1 - y` flip is right, and its `leftShoulder` is the subject's left.
  - COCO-17 → MP-33 slots are right.
  - Back views keep subject sides in every runner, with no blanket swap.
- **Lens / rolling shutter** (`$DATA/audit/geometry-gt.jpg`):
  - `geometric_gt.py` applies `distort_points` to keypoints and `distort_mask` to masks
    (the bbox comes from the warped mask). The forward lens model in `distort_points` is the
    exact inverse of `lens_image`'s sampling map: `2/(1+k+√((1+k)²−4kr'²))` solves
    `r' = r(1+k)/(1+kr²)`.
  - Lens then rolling-shutter order and `t = (frame-1)/fps` match in pixels and points.
  - Measured: RTMO-s's median error is 2.27 px against the warped GT and 3.37 px against the
    pinhole GT; RTMPose-s's is 2.02 against 3.05. Where the warp moves a point by more than
    3 px, the gap is 2.5 against 4.1 px.
  - The rolling-shutter variant (8 px) moves GT by under 3 px; the warped GT is marginally
    closer (2.90 against 3.01 px).
  - Caveat: the cam-fov-120 corners are edge-replicated (documented in `geometric_gt.py`).
- **fps drops**: `sens-fps-15` keeps its original frame numbers (1, 3, 5, …). The Python
  runners' `t_ms` (`(frame-1)·1000/30`) and `run-game.ts:167`'s `t_ms` (from GT) both match
  GT. `meta.fps` stays 30, so `gt_score` uses every frame and `gt_same_times_score` isolates
  the rate.
- **RTMPose `--det-interval 5`** doesn't handicap RTMPose; detecting every frame
  (`rtmpose-s-det1`, 10 scenes) is no better and sometimes worse. Keypoint-propagated boxes
  beat fresh YOLOX-tiny boxes on extended poses:
  - base-genre-br: 5.1% against 13.1% lost.
  - mot-jumps: 28.9% against 35.6%.
  - Other scenes are within about ±1.5 points, with identity unchanged; base-quad 14.3%
    against 14.7%.

  It does cost latency: base-quad 130 against 235 ms per frame under load.
- **MediaPipe VIDEO mode**: the suite's MediaPipe numbers all come from the game's browser
  worker (`mp-*-game`), with the game's thresholds and strips. The Python Tasks runner (`mp-*`)
  ran only on `proto/rt`, so its CPU/no-strips differences don't enter the comparison.
  `run-game.ts` warms up on frame 1 and then four grey frames, so the scene starts with no
  tracking state; the Python runners start cold too.
- **Frames**: every runner processed every frame (675 lines for a 675-frame scene; 338 for
  fps-15); none skip.

### F7. Notes

- The score's reference is the GT's anatomical joints. A model whose convention differs
  (COCO hips sit higher and wider) pays a small systematic limb-angle cost that only PCK
  corrects for. The learnt offsets are small for every model (|dv| ≤ 0.09 on body joints), so
  this is minor here, but it would matter for a model with a different skeleton.
- `report.ts` averages each model over its own scene set (mp-lite-game 111 scenes, the others
  75–81), so its rows aren't on the same scenes. Compare on the intersection.
- `/tmp/inspect.py` (from another session) shadows the stdlib for any Python started in
  `/tmp`: run scripts elsewhere or with `-I`.

## Recalibration results

Variants (`confcal.py`; only `conf` changes, positions are copied bit for bit, looks
resampled with the new conf):

- `orig`: the `-fix` copy (conf unchanged).
- `one`: every joint conf 1, no gate.
- `cal`: isotonic P(within 0.2 torso | conf), fitted on the fit split.
- `thr*`: piecewise-linear remap sending the fit-split-best raw gate T (0.05 for every model)
  to 0.5.
- `top`: conf unchanged, top `players` people per frame.
- `cal+top`: both.
- `drop-if-wrong`: the GT-informed diagnostic from F1.

For MediaPipe, `top` equals `orig` (it already returns `players` poses). PCK is unchanged by
any conf mapping, so it is given once, on the test split.

| estimator | lost % orig | lost % one | lost % cal | lost % thr* | lost % top | lost % cal+top | lost % drop-if-wrong | share of loss from the 0.5 gate | PCK@0.2 | PCK@0.2 corr | limbs usable orig → cal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mp-lite-game | 14.9 | 9.7 | 9.7 | 10.0 | 14.9 | 9.7 | 34.2 | 33% | 0.886 | 0.901 | 0.967 → 1.000 |
| mp-full-game | 15.0 | 8.0 | 9.4 | 8.8 | 15.0 | 9.4 | 25.7 | 42% | 0.922 | 0.933 | 0.960 → 0.994 |
| mp-heavy-game | 18.6 | 6.8 | 9.1 | 8.9 | 18.6 | 9.1 | 19.2 | 52% | 0.943 | 0.950 | 0.940 → 0.991 |
| rtmo-s | 11.5 | 8.3 | 11.4 | 8.3 | 8.3 | 7.8 | 20.4 | 28% | 0.939 | 0.947 | 0.990 → 0.992 |
| rtmpose-s | 15.2 | 6.3 | 9.3 | 6.3 | 15.1 | 9.3 | 20.0 | 59% | 0.942 | 0.949 | 0.961 → 0.987 |
| movenet-multipose | 51.7 | 13.5 | 19.3 | 13.6 | 50.8 | 18.1 | 43.2 | 74% | 0.851 | 0.870 | 0.812 → 0.978 |
| apple-vision | 33.1 | 13.0 | 14.6 | 13.0 | 32.6 | 14.1 | 34.8 | 61% | 0.830 | 0.878 | 0.868 → 0.989 |

**Ranking changes (test split, score lost %, lower is better):**

- **orig**: rtmo-s 11.5 < mp-lite-game 14.9 < mp-full-game 15.0 < rtmpose-s 15.2 < mp-heavy-game 18.6 < apple-vision 33.1 < movenet-multipose 51.7
- **one**: rtmpose-s 6.3 < mp-heavy-game 6.8 < mp-full-game 8.0 < rtmo-s 8.3 < mp-lite-game 9.7 < apple-vision 13.0 < movenet-multipose 13.5
- **cal**: mp-heavy-game 9.1 < rtmpose-s 9.3 < mp-full-game 9.4 < mp-lite-game 9.7 < rtmo-s 11.4 < apple-vision 14.6 < movenet-multipose 19.3
- **thr***: rtmpose-s 6.3 < rtmo-s 8.3 < mp-full-game 8.8 < mp-heavy-game 8.9 < mp-lite-game 10.0 < apple-vision 13.0 < movenet-multipose 13.6
- **top**: rtmo-s 8.3 < mp-lite-game 14.9 < mp-full-game 15.0 < rtmpose-s 15.1 < mp-heavy-game 18.6 < apple-vision 32.6 < movenet-multipose 50.8
- **cal+top**: rtmo-s 7.8 < mp-heavy-game 9.1 < rtmpose-s 9.3 < mp-full-game 9.4 < mp-lite-game 9.7 < apple-vision 14.1 < movenet-multipose 18.1
- **drop-if-wrong**: mp-heavy-game 19.2 < rtmpose-s 20.0 < rtmo-s 20.4 < mp-full-game 25.7 < mp-lite-game 34.2 < apple-vision 34.8 < movenet-multipose 43.2

Under a fair gate (`thr*`, chosen on held-out data), RTMPose-s is best, ahead of RTMO-s and
MP Full/Heavy. MoveNet and Vision close most of the gap (51.7% → 13.6% and 33.1% → 13.0%) but
stay last, consistent with their lower PCK (0.851 and 0.830 against 0.886–0.943). With
`cal+top`, which keeps a 0.5 gate meaning "more likely right than wrong" and adds the player
cap, RTMO-s is first. Either way, the original ordering (MoveNet ≫ Vision ≫ the rest) is
mostly confidence semantics.

## Derived data left in `$TRACKBENCH_DATA`

The derived runs are new ids under `runs/`, and `report.ts` with no `--estimators` reads every
id there, so **pass `--estimators` from now on**, or move these out:

- `<est>-{fix,one,cal,thrbest,oracle}` for the seven models.
- `<est>-{top,caltop}` for rtmo-s, rtmpose-s, movenet-multipose and apple-vision.
- `<est>-thr{0.05,0.1,0.2,0.3,0.4,0.6,0.7}` on the fit split.
- `rtmpose-s-det1`: 10 suite scenes added beside its `rt` stills.
- `zz-audit-mp-{lite,heavy}-image-check`: 40 frames of cam-fov-120.

Calibration fits, the cached per-joint arrays and these tables are in `$DATA/audit/cal/`
(`calibration.json`, `best-thresholds.json`, `results.json`, `*.npz`). The images are in
`$DATA/audit/`. Nothing was deleted.

To reproduce, from the repository root:

```sh
PY=/Volumes/development/aerodance-trackbench/.venv/bin/python
A=tools/trackbench/audit
$PY -I $A/confcal.py collect && $PY -I $A/confcal.py fit
for v in fix cal one oracle; do $PY -I $A/confcal.py write $v; done
for v in top caltop; do $PY -I $A/confcal.py write $v --estimators rtmo-s,rtmpose-s,movenet-multipose,apple-vision; done
for t in 0.05 0.1 0.2 0.3 0.4 0.6 0.7; do $PY -I $A/confcal.py write thr$t --scenes fit; done
$A/run-variants.sh <ids...>                     # track.ts + metrics.ts
$PY -I $A/tables.py sweep                       # writes best-thresholds.json
$PY -I $A/confcal.py write thrbest --scenes test && $A/run-variants.sh <est>-thrbest ...
$PY -I $A/tables.py results; $PY -I $A/tables.py calib
```
