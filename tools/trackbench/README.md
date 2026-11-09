# trackbench

A benchmark for aerodance's player tracking. Blender renders synthetic webcam footage of realistic
people (MakeHuman/MPFB humans) dancing real motion capture (AIST++) in living rooms, with exact
per-frame ground truth. Harnesses then run the game's own pose pipeline, and candidate replacement
pose estimators, over the footage. They measure what players feel: whether everyone is found and
kept apart, how long setup takes, and above all how many points tracking costs them.

The findings, and the changes made because of them, are in [REPORT.md](REPORT.md).

| Part | What it does | Docs |
|---|---|---|
| [`CONTRACT.md`](CONTRACT.md) | Scene spec, ground-truth and detection formats, coordinates | |
| [`scenes/`](scenes/) | The suite: one hand-editable JSON spec per scene, 133 of them | [`SUITE.md`](scenes/SUITE.md) |
| [`render.py`](render.py), [`blender/`](blender/) | Spec → frames, masks, `gt.jsonl` | [`GENERATOR.md`](blender/GENERATOR.md), [`ENVIRONMENT.md`](blender/ENVIRONMENT.md) |
| [`post/`](post/) | Sensor and lens effects (noise, low light, blur, JPEG, ultrawide, rolling shutter) | [`ENVIRONMENT.md`](blender/ENVIRONMENT.md) |
| [`harness/`](harness/) | The game's worker in Chromium/Metal, its tracker, calibration and scorer; metrics; reports | [`harness/README.md`](harness/README.md) |
| [`estimators/`](estimators/) | Runners for candidate pose estimators (MediaPipe, RTMO, RTMPose, MoveNet, Apple Vision, YOLO references), browser latency probes | [`README.md`](estimators/README.md), [`CANDIDATES.md`](estimators/CANDIDATES.md) |
| [`matrix.py`](matrix.py), [`finalize.sh`](finalize.sh) | Every estimator over every scene, skipping work that's done | |
| [`studies/`](studies/) | Paired comparisons, calibration rules, scoring treatments | below |
| [`sim2real/`](sim2real/) | Checks that synthetic conclusions hold on real footage (AIST++ videos) | [`README.md`](sim2real/README.md) |
| [`audit/`](audit/) | Independent audits of the GT, harness and runners, with their check scripts | [`gt-harness-audit.md`](audit/gt-harness-audit.md), [`estimators-audit.md`](audit/estimators-audit.md) |

## Setup

Data lives outside the repository in `$TRACKBENCH_DATA` (default
`/Volumes/development/aerodance-trackbench`): downloads, rendered scenes, runs and reports. Never
commit any of it.

1. Blender 5.2 with the **MPFB** extension (`blender --online-mode --command extension install mpfb --enable`)
   and the MakeHuman CC0 system assets
   (`http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip`)
   unpacked into MPFB's user data directory
   (`~/Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data`).
2. AIST++ annotations (CC BY 4.0): `motions.zip` and `keypoints3d.zip` from
   `https://github.com/google/aistplusplus_dataset/releases/tag/v1.0`, unpacked into
   `$TRACKBENCH_DATA/downloads/aist/`.
3. Poly Haven CC0 furniture, textures and HDRIs: `python3 tools/trackbench/blender/assets_fetch.py`.
4. A Python 3.12 venv at `$TRACKBENCH_DATA/.venv` with numpy, scipy, opencv-python-headless,
   pillow, onnxruntime, mediapipe, rtmlib and tensorflow (`uv venv -p 3.12` then `uv pip install`).
5. `npm ci && npm run build` in the repository (the harness serves a snapshot of `dist/`).

## Use

```sh
# Render a scene (or several), with an overlay video of the ground truth.
python3 tools/trackbench/render.py base-solo --jobs 2 --preview

# The game's own pipeline on it, then metrics.
node tools/trackbench/harness/run-game.ts base-solo                  # --model full|heavy, --realtime
node tools/trackbench/harness/metrics.ts mp-lite-game base-solo

# A candidate estimator: detections, the game's tracker, metrics.
$TRACKBENCH_DATA/.venv/bin/python tools/trackbench/estimators/run.py rtmo-s base-solo
node tools/trackbench/harness/track.ts rtmo-s base-solo
node tools/trackbench/harness/metrics.ts rtmo-s base-solo

# The game's pipeline over every rendered scene, several at once (see harness/README.md).
caffeinate -dimsu node tools/trackbench/harness/run-suite.ts --id mp-lite-game

# Everything over every rendered scene, then the paired comparison.
caffeinate -dimsu python3 tools/trackbench/matrix.py --cpu-jobs 3
node tools/trackbench/studies/paired.ts --name my-comparison
```

To try a change to the game's tracking, change the game's code and re-run. The harness imports
the game's tracker, calibration and scorer, and serves the built worker, so `track.ts` and
`metrics.ts` measure the change directly. (`run-game.ts` snapshots `dist/` by git commit, so
rebuild and commit, or delete the snapshot, after changing the worker.)

### Studies

- `studies/paired.ts`: every estimator on the same scenes, failures counted, and differences from
  a baseline with paired bootstrap 95% intervals, overall and per category.
- `studies/calibration.ts`: replays detections through the game's loop with calibration rules
  swapped in. It measures time to calibrate after players start holding still, completions that
  never come, and completions that shouldn't happen.
- `studies/score-robustness.ts`: scores tracked poses with treatments (confidence gates, joint
  holds, smoothing), against the right dance and two controls that must not gain: the wrong
  moves of the same song, and the player standing still.

### Adding a scene

Copy a spec in `scenes/` (or write a variant: `"base": "<id>"` plus the fields that differ), and
describe the hypothesis it tests in `description` and `SUITE.md`. The timeline's segments
(`offstage`, `walk`, `hold`, `dance`) set what each person does. Holds meant to calibrate must
be at least 3.5 s: the game needs 2.5 s of stillness, and segments blend. Look at the preview
before trusting a scene.

## What the numbers mean, and don't

- **Synthetic vs real.** On 18 real AIST++ videos with triangulated ground truth, estimator
  rankings matched their synthetic twins' (Spearman 0.84-0.91 across metrics, 0.89 for score
  lost). Absolute errors are higher on synthetic footage, by a model-dependent amount, and back
  views are easier on renders. Trust comparisons, not levels ([sim2real](sim2real/README.md)).
- **"Score lost to tracking"** is the game's real scorer, run with the tracked poses against a
  reference made from the dancer's own ground truth. It is compared with the same scorer given
  the ground truth itself, with joints outside the picture unseen. It's an oracle comparison,
  not a hard upper bound ([audit](audit/gt-harness-audit.md#7-gt-as-live-input-is-an-oracle-baseline-not-an-upper-bound)).
- **Corrected keypoint errors** remove each model's mean per-joint offset, fitted on the ten
  `base-genre-*` scenes only (models define hips and shoulders differently from the rig's joint
  centres). Raw errors are reported too.
- **Timings** in the matrix come from a shared machine running renders. Use the browser probes
  in `estimators/web/` on an idle machine for latency.

## Licences

AIST++ annotations are CC BY 4.0 (credit: Li et al., *AI Choreographer*, ICCV 2021). MakeHuman
assets and Poly Haven assets are CC0. The AIST Dance DB videos used by `sim2real/` are for
research use under AIST's terms and stay outside the repository. Candidate estimators' code and
weight licences are in [CANDIDATES.md](estimators/CANDIDATES.md). Ultralytics YOLO is AGPL and
is only a reference here.
