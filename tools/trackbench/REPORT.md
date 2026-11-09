# Player tracking: benchmark findings (November 2026)

What [trackbench](README.md) found about aerodance's tracking, what this branch changes because
of it, and what to do next. Numbers are means over scenes. Brackets are paired bootstrap 95%
intervals over scenes. The reports they come from are in `$TRACKBENCH_DATA/reports/`. The
end-to-end comparison is the game's own pipeline on every scene, from `dev` (`runs/dev-final`, at
61414651) and from this branch (`runs/final5-game`), in `reports/final5-game-vs-dev.md`, and
split between the scorer and the tracking in `reports/scorer-share-final5-game.md`. Re-running
either gives identical detections, so differences between them come from the code.

## Summary

Over all 133 scenes, with the shipping model (MediaPipe Lite), this branch takes the score that
players lose to tracking from **15.9% to 8.0%** [−10.0, −6.3 points], and every one of the 133
scenes loses less. Most of that is the scorer: scored with this branch's scorer, `dev`'s own
tracking loses 10.3%, so the scorer accounts for 5.6 points [4.8, 6.4] of the gain and the
tracking and calibration changes for 2.4 [1.0, 4.3], mostly in the scenes they were made for.
Calibration finishes before the dance in **77% → 95%** of scenes, and players are numbered
correctly in 89% → 98% of the scenes with two or more players.

What changed, and why:

- **Scoring threw away points that tracking had right.** The scorer ignored any joint the model
  was less than 50% sure of, and an ignored limb scores 0, though most of those joints were
  roughly right. Scorer version 2 counts joints down to 10% confidence (which alone took score
  lost from 14.2% to 9.4% on the first 117 scenes), and keeps a limb's direction for 300 ms when
  tracking loses it. Dancing the wrong moves, or standing still, gains about what it would with
  perfect tracking ([scoring](#scoring-unsure-joints-were-thrown-away)).
- **Setup's calibration hold often never finished.** One jittery result, or one player
  twitching, restarted the 2.5 s hold for everybody. Each player's hold now runs on its own,
  judged on a short median of their poses and only on the joints calibration measures, and
  counts from when they stop ([setup](#setup-calibration-that-never-completes)).
- **Two players close together: MediaPipe found one and never the other.** Two players now get a
  second landmarker that, while only one is found, looks at the picture with that player
  greyed out ([two players](#two-players-close-together-a-search-for-the-missing-one)).
- **A 120° webcam: nobody was found at all** (the dancer about 105 pixels tall). One player now
  gets a zoom: while nobody is found, the middle of the picture is shown enlarged
  ([zoom](#one-player-far-away-or-on-an-ultrawide-webcam-the-zoom)).
- **Passers-by and look-alikes confused the tracker.** Somebody walking in front of a player
  dragged the player's place away with them, and look-alikes crossing at different depths were
  swapped back. A player now has a home that passers-by can't take, and tangled players of
  clearly different sizes are told apart by size
  ([tracker](#passers-by-and-look-alikes-the-tracker)).
- **The iPhone/iPad app tracked with less.** It went without the strips, the search and the
  zoom, to save memory: with four players it lost 18.0% of score against 7.9%. It now tracks
  as a browser does ([the app](#the-iphoneipad-app-the-same-pipeline-as-a-browser)).
- **A better model is available, at a price.** RTMO-s (an open multi-person model) loses about
  half of what Lite does, but needs WebGPU, has no depth for the character, and its weights need
  a licence check. MediaPipe **Full** is the cheap step where a device is fast enough
  ([models](#should-another-pose-estimator-replace-lite)).
- **Synthetic results transfer to real footage.** Estimator rankings on synthetic scenes match
  those on 18 real AIST++ videos with triangulated ground truth (Spearman 0.84-0.91).

Every change was measured over the whole suite before it was kept, and three rounds of independent
review (each finding checked by a second reviewer trying to refute it), then a fact-check of this
report, found problems that were fixed and measured again: they're described with each change.

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
- **The suite:** 133 scenes, 91,290 frames at 640x480 30 fps, in ten categories (baseline,
  camera, lighting, appearance, background, motion, multiplayer, bystander, setup, sensor): 79
  with one player, 36 with two, 8 with three and 10 with four. Each scene tests one stated
  hypothesis ([SUITE.md](scenes/SUITE.md)). The first 117 were analysed first; two off-centre
  pairs came from the first review, and 14 crossing, crowding and passer-by scenes were added to
  test the tracker changes.
- **Measurement:** the game's real worker runs in Chromium on the GPU, with its strips. Its
  `PlayerTracker`, `WebcamCalibration` and scorer run in the loop, by import, so a change to the
  game's code is measured directly. Metrics cover detection, joint error, limb angles, identity,
  numbering, calibration time and **score lost to tracking**. The last is the scorer's result with
  the tracked poses against the same scorer given the dancer's ground truth.
- **Candidates:** 18 estimator configurations, including MediaPipe Lite/Full/Heavy, RTMO, RTMPose,
  MoveNet, Apple Vision, YOLO11/26-pose (references only: AGPL) and RTMW. Each runs over the same
  scenes, through the game's own tracker. 7 cover the first 117 scenes and 3 more a 39-scene subset.

Two models built it in parallel: Claude Opus 5.5 (generator, harness, solo scenes, sim-to-real,
the game changes) and GPT-6 Astra (environments and sensors, estimator survey and runners,
multiplayer and setup scenes, the crossing scenes). Each audited the other's half.

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

  Both are fixed, and every estimator comparison here uses the same 117 scenes with paired intervals
  ([audit](audit/estimators-audit.md)).
- **Repeatable:** the game's pipeline gives identical detections when a scene is run again, and
  `dev` run today gives the same detections as `dev` a week earlier, so a difference between two
  runs is the code's, not noise.
- **Limits:**
  - One machine (M5 Pro), so no phone or iPad measurements. Browser latency is Chromium only.
  - No real multiplayer footage with keypoints.
  - The synthetic people are clean renders: no cluttered real homes, no compression from real
    webcams.
  - Fairness results (skin tone) rest on a few scenes.

## Findings and changes

End to end, `dev` against this branch, over the 133 scenes. "dev, scorer v2" is `dev`'s own
tracking scored with this branch's scorer (`studies/score-robustness.ts`, split by
`studies/scorer-share.ts`), which separates the scorer's share from the tracking and calibration
changes':

| | dev | dev, scorer v2 | this branch |
|---|---|---|---|
| score lost to tracking | 15.9% | 10.3% | **8.0%** [−10.0, −6.3] |
| judgement windows downgraded | 38.7% | | **19.4%** [−22.1, −16.5] |
| players numbered correctly (54 scenes with two or more players) | 88.9% | 88.9% | **98.1%** [+1.9, +18.5] |
| identity after numbering | 94.8% (5 scenes never numbered) | 94.8% | **96.8%** |
| player-frames lost | 3.9% | 3.9% | **1.6%** |
| calibrated before the dance | 76.7% | 76.7% | **94.7%** [+12.0, +24.8] |
| calibration time after everyone holds still (completed only) | 2.8 s | 2.8 s | 2.7 s |
| scored-limb angle error | 7.3° | | 7.8° |

The scored-limb error rises because 99.7% of scored limbs now count, against 96.6%: the
unsure ones version 1 threw away (and scored 0) are a little less accurate than the rest.

On the same scorer the tracking changes help on average, and a lot where they were aimed (the
ultrawide, close-together pairs, passers-by, look-alikes), but they aren't free in every scene.
In single-player scenes the zoom can pick a player up a little earlier, from the middle of the
picture, as they walk in; MediaPipe then follows a slightly different path for the rest of the
scene. Apart from the ultrawide and two large gains (`mp1-passerby-front` −7.8 points, from the
tracker's home, and `sens-dim-gain-jpeg` −4.7), single-player scenes stay where they were on
average (−0.02 points): 26 better and 25 worse by more than 0.05, the worst by 0.8 (`mot-floor`;
`cam-yaw-55` 0.5, `light-party` 0.4). Of the scenes with two or more players only
`mp3-arm-overlap` loses more than 0.1 (+0.4).

| Score lost, by category | dev | dev, scorer v2 | this branch |
|---|---|---|---|
| bystander (10 scenes) | 24.8% | 15.6% | 10.6% |
| multiplayer (31) | 24.7% | 16.2% | 11.1% |
| setup (11) | 18.6% | 9.0% | 8.4% |
| motion (8) | 18.0% | 7.7% | 7.7% |
| camera (14) | 13.4% | 10.8% | 4.1% |
| appearance (13) | 11.4% | 8.6% | 8.6% |
| sensor (13) | 10.7% | 8.7% | 8.5% |
| baseline (14) | 10.4% | 5.9% | 5.8% |
| lighting (9) | 9.3% | 7.0% | 6.8% |
| background (10) | 5.2% | 3.5% | 3.5% |
| one player (79) | 11.1% | 7.8% | 6.4% |
| two players (36) | 27.2% | 16.9% | 11.4% |
| three players (8) | 14.9% | 8.8% | 8.2% |
| four players (10) | 14.3% | 8.2% | 7.9% |

### Scoring: unsure joints were thrown away

The scorer drops live joints below a confidence threshold, and a dropped limb scores 0 for that
interval. At 0.5, MediaPipe Lite dropped 3.3% of scored limbs. Heavy, the most accurate MediaPipe
model, dropped 5.8% and so scored *worse* than Lite. Most of what was dropped was roughly right: on the
single-player scenes, 72% of Lite's unsure joints were within 0.2 torso lengths of the truth (89%
of its sure ones). Across models, the gate explained 28-74% of their score loss
([audit](audit/estimators-audit.md)).

`studies/score-robustness.ts` scored every tracked run under other treatments, with two controls
that must **not** gain: the same tracked poses against a wrong reference (the dancer's moves 4 s
later, i.e. dancing the wrong part of the song), and the players standing still, looped over the
dance. First, on the 117 scenes and the game as it was then:

| MediaPipe Lite, 117 scenes | score lost | wrong-moves score | standing-still score |
|---|---|---|---|
| gate 0.5 (version 1) | 14.2% | 22.5% | 28.4% |
| gate 0.2 | 10.2% | 24.2% | 29.0% |
| **gate 0.1** | **9.4%** | 24.6% | 29.0% |
| perfect tracking (ground truth) | 0 | 24.8% | – |

- **Score lost** fell by 4.8 points [4.1, 5.6] for Lite and 5.4 for Full, and no scene was worse.
- **Smoothing doesn't help:** smoothing positions (`smooth-50`) made scores worse for every model.
- **A limb's last direction, kept for 300 ms** when tracking loses it entirely, kept 0.58 points
  more [0.41, 0.76] on top of the gate, with no scene lower.

**Changed in this branch (scorer version 2):** `MIN_CONFIDENCE` 0.5 → 0.1 in
`packages/score/features.ts`, compared in the recording format's quantised steps so a replay
scores the same, and a limb lost entirely keeps its direction from the last sample within 300 ms
(`HOLD_MS` in `scorer.ts`, looked up by sample time so delivery order doesn't matter). Strips
mark joints beyond their cut edges at 0.05, below the gate, since those are the model's guesses.
Best scores are stored per version, so they start afresh. The character's own joint hold
(`livePose.ts`, 0.5) is unchanged.

With everything in this branch (`final5-game`, 133 scenes), the controls against ground truth:
the right dance loses 8.0% to tracking; dancing the wrong moves scores 25.8% (25.3% with perfect
tracking); standing still scores 29.8% (29.7% with perfect tracking, over 132 scenes). Tracking
errors pull a wrong dance towards chance by 0.4 points on average: by 9 points in `by-old-place`
(24.5% against 15.3%), where tracking follows somebody else for a while, and by 2-4 points in a
few multiplayer and setup scenes (`mp4-small-room`, `setup-too-close`, `mp4-dim`); 37 scenes gain
more than a point, and 9 lose more than a point. The gap between the right dance (about 92%) and
the wrong one stays. Joints off the picture's own edges, such as feet below the frame, now count
when the model gives them 0.1 or more: standing still gains over a point on perfect tracking in
seven scenes: the most where the legs are out of the picture (`setup-too-close` 6.3,
`mp4-small-room` 4.6), and 1-3 points in the close-together pairs and the gained-up dark scenes.

### Setup: calibration that never completes

Calibration needs every player's shoulders, hips and ankles in view at confidence 0.5. Everyone
then holds still within 0.15 torso lengths for 2.5 s. On `dev`:
- the hold was shared, so one player missed for over 200 ms, or one joint moving in a single
  result, restarted it for everybody;
- wrists counted, though calibration never measures them.

In 5-second holds where people stood still (their sway peaks at 0.09 torso lengths), 95% of
results showed everyone "holding". Single-result jitter spikes still left the longest unbroken
run at 69-75 results, just short of the 75 needed. In practice it's luck, and players have to try
again.

`studies/calibration.ts` replays every run's detections through the game's loop with other rules
swapped in. On the first 117 scenes, with each model's detections from before the search and the
zoom, it counts the scenes, of the 115 with a calibratable still hold (4-9 s: mostly 4 s with one
player, 5 s with more), where calibration completes by half a second after the hold ends:

| rule | MP Lite | MP Full | MP Heavy | RTMO-s | RTMPose-s | MoveNet | Apple Vision |
|---|---|---|---|---|---|---|---|
| shared hold (dev) | 78% | 63% | 91% | 91% | 59% | 84% | 50% |
| ignore wrists only | 91% | 92% | 95% | 97% | 92% | 87% | 81% |
| median of recent results only | 90% | 83% | 96% | 84% | 91% | 86% | 56% |
| **this branch** | **96%** | **95%** | **95%** | **99%** | **96%** | **90%** | **84%** |

**The rule in this branch:**
- Each player's hold runs on its own: one who moves, steps out, or stays unsure of a joint for
  more than 0.2 s restarts only their own hold.
- Stillness is judged on the median of the player's last few results (up to 5 within 300 ms),
  only on shoulders, hips and ankles (shoulders and hips for minigames that don't need feet).
- The stance a hold is measured from follows the player over its first half second, while they
  settle at the end of a walk to their spot; meanwhile the hold counts from the last result in
  which they still moved more than 0.3 tolerances, so the walk doesn't count as holding still.
  The model's jitter can delay a hold by half a second at most.
- Calibration completes at the first moment every player has held 2.5 s, and each player's
  latest pose (not only the median) is within two tolerances of their stance. Nobody is
  calibrated alone, so a player who leaves, or a number that passes to somebody else, can't keep
  an old stance.
- The setup line-up retry clears the holds, in songs and in minigames.

Reviews shaped it. The first version kept players calibrated once done, and a review showed how
renumbering, leavers and a stuck retry broke that. Another led to the symmetric median and the
tolerance for brief unsure joints. The benchmark then showed the stance being taken while a
player was still slowing down (most of the way to the tolerance from where they stood, so a
little sway later restarted the hold: three scenes `dev` calibrates didn't), and a review showed
the fix letting the end of a walk count, and the median outvoting a number swap in the last
result before completion.

End to end, over the 133 scenes (131 with a calibratable hold), with this branch's detections:
- **Accuracy:** the same as `dev`'s rule on the scenes both complete (torso length 0.00 points
  [−0.03, +0.03], floor the same).
- **Speed:** a median of 2.7 s from "everyone still" to calibrated, for MediaPipe Lite. One
  scene completes 0.1 s short of 2.5 s after the ground truth's stop; none early or falsely. The
  two scenes built so they must not calibrate (ankles out of view, behind a table) don't.
- **Lite still fails in five scenes:** the three close-together two-player scenes (the second
  player isn't found steadily enough: below) and two very dark, gained-up scenes. (In the table's
  set, on detections from before the search and the zoom, the ultrawide and `mp2-arm-overlap`
  failed too; this branch calibrates both.)

**Recommended, not changed:** a 1.5 s hold. A calibration from 1.5 s of samples was as accurate as
from 2.5 s, and setup would take a second less. The 2.5 s is a feel decision, so it's left to you.

### Two players close together: a search for the missing one

In the close-together scenes, MediaPipe Lite and Full, on the whole picture as the game runs two
players, found one player and **never** found the other: half the player-time lost, and 50-69%
of score. Every other model found both. MediaPipe's person detector sees the picture shrunk to a
small square and finds one box for two people close together; asking for more people, or a
fresh detection every frame, didn't help.

**Tried first, not kept: two strips, as three and four players use.** Two overlapping strips cut
score lost on the 29 two-player scenes then in the suite, and on real two-dancer footage. But all
29 happened to place the players symmetrically about the centre, and a review pointed out that
fixed strips assume one player each side. Two new scenes confirmed it: with both players in the
left 40% of the picture, strips lost 63% of score and never calibrated. A webcam off to one side
of where people dance is common.

**Changed in this branch: a search.** Two players get a second landmarker. While the first finds
only one person, the second is shown the picture with that person's head, torso and legs greyed
out, and follows whoever else is there; results that are the same person are merged as strips'
are. It runs only while somebody is missing, and needs the GPU and an extra landmarker.

| scene, Lite: score lost (frames with both players tracked) | dev | dev, scorer v2 | this branch |
|---|---|---|---|
| `mp2-tight` | 65.8% (0%) | 51.0% | 25.4% (65%) |
| `mp2-close-offcentre` (both in the right 40%) | 68.6% (0%) | 58.9% | 22.2% (79%) |
| `mp2-close-far` | 49.6% (0%) | 40.5% | 20.0% (67%) |
| `mp2-offcentre-near` | 61.4% (0%) | 55.2% | 27.4% (71%) |
| `mp2-arm-overlap` | 61.1% (0.4%) | 55.9% | 35.1% (66%) |
| `mp2-offcentre-left` | 23.1% | 14.1% | 13.5% |
| `mp2-offcentre-right` | 18.3% | 7.9% | 7.9% |

All two-player scenes together: 27.2% → 11.4% (16.9% with dev's tracking on the new scorer).
What's left in these scenes is mostly the two players swapping while they overlap (identity
79-88%), and calibration in three of them.

### One player far away, or on an ultrawide webcam: the zoom

On a 120° webcam at 3.2 m (`cam-fov-120`), MediaPipe found nobody, ever: the dancer is about 105
pixels tall, too small for its person detector. Shown the middle of the picture enlarged, it
found them in 126 of 135 frames.

**Changed in this branch: a zoom for one player.** While nobody has been found for a second,
every other frame shows the landmarker the middle three quarters of the picture; whichever view
finds somebody is kept.
- The middle is kept only while all of the person fits well inside it. Somebody too big for it
  (close to the camera, or walking forward from far back) is found again on the whole picture,
  where the middle would cut off their feet or hands; somebody small at its edge is followed
  there, as the whole picture's detector can't find them.
- Anybody the landmarker finds afresh through the middle counts only standing: enlarged, an empty
  room's sofa looked like somebody lying on it, and was numbered as the player before they walked
  in. A player last seen going down (leaning more than 20°, on either view) within 3 s and a
  fifth of the picture of there counts lying down too (floor work).
- Every two seconds on the middle, a second landmarker glances at the whole picture afresh;
  somebody it finds elsewhere brings the whole picture back. It's made the first time the middle
  is kept, and its first glance takes about 150 ms, once.
- It runs on the CPU too, where it's the only way to find somebody small.

`cam-fov-120`: 100% of score lost → **5.1%**, the player found in 96% of frames, and calibrated.
Elsewhere it changes little: on the same scorer the farther cameras lose slightly more with it
(`cam-far-5.0` 3.3% → 3.6%, `cam-far-6.5` 3.4% → 3.6%), and the other single-player scenes move
a little either way, and `sens-dim-gain-jpeg` gains 4.7 points ([above](#findings-and-changes)).

**Known limits:**
- A mannequin in the middle of an empty room is upright and person-shaped, so it can be taken
  for the player until they walk in and a glance brings the whole picture back
  (`bg-mannequin-coats`: the player found in 94% of frames instead of 99.5%, and numbered a
  moment late; 3.4% → 3.5% of score lost on the same scorer).
- A small player who drops to the floor faster than the camera sees them going down isn't found
  again until they stand up; and something lying near where a player was last seen going down
  can, for those 3 s, be taken for them.

Three reviews of the zoom found cases the suite didn't have: a close player stuck on the middle
without their feet, a small player dropped at its edge, a floor dancer not found again, and (with
real MediaPipe, a small player composited into an empty room) the sofa taken when a player the
middle followed vanished. A simulation of the worker with a fake landmarker, and probes of the
real one on composited scenes, reproduced and then checked each fix; none of the zoom's rules
are in the unit tests, which can't run MediaPipe.

### Passers-by and look-alikes: the tracker

Two tracker problems showed up in the scenes, with every model, so they were the tracker's.

- **Somebody walking in front of a player.** As they covered the player, the model's following
  could slide onto them, and the player's remembered place went with them across the room. Back
  where they dance, the player was then taken for somebody else for seconds. A player now also
  has a **home**: where they've stood clear of others, going no faster than 1.5 body sizes a
  second, for half a second. A passer-by can't take it along, and a missing player is found
  again near it.
- **Look-alikes crossing at different depths** were put back in their old left-to-right order
  after they parted, which is wrong after a real crossing. When tangled players were clearly
  different sizes when they met and are again when they part, they're now told apart by size
  (the nearer stays the bigger).

| scene, Lite: score lost (identity) | dev | dev, scorer v2 | this branch |
|---|---|---|---|
| `by-walk-front` (somebody walks between the camera and two players) | 41.3% (82%) | 31.9% | 11.9% (96%) |
| `mp2-passerby-front-slow` | 43.9% (72%) | 36.5% | 17.0% (88%) |
| `mp1-passerby-front` (one player) | 22.1% (86%) | 20.4% | 12.7% (91%) |
| `by-old-place` | 25.9% (94%) | 14.3% | 11.3% (96%) |
| `mp2-cross-alike` (dressed alike, crossing) | 25.9% (57%) | 15.8% | 7.4% (99.7%) |
| `mp2-cross-alike-heights` | 27.2% (58%) | 16.2% | 9.0% (97%) |
| `mp3-cross-alike-heights` | 20.3% (73%) | 13.2% | 7.3% (99%) |
| `mp4-cross-alike` | 21.4% (80%) | 12.3% | 9.7% (99%) |

Reviews took one part back out: an exemption from the bystander rule at a missing player's home
changed no scene, but let somebody standing beside a player take their number the moment the
model missed them. The tracker changes are tested, each fix with a test that fails without it,
with no more people per result than the worker gives for that many players.

### Three and four players

Fourteen scenes were added to test the tracker where the suite was thin: three- and four-player
crossings (look-alikes among them), a pair bunched at the picture's edge with four players,
overlapping arms, close and off-centre pairs, and slow passers-by
([SUITE.md](scenes/SUITE.md#crossings-crowding-and-off-centre)). Three players: 14.9% → 8.2%,
four: 14.3% → 7.9%, most of it the scorer's (8.8% and 8.2% with dev's tracking on the new
scorer); the gain beyond that is in the look-alike crossings. The strips (unchanged) keep
everybody detected (in 98% or more of player-frames in every crossing). One crossing still ends with
two numbers swapped: `mp4-cross-adjacent`, distinct players 2 and 3 crossing the middle strips'
edge (identity 80%, as on `dev`).

### Where tracking still fails

With everything in this branch, a selection of Lite's worst scenes:

| scene | score lost: dev → this branch | why |
|---|---|---|
| `mp2-arm-overlap` | 61.1% → 35.1% | two players close, arms across each other: they swap while they overlap |
| `sens-dim-gain`, `-jpeg` (dark room pushed up, noisy) | 36-40% → 32% | joints wander (limb error ~20°), and calibration never finishes |
| `mp2-offcentre-near`, `mp2-tight`, `mp2-close-*` | 50-69% → 20-27% | both players tracked in 65-79% of frames (none on `dev`); swaps while overlapping |
| `look-long-skirt`, `look-dress` | 24-31% → 17-26% | hidden knees and hips |
| `mp2-passerby-front-slow` | 43.9% → 17.0% | somebody standing a second in front of a player |
| `mp4-dim` | 22.4% → 16.6% | four players in dim light |
| `setup-dim-far` | 26.6% → 15.2% | two players far back in dim light |
| `mot-floor`, `mot-side` | 37-41% → 13-15% | upside-down and lying poses; dancing side-on |
| `look-dark-on-dark` | 17.6% → 14.2% | dark clothes against a dark background |

**Skin tone (a flag, not a conclusion).** In bright light there's no difference between the three
skin families for any model. In dim light the darker-skinned dancer loses more score with every
model but Apple Vision: with this branch, Lite 13.0% against 12.5%; with scorer version 2's gate
only, Full 17.4% against 13.2% and RTMO-s 10.6% against 4.6% (Apple Vision 14.8% against 17.8%).
That's one scene per skin tone; it needs a proper sweep before anything is concluded.

### The iPhone/iPad app: the same pipeline as a browser

The app's camera ran without the strips, the search and the zoom, to save their landmarkers'
memory in the process the game runs in; a paired phone's page, on the same phones, ran them all.
With the app's settings (`runs/app-game`, `run-game.ts --no-strips --no-search --no-zoom`) against
this branch's (`runs/final5-game`), same code and scorer, 133 scenes:

| players (scenes) | what the app went without | score lost, app → full | players found | calibrated before the dance |
|---|---|---|---|---|
| 1 (79) | zoom | 7.7% → 6.4% | 97.9% → 99.0% | 76 → 77 |
| 2 (36) | search | 15.3% → 11.4% [+1.2, +7.2] | 90.9% → 96.6% | 29 → 31 |
| 3 (8) | strips | 15.5% → 8.2% [+2.6, +13.7] | 92.0% → 99.6% | 8 → 8 |
| 4 (10) | strips | 18.0% → 7.9% [+5.7, +15.7] | 87.9% → 99.7% | 4 → 10 |

(Brackets: paired 95% intervals of the difference, in points. One player's difference is the
ultrawide, which the app never found.) Peak physical footprint of the harness's Chromium on this
Mac, whole picture → the full pipeline: one player ~740 → ~880 MB, only once the zoom's glances
start (otherwise no more); two ~750 → ~840 MB; three ~775 → ~1,090 MB; four ~800 → ~1,250 MB.
That's 85-160 MB a landmarker, as measured in the iOS simulator (about 100 MB in the process the
game runs in).

**Changed in this branch:** every source tracks the same way, the app's included; the option
to go without is gone. Not yet tried against a real device's memory limit: if iOS turns out to
end the game for it, a budget from the device's memory, not a platform switch, is the fix.

### Should another pose estimator replace Lite?

Measured when scorer version 2 was only the 0.1 gate, before the search, the zoom and the
tracker changes (which help every model), on the same 117 scenes, with the game's tracker and
calibration for all:

| | MP Lite (now) | MP Full | MP Heavy | RTMO-s | RTMPose-s | MoveNet MultiPose | Apple Vision |
|---|---|---|---|---|---|---|---|
| score lost | 9.4% | **8.4%** [−1.4, −0.6] | 8.4% [−1.5, −0.3] | **5.0%** [−6.5, −1.8] | **5.1%** [−6.3, −1.9] | 12.0% (worse) | 10.7% (n.s.) |
| judgement windows downgraded | 22.0% | 19.1% | 17.4% | 8.2% | 9.3% | 36.3% | 26.5% |
| PCK@0.2 torso | 0.895 | 0.926 | 0.948 | 0.947 | 0.948 | 0.865 | 0.851 |
| scored-limb angle error | 7.7° | 6.3° | 5.3° | 5.1° | 5.8° | 10.1° | 8.7° |
| player recall | 97.3% | 97.3% | 97.3% | 99.9% | 99.9% | 99.9% | 99.5% |
| calibrates during the setup still hold (the final rule) | 96% | 95% | 95% | 99% | 96% | 90% | 84% |
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
   [slower devices](#full-vs-lite-on-slower-devices)), so choose by measured speed. It's the
   same API, output and z, and it shows the same gain on real footage. One catch: Full is
   jumpier than Lite in still holds, but the new calibration absorbs that (63% → 95%).
2. **Next: prototype RTMO-s (or RTMPose-s with a light detector) behind WebGPU.** It halves score
   lost again, finds close-together players and the ultrawide dancer without the search and the
   zoom, and its confidences are well calibrated. Before it can ship:
   - The character needs depth. Keep MediaPipe's z by running both models (costly), or derive yaw
     and limb depth from 2D (shoulder width, nose against ears) or a small 2D-to-3D lifter.
   - It needs a WASM/WebGL fallback for browsers without WebGPU (WASM measured at 440 ms a frame).
   - The weights need a licence check (Body7 training data) or a retrain on cleared data.
   - It sees posters, mirrors and mannequins as people: the player cap and the tracker handle most
     of it, but the mannequin still fooled it (calibrating on it before the player arrived, under
     dev's calibration rule too), and a bystander on the sofa took a player's number once.
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

- **Choose Lite or Full by measured speed** ([above](#full-vs-lite-on-slower-devices)). Full is
  bundled out of the game today; that's a download-size and product decision, so it's left to
  you.
- **Two players overlapping** are still swapped while they overlap. The search finds them; the
  tracker's looks don't yet tell two people apart when one is half hidden. Body proportions
  (shoulder width against torso length) barely change while dancing and could help, as size does
  for look-alikes crossing at different depths.
- **When swapping models:** calibrate each model's confidences on a held-out set
  (`audit/confcal.py` shows how) instead of assuming a 0.5 means the same thing.
- **Brightening dim frames** before MediaPipe (auto gain, local contrast) helped only 1-3.6 PCK
  points in the dim scenes, and webcams already auto-expose: tested, not adopted.
- **Grow the benchmark where it's thin:** real multiplayer footage with keypoints, a skin-tone ×
  lighting sweep, phones and the iPad (latency, memory and heat), hands (the minigames' hand
  tracking has no ground truth here: AIST++ has no finger motion), and loose clothes.

## This branch

- `tools/trackbench/`: the benchmark (generator, environments, sensor effects, harness, estimator
  runners, studies, sim-to-real, audits) and the 133 scene specs. Data stays outside the
  repository.
- `packages/score/features.ts`, `scorer.ts`, the scorer test and `docs/scoring.md`: scorer
  version 2 (the 0.1 gate and the 300 ms limb hold).
- `apps/web/src/game/webcamCalibration.ts`, `GameSession.ts`,
  `apps/web/src/minigames/MinigameSession.ts` and their tests: per-player, jitter-tolerant
  calibration holds.
- `packages/pose/browser/pose.worker.ts`, `WebcamPoseSource.ts`, `tiles.ts` and their tests: the
  two-player search, the one-player zoom, and strips' cut-edge joints below the scoring gate.
- `packages/pose/browser/tracker.ts` and its tests: players' homes, and look-alikes told apart by
  size.
- `apps/web/src/pose/CameraInput.ts`, `WebcamPoseSource.ts` and the webcam test: the iPhone/iPad
  app's camera tracks as every other source does.
- `docs/player-tracking.md`, `docs/three-and-four-players.md`, `docs/pose-binary-format.md`.

Before release, check on devices what the benchmark can't:
- the new calibration with real people (it should feel faster and never stall);
- the scoring change against a few real playthroughs (scores will be higher, and best scores
  start afresh under version 2);
- two people dancing close together in front of a real webcam, and one far away or on a wide
  lens (the search and the zoom), including the cost of their extra landmarker on a slower
  laptop.
