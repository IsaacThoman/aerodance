# sim2real: do trackbench's synthetic results transfer to real footage?

## Verdict

**Rankings transfer; absolute numbers don't.** The primary test pairs 18 real AIST Dance DB
videos (real people, real cameras, triangulated AIST++ GT) with 18 synthetic twins that
trackbench rendered from the same AIST++ motion and camera geometry. Across 11 estimators:

- **Estimator rankings agree.** Spearman ρ between real and synthetic is 0.84 [0.72, 0.94]
  for PCK@0.2, 0.91 [0.67, 0.95] for offset-corrected joint error, 0.85 [0.75, 0.94] for
  scored-limb angle and 0.89 [0.84, 0.96] for **score lost to tracking**. Of the 55 estimator
  pairs, 46-49 keep the same order (depending on the metric). At most 1 pair per metric flips with both sides
  significant: mp-lite-game vs yolo26n-pose for joint error, rtmpose-s vs yolo26n-pose for
  score lost.
- **Synthetic is pessimistic, by different amounts per model.** Every estimator's error is
  higher on the twins: +0.015 to +0.060 torso lengths, and +0.5 to +11 points of score lost.
  The penalty is 2-3× larger for small one-stage COCO-trained models (yolo26n, rtmo-t,
  yolo26s, MoveNet, Apple Vision) than for MediaPipe and RTMPose. Scoring both sides with the
  same pseudo-GT ensemble shows the cause:
  - MediaPipe's remaining gap is ≈0 (lite −0.002, full −0.004), so its penalty was a
    GT-definition effect: trackbench's anatomical joint centres vs the COCO-style points the
    models learnt.
  - yolo26n (−0.037) and rtmo-t (−0.030) keep a large gap. That is a rendering-appearance
    gap specific to those models.
- **Failure modes partly transfer.**
  - Arms overhead raises error by +40% on real footage and +37% on the twins: this transfers.
  - Back views raise error by +55% real but only +10% synthetic (+41% vs +5% with the same
    pseudo-GT on both): synthetic **underestimates** back-view difficulty.
  - Crouching/low poses are overestimated: +38% real vs +54% synthetic.
  - Frame by frame, real and synthetic difficulty correlate at ρ = 0.56 (8100 paired frames);
    per sequence, ρ = 0.66 [0.27, 0.92].
- **Not validated:** detection recall (≈1.0 everywhere on single dancers: no signal); false
  positives (ρ 0.27 [−0.01, 0.63]; the real ones come from the studio background, which the
  twins don't have); and identity under crossings. In the second, pseudo-GT domain, identity
  is near ceiling in both real and synthetic multi-dancer clips without crossings (0.98-1.00).
  The one real clip where dancers swap places (c2: 24-32 switches for every estimator) has no
  synthetic counterpart, and its pseudo-GT identities swap too, so it is excluded.

**Trust synthetic for:**
- which estimator is better on keypoint accuracy, limb angles and score lost, when the
  difference is clear on synthetic;
- comparisons within a model family (e.g. MediaPipe lite/full/heavy: real and synthetic both
  say full < lite < heavy in score lost, 0.158 / 0.183 / 0.220 real vs 0.185 / 0.207 / 0.251
  twin);
- arms-overhead and side-view effects;
- which sequences are hard.

**Don't trust synthetic for:**
- absolute error, PCK or score-lost levels;
- MediaPipe vs small one-stage COCO models when synthetic shows MediaPipe ahead by less
  than ≈0.04 torso lengths or ≈5-9 score points (synthetic gives those models an extra
  penalty);
- back-view difficulty;
- false positives and distractors;
- multi-dancer identity, until scenes with crossings are validated against real footage.

## Design

| Domain | Pictures | GT | Root (`$TRACKBENCH_DATA/sim2real/…`) |
|---|---|---|---|
| **AIST real** (primary) | 18 AIST Dance DB videos, 15 s each (clip seconds 4-19), all 10 genres; 9 front, 5 diagonal, 2 side, 2 back views (one low floor camera) | AIST++ `keypoints3d_optim` (triangulated from 9 views) projected through the camera with lens distortion; COCO-17 | `aist/` (`real-aist-<id>`) |
| **AIST twin** | trackbench render of the **same AIST++ motion and window**, camera at the AIST camera's height, distance, angle to the dancer and the real crop's FOV; similar body and clothes | exact (anatomical joint centres) | `aistsyn/` (`twin-aist-<id>`) |
| AIST real, pGT / twin, pGT | the same pictures | pseudo-GT from one reference ensemble on both sides (same GT kind) | `aistpgt/`, `aistsynpgt/` |
| **Eval real** (second) | 10 sequences from `~/aerodance-tracking-eval` clips: 4 solo, 6 multi-dancer (3-4 players), webcam-ish home and outdoor scenes | pseudo-GT only | `real/` (`real-<seq>`) |
| Eval twin | matched framing, camera height, dancer count, spacing, setting and outfits; different (AIST++) motion | exact, and pseudo-GT | `syn/`, `synpgt/` (`syn-<seq>`) |

The three-way comparisons separate effects:
- **Real vs twin, both pseudo-GT:** same GT kind on both sides, so it isolates the appearance
  (rendering) gap.
- **Twin pseudo-GT vs twin exact:** same pictures, so it isolates the GT-definition effect.
- **Real pseudo-GT vs AIST++ GT on the same real frames:** measures how far pseudo-GT can be
  trusted, which validates the eval-clip domain.

Every root is a separate `TRACKBENCH_DATA`, so each estimator's learnt per-joint offsets stay
within one GT kind, and nothing here touches the main suite's `runs/` or offsets.

Statistics:
- Each domain value is a mean over sequences.
- Rank correlations are over the 11 ranked estimators.
- 95% CIs come from 2000 percentile-bootstrap resamples of sequences (a real sequence and
  its twin always drawn together).
- Gaps are paired differences over sequences, bootstrapped the same way.
- Groups with 2 sequences (AIST "back") give degenerate CIs; read them as indicative only.
- Pairwise flips (`pairflips.py`): a pair "flips" when its per-sequence difference has a 95%
  CI excluding 0 in both domains, with opposite signs.

## Data and provenance

Nothing derived from real footage is committed: no frames, images, detections or GT. This
directory holds code, specs and summary numbers only (`results.json`, `results.md`).

- **AIST Dance DB videos** (refined 10M MP4s, 1920x1080 59.94 fps;
  <https://aistdancedb.ongaaccel.jp/>):
  - Downloaded on the user's acceptance of the
    [AIST Dance DB terms](https://aistdancedb.ongaaccel.jp/terms_of_use/) (research use;
    commercial use needs AIST's written consent; no redistribution), for internal evaluation
    only.
  - Stored in `$TRACKBENCH_DATA/downloads/aist-video/` (with `SOURCE.md`).
  - Citation: Tsuchida et al., *AIST Dance Video Database*, ISMIR 2019.
  - Sequences are in `aist.json`; crops and twin cameras are in `aist_cameras.json`.
- **AIST++ annotations** (`keypoints3d`, `cameras`, `motions`): CC BY 4.0 (Li et al., *AI
  Choreographer*, ICCV 2021).
- **Eval clips:** YouTube/TikTok dance clips already in `~/aerodance-tracking-eval` (sources
  in `sequences.json`), used locally only. They were reframed to the game's frames:
  - 9:16 phone video: 360x640, padded to 480x640 (portrait phone);
  - 16:9: letterboxed to 640x480;
  - the stage clip: centre 480x360 crop, scaled to 640x480.

  Twins are rendered at the source size and go through the same `reframe.py` op.
- **Pseudo-GT references** (`refs.py`), local evaluation only, never shipped:

  | Reference | How it runs | Weights licence |
  |---|---|---|
  | YOLO26x-pose (Ultralytics) | one-stage | AGPL-3.0 |
  | ViTPose++-H (`usyd-community/vitpose-plus-huge`, COCO head) | top-down on YOLO's boxes | Apache code; mixed-dataset weights |
  | RTMW-x (`~/wmyb-blender/models/rtmw-x-b8.onnx`) | top-down on YOLO's boxes, via onnx2torch on MPS | COCO-WholeBody research terms |

  The reference venv and Hugging Face cache are in `$TRACKBENCH_DATA/sim2real/`.
- **Twin assets:** MakeHuman CC0 and Poly Haven CC0, as in trackbench.

## Method

- **AIST GT** (`aist_scenes.py`):
  - Frames: video frames 240, 242, … (30 fps), cropped to a fixed 4:3 window holding the
    dancer (960x720, or 1440x1080 for the two travelling jb sequences), scaled to 640x480.
  - GT: keypoints3d projected with the camera's intrinsics, extrinsics and distortion, then
    through the crop; COCO slots in pose-33, with unmapped slots flagged as not scored.
  - `kp3d` and depth are real, so the harness's torso scale is the projected 3D torso, as for
    exact GT.
  - `vis` is 3 outside the picture, else 0 (self-occlusion is unknown).
  - Checked by eye on contact sheets.
- **Twins** (`aist_twins.py` → `scenes/twin-aist-*.json`):
  - Same clip and `clip_start_s` 4, `travel` 1, so the dancer wanders as they really did.
  - The camera stays in front (inside the room) and the dancer is turned by −(view angle),
    which gives the same relative geometry.
  - Room `plain_wall` with bright light. The AIST studio is white on white, which the
    generator has no preset for.
  - First frames were checked side by side with the real ones (same pose in the same frame,
    from front, side, diagonal and behind).
  - Eval twins: `make_twins.py`.
- **Pseudo-GT** (`fuse_pgt.py`):
  - People: YOLO26x boxes ≥ 0.3, duplicates merged, linked and stitched into tracks.
  - Players: the scene's `players` most present tracks.
  - Joints: the median of the confident references.
  - Only **agreed** joints are scored: all three references confident and within 0.1 person
    scales of the median. Coverage of body joints is 95.0% (AIST real), 93.8% (AIST twin),
    89.7% (eval real; wrists 71%) and 93.6% (eval twin).
  - Person scale: a robust 2D torso, the same on both sides.
  - `s2r_metrics.ts` marks unagreed joints unknown for the keypoint metrics; matching, recall,
    tracking and score use the filled pseudo-GT.
- **Identity GT, eval clips:** the reference tracks (continuous, checked by eye).
  - The tracking eval's colour oracle (`gt-c*.json`) did not separate the dancers when sampled
    at the reference keypoints: it gave 2-3 simultaneous dancers the same label in c2/c3.
  - In c2 the dancers swap places around 14-16 s and the reference tracks exchange two
    identities there (the black-jacket dancer is t0 at frame 380 and t3 at frame 500).
    **c2 is therefore excluded from identity and score metrics** in every eval domain.
- **Estimators.** Ranked:
  - `mp-lite-game`, `mp-full-game`, `mp-heavy-game`: the game's worker in Chromium on the GPU
    via `run-game.ts`, tracker in the loop.
  - via `estimators/run.py` then the game's tracker (`track.ts`): `rtmo-t`, `rtmo-s`,
    `rtmpose-s`, `rtmpose-m`, `movenet-multipose`, `apple-vision`, `yolo26n-pose`,
    `yolo26s-pose`.

  The eval domain ran only the 3 game models plus `rtmo-s`, `movenet-multipose`,
  `apple-vision` and `yolo26s-pose` (7 ranked), because CPU time on the shared machine ran
  out.

  Not ranked:
  - the references and their fusion (`ref-*`): fair against AIST++ and exact GT, biased
    against pseudo-GT;
  - Python CPU MediaPipe (duplicates the game's runs).

  `run_limited.py` caps each Python model at 3 CPU threads (the shared machine thrashed
  otherwise); this affects speed only. No timings are reported.
- **Metrics:** the harness's own (`harness/metrics.ts` functions). PCK and joint error are
  offset-corrected (each estimator's mean per-joint offset, learnt per root, removed), so
  COCO vs anatomical conventions don't count as error.
  - `limb_c` is the scored-limb angle with the same offsets removed first. Limb angles and
    score use raw positions, so they mix accuracy with where a model puts a joint.
  - Pose conditions (`s2r_metrics.ts`), defined in 2D from the GT:
    - arms up: a wrist above the nose;
    - back: the left shoulder on the picture's left by more than 0.25 scales;
    - low: hips less than 0.9 scales above the lower ankle.

## Results

All tables: `results.md` (every metric, domain and view) and `results.json` (with per-sequence
values). Error = mean offset-corrected body-joint error in torso lengths; limb° =
convention-corrected scored-limb angle error; score lost = fraction of the GT score lost to
tracking.

### AIST: real video vs synthetic twin

| estimator | err real | err twin | err real − twin [95% CI] | limb° real | limb° twin | limb° real − twin [95% CI] | score lost real | score lost twin | score lost real − twin [95% CI] |
|---|---|---|---|---|---|---|---|---|---|
| ref-fused (ref) | 0.054 | 0.057 | -0.003 [-0.009, 0.003] | 4.4 | 3.8 | 0.6 [0.3, 1.0] | 0.169 | 0.181 | -0.012 [-0.047, 0.024] |
| ref-vitpose-h (ref) | 0.056 | 0.057 | -0.002 [-0.007, 0.004] | 5.5 | 4.5 | 0.9 [0.5, 1.3] | 0.106 | 0.100 | 0.006 [-0.028, 0.037] |
| ref-rtmw-x (ref) | 0.058 | 0.058 | -0.000 [-0.006, 0.005] | 5.5 | 4.6 | 0.9 [0.5, 1.4] | 0.068 | 0.047 | 0.021 [0.006, 0.039] |
| ref-yolo26x (ref) | 0.059 | 0.076 | -0.017 [-0.032, -0.006] | 5.6 | 6.0 | -0.4 [-1.5, 0.5] | 0.092 | 0.100 | -0.008 [-0.031, 0.013] |
| rtmpose-m | 0.060 | 0.075 | -0.015 [-0.030, -0.004] | 5.6 | 5.8 | -0.2 [-1.3, 0.6] | 0.083 | 0.091 | -0.008 [-0.037, 0.015] |
| rtmo-s | 0.061 | 0.078 | -0.018 [-0.026, -0.010] | 6.1 | 6.7 | -0.5 [-1.3, 0.3] | 0.082 | 0.087 | -0.005 [-0.022, 0.014] |
| mp-heavy-game | 0.064 | 0.086 | -0.022 [-0.041, -0.010] | 6.2 | 6.7 | -0.6 [-2.1, 0.5] | 0.220 | 0.251 | -0.031 [-0.069, 0.000] |
| rtmpose-s | 0.067 | 0.085 | -0.018 [-0.032, -0.006] | 6.0 | 6.5 | -0.5 [-1.4, 0.2] | 0.132 | 0.140 | -0.008 [-0.038, 0.019] |
| yolo26s-pose | 0.068 | 0.103 | -0.035 [-0.051, -0.021] | 6.8 | 8.6 | -1.9 [-3.3, -0.6] | 0.108 | 0.144 | -0.036 [-0.068, -0.007] |
| rtmo-t | 0.068 | 0.113 | -0.046 [-0.064, -0.031] | 7.1 | 9.7 | -2.6 [-4.2, -1.0] | 0.080 | 0.142 | -0.062 [-0.089, -0.037] |
| mp-full-game | 0.073 | 0.094 | -0.021 [-0.034, -0.011] | 7.3 | 7.7 | -0.4 [-1.5, 0.6] | 0.158 | 0.185 | -0.027 [-0.048, -0.009] |
| yolo26n-pose | 0.076 | 0.136 | -0.060 [-0.088, -0.038] | 8.4 | 11.6 | -3.2 [-5.2, -1.3] | 0.107 | 0.174 | -0.067 [-0.109, -0.030] |
| mp-lite-game | 0.087 | 0.108 | -0.021 [-0.030, -0.011] | 8.9 | 9.4 | -0.6 [-1.4, 0.4] | 0.183 | 0.207 | -0.025 [-0.045, -0.007] |
| movenet-multipose | 0.088 | 0.129 | -0.041 [-0.050, -0.033] | 6.8 | 8.7 | -1.9 [-2.8, -1.0] | 0.429 | 0.539 | -0.110 [-0.169, -0.048] |
| apple-vision | 0.107 | 0.147 | -0.041 [-0.062, -0.021] | 5.9 | 7.4 | -1.6 [-2.6, -0.6] | 0.256 | 0.287 | -0.031 [-0.085, 0.027] |

The large references (ViTPose-H, RTMW-x) have the same error on real video and twins (0.056
vs 0.057 and 0.058 vs 0.058), so the twins are not uniformly harder. The extra error falls on
specific models.

### AIST: same GT kind on both sides (pseudo-GT)

| estimator | err real | err twin | err real − twin [95% CI] | score lost real | score lost twin | score lost real − twin [95% CI] |
|---|---|---|---|---|---|---|
| ref-fused (ref) | 0.000 | 0.000 | 0.000 [0.000, 0.000] | 0.133 | 0.151 | -0.019 [-0.053, 0.015] |
| ref-vitpose-h (ref) | 0.010 | 0.012 | -0.002 [-0.003, -0.001] | 0.083 | 0.085 | -0.002 [-0.035, 0.029] |
| ref-rtmw-x (ref) | 0.014 | 0.013 | 0.001 [0.001, 0.002] | 0.034 | 0.028 | 0.006 [-0.004, 0.019] |
| ref-yolo26x (ref) | 0.018 | 0.019 | -0.001 [-0.002, -0.001] | 0.068 | 0.074 | -0.006 [-0.025, 0.012] |
| rtmo-s | 0.023 | 0.032 | -0.009 [-0.014, -0.005] | 0.058 | 0.062 | -0.004 [-0.020, 0.011] |
| rtmpose-m | 0.024 | 0.030 | -0.007 [-0.015, -0.001] | 0.056 | 0.069 | -0.013 [-0.040, 0.006] |
| rtmpose-s | 0.034 | 0.040 | -0.006 [-0.013, 0.000] | 0.109 | 0.117 | -0.007 [-0.037, 0.020] |
| yolo26s-pose | 0.034 | 0.051 | -0.017 [-0.026, -0.009] | 0.090 | 0.118 | -0.028 [-0.056, -0.000] |
| rtmo-t | 0.035 | 0.064 | -0.030 [-0.042, -0.019] | 0.059 | 0.115 | -0.056 [-0.080, -0.033] |
| mp-heavy-game | 0.043 | 0.052 | -0.009 [-0.022, -0.001] | 0.208 | 0.234 | -0.026 [-0.060, 0.002] |
| yolo26n-pose | 0.047 | 0.084 | -0.037 [-0.056, -0.021] | 0.094 | 0.146 | -0.052 [-0.089, -0.016] |
| apple-vision | 0.052 | 0.074 | -0.021 [-0.036, -0.007] | 0.243 | 0.267 | -0.025 [-0.079, 0.030] |
| mp-full-game | 0.053 | 0.058 | -0.004 [-0.012, 0.002] | 0.149 | 0.167 | -0.017 [-0.037, -0.001] |
| movenet-multipose | 0.061 | 0.086 | -0.025 [-0.034, -0.017] | 0.419 | 0.525 | -0.105 [-0.159, -0.049] |
| mp-lite-game | 0.068 | 0.070 | -0.002 [-0.009, 0.005] | 0.176 | 0.186 | -0.010 [-0.029, 0.008] |

With the GT definition held equal:
- MediaPipe lite and full lose almost nothing on the twins: their exact-GT gap was GT
  definition.
- yolo26n, rtmo-t, yolo26s, MoveNet and Apple Vision keep a gap of 0.017-0.037: rendering
  appearance.
- The score-lost gap for MoveNet (−0.105) and the small one-stage models (−0.03 to −0.06) survives.

### Rank correlations

| metric | AIST real vs twin (n=18) | AIST real vs twin, both pseudo-GT | AIST pseudo-GT vs AIST++ GT, same real frames | eval real vs twin (exact GT) | eval real vs twin, both pseudo-GT |
|---|---|---|---|---|---|
| pck20c | 0.84 [0.72, 0.94] | 0.87 [0.68, 0.93] | 0.98 [0.90, 1.00] | 0.68 [0.54, 0.86] | 0.86 [0.68, 0.93] |
| pck10c | 0.90 [0.79, 0.95] | 0.90 [0.80, 0.95] | 0.90 [0.76, 0.97] | 0.86 [0.68, 0.86] | 0.89 [0.86, 0.96] |
| err_c | 0.91 [0.67, 0.95] | 0.84 [0.67, 0.88] | 0.85 [0.80, 0.94] | 0.86 [0.64, 0.93] | 0.96 [0.86, 0.96] |
| limb | 0.85 [0.75, 0.94] | 0.80 [0.73, 0.91] | 0.75 [0.61, 0.88] | 0.93 [0.68, 0.96] | 0.96 [0.86, 1.00] |
| limb_c | 0.85 [0.75, 0.94] | 0.79 [0.71, 0.90] | 0.75 [0.62, 0.89] | 0.82 [0.68, 0.96] | 0.86 [0.79, 0.96] |
| usable | 0.96 [0.91, 0.97] | 0.96 [0.87, 0.99] | 0.97 [0.94, 0.99] | 0.93 [0.75, 1.00] | 0.96 [0.75, 1.00] |
| sure_wrong | 0.95 [0.81, 0.96] | 0.85 [0.65, 0.92] | 0.78 [0.55, 0.89] | 0.57 [0.29, 0.64] | 0.54 [0.39, 0.79] |
| jitter | 0.89 [0.76, 0.96] | 0.88 [0.61, 0.95] | 0.90 [0.81, 0.94] | 0.57 [0.43, 0.82] | 0.82 [0.61, 0.93] |
| swaps | 0.63 [-0.20, 0.85] | 0.55 [-0.17, 0.72] | 0.92 [0.17, 0.98] | 0.18 [-0.13, 0.75] | 0.54 [-0.09, 0.82] |
| recall | 0.63 [0.26, 0.86] | 0.54 [0.26, 0.84] | 1.00 [1.00, 1.00] | 0.50 [0.00, 0.71] | 0.50 [-0.04, 0.71] |
| fp | 0.27 [-0.01, 0.63] | 0.29 [-0.04, 0.70] | 1.00 [0.96, 1.00] | 0.29 [-0.19, 0.50] | 0.32 [-0.13, 0.71] |
| lost | 0.63 [0.41, 0.94] | 0.63 [0.41, 0.94] | 1.00 [1.00, 1.00] | 0.93 [0.14, 0.98] | 0.93 [0.20, 0.96] |
| id_acc | 0.62 [0.42, 0.95] | 0.62 [0.40, 0.94] | 1.00 [1.00, 1.00] | 0.75 [0.36, 0.95] | 0.86 [0.40, 0.95] |
| score_lost | 0.89 [0.84, 0.96] | 0.96 [0.87, 0.99] | 0.95 [0.96, 1.00] | 1.00 [0.93, 1.00] | 0.96 [0.93, 1.00] |

AIST by view, real vs twin:

| metric | front (9) | angled (7) | back (2) |
|---|---|---|---|
| err_c | 0.69 [0.42, 0.95] | 0.91 [0.78, 0.93] | 0.94 [0.70, 0.94] |
| limb_c | 0.87 [0.63, 0.94] | 0.85 [0.56, 0.93] | 0.87 [0.77, 0.87] |
| score_lost | 0.75 [0.63, 0.94] | 0.95 [0.86, 0.97] | 0.87 [0.87, 0.91] |

Front-view ranks of joint error correlate least (0.69). On front views the estimators are
closest together, so the model-specific synthetic penalties reorder them more easily.

### Per joint (AIST, mean offset-corrected error over ranked estimators)

| joint | real, AIST++ GT | twin, exact GT | real, pGT | twin, pGT |
|---|---:|---:|---:|---:|
| shoulders | 0.051 | 0.100 | 0.034 | 0.045 |
| elbows | 0.098 | 0.134 | 0.053 | 0.078 |
| wrists | 0.122 | 0.178 | 0.057 | 0.104 |
| hips | 0.060 | 0.080 | 0.040 | 0.040 |
| knees | 0.057 | 0.070 | 0.039 | 0.046 |
| ankles | 0.060 | 0.070 | 0.040 | 0.046 |

- **Shoulders:** the doubling under exact GT (0.051 → 0.100) is mostly GT definition, since
  the same-kind gap is only 0.034 → 0.045. trackbench's shoulder is the joint centre inside
  the body; the models learnt the COCO point. The pose-dependent part of that difference
  survives the mean-offset correction.
- **Wrists and elbows:** a real appearance gap (0.057 → 0.104 for wrists with pseudo-GT on
  both sides). Rendered hands and forearms are harder for these models than real ones.
- **Hips and legs:** no appearance gap.

### Failure modes (AIST, mean over ranked estimators; error with / without the condition)

| condition | real, AIST++ GT | twin, exact GT | real, pGT | twin, pGT | frames real / twin |
|---|---|---|---|---|---|
| arms overhead | 0.097 / 0.069 (+40%) | 0.134 / 0.098 (+37%) | 0.055 / 0.040 (+37%) | 0.084 / 0.052 (+61%) | 1535 / 1522 |
| back view | 0.105 / 0.068 (+55%) | 0.114 / 0.103 (+10%) | 0.056 / 0.040 (+41%) | 0.060 / 0.057 (+5%) | 1352 / 1401 |
| low (crouch / floor) | 0.101 / 0.073 (+38%) | 0.159 / 0.103 (+54%) | 0.068 / 0.042 (+63%) | 0.103 / 0.056 (+84%) | 309 / 286 |

Paired difficulty: the same frame's mean error across estimators correlates real vs twin at
ρ = 0.56 (8100 frames; median 0.57 within a sequence). Per sequence, ρ = 0.66 [0.27, 0.92]:
the hard sequences (jb travelling, the back and side views) are hard in both domains.

### Pseudo-GT validity (on real AIST frames, against AIST++ GT)

- **Accuracy:** the fused pseudo-GT scored as an estimator has error 0.054 and PCK@0.2 0.977
  against AIST++ GT, about the same as the best single reference (ViTPose-H 0.056).
- **Bias:** it understates other models' errors, by ≈2.5× for COCO-family models (rtmpose-m
  0.024 vs 0.060) and ≈1.5× for MediaPipe (heavy 0.043 vs 0.064), because it shares the COCO
  models' conventions and some of their mistakes.
- **Ranking:** estimators ranked by pseudo-GT vs by AIST++ GT on the same frames give ρ = 0.98
  [0.90, 1.00] for PCK@0.2, 0.85 [0.80, 0.94] for error, 0.75 [0.61, 0.88] for limb angle and
  0.95 for score lost. Two clear pairwise flips for error (Apple Vision vs MoveNet, Apple
  Vision vs mp-lite), none for PCK, limb or score.

Pseudo-GT therefore ranks well-separated models correctly but can't rank models whose error
is within ≈0.03 torso lengths of each other or of its own error. Read the eval-clip domain
with that limit.

### Second real domain: eval clips (pseudo-GT; 4 solo + 6 multi-dancer)

| estimator | err real | err twin pGT | err real − twin pGT [95% CI] | score lost real | score lost twin pGT | score lost real − twin pGT [95% CI] | id acc real | id acc twin pGT | id acc real − twin pGT [95% CI] |
|---|---|---|---|---|---|---|---|---|---|
| ref-fused (ref) | 0.000 | 0.000 | 0.000 [0.000, 0.000] | 0.356 | 0.174 | 0.181 [0.023, 0.401] | 0.958 | 0.982 | -0.022 [-0.050, 0.003] |
| ref-vitpose-h (ref) | 0.014 | 0.013 | 0.001 [-0.000, 0.002] | 0.069 | 0.040 | 0.029 [-0.015, 0.087] | 0.803 | 0.704 | 0.099 [0.058, 0.138] |
| ref-rtmw-x (ref) | 0.017 | 0.014 | 0.002 [0.000, 0.004] | 0.069 | 0.021 | 0.048 [0.012, 0.098] | 0.999 | 0.997 | 0.002 [-0.001, 0.004] |
| ref-yolo26x (ref) | 0.022 | 0.022 | 0.000 [-0.002, 0.002] | 0.090 | 0.047 | 0.043 [-0.003, 0.114] | 0.999 | 0.999 | 0.000 [-0.001, 0.002] |
| rtmpose-m | 0.028 | – | – | 0.072 | – | – | 1.000 | – | – |
| rtmo-s | 0.033 | 0.036 | -0.002 [-0.008, 0.002] | 0.075 | 0.033 | 0.042 [0.008, 0.096] | 0.997 | 0.998 | -0.000 [-0.002, 0.002] |
| rtmpose-s | 0.038 | – | – | 0.137 | – | – | 1.000 | – | – |
| yolo26s-pose | 0.041 | 0.053 | -0.012 [-0.021, -0.005] | 0.106 | 0.075 | 0.030 [-0.019, 0.098] | 0.998 | 0.999 | -0.000 [-0.001, 0.000] |
| rtmo-t | 0.044 | – | – | 0.061 | – | – | 1.000 | – | – |
| yolo26n-pose | 0.050 | – | – | 0.077 | – | – | 1.000 | – | – |
| mp-heavy-game | 0.055 | 0.054 | 0.001 [-0.006, 0.007] | 0.292 | 0.154 | 0.138 [0.052, 0.245] | 0.994 | 0.997 | -0.002 [-0.007, 0.001] |
| mp-full-game | 0.068 | 0.063 | 0.005 [-0.004, 0.017] | 0.221 | 0.116 | 0.104 [0.026, 0.202] | 0.993 | 0.997 | -0.005 [-0.017, 0.003] |
| apple-vision | 0.075 | 0.125 | -0.050 [-0.072, -0.033] | 0.317 | 0.253 | 0.064 [-0.032, 0.164] | 0.985 | 0.979 | 0.006 [-0.010, 0.024] |
| mp-lite-game | 0.081 | 0.074 | 0.007 [-0.005, 0.018] | 0.244 | 0.115 | 0.128 [0.045, 0.230] | 0.997 | 0.993 | 0.004 [-0.003, 0.014] |
| movenet-multipose | 0.091 | 0.152 | -0.061 [-0.099, -0.030] | 0.662 | 0.679 | -0.016 [-0.096, 0.067] | 0.952 | 0.910 | 0.043 [-0.003, 0.091] |

- **Rankings:** real vs twin with pseudo-GT on both sides, ρ = 0.96 [0.86, 0.96] for joint
  error, 0.86 [0.68, 0.93] for PCK@0.2 and 0.96 [0.93, 1.00] for score lost (7 estimators).
  With exact twin GT: 0.86, 0.68 and 1.00.
- **Appearance gap:** the same pattern as AIST. MoveNet (−0.061) and Apple Vision (−0.050)
  are much worse on renders; MediaPipe has no gap (+0.001 to +0.007).
- **Score lost is higher on these real clips than on their twins**, the reverse of AIST:
  +0.10-0.14 for MediaPipe, +0.04 for rtmo-s. This domain can't separate harder real content
  (phone video, motion blur, small people in padded portrait frames) from noisier pseudo-GT
  (89.7% agreed joints, wrists 71%; the filled joints enter the score reference). On AIST,
  where pseudo-GT agreement is 95%, real and twin score-lost levels match within 3 points
  for MediaPipe.
- **Identity** (multi-dancer, c2 excluded), mean of c1, c3 and atd-1..3:

  | estimator | real identity accuracy | twin identity accuracy | real switches / scene | twin switches / scene | real lost frac | twin lost frac |
  |---|---:|---:|---:|---:|---:|---:|
  | mp-lite-game | 0.994 | 0.988 | 3.8 | 0.6 | 0.026 | 0.009 |
  | mp-full-game | 0.987 | 0.995 | 3.4 | 1.0 | 0.029 | 0.008 |
  | mp-heavy-game | 0.990 | 0.993 | 3.6 | 1.6 | 0.031 | 0.013 |
  | rtmo-s | 0.995 | 0.995 | 1.4 | 0.0 | 0.012 | 0.007 |
  | yolo26s-pose | 0.997 | 0.997 | 1.2 | 0.8 | 0.013 | 0.005 |
  | apple-vision | 0.979 | 0.975 | 1.0 | 1.2 | 0.031 | 0.027 |
  | movenet-multipose | 0.915 | 0.836 | 4.6 | 0.8 | 0.040 | 0.166 |

  - Identity accuracy agrees within 0.01, except MoveNet.
  - Real clips have 2-6× more brief switches and 2-3× more lost frames for the MediaPipe
    pipelines. These are short drop-outs and re-acquisitions, not lasting swaps.
  - On c2 every estimator swaps (24-32 switches, 14-32% wrong-player frames, partly
    pseudo-GT error). Its twin had none, because the twin's dancers stay on their spots.

## Limits

- **Sample:** 18 AIST sequences (single dancer, 15 s each) and 11 ranked estimators; 10 eval
  sequences and 7 estimators. Many rank CIs are wide, and the back-view group has 2
  sequences.
- **AIST is not a webcam scene:** a white studio, cameras about 5 m away (cropped to a webcam
  framing with a 34-55° FOV), a single dancer. The twins use trackbench's plain room. Living
  rooms, clutter, low light, distractors and multiplayer are not covered by the clean
  real-GT test; the eval domain covers some of them, with pseudo-GT only.
- **GT definitions differ:** AIST++ follows COCO conventions; trackbench uses anatomical
  centres.
  - Offset-corrected metrics remove the mean difference, not the pose-dependent part
    (mainly shoulders).
  - Raw limb and score metrics include it. The convention-corrected `limb_c` changes little
    (ρ 0.85 either way).
  - Pose conditions defined on GT points shift slightly with the convention.
- **AIST++ GT is not perfect:** triangulated from 2D detections and optimised. Its noise
  limits how well the best models (error ≈0.055) can be separated.
- **Pseudo-GT** (eval domain and the `*pgt` roots) scores only agreed joints, which biases
  toward easier joints (wrists are 71-89% covered). It also understates COCO-family errors
  (see the validity section).
- **Twin fidelity:**
  - Eval twins match framing and setting but not motion.
  - AIST twins match motion and camera but not body shape exactly, and only approximately
    clothes and hair.
  - The twins never reproduce crossings or bystanders.
- **Runtimes:** non-MediaPipe models ran in Python on the CPU (`estimators/run.py`), not as
  browser ports. MediaPipe ran through the game's own worker.

## Suggestions for trackbench

1. Rank on synthetic, but calibrate absolute levels against `real-aist-*`.
2. Treat MediaPipe-vs-small-one-stage-model margins under ≈0.04 torso lengths as unresolved.
3. Add an option to score against COCO-style keypoints (or report per-joint): the shoulder
   joint-centre definition doubles shoulder error for models trained on COCO.
4. Look at forearm and hand rendering: wrists and elbows carry the remaining appearance gap.
5. Back views look easier on the renders than on real footage. Check why (hair? clothing
   back textures? the face's absence?) before relying on the back-view category.
6. Validate the multiplayer and identity categories against real crossings: the twins here
   had none, and the one real clip with crossings needs hand-labelled identities.

## Reproduce

```sh
S2R=/Volumes/development/aerodance-trackbench/sim2real   # roots aist/ aistsyn/ aistpgt/ aistsynpgt/ real/ syn/ synpgt/ (symlinks to .venv, downloads, models, bin, dist-snapshot)
PY=/Volumes/development/aerodance-trackbench/.venv/bin/python
H=tools/trackbench/sim2real
uv venv -p 3.12 $S2R/.venv-ref && VIRTUAL_ENV=$S2R/.venv-ref uv pip install torch torchvision transformers ultralytics onnx onnx2torch rtmlib opencv-python-headless pillow scipy
# AIST (videos in $TRACKBENCH_DATA/downloads/aist-video/<seq with cNN>.mp4 from https://aistdancedb.ongaaccel.jp/v1.0.0/video/10M/)
$PY $H/aist_views.py                      # view geometry for choosing sequences
$PY $H/aist_scenes.py                     # real-aist-* scenes + aist_cameras.json
python3 $H/aist_twins.py && TRACKBENCH_DATA=$S2R/aistsyn python3 tools/trackbench/render.py $H/scenes/twin-aist-*.json --jobs 2
# Eval clips
python3 $H/make_twins.py && TRACKBENCH_DATA=$S2R/syn python3 tools/trackbench/render.py $H/scenes/twin-{stage,living}-[12].json $H/scenes/twin-{c1,c2,c3,atd-1,atd-2,atd-3}.json --jobs 2
$PY $H/make_scenes.py real && $H/pipeline.sh twins
# References, pseudo-GT
for r in aist aistsyn real syn; do $H/pipeline.sh refs $r; done
$H/pipeline.sh fuse-real
$H/pipeline.sh pgt-copy aist aistpgt; $H/pipeline.sh pgt-copy aistsyn aistsynpgt; $H/pipeline.sh pgt-copy syn synpgt
# Estimators (ESTS=... to choose), the game's pipeline, references as estimators, tracking
ESTS="rtmo-s rtmpose-s movenet-multipose apple-vision yolo26n-pose yolo26s-pose rtmo-t rtmpose-m" $H/run_estimators.sh aist   # and aistsyn; eval: real, syn
$H/run_game.sh aist   # and aistsyn, real, syn
$H/pipeline.sh refdets aist 'real-aist-*' aistpgt; $H/pipeline.sh refdets aistsyn 'twin-aist-*' aistsynpgt; $H/pipeline.sh refdets real 'real-*' real; $H/pipeline.sh refdets syn 'syn-*' synpgt
for r in aist aistsyn real syn; do $H/pipeline.sh track $r; done
$H/pipeline.sh link aist aistpgt; $H/pipeline.sh link aistsyn aistsynpgt; $H/pipeline.sh link syn synpgt
for r in aist aistsyn aistpgt aistsynpgt real syn synpgt; do $H/pipeline.sh metrics $r; done
$PY $H/analyze.py --boot 2000            # results.json, results.md (~20 min)
$PY $H/pairflips.py aist aist aistsyn    # pairwise decision flips
$PY $H/readme_tables.py                  # the compact tables above
$PY $H/draw_pgt.py <scene-dir> /tmp/sheet.jpg [frames]   # eyeball GT; never write into the repo
```

## Files

| File | |
|---|---|
| `aist.json`, `aist_cameras.json` | real-aist sequences; their crops and twin cameras |
| `aist_views.py`, `aist_scenes.py`, `aist_twins.py` | AIST view geometry, real scenes with projected GT, twin specs |
| `sequences.json`, `make_twins.py`, `make_scenes.py`, `reframe.py` | eval clips, their twins, the shared reframing |
| `scenes/twin-*.json` | twin specs (render with `render.py`); `twin-stage-3`, `twin-living-3/4` are written by `make_twins.py` but were dropped (time) and not rendered |
| `refs.py`, `fuse_pgt.py`, `refdets.py` | reference ensemble, pseudo-GT fusion, references as estimators |
| `run_estimators.sh`, `run_limited.py`, `run_game.sh`, `run_all.sh`, `pipeline.sh` | runners |
| `s2r_metrics.ts` | harness metrics, pseudo-GT aware, plus per-frame rows (conditions, limb angles) |
| `analyze.py`, `pairflips.py`, `readme_tables.py` | statistics and tables |
| `results.json`, `results.md` | the numbers |
| `draw_pgt.py` | GT contact sheets for checking (outside the repo only) |
