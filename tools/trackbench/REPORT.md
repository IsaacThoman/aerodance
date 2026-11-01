# Player tracking: benchmark findings (November 2026)

What [trackbench](README.md) found about aerodance's tracking, what this branch changes because of
it, and what to do next. Numbers are means over scenes. Brackets are paired bootstrap 95%
intervals over scenes. The reports they come from are in `$TRACKBENCH_DATA/reports/`
(`paired-v1-scorer`, `paired-v2`, `calibration-final`, `score-robustness`, `strips2`). The
end-to-end "after" run of the committed game is `runs/mp-lite-game-final`.

## Summary

- **Scoring threw away points that tracking had right.** The scorer ignored any joint the model
  was less than 50% sure of, and an ignored limb scores 0. MediaPipe is often unsure of joints that
  are in the right place, so players lost points to tracking rather than to their dancing.
  **Changed:** the scorer now ignores a joint only below 10% confidence (scorer version 2). Score
  lost to tracking with the shipping model fell from **14.3% to 9.4%**. Every one of 117 scenes
  improved. Dancing the wrong moves, or standing still, gains no more than it would with perfect
  tracking.
- **Setup's calibration hold often never finished.** One jittery estimate (usually a wrist), or one
  player twitching, restarted the 2.5-second hold for everybody. With the shipping model only
  **78%** of scenes calibrated during a 5-second still hold: 47% with several players, 38% with a
  bystander in view. **Changed:** each player's hold now runs on its own, judged on a short median
  of their poses and only on the joints calibration measures. It completes when everyone is in
  view and has held long enough. **94%** now calibrate, with no false or premature completions.
- **Two players standing close together: MediaPipe loses one for the whole song.** In both such
  scenes, Lite and Full never found the second player (53-66% of score lost); every other model
  found both. Giving two players strips (as three and four get) fixed that, and was better on all
  29 symmetric two-player scenes and on real two-dancer footage. But it fails when both players
  stand on one side of the picture (63% lost), so it **isn't** in this branch. An adaptive design
  is recommended instead ([below](#two-players-close-together-not-changed-a-design-is-needed)).
- **Together**, measured end to end with the committed game, the two changes take the shipping
  model from **14.3% to 9.3%** of score lost to tracking [−5.8, −4.2 points], with no scene worse.
  Calibration before the dance rises from **77% to 92%** of scenes.
- **A better model is available, at a price.** With both changes, RTMO-s (an open, one-stage,
  multi-person model) loses **5.0%** of score against Lite's 9.4% [−6.5, −1.8 points], and RTMPose
  similar. Neither gives the depth (z) the live character turns with, both need WebGPU to run in
  real time in a browser, and their weights need a licence check. MediaPipe **Full** is the cheap
  step: 8.4% [−1.4, −0.6 points vs Lite], the same API, 3.6 MB more to download.
- **Synthetic results transfer to real footage.** Estimator rankings on synthetic scenes match
  rankings on 18 real AIST++ videos with triangulated ground truth (Spearman 0.84-0.91, 0.89 for
  score lost). Synthetic absolute numbers are somewhat pessimistic, and back views are too easy.

## What was built

[trackbench](README.md) renders realistic people dancing in realistic rooms, with exact
ground truth, and replays the footage through the game's own pipeline.

- **People:** MakeHuman bodies (adults, children, heavy, tall; three skin families), MakeHuman
  clothes recoloured, plus loose skirts and dresses. They dance **AIST++** motion capture: 10 genres
  including floor work, spins, jumps and krump. Walks and holds are procedural.
- **Places:** eight furnished rooms built from Poly Haven assets, ten lighting presets (dim lamp,
  TV glow, backlit window, party lights, flicker), and traps: mirrors, posters and TVs with people,
  a mannequin, a coat rack.
- **Cameras and sensors:** height, distance, angle, roll, portrait phones, 90° and 120° ultrawide
  lenses with barrel distortion, shake and bumps. Sensor effects include noise, dark-room gain,
  JPEG, motion blur, low frame rate, auto exposure and white balance, and rolling shutter.
- **Ground truth per frame:** MediaPipe's 33 joints in 2D and 3D, visibility (seen,
  self-occluded, hidden by another, out of frame), instance masks and identities.
- **The suite:** 117 scenes, 79,830 frames at 640x480 30 fps, 1-4 players, in ten categories
  (baseline, camera, lighting, appearance, background, motion, multiplayer, bystander, setup,
  sensor). Each scene tests one stated hypothesis ([SUITE.md](scenes/SUITE.md)).
- **Measurement:** the game's real worker runs in Chromium on the GPU, with its strips. Its
  `PlayerTracker`, `WebcamCalibration` and scorer run in the loop, by import, so a change to the
  game's code is measured directly. Metrics cover detection, joint error, limb angles, identity,
  numbering, calibration time and **score lost to tracking**. The last is the scorer's result with
  the tracked poses against the same scorer given the dancer's ground truth.
- **Candidates:** 18 estimator configurations, including MediaPipe Lite/Full/Heavy, RTMO, RTMPose,
  MoveNet, Apple Vision, YOLO11/26-pose (references only: AGPL) and RTMW. Each runs over the same
  scenes, through the game's own tracker. 7 cover the whole suite and 3 more a 39-scene subset.

Two models built it in parallel: Claude Opus 5.5 (generator, harness, solo scenes, sim-to-real)
and GPT-6 Astra (environments and sensors, estimator survey and runners, multiplayer and setup
scenes). Each audited the other's half, and each reviewed the game changes once.

## How far to trust it

- **Ground truth:** an independent audit re-projected seven scenes' 3D joints, including portrait,
  120° ultrawide, rolling shutter, a crossing, spins and floor work. Projections agree within
  0.023 px. Overlays match the bodies, and occlusion codes agree with the masks. The game's real
  `GameSession` record path reproduces the harness's scores exactly
  ([audit](audit/gt-harness-audit.md)).
- **Real footage:** 18 real AIST++ videos (all 10 genres; front, diagonal, side, back and floor
  cameras), with ground truth from triangulated keypoints, were paired with synthetic twins of the
  same motion and camera. Estimator rankings agree (Spearman, 95% CI):

  | Metric | Spearman ρ [95% CI] |
  |---|---|
  | joint error | 0.91 [0.67, 0.95] |
  | PCK@0.2 | 0.84 [0.72, 0.94] |
  | limb angle | 0.85 [0.75, 0.94] |
  | score lost | 0.89 [0.84, 0.96] |

  - Synthetic footage is harder: 0.5-11 more points of score lost, and 2-3× that for small
    one-stage models.
  - Arms-overhead difficulty transfers.
  - Back views are much easier on renders (+10% error, against +55% on real footage).
  - MediaPipe Full beats Lite, and Heavy loses the most score, on real footage too
    ([sim2real](sim2real/README.md)).
- **Fair comparison:** an audit found that candidate models were initially handicapped:
  - they weren't capped to the player count, as the game's MediaPipe is;
  - Apple Vision's missing joints were written at (0, 0).

  Both are fixed, and every comparison here uses the same 117 scenes with paired intervals
  ([audit](audit/estimators-audit.md)).
- **Limits:**
  - One machine (M5 Pro), so no phone or iPad measurements. Browser latency is Chromium only.
  - No real multiplayer footage with keypoints.
  - The synthetic people are clean renders: no cluttered real homes, no compression from real
    webcams.
  - Fairness results (skin tone) rest on a few scenes.

## Findings and changes

### Scoring: unsure joints were thrown away

The scorer drops live joints below a confidence threshold, and a dropped limb scores 0 for that
interval. At 0.5, MediaPipe Lite dropped 3.3% of scored limbs. Heavy, the most accurate MediaPipe
model, dropped 5.8% and so scored *worse* than Lite. Most of what was dropped was roughly right: on the
single-player scenes, 72% of Lite's unsure joints were within 0.2 torso lengths of the truth (89%
of its sure ones). Across models, the gate explained 28-74% of their score loss
([audit](audit/estimators-audit.md)).

`studies/score-robustness.ts` scored every tracked run under other treatments. It also ran two
controls that must **not** gain:
- the same tracked poses against a wrong reference: the dancer's moves 4 s later, i.e. dancing
  the wrong part of the song;
- the model's own output while the players stood still, looped over the dance.

| MediaPipe Lite, 117 scenes | score lost | wrong-moves score | standing-still score |
|---|---|---|---|
| gate 0.5 (version 1) | 14.2% | 22.5% | 28.4% |
| gate 0.2 | 10.2% | 24.2% | 29.0% |
| **gate 0.1 (version 2)** | **9.4%** | 24.6% | 29.0% |
| perfect tracking (ground truth) | 0 | 24.8% | – |

- **Score lost:** at gate 0.1 it falls by 4.8 points [4.1, 5.6] for Lite and 5.4 for Full, and no
  scene is worse. The controls stay at or below what perfect tracking gives them.
- **Discrimination improves:** the gap between dancing right and dancing wrong *widens*, from 63
  to 66 points.
- **Smoothing doesn't help:** smoothing positions (`smooth-50`) made scores worse for every model.
- **Holding joints is close behind:** holding a joint's last sure position for 300 ms recovers
  most of what the gate does.

**Changed in this branch:** `MIN_CONFIDENCE` 0.5 → 0.1 in `packages/score/features.ts`,
`SCORER_VERSION` 2 (best scores are stored per version), `docs/scoring.md`, and a scorer test.
The scorer compares the threshold in the recording format's steps, so a replay scores the same.
Strips now mark joints beyond their cut edges at 0.05, below the gate, since those are the
model's guesses. The character's own joint hold (`livePose.ts`, 0.5) is unchanged. One effect to
know: joints off the picture's own edges, such as feet below the frame, now count when the model
gives them 0.1 or more. The standing-still control bounds what that can gain.

| Score lost, MediaPipe Lite, by category | version 1 | version 2 |
|---|---|---|
| baseline (14 scenes) | 10.4% | 6.0% |
| motion (8) | 18.0% | 7.7% |
| camera (14) | 13.4% | 10.8% |
| lighting (9) | 9.3% | 7.0% |
| appearance (13) | 11.4% | 8.6% |
| background (10) | 5.2% | 3.5% |
| sensor (13) | 10.7% | 8.7% |
| multiplayer (17) | 22.5% | 14.4% |
| bystander (8) | 22.7% | 14.3% |
| setup (11) | 18.6% | 10.3% |

### Setup: calibration that never completes

Calibration needs every player's shoulders, hips and ankles in view at confidence 0.5. Everyone
then holds still within 0.15 torso lengths for 2.5 s. Before this branch:
- the hold was shared, so one player missed for over 200 ms, or one joint moving in a single
  result, restarted it for everybody;
- wrists counted, though calibration never measures them.

In 5-second holds where people stood still (their sway peaks at 0.09 torso lengths), 95% of
results showed everyone "holding". Single-result jitter spikes still left the longest unbroken
run at 69-75 results, just short of the 75 needed. In practice it's luck, and players have to try
again.

`studies/calibration.ts` replays every run's detections through the game's loop with other rules
swapped in. It counts the scenes, of the 115 with a calibratable 5 s hold, where calibration
completes during the hold:

| rule | MP Lite | MP Full | MP Heavy | RTMO-s | RTMPose-s | MoveNet | Apple Vision |
|---|---|---|---|---|---|---|---|
| shared hold (before) | 78% | 64% | 91% | 91% | 59% | 84% | 50% |
| ignore wrists only | 91% | 92% | 95% | 97% | 92% | 87% | 81% |
| median of recent results only | 90% | 83% | 96% | 84% | 91% | 86% | 56% |
| **this branch** | **94%** | **94%** | **96%** | **97%** | **96%** | **91%** | **84%** |

**The rule in this branch:**
- Each player's hold runs on its own: one who moves, steps out, or stays unsure of a joint for
  more than 0.2 s restarts only their own hold.
- Stillness is judged on the median of the player's last few results (up to 5 within 300 ms),
  only on shoulders, hips and ankles.
- The stance a hold is measured from settles over its first three results.
- Calibration completes at the first moment every player is holding and has held 2.5 s. Nobody
  is calibrated alone, so a player who leaves, or a number that passes to somebody else, can't
  keep an old stance.
- The setup line-up retry clears the holds.

Two independent reviews shaped it. The first version kept players calibrated once done, and the
first review showed how renumbering, leavers and a stuck retry broke that. The second review led
to the symmetric median, the settling anchor, and the tolerance for brief unsure joints.

- **Accuracy:** calibration accuracy is unchanged for Lite (torso length within 3.7% of the same
  rule on ground truth) and better for Full (5.8% → 3.5%).
- **Speed:** the median time from "everyone still" to calibrated rises from 2.6 to 2.8 s, because
  the harder scenes now finish too.
- **False completions:** none premature or false for MediaPipe. The two scenes built so they must
  not calibrate (ankles out of view, behind a table) still don't.
- **Lite still fails in 7 scenes, all genuinely hard:**
  - the 120° ultrawide (nobody detected);
  - a camera bump during the hold;
  - the two close-together scenes (one player never found);
  - four players in dim light;
  - two very dark gained-up scenes.

**Changed in this branch:** `apps/web/src/game/webcamCalibration.ts`, `GameSession.ts` (the retry
clears holds), and the calibration and session tests. The tests cover:
- independent holds;
- hands moving;
- one-result jitter, either way;
- brief unsure joints;
- leavers;
- renumbering;
- a slow camera;
- the retry.

**Recommended, not changed:** a 1.5 s hold. A calibration from 1.5 s of samples was as accurate as
from 2.5 s in this study, and setup would take a second less. The 2.5 s is a feel decision, so
it's left to you.

### Two players close together (not changed: a design is needed)

In `mp2-tight` and `mp2-arm-overlap`, two players dance close together. MediaPipe Lite and
Full, on the whole picture as the game runs two players, found one of them and **never** found
the other. Half the player-time was lost, and 53-66% of score. Every other model found both.

**Experiment: two strips, as three and four players use.** Two overlapping strips (each 60% of
the width) on the 29 two-player scenes, Lite, scorer version 2:
- **Score lost** fell from 15.0% to 9.3% [−9.9, −2.8 points]. The close-together scenes went
  from 53-57% to 11-12%.
- **Calibration** before the dance rose from 86% to 97%.
- **Cost:** inference took the same time on this GPU.
- **Real footage agreed:** two dancers cropped from six real group clips scored as good or
  better in all six.

**Why it isn't in this branch.** All 29 scenes happened to place the players symmetrically
about the centre. A review pointed out that fixed strips assume one player on each side, and two
new scenes confirmed it:
- `mp2-offcentre-left`: both players in the left 40% of the picture.
- `mp2-offcentre-right`: one player across the left strip's cut edge.

| scene, Lite | whole picture | two strips (0.6) | two strips (0.7) |
|---|---|---|---|
| `mp2-offcentre-left` | 15.2% lost, calibrates | **63.3%** lost, one player missing half the time, never calibrates | 56.9%, never calibrates |
| `mp2-offcentre-right` | 10.5% | 27.7% | 20.0% |

A webcam off to one side of where people dance is common, so fixed strips trade one failure for
another.

**Recommended design:**
- Keep the whole picture for two players.
- Fall back to strips only while the tracker has found fewer than two people for about a second.
  The worker already learns the found-player count every frame, for steering the strips.
- Place the strips around where the players were last seen, rather than at fixed halves.

trackbench now has the scenes to test this both ways (`mp2-tight`, `mp2-arm-overlap`,
`mp2-offcentre-*`; `run-game.ts --strip-width`, `--no-strips`).

### Where tracking still fails

With both changes, Lite's worst scenes:

| scene | score lost (v1) | why |
|---|---|---|
| `cam-fov-120` (120° ultrawide at 3.2 m) | 100% | nobody is ever detected: the dancer is ~105 px tall. RTMO-s and RTMPose-s cope. |
| `mp2-tight`, `mp2-arm-overlap` | 61-66% | the second player is never found (above) |
| `mot-side` (dancing side-on) | 41% | far arm hidden; limbs foreshortened |
| `by-walk-front` (someone walks between camera and players) | 41% | the player is lost and taken back late |
| `sens-dim-gain(-jpeg)` (dark room pushed up, noisy) | 36-40% | joints wander: limb error ~20° |
| `mot-floor` (break dance floor work) | 37% | upside-down and lying poses |
| `look-long-skirt`, `look-dress` | 25-31% | hidden knees and hips |
| `mp2-cross-alike` (look-alikes cross) | 26%, identity 57% | dressed alike, they're put back in the wrong order after crossing. Every model does this: the tracker, not the model, decides. |

**Skin tone (a flag, not a conclusion).** In bright light there's no difference between the three
skin families for any model. In dim light the darker-skinned dancer loses more score with every
model: Lite 16.4% vs 14.9%, Full 24.3% vs 17.5%, RTMO-s 12.0% vs 5.9%. That's one scene per skin
tone; it needs a proper sweep before anything is concluded.

### Should another pose estimator replace Lite?

Same 117 scenes, scorer version 2, the game's tracker and calibration for all:

| | MP Lite (now) | MP Full | MP Heavy | RTMO-s | RTMPose-s | MoveNet MultiPose | Apple Vision |
|---|---|---|---|---|---|---|---|
| score lost | 9.4% | **8.4%** [−1.4, −0.6] | 8.4% [−1.5, −0.3] | **5.0%** [−6.5, −1.8] | **5.1%** [−6.3, −1.9] | 12.0% (worse) | 10.7% (n.s.) |
| judgement windows downgraded | 22.0% | 19.1% | 17.4% | 8.2% | 9.3% | 36.3% | 26.5% |
| PCK@0.2 torso | 0.895 | 0.926 | 0.948 | 0.947 | 0.948 | 0.865 | 0.851 |
| scored-limb angle error | 7.7° | 6.3° | 5.3° | 5.1° | 5.8° | 10.1° | 8.7° |
| player recall | 97.3% | 97.3% | 97.3% | 99.9% | 99.9% | 99.9% | 99.5% |
| calibrates during a 5 s still hold | 94% | 94% | 96% | 97% | 96% | 91% | 84% |
| browser, M5 Pro (Chromium) | 6 ms WebGL | 9 ms WebGL | 20 ms WebGL | 21-25 ms WebGPU, 440 ms WASM | not ported | 19-21 ms WebGL | native only |
| download | 5.8 MB | 9.4 MB | 30.7 MB | 39.6 MB | 21.9 + 20.3 MB detector | 9.7 MB | in the OS |
| depth (z) for the character | yes | yes | yes | no | no | no | no (3D API: one person) |
| feet (heels/toes) | yes | yes | yes | no | no (Halpe26 variant has them) | no | no |
| licence | Apache-2.0 | Apache-2.0 | Apache-2.0 | Apache-2.0 code; Body7 weights need clearance | same | Apache-2.0 | OS API |

Bracketed: paired difference from Lite, in points.

On a 39-scene subset (genres, motion, camera, multiplayer bases, four players): RTMPose-m loses
2.3%, RTMO-s 3.1%, RTMPose-s 4.1%, YOLO26s (AGPL, reference) 5.6%, RTMO-t 6.5%, Full 6.9%, Lite
8.0%.

**Recommendation:**

1. **Now: MediaPipe Full where it's fast enough.** It wins until results take ~100 ms (see
   [slower devices](#full-vs-lite-on-slower-devices)), so choose by measured speed. It's the same API, output and z, and it shows the same gain on real footage. One
   catch: Full is jumpier than Lite in still holds, but the new calibration absorbs that (64% →
   94%).
2. **Next: prototype RTMO-s (or RTMPose-s with a light detector) behind WebGPU.** It halves score
   lost again, finds close-together players and the ultrawide dancer, and its confidences are
   well calibrated. Before it can ship:
   - The character needs depth. Keep MediaPipe's z by running both models (costly), or derive yaw
     and limb depth from 2D (shoulder width, nose against ears) or a small 2D-to-3D lifter.
   - It needs a WASM/WebGL fallback for browsers without WebGPU (WASM measured at 440 ms a frame).
   - The weights need a licence check (Body7 training data) or a retrain on cleared data.
   - It sees posters, mirrors and mannequins as people: the player cap and the tracker handle most
     of it, but the mannequin still fooled it, and a bystander on the sofa took a player's number
     once.
3. **Not MoveNet or Apple Vision.** Both are worse than Lite even after the gate fix. Vision is
   also native-only. YOLO is AGPL, and Sapiens/RTMW are too big for real time.

### Full vs Lite on slower devices

No phone was measured directly. Three sources bound the cost:

- **Compute: Full costs 1.2-1.5× Lite.**

  | path | Lite | Full | Full / Lite |
  |---|---|---|---|
  | CPU on this Mac's efficiency cores (a low-tier phone proxy) | 19.8 ms | 25.1 ms | 1.27× |
  | CPU on performance cores | 4.3 ms | 5.1 ms | 1.19× |
  | desktop GPU in Chromium | 6 ms | 9 ms | 1.5× |

  Heavy is 3.2× Lite on efficiency cores. Google's published figures agree:
  - Pixel 3 (TFLite GPU): 20 vs 25 ms.
  - Pixel 5 (MediaPipe web runtime): 25 vs 21 fps.
  - iPhone 11 (TF.js WebGL): 43 vs 32 fps.

  Memory barely changes: the weights are 3.6 MB apart, and most of a landmarker's memory is the
  runtime.
- **What slowness costs.** `run-game.ts --realtime --busy-ms N` gives every result a fixed time,
  so the game drops camera frames as a slower device would. Lite ran at 33, 66, 100 and 150 ms a
  frame, and Full at 1.3× that, on the ten genre scenes plus a two-player scene (scorer version 2).
  Score timing uses capture times, so lateness itself costs nothing; only the lower pose rate does.

| per frame (Lite / Full) | Lite: score lost, poses/s | Full: score lost, poses/s | Full − Lite |
|---|---|---|---|
| every frame | 5.9%, 30 | 4.6%, 30 | −1.2 [−1.9, −0.5] |
| 33 / 43 ms | 5.9%, 30 | 4.7%, 23 | −1.2 [−1.8, −0.6] |
| 66 / 86 ms | 6.1%, 15 | 5.3%, 12 | −0.8 [−1.5, −0.0] |
| 100 / 130 ms | 7.9%, 10 | 6.9%, 7.7 | −1.0 [−2.0, −0.1] |
| 150 / 195 ms | 8.8%, 6.7 | 10.2%, 5.2 | **+1.4** [+0.1, +2.7] |

- **Where Full wins:** until a device runs Lite slower than about 100 ms a frame (10 poses a
  second). Calibration completed in every case.
- **Where Lite wins:** past about 150 ms, Full's lower frame rate costs more than its accuracy
  gains.
- **Strips multiply the cost.** With three or four players each strip is a landmarker, so a phone
  at 33 ms per landmarker reaches ~130 ms with four strips: the crossover.

**Recommendation: pick the model by measured speed, not by device class.**
- Start with Full.
- Read the worker's inference time (WebcamPoseSource already reports `inferenceMs`) during the
  calibration screen.
- Drop to Lite if a result takes over ~100 ms, counting every strip.

On a phone, also watch heat over a whole song. This simulation doesn't model thermal throttling.

## Other recommendations

- **Ultrawide cameras:** when nobody is found for a second, run detection on a centre crop (a
  digital zoom). At 120° the dancers are too small for MediaPipe's person detector.
- **When swapping models:** calibrate each model's confidences on a held-out set (`audit/confcal.py`
  shows how) instead of assuming a 0.5 means the same thing.
- **Grow the benchmark where it's thin:** real multiplayer footage with keypoints, a skin-tone ×
  lighting sweep, phones and the iPad (latency and memory), crossings by look-alikes (to tune the
  tracker), and loose clothes.

## This branch

- `tools/trackbench/`: the benchmark (generator, environments, sensor effects, harness, estimator
  runners, studies, sim-to-real, audits) and the scene specs: the 117 analysed here, plus the
  two off-centre two-player scenes added after review. Data stays outside the repository.
- `apps/web/src/game/webcamCalibration.ts`, `GameSession.ts` and the calibration tests:
  per-player, jitter-tolerant calibration holds.
- `packages/score/features.ts`, `scorer.ts` (version 2), the scorer test and `docs/scoring.md`:
  the scoring confidence gate at 0.1.
- `packages/pose/browser/tiles.ts`: joints beyond a strip's cut edge are marked below the new
  scoring gate.

Before release, check on devices what the benchmark can't:
- the new calibration with real people (it should feel faster and never stall);
- the scoring change against a few real playthroughs (scores will be higher, and best scores
  start afresh under version 2).
