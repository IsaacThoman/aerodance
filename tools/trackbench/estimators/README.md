# Candidate estimator runners

All generated data stays under `$TRACKBENCH_DATA` (default `/Volumes/development/aerodance-trackbench`). No weights, footage, rendered images, or AGPL implementation source are checked in. See [CANDIDATES.md](CANDIDATES.md) for the survey, licence boundaries, measurements and recommendations.

## Run

From the repository root:

```sh
PY=/Volumes/development/aerodance-trackbench/.venv/bin/python
$PY tools/trackbench/estimators/run.py mp-full _sample-solo
$PY tools/trackbench/estimators/run.py rtmo-s _sample-quad
$PY tools/trackbench/estimators/run.py rtmpose-s _sample-quad --det-interval 5
$PY tools/trackbench/estimators/run.py rtmpose-s _sample-quad --det-interval 1 --run-id rtmpose-s-det1
$PY tools/trackbench/estimators/run.py movenet-multipose _sample-quad
$PY tools/trackbench/estimators/run.py apple-vision _sample-quad
$PY tools/trackbench/estimators/run.py apple-vision-3d _sample-solo
$PY tools/trackbench/estimators/run.py yolo26n-pose _sample-quad
$PY tools/trackbench/estimators/run.py mp-lite /Volumes/development/aerodance-trackbench/proto/rt --players 1 --limit 6
$PY tools/trackbench/estimators/run_ready.py --limit 30
$PY tools/trackbench/estimators/sanity.py _sample-quad
```

IDs: `mp-lite`, `mp-full`, `mp-heavy`, `rtmo-t`, `rtmo-s`, `rtmo-m`, `rtmpose-s`, `rtmpose-m`, `rtmw-x`, `movenet-multipose`, `movenet-lightning`, `movenet-thunder`, `apple-vision`, `apple-vision-3d`, `yolo11n-pose`, `yolo11s-pose`, `yolo26n-pose`, `yolo26s-pose`.

Python dependencies: numpy, scipy, opencv-python, onnxruntime, mediapipe, rtmlib, tensorflow. Installed TensorFlow 2.21.0 and onnx 1.23.2 in the supplied shared venv. YOLO is reference-only and automatically re-execs `~/wmyb-blender/.venv/bin/python` if ultralytics is absent; that existing environment is used read-only. Apple requires macOS and `swiftc`; the compiled executable goes in `$TRACKBENCH_DATA/bin`. Nothing changes the app's package.json/lockfile.

`scene-id` reads `scenes/<id>/spec.json` for fps and player count and requires READY. A frames directory also works; supply `--players`/`--fps` as needed (defaults 1/30). `--start` is a 1-based slice into sorted files; numeric filenames preserve original GT frame numbers. Non-numeric prototype filenames use sequential frame numbers; the sparse prototype images are **not** a continuous 30 fps sequence. `--limit` limits work, `--run-id` separates settings. Outputs are `runs/<id>/<scene>/detections.jsonl` and `run.json`; rerunning the same id replaces its results. Python detections are written through a temporary file. Metadata contains hashes, byte sizes, versions, settings and timing scope.

## Semantics

- Every detection has exactly 33 slots. COCO-17 maps to `0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28`. Subject left stays left. Missing face corners, mouth, hands and feet stay null. Never duplicate the ankle into a missing heel.
- Halpe-26: source big toes 20/21 → 31/32; heels 24/25 → 29/30. COCO-WholeBody: big toes 17/20 → 31/32; heels 19/22 → 29/30. Small toes are not substituted. WholeBody also maps its 68-point face eye/mouth corners and hand thumb/index/pinky tips into the corresponding slots; these annotation conventions are close but not anatomically identical to MediaPipe.
- x/y use the full unmirrored frame. Preserve out-of-frame predictions instead of clamping (clamping hides error). Vision's bottom-left image y is flipped. 2D models emit z=0. MediaPipe keeps its native hip-relative z. Vision 3D records root-relative **metres**, explicitly flagged in metadata: those z values cannot feed the current character retargeter unchanged.
- MediaPipe uses `min(visibility,presence)`, VIDEO mode, scene player count, thresholds .5. Python CPU Tasks is not the browser GPU worker and does not implement strips. Accuracy/timing must be labelled accordingly.
- RTMO uses a .3 person threshold and .45 NMS via RTMLib; removes its all-zero dummy pose on empty images. Joint scores are clipped to [0,1]. Person score is the mean first-17 joint score (not the internal detector score); the browser probe reports the detector score but uses the same filtering.
- RTMPose Body7 downloaded s/m exports yield raw SimCC responses around 0–1.1 on the tested crops: `clip(raw,0,1)`. RTMW-x's supplied raw responses reach roughly 9: `clip(raw/10,0,1)`. These are **fixed, provisional scores, not calibrated probabilities**. RTMLib combines per-axis maxima by their mean in the installed version. A .5 game gate is not semantically equivalent across models. Do not optimize a score mapping against the evaluation split; calibrate on a separate labelled set. Unit tests exercise both scales and foot mappings.
- RTMPose/RTMW use YOLOX-tiny HumanArt at 416², .3 threshold. Every fifth processed frame redetects (or sooner if no boxes remain). Between detections, boxes come from previous keypoints above raw .2 (RTMW 2), with 15% padding; pose preprocessing adds its standard 1.25 crop expansion. This is box propagation, **not identity tracking**. New arrivals may wait four frames; crossings, fast motion and close bodies need the harness. `--det-interval 1` is the detector-every-frame baseline.
- Supplied RTMW-x is **fixed batch 8**. The adapter repeats each crop eight times and discards seven outputs. This establishes a working accuracy reference, not a fair optimized speed baseline; a batch-1 re-export or actual multi-person batching is required before latency comparison.
- MoveNet Python uses the official SavedModel release (MultiPose v1; singles v4), RGB int32, centered letterbox to 256² (Lightning single 192²), inverse padding on outputs. MultiPose supports up to six people, filtered at .2 person score. Singles are whole-frame only, no tracking crop. TF.js uses the corresponding official MultiPose v1 graph, same square input and no smoothing.
- Vision 2D is multi-person. Vision 3D works here but normally represents the most prominent person, has a different joint layout, and exposes observation confidence rather than a visibility probability per joint. Errors are recorded in `run.json`, not silently treated as good detections.

Python timings include preprocessing, network inference and output decoding/mapping; exclude image file decode except Vision's URL-backed lazy decode. First inference is retained. Initialization includes download if uncached. Shared machine contention is possible. No reported number is an A10X/iPhone measurement.

## Browser probe

```sh
npm ci --prefix tools/trackbench/estimators/web --no-audit --no-fund
$PY tools/trackbench/estimators/web/prepare.py
node tools/trackbench/estimators/web/bench.mjs
$PY tools/trackbench/estimators/web/parity.py
```

`prepare.py [solo-image] [quad-image]` accepts replacement images or directories. Defaults: synthetic `proto/rt/f0001.png` and verified four-dancer `~/aerodance-tracking-eval/frames/v4/02000.jpg`. It resizes to 640×480 **outside the repo**, produces exact RTMO input tensors and Python raw-output references, and downloads the official MoveNet TF.js graph/shards. These fixtures are local evaluation material, not redistributable assets.

The launcher serves only on loopback, starts Chromium 1243 with Metal/GPU flags, rejects SwiftShader, and closes its browser/server. ORT 1.24.3: RTMO-t/s WebGPU and single-thread WASM. TF.js 4.22.0: MoveNet MultiPose WebGL. Repo Tasks Vision: Lite/Full/Heavy WebGL in module workers. All run in workers. Optional model list: `node .../bench.mjs rtmo-m` (overwrites latest report). Each case gets a fresh page/worker, three warmups and ten timed repeated-still inferences. This is a feasibility probe, not video accuracy or a thermal test.

`browser-results/latest.json` includes byte size, loopback fetch time, init time, every latency sample, final detections, requested count, renderer, raw parity and memory observations. ORT timing includes canvas readback, BGR/CHW preprocessing, inference and decoding/NMS; MoveNet includes tensor construction/resize and awaited output readback; MediaPipe includes its processing. Reported bytes exclude runtime JS/WASM and HTTP compression. RSS is the launcher's own browser process tree sampled after each case, **not peak memory or isolated model allocations**; worker JS heap and TF tensor allocations cannot measure GPU memory reliably.

`parity.py` adds end-to-end decoded keypoint error versus Python, using identical fixture frames and matched high-confidence joints. Raw-tensor parity isolates ORT execution differences; canvas resize vs OpenCV can still move coordinates. TensorFlow vs TF.js MoveNet is compared separately; a numerical match is not assumed from the architecture name.

Safari was not measured: the supplied environment reports that Playwright WebKit cannot launch. Published Safari 26 support is discussed in CANDIDATES; Chromium measurements do not certify WKWebView, Safari workers, or A10X performance.

## Mapping sanity

`sanity.py` performs Hungarian matching on confident shoulders/hips and reports per-joint pixel mean/p95, count, and deliberately swapped-side error. Unmatched people/missing joints do not get zero error. It includes self/other occluded joints but excludes out-of-frame GT, uses no anatomical offset correction, and refuses partial scenes. The full harness should own identity, coverage and score-loss metrics. Tests:

```sh
$PY -m unittest discover -s tools/trackbench/estimators -p 'test_*.py'
```
