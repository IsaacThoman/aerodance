# Independent GT / harness audit

Reviewed 2026-11-01, in the shared checkout. No production files changed, no commits, no render/model jobs launched. Audit scripts are beside this report; generated measurements and independently drawn overlays are in `/Volumes/development/aerodance-trackbench/audit/`. Other agents were adding runs during this audit: counts below refer to `summary-checks.json`, not a frozen suite.

**Verdict:** the sampled GT geometry and the tested score replay are sound. Fix report failure handling and distorted-camera normalization before using aggregate numbers to rank estimators. Corrected PCK, calibration, dropped-frame tracking metrics, and the “GT ceiling” need the qualifications below. I found no demonstrated one-frame/time-unit shift or wholesale left/right inversion.

## Findings

### 1. Null failures disappear from averages and worst cases; deltas cease to be paired

**Severity: wrong conclusions.** `harness/report.ts:59`, `:68–80`; `metrics.ts:308–318`, `:340–344`.

`avg` discards nulls. Never calibrated, never numbered, and never tracked are represented as null timing/identity values. They therefore disappear from means and the corresponding worst-scenes lists, without an effective sample count or failure rate. Snapshot: Lite has 27 never-calibrated scenes out of 112, Heavy 12/82, RTMO-s 7/79. Lite also has three null after-numbering identity metrics. None of these failures contributes a penalty to the corresponding report column.

The code correctly intersects scene IDs for baseline deltas, **but then filters nulls independently**. Executable counterexample in `check_harness.ts`: baseline calibration `[1000,3000]`, candidate `[null,3000]` on the same two scenes gives delta **+1000 ms**, although the only finite paired difference is **0 ms**. The candidate's actual failure is not reported in that delta. A different missingness pattern can favor the failing estimator.

Summary/category means also use each estimator's own scene set (112 versus 82 versus 79 here). They are not comparable rankings, even though fully finite baseline deltas use shared scenes.

**Fix:** expose success/failure/eligible counts per metric; show failed scenes explicitly in worst cases. Compute finite-value deltas from pairwise differences on the same eligible pairs, report their N, and separately compare failure rates. Use a common scene cohort for ranking tables or prominently label different coverage. Treat setup timeouts as censored failures, not ordinary missing data.

### 2. The 120° distortion bypasses the intended focal-length correction

**Severity: biased.** `harness/common.ts:118–127`, `:188–196`; `post/degrade.py:100–119`.

`focalOf` returns `meta.camera.K[0][0] / height` before checking whether lens distortion applies. The metadata K is explicitly pinhole; the image and GT have already been warped. Thus the documented distorted-camera fallback is unreachable for generated scenes.

For `cam-fov-120`, the harness uses **0.384900 picture heights**, versus **0.4323** inferred from GT: ratio **1.12315**. The lens has 1.12 magnification at the center. Normalized errors are inflated and the matching/PCK gates become stricter. Independent Python recomputation for RTMO-s reproduced raw error **0.174875**, PCK@.2 **0.830808**. Substituting the documented GT-estimated scale changes PCK to **0.854924** and the mean to approximately **0.1557**. This is a normalization change, not improved detections.

**Fix:** detect geometric post effects before accepting K. Prefer a local projection Jacobian applied to a canonical unforeshortened torso size; a single effective focal length is only an approximation away from image center. At minimum implement the documented distortion fallback. Recompute offsets and affected metrics. This does not directly change score replay, which uses limb directions rather than torso scale.

### 3. Offset-corrected metrics fit the evaluation data, with different training cohorts per estimator

**Severity: biased.** `harness/metrics.ts:45–67`, `:99–108`, `:423–440`.

`suiteOffsets` fits on every available detection scene, including those being scored. It uses all non-null joints with GT vis 0/1, irrespective of detection confidence. A systematic pose error is indistinguishable from an annotation offset in this fit. Scene availability changes the correction; even a request to score one scene refits using all available runs. `metrics.json` records only the number of fitting scenes, not a frozen offset identity.

Repro on RTMO-s `base-solo`: raw mean **0.0580**, raw PCK@.1 **0.8873**; fitting that scene and evaluating it gives mean **0.0464**, PCK@.1 **0.9241**. The saved suite correction gives **0.0468 / 0.9180**. This does not prove every improvement is spurious—annotation offsets are real—but these are in-sample residuals, not held-out tracking accuracy.

**Fix:** fit once on a disjoint, common calibration set, freeze/version the offsets, and use identical held-out scenes across estimators. Report raw metrics as primary until then. Label current corrected metrics as descriptive residuals. Score loss itself is unaffected: these offsets are not passed to the scorer.

### 4. Lost tracking and identity are conditioned on delivered records, not elapsed play time

**Severity: biased.** `harness/metrics.ts:178–191`, `:263–275`, `:307–314`.

Detection recall iterates only processed frames. Tracking discards every `dropped` result and has no representation for skipped camera frames or elapsed gaps. Consequently a slow estimator can look excellent whenever it supplies a pose while being unusable much of the song. The explicit dropped-only fixture produces **records=0, lost=null, identity=null**, not a failure; report aggregation then drops it as in finding 1. A perfect but very sparse stream can have identity=1 and lost=0.

**Fix:** preserve the existing metrics as “per processed frame / per delivered record” diagnostics, and add coverage/lost time on a common camera or wall-clock grid with an explicit stale-pose timeout. Report processed fraction and maximum/percentile gaps alongside them. Do not compare offline and realtime record-conditioned rates as user-visible coverage. The score path does account for sparse delivery via the real scorer's gap/reach rules, so this finding is not a claim that score loss ignores gaps.

### 5. Calibration replay permanently latches success and misses setup timeout transitions

**Severity: biased.** `harness/gameloop.ts:56–64`, `:80–85`; actual `GameSession.ts:182–191`, `:287–300`; `webcamCalibration.ts:118–120`.

Once `calibrated` is true, the harness stops both `accept` and its setup tick. In the game, while still in ready/calibrating, `status(now)` can revoke readiness after a 400 ms gap, and subsequent samples must hold again. Before completion, checking status only on result arrival also leaves stale anchors in place during silent intervals, delaying the setup line-up retry.

Executable fixture: confident fixed pose samples every 100 ms through 3000 ms complete calibration; next sample at 4000 ms, with dance start at 10000 ms. Harness record says **complete=true**. Calling the underlying calibration's actual `status(4000)` gives **complete=false, progress=0, players=['missing']**. This matters when setup is still waiting; the default game auto-start may already have left ready, so this is not an assertion that every successful run is affected. Also, `calibrationMetrics` reports capture time (`r.t_ms`) rather than the arrival time at which the user becomes ready.

**Fix:** model setup/ready/countdown explicitly, run status/retry ticks independently of results, and continue readiness checks until the simulated song starts. Distinguish first completion, readiness at start, and user-visible arrival time. Keep the documented forced dance start as a separate counterfactual mode; a score on a run that never calibrated is not an actual end-to-end playthrough.

### 6. Low-fps and irregular realtime streams have no meaningful jitter result

**Severity: biased.** `harness/metrics.ts:213–235`, `:384–394`.

Jitter requires numeric frame IDs `n-1,n,n+1`. The 15 fps scene correctly retains original IDs **1,3,5,...,675** (338 JPEGs) against 30 fps source GT. It therefore has **zero jitter samples** for Lite, Heavy, and RTMO-s. Irregular realtime streams similarly measure only consecutive surviving runs, silently selecting the easier/full-rate portions. `camera_fps` remains the source 30 rather than delivered 15.

**Fix:** use consecutive delivered samples and actual timestamps, matching GT at those times; report acceleration in torso lengths/s² or resample consistently. State source and output fps separately and expose coverage/sample count. Do not renumber frames: their existing IDs/timestamps are correct.

### 7. “GT as live input” is an oracle baseline, not an upper bound

**Severity: biased (interpretation).** `harness/score.ts:16–20`, `:39–43`, `:81–84`; `metrics.ts:358–377`.

The reference includes exact offscreen joints with confidence 1, while GT live input sets them to 0. The game's live scorer does not reject coordinates outside [0,1]; an estimator that predicts those joints confidently can beat this baseline. Conversely self/other-occluded GT joints receive confidence 1, which is an intentionally privileged oracle and not guaranteed observable tracking.

Executable check using identical input coordinates and only changing offscreen confidence: in `setup-too-close`, P1 is **713,213** under `gtLandmarks`, versus **999,918** when exact offscreen joints are enabled; P2 is **1,000,000** in both. `cam-near-2.0` gives **999,664 versus 999,983**. No saved negative score losses were found in the scanned runs; the issue is the interpretation and future validity of the claimed ceiling, not evidence of current negative results.

**Fix:** call it “score delta versus in-frame GT oracle.” Report a full-joint oracle separately, retain signed deltas, and explain what framing/occlusion penalties are included. For a camera-independent estimate of total score loss, use the full-joint oracle. Do not clamp negative deltas or describe this quantity as guaranteed loss bounded by zero.

### 8. Aggregate cost/confidence comparisons lose important runner semantics

**Severity: biased (reporting).** `estimators/run.py:20–22`, `:83`, `:197–212`; `harness/run-game.ts:139–153`, `:166–188`; `harness/report.ts:30–31`.

Python runners retain first inference and time preprocessing/network/output mapping. The game runner warms up on one real plus four grey frames and reports worker `inferenceMs`; its roundtrip is separately available but not a headline report column. CPU Python, GPU browser, and different timing scopes are placed under the same “inference ms” label. Concurrent rendering adds uncontrolled contention. These limits are documented in the runner README, but the aggregate report omits them.

Likewise a fixed .5 threshold is faithful to today's game integration, but is not equivalent visibility calibration across MediaPipe, RTMO, raw RTMPose, and provisional RTMW raw/10. A low score can reflect adapter confidence rather than inaccurate coordinates.

**Fix:** include runtime/device/timing scope/warmup/operating mode in comparisons; compare common end-to-end timing and steady-state distributions on an idle machine. Keep raw spatial error, usable-limb coverage and score together, and calibrate confidence only on a held-out training split. Do not rank architecture accuracy or deployment latency solely from the current score/cost columns.

## Verified correct, and limits of the verification

### GT geometry, visibility and frame alignment

`check_gt.py` independently applies the inverse stored camera-to-world matrix, pixel K, top-left image convention, and a separately written forward lens/shear mapping to every stored 3D keypoint in seven scenes. It does not import generator projection or `distort_points`. Max Euclidean discrepancy after stored-coordinate rounding:

| scene | GT frames | JPEGs | max projection error (px) |
|---|---:|---:|---:|
| cam-portrait | 675 | 675 | 0.01600 |
| cam-fov-120 | 675 | 675 | 0.01155 |
| sens-rolling-shutter | 675 | 675 | 0.01822 |
| sens-fps-15 | 675 | 338 | 0.01626 |
| mp2-cross-distinct | 720 | 720 | 0.02294 |
| mot-spins | 675 | 675 | 0.01522 |
| mot-floor | 675 | 675 | 0.01753 |

Every JPEG has corresponding GT. All source timestamps agree with `(frame-1)*1000/30` within **0.000334 ms**. All **338/338** retained fps-15 JPEGs are byte-identical to the same numbered base-solo frame. No speed-up or frame-number renumbering was found. Motion evaluation uses `arange(n)/fps`, bone keys use frames 1..N, and generator samples GT/render at the same scene frame.

I drew and **opened/viewed** seven independent annotated contact sheets. These are evidence paths, not generator previews:

- `/Volumes/development/aerodance-trackbench/audit/cam-portrait-gt.png`
- `/Volumes/development/aerodance-trackbench/audit/cam-fov-120-gt.png`
- `/Volumes/development/aerodance-trackbench/audit/sens-rolling-shutter-gt.png`
- `/Volumes/development/aerodance-trackbench/audit/sens-fps-15-gt.png`
- `/Volumes/development/aerodance-trackbench/audit/mp2-cross-distinct-gt.png`
- `/Volumes/development/aerodance-trackbench/audit/mot-spins-gt.png`
- `/Volumes/development/aerodance-trackbench/audit/mot-floor-gt.png`

Green=visible, orange=self-occluded, red=other-occluded; joint labels are pose-33. Sheets show frames 181/301/451/601, except rolling shutter 185/305/455/605 (nonzero shear), and crossing 404–407 (maximum overlap). Portrait dimensions are genuinely 480×640; overlays have no axis swap or rotation. Shoulders/elbows/wrists/hips/knees/ankles follow the actual rendered poses. Subject-left is image-right in the frontal pose and rotates appropriately through spins; no global L/R inversion observed.

At the crossing, **75/77** vis=2 keypoints sample the other person's mask; the remaining two sample their own label at the pixel center, compatible with raster/ray boundary differences. All **51** self-occluded points there sample their own mask; none sample the other person. Visible points never sampled the other person's mask in these sheets. A few sampled background pixels at thin extremities are compatible with subpixel/antialiasing edges. Sampled bbox boundaries agree with independently computed mask extents within **0.0032 px**. Spin back-facing facial points become self-occluded; floor-contact points can be marked environment-occluded.

Limits: masks cannot independently prove self-occlusion versus visible on the same body. GT uses explicit bone/reach heuristics for buried joint centers and excludes hair as an occluder, so these codes are approximate anatomical visibility, not photometric visibility. I did not independently rebuild the mesh BVHs or validate every face/hand vertex against an external anatomical annotation. The implemented rolling shutter is a row-dependent shear, not independently time-sampled moving geometry; consistency with that synthetic effect is verified, physical sensor fidelity is not. Static camera metadata projection checks alone would not prove RGB alignment; the viewed overlays are the separate check.

### Metric arithmetic and matching

`check_metrics.py` independently uses NumPy geometry and SciPy assignment, not harness helpers. RTMO-s `base-solo`: **recall=1.0**, **7,855** body-joint samples, mean **0.05801308**, PCK@.2 **0.97275621**; these reproduce saved **1 / 7855 / .0580 / .9728**. The FOV result in finding 2 also reproduces saved metrics. The Hungarian gate and L/R-invariant identity matching are intentional and reasonable; raw labelled errors still penalize swaps.

Torso normalization correctly applies image aspect and 3D length/depth for pinhole scenes, avoiding severe foreshortening when floor dancers bend. Expected numbering uses **descending raw-image x**, matching `PlayerTracker`'s P1 on the left of the mirrored preview (`tracker.ts:364–371`). Different estimators may number at different times; the mapping is intentionally relative to that event rather than assuming `p1` means player 1.

### Score replay

`check_harness.ts` builds the real binary reference and feeds saved records through **actual `GameSession.onRecord`**, independently advancing the scorer at 60 Hz between arrivals, then finishing. This tests a forced playing phase with song time equal to capture time, not camera/audio acquisition or setup auto-start. Scores exactly equal `scoreRecords`:

| Lite run | harness | GameSession record path |
|---|---|---|
| base-solo | 952782 | 952782 |
| sens-fps-15 | 955326 | 955326 |
| mp2-cross-distinct | 800495, 774619 | 800495, 774619 |
| mot-floor | 627942 | 627942 |

Capture and arrival clocks are not confused; confidence and aspect are passed unmodified. The shared scorer handles confidence <.5, unknown confidence, interpolation, timing search, late allowance and finish. Binary position quantization/reference interpolation can make full in-frame GT slightly below one million; the benchmark appropriately measures against its actual GT score instead of blindly subtracting from a million. No scoring-specific mismatch was demonstrated in these runs. The fixtures are offline; arbitrary delayed/malformed records and full realtime GameSession transitions are not exhaustively verified.

## Reproduction and artifacts

From the repository root:

```sh
/Volumes/development/aerodance-trackbench/.venv/bin/python -B tools/trackbench/audit/check_gt.py
/Volumes/development/aerodance-trackbench/.venv/bin/python -B tools/trackbench/audit/check_metrics.py
node tools/trackbench/audit/check_harness.ts
/Volumes/development/aerodance-trackbench/.venv/bin/python -B tools/trackbench/audit/check_summary.py
```

Outputs: `gt-checks.json`, `metrics-checks.json`, `harness-checks.json`, `summary-checks.json` and seven PNG sheets in the external audit directory. Scripts read production data, and write only audit artifacts. No full Blender rerender or estimator rerun was needed. Run snapshots were not frozen or content-hashed; re-running after concurrent jobs finish can legitimately change suite counts and measurements.
