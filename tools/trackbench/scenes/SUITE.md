# Trackbench scene suite

## Table tennis (`pp-*`)

34 scenes (33 renders and one post-only sensor variant) of the Table Tennis minigame's activity:
one or two players facing the webcam, swinging a paddle hand (empty, or holding a paddle prop)
in a rally of serves and strokes, the free hand raised to serve. They exist to measure **paddle
hand tracking** (hand-21 and wrist accuracy, hand found rate, side swaps, lag, jitter), which
the dance scenes don't exercise. Motion is the generator's procedural `pingpong` segment
(GENERATOR.md, Table tennis); hand-21 and paddle GT are in CONTRACT.md (v1.4).

Common to all: **1280×960** (the harness downscales to 640×480 for the game's current webcam
size; the originals test whether resolution helps), 30 fps, 20 s (0.3 s offstage, a 1.7 s walk
in, 18 s of play: `setup` 0-2 s, `play` 2-20 s; per-frame GT phases `walk`, `ready`, `swing`,
`serve`), webcam-like motion blur (shutter 0.5 of a frame in normal light, 0.9 in dim/TV light:
fast hands smear), 16 EEVEE samples, JPEG q95. Rallies are seeded `auto` rallies (a serve, 3-7
strokes at irregular 0.15-1.1 s gaps, a 0.8-2 s pause, a serve again) with peak wrist speeds
2.5-6 m/s unless listed; `meta.json` lists every stroke (kind, contact time, measured peak speed).
One-factor variants of `pp1-base` keep its seed, so the woman plays **the same rally** and only
the listed factor changes (still separate renders: compare in pairs). `pp1-lefty`,
`-lefty-paddle` share one rally, as do `pp1-sleeves-dark` and `-sleeves-wall`.

In two-player scenes each player has their own rally (they overlap in time at random). Side by
side, nobody lunges into their neighbour: the left player in the picture skips wide backhands
(wide forehands for a left-hander) and the right one wide forehands; a full-motion clearance check
(every frame, wrists and elbows against the neighbour's limb and torso axes) keeps ≥ 12 cm between
axes. Arms still swing into each other's space and cross in front in `pp2-close`,
`pp2-crossing` and `pp2-lefty-righty`.

**Held out**: `pp-held-*` vary several things at once. Use them only for final checks of a
change, never while tuning.

Camera column: lens height / distance to the look-at point / horizontal FOV · lighting · paddle
hand per player (R/L, +paddle if they hold one). Rooms are the living room (clutter 0.5) unless
the description says otherwise.

| Scene id | Players | Camera · light · hands | What it's for |
|---|---|---|---|
| `pp1-base` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R | Baseline for the table-tennis scenes: one right-handed adult woman, bare forearms, empty-handed, walks in and plays an 18 s rally (serves, drives, pushes, blocks, loops, wide reaches; peak wrist speeds 2.5-6 m/s) facing a webcam on the TV stand, 1.0 m high at 2.4 m, 70 deg, in a bright living room. |
| `pp1-backlit` | 1 | 1.0 m / 2.4 m / 70° · backlit_window · R | pp1-base in front of a bright window (backlit_window): a near silhouette, hands against the light. |
| `pp1-bystander` | 1 +1 by | 1.0 m / 2.4 m / 70° · bright_even · R | pp1-base with a man sitting on the sofa behind, fidgeting: a second person in the picture (players stays 1). |
| `pp1-clutter` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R | pp1-base in the open-plan room with patterned wallpaper and full clutter: busy background behind the hands. |
| `pp1-dim` | 1 | 1.0 m / 2.4 m / 70° · dim_evening · R | pp1-base in a dim evening room (one warm lamp), a 1/30 s shutter: dark, smeared fast hands. |
| `pp1-far-tv` | 1 | 1.4 m / 3.0 m / 80° · bright_even · R | Webcam on top of a big TV: 1.4 m high at 3.0 m, 80 deg, tilted down: small hands (a palm ~20 px at 640x480). |
| `pp1-fast` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R | A hard rally: loops and drives at 5-8 m/s peak wrist speed, short gaps: blur and the tracker's motion gates. |
| `pp1-gentle` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R | A gentle rally: pushes, blocks and soft drives at 1.5-3 m/s. |
| `pp1-lefty` | 1 | 1.0 m / 2.4 m / 70° · bright_even · L | A left-handed man (dark skin, white tee recoloured red) in the base framing: the paddle hand is the person's left. |
| `pp1-lefty-paddle` | 1 | 1.0 m / 2.4 m / 70° · bright_even · L+paddle | pp1-lefty holding a paddle in his left hand. |
| `pp1-near-laptop` | 1 | 1.0 m / 1.2 m / 70° · bright_even · R | Laptop on a desk: camera 1.0 m high at 1.2 m, 70 deg, tilted up a little and rolled 2 deg; the player is cut at the thighs and the raised hands near the top edge. |
| `pp1-near-laptop-paddle` | 1 | 1.0 m / 1.2 m / 70° · bright_even · R+paddle | pp1-near-laptop with a paddle in hand: large hands, the blade over the fingers. |
| `pp1-near-phone` | 1 | 0.7 m / 1.5 m / 68° · bright_even · R | Phone propped low on a chair: camera 0.7 m high at 1.5 m, 68 deg, looking up (roll -3 deg); knees at the bottom edge, foreshortened torso. |
| `pp1-offcentre` | 1 | 1.0 m / 1.9 m / 75° · bright_even · R | The player stands 0.75 m to the camera's right of a centred camera (1.9 m, 75 deg): forehands swing out towards the picture edge. |
| `pp1-paddle` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R+paddle | pp1-base holding a real paddle (red/black blade, wooden handle): the blade hides part of the hand and fingers, as when players hold one. |
| `pp1-sensor-cheap` | sensor | post-only on `pp1-base` | Post-only variant of pp1-base (same pixels): a cheap webcam's noise, chroma subsampling and JPEG 45. |
| `pp1-skin-dark` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R | pp1-base with dark skin (same stature and clothes): hand detection fairness. |
| `pp1-sleeves-dark` | 1 | 1.0 m / 2.4 m / 70° · dim_evening · R | A man in a near-black long-sleeved top in the dim evening room: dark sleeves on a dark background, only the hands lit. |
| `pp1-sleeves-wall` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R | A man in a long-sleeved top the colour of the off-white wall behind him: forearms with little contrast, bare hands. |
| `pp1-tv-glow` | 1 | 1.0 m / 2.4 m / 70° · tv_glow · R | pp1-base lit only by the TV (tv_glow, blue, very dark), 1/30 s shutter. |
| `pp1-wide-fov` | 1 | 1.1 m / 1.6 m / 95° · bright_even · R | Ultrawide webcam: 95 deg (barrel distortion, GT through the same lens) at 1.6 m, 1.1 m high; hands swing out towards the curved edges. |
| `pp1-wide-reach` | 1 | 1.0 m / 2.4 m / 70° · bright_even · R | Mostly wide and low balls: steps out to either side, lunges and low pick-ups (hands far from the body, near the hips and knees). |
| `pp2-base` | 2 | 1.0 m / 3.0 m / 75° · bright_even · R, R | Two right-handed players side by side 1.2 m apart (woman left, man right in the picture), each in their own rally; TV-stand webcam 1.0 m high at 3.0 m, 75 deg. |
| `pp2-bystander` | 2 +1 by | 1.0 m / 3.0 m / 75° · bright_even · R, R | Two players 1.2 m apart and a man on the sofa between and behind them: a third person whose hands are in the picture. |
| `pp2-close` | 2 | 1.0 m / 2.0 m / 85° · bright_even · R, R | Two players 0.8 m apart (the right one 0.35 m further back) at a near camera (2.0 m, 85 deg): strokes swing into the neighbour's space, his forehand backswing passes behind her, and the cuts round their wrists overlap. |
| `pp2-crossing` | 2 | 1.0 m / 2.3 m / 80° · bright_even · R, R | Two right-handers 0.9 m apart, the left one 0.55 m nearer the camera and forehand-heavy: her follow-throughs sweep across in front of the other player. |
| `pp2-depths` | 2 | 1.0 m / 3.0 m / 75° · bright_even · R, R | Two players 1.4 m apart at different depths (0.7 m): the far one is smaller, the near one's arm passes in front at times. |
| `pp2-dim` | 2 | 1.0 m / 3.0 m / 75° · dim_evening · R, R | pp2-base's pair in the dim evening room, 1/30 s shutter. |
| `pp2-lefty-righty` | 2 | 1.0 m / 2.4 m / 80° · bright_even · L, R | A left-hander on the picture's left and a right-hander on its right, 1.0 m apart: both forehand sides are in the middle, where their swings meet. |
| `pp2-paddles` | 2 | 1.05 m / 1.8 m / 80° · bright_even · R+paddle, R+paddle | Two players with paddles, 1.0 m apart, at a laptop-like near camera (1.8 m, 80 deg, cut at the thighs). |
| `pp-held-1` | 1 | 0.95 m / 1.3 m / 72° · dim_evening · L+paddle | HELD OUT. A left-handed woman in dark long sleeves with a paddle, dim room, laptop camera (1.3 m, 72 deg, roll 3 deg), a fast rally. |
| `pp-held-2` | 2 | 1.1 m / 1.7 m / 92° · backlit_window · R, R+paddle | HELD OUT. Two players 0.9 m apart standing off to the left of a 92 deg webcam at 1.7 m, backlit window behind, the right one with a paddle. |
| `pp-held-3` | 1 | 1.35 m / 2.8 m / 78° · bright_even · R | HELD OUT. Webcam on a TV 1.35 m high at 2.8 m, 78 deg, tilted down, open-plan cluttered room, a dark-skinned man in a wall-coloured long-sleeved top, wide and hard strokes. |
| `pp-held-4` | 2 +1 by | 0.75 m / 1.9 m / 80° · tv_glow · R, L+paddle | HELD OUT. Two players 1.0 m apart (a right-hander and a left-handed man with a paddle), phone propped low (0.75 m, 1.9 m, 80 deg), TV glow only, someone on the sofa. |

Render checks (`$TRACKBENCH_DATA/scenes/<id>/`): `contact-sheet.jpg` (GT overlay every 40
frames), `hands-sheet.jpg` (every hand every 60 frames, cut like the game cuts it, GT drawn),
`preview.mp4`. Low-resolution previews of every scene were looked at before the suite render.
GT sanity on `pp1-base`: MediaPipe's Hand Landmarker on game-style cuts round the GT wrists finds
93 % of hands (ready 98 %, swing 81 %) with a median wrist error of 5 px and 0.15 palm lengths
over the 21 points; Pose Lite finds the player in every frame; hand `kp3d` re-projects to
0.04 px (`checks/hand_check.py`, `checks/mp_check.py`, `audit/check_gt.py pp1-base`).
Across the suite (`$TRACKBENCH_DATA/reports/pingpong/SUMMARY.md`, per-scene JSON beside it):
every vis-0 point lies on its person's mask; body and hand `kp3d` re-project to ≤ 0.13 px; Pose
Lite finds the players in 93-100 % of frames; the Hand Landmarker's found rate on GT-cut hands
ranges from 0.95 (`pp1-gentle`, `pp1-base`) through 0.85-0.87 with a paddle in hand, 0.71 in dark
sleeves, 0.52-0.58 in dim/TV light, to 0.32 (`pp-held-1`), and is lowest mid-swing: the suite
separates the conditions it was built for. Render log: `$TRACKBENCH_DATA/logs/pingpong/suite.log`
(per-scene logs beside it; the suite took 2 h 2 min at ~3.3 min a scene, 37 GB with `render/`
PNGs kept).

## Multiplayer, bystanders and setup

36 variants at 640×480, 30 fps, 23–24 seconds, using the default 24 EEVEE samples (generator 1.2). Bases `base-duo`, `base-trio`, and `base-quad` use distinct adults, living-room furniture, bright-even light, a frontal 1 m camera, 2 s entry, 5 s neutral hold, and 16 s AIST++ dance. Entries approach in separate lanes from the foreground; delayed entrants start beyond the image edge. The dance phase includes any deliberate interruption/crossing. Camera distances are 4.5 m (duo), 5.8 m (trio), and 6.1 m (quad). Duo and trio lanes are 2 m apart; quad lanes are 1.42 m apart with a 0.45 m alternating depth stagger so wide arm motions clear neighbours.

Each setup success case has at least 5 s of shared quiet hold (allowing for the generator’s transition blend). `setup-too-close` and `setup-table-feet` deliberately cannot calibrate during setup. Dim/far holds should calibrate with perfect observations; Lite may fail. `mp4-small-room` deliberately crops edge players. `setup-trio`/`setup-quad` reuse the same pixels as the multiplayer baselines, and `setup-return` reuses `mp2-leave-return`; do not treat these as independent samples in a pooled result.

The seated-watcher and fidget cases required two small additions to `blender/motion.py`: a floor-grounded `seated` hold (90° hips/knees) and optional `hold.sway_m` (default remains 0.01 m, fidget uses 0.04 m). Child foreground movement uses the generator’s procedural fast walk, not running mocap. Standing mesh heights are 1.81–1.94 m for adults, 1.36 m for the adult/child case and 1.40 m for the moving child. These are full body heights, not nose-to-foot landmark spans. Children are intentional only in `mp2-adult-child` and `by-child-moving`.

| Scene id | Category | Base | What varies | Hypothesis |
|---|---|---|---|---|
| `mp2-tight` | multiplayer | `base-duo` | 0.7 m lateral spacing; 0.65 m safety depth offset; compact pop | At 0.7 m lateral spacing, 0.65 m safety depth offset and a compact pop dance, can two distinct players remain separately numbered? |
| `mp2-wide` | multiplayer | `base-duo` | 3.8 m spacing near picture edges | Two players near opposite frame edges test reacquisition and arm cropping at wide spacing. |
| `mp2-depth` | multiplayer | `base-duo` | 1.5 m depth difference | A player 1.5 m behind their neighbour tests size gating without complete torso overlap. |
| `mp2-adult-child` | multiplayer | `base-duo` | Second player is a 1.36 m child | An adult and an intentionally short child test size-based acquisition and calibration. |
| `mp2-cross-distinct` | multiplayer | `base-duo` | Mid-dance front/back crossing, distinct outfits | Players swap via separated front/back paths; distinct clothes should restore identity after overlap. |
| `mp2-cross-alike` | multiplayer | `base-duo` | Same crossing with matching bodies/outfits | Identically dressed adults swap via separated front/back paths, testing the documented old-order ambiguity. |
| `mp2-identical` | multiplayer | `base-duo` | Matching clothing cut and colours | Identical garments and colours remove the appearance cue while distinct adults dance in their own lanes. |
| `mp2-colour-only` | multiplayer | `base-duo` | Matching clothing cut, red vs blue | The same garments in red versus blue test whether clothing colour alone separates identities. |
| `mp2-arm-overlap` | multiplayer | `base-duo` | 0.76 m spacing, 1.6 m depth offset | Depth-separated neighbours have overlapping arm projections while dancing, testing limb confusion without bodily collisions. |
| `mp2-leave-return` | multiplayer | `base-duo` | Two-second offscreen absence | A player walks beyond the right frame edge for two seconds and returns, testing identity recovery. |
| `mp2-back-turn` | multiplayer | `base-duo` | Four-second back-facing dance | One player dances facing away for four seconds, testing temporary detector loss and front-view reacquisition. |
| `mp3-same` | multiplayer | `base-trio` | Three synchronized dancers | 3 distinct adults perform the same dance, testing strip coverage and common-motion identity. |
| `mp3-different` | multiplayer | `base-trio` | Three different AIST++ genres | 3 distinct adults perform different genres, testing strip merging and independent limb scoring. |
| `mp4-same` | multiplayer | `base-quad` | Four synchronized dancers | 4 distinct adults perform the same dance, testing strip coverage and common-motion identity. |
| `mp4-different` | multiplayer | `base-quad` | Four different AIST++ genres | 4 distinct adults perform different genres, testing strip merging and independent limb scoring. |
| `mp4-small-room` | multiplayer | `base-quad` | Small room, compact pop, 0.7 m depth stagger, edge clipping | Four adults in a small room perform compact pop with 0.7 m depth staggering and deliberate edge cropping; tests lost joints and incomplete calibration. |
| `mp4-dim` | multiplayer | `base-quad` | Dim-evening light | Four distinct adults in dim evening light test strip misses and score loss. |
| `by-walk-behind` | bystander | `base-duo` | Mid-dance rear-lane passer | A bystander crosses the clear lane behind the dancing pair, testing size gating and player displacement. |
| `by-walk-front` | bystander | `base-duo` | Mid-dance foreground passer | A close bystander crosses between the camera and dancers, testing short total occlusion and takeover. |
| `by-sofa-watcher` | bystander | `base-duo` | Seated sofa spectator | A seated spectator on the sofa tests whether the limited detector budget displaces a standing player. |
| `by-half-edge` | bystander | `base-duo` | Half-visible stationary spectator | A stationary spectator half in the right camera edge tests persistence of partial-person detections. |
| `by-before-arrival` | bystander | `base-duo` | Spectator precedes player arrivals | A bystander visible before either player arrives tests the documented provisional-numbering trap. |
| `by-old-place` | bystander | `base-duo` | Look-alike lingers at absent player’s spot | A look-alike bystander occupies a missing player’s old place for more than five seconds, testing number takeover and return. |
| `by-dressed-alike` | bystander | `base-duo` | Rear passer wears p2’s outfit | A spectator dressed like p2 passes behind both players, testing mistaken appearance-based reassignment. |
| `by-child-moving` | bystander | `base-duo` | Child crosses foreground twice | A child hurries across the foreground and back, testing size rejection and transient occlusion (procedural fast walk). |
| `setup-sequential` | setup | `base-duo` | Two-second arrival stagger | Players arrive two seconds apart, then share a 5 s hold; ideal calibration should complete before dance. |
| `setup-late-joiner` | setup | `base-duo` | Second arrival after four seconds alone | The second player arrives after the first has held for four seconds; both then hold 5 s, so ideal calibration should complete. |
| `setup-fidget` | setup | `base-duo` | Upper-body sway then quiet common hold | One player sways ±4 cm for four seconds before a shared 5 s quiet hold; tests whether natural sway resets calibration, which should complete before dance. |
| `setup-too-close` | setup | `base-duo` | Near player’s ankles outside image | One still player is too close for ankles to fit; calibration should deliberately fail despite the 5 s hold. |
| `setup-table-feet` | setup | `base-duo` | Table hides both ankles; shoulders/hips stay visible; clear dance area after | One player holds 5 s with both ankles hidden by the coffee table while shoulders and hips stay visible; calibration should deliberately fail before dance. |
| `setup-dim-far` | setup | `base-duo` | Dim light, camera at 5.8 m | Both players hold 5 s in dim light at 5.8 m camera distance; ideal calibration should complete, testing estimator jitter alone. |
| `setup-trio` | setup | `base-trio` | Three-player calibration | Three adults share a 5 s hold; ideal calibration should complete, testing delay from strip misses. |
| `setup-quad` | setup | `base-quad` | Four-player calibration | Four adults share a 5 s hold; ideal calibration should complete, testing whether one missed player resets everyone. |
| `setup-return` | setup | `mp2-leave-return` | Post-calibration departure and return | After a calibratable 5 s hold, one player leaves and returns during dance; tests retained numbering after setup. |
| `setup-swap` | setup | `base-duo` | Swap immediately after common hold | Immediately after a calibratable 5 s hold, players swap through separated depth lanes; tests stable post-calibration numbering. |
| `setup-t-pose` | setup | `base-duo` | T-pose hold with 2 m spacing | Both players hold a T-pose for 5 s instead of neutral; ideal calibration should complete with wrists stable. |

Motion source: AIST++ annotations, CC BY 4.0; human assets: MakeHuman CC0; room assets/textures: Poly Haven CC0-1.0 (URLs, authors and hashes in `$TRACKBENCH_DATA/downloads/polyhaven/manifest.json`). This half of the suite reused the existing asset cache; no additional downloads were needed. Rendered data, logs and preview contact sheets remain outside the repository under `/Volumes/development/aerodance-trackbench/`.

Setup preflight replays the real `WebcamCalibration` with ideal GT observations (external occlusions/out-of-frame joints receive confidence 0), checking both success cases and deliberate failures. Final GT replay confirms calibration before dance in all nine setup success cases and no setup completion in the two deliberate failures. A full-frame pose clearance pass checks every scene for overlapping limb, hand, foot and head capsules; rendered contact sheets provide the visual review. This caught brief arm intersections between the original sparse preview samples and led to the wider trio, staggered quad, compact cramped-room dance and adjusted spectator lane. Longer late-arrival/fidget/absence variants are capped at 24 s, trimming the final dance tail rather than the calibration hold.

Timed offstage transitions are checked explicitly: actors enter from, and disappear beyond, the image edge. This caught in-frame appearances in the initial sequential/late-entry renders and an early spectator exit; those paths were corrected. Natural 4 cm sway can still satisfy the 0.15-torso tolerance, so the fidget case tests whether resets occur rather than requiring failure during sway.

Completion: all 36 variants and three bases are rendered, have `preview.mp4`, and have fresh Lite results and metrics. All 39 final contact sheets were opened and inspected. Structural validation passes for all 39 outputs, with zero dropped Lite results; full-frame capsule clearance checks have zero flags. Final standing GT landmark spans are 1.68–1.82 m for the adults (full mesh heights above). The only player key-joint cropping during dance occurs in the deliberate `setup-too-close`, `mp2-wide` and `mp4-small-room` cases. No scenes were dropped or left unrendered.

There are 34 unique renders across the 39 outputs; reused base footage is not an independent observation. Recorded rendering wall time is 4 h 38 min for retained unique renders, plus 2 h 21 min of logged superseded/interrupted work: 6 h 59 min total. Sparse probes, untimed early attempts and preview/QA work are additional. Timing records and all rendered IDs are in `$TRACKBENCH_DATA/suite-mp/completion.json` and `COMPLETION.md`.

Lite reports: `$TRACKBENCH_DATA/reports/suite-multiplayer-setup-lite.md` (all 39 outputs), plus `suite-mp2.md`, `suite-mp3.md`, `suite-mp4.md`, `suite-by.md` and `suite-setup.md`.

## Single player: factor sweeps

78 scenes: 63 rendered, 15 post-only (`base-genre-mh` and the 14 `sens-*`).

One player, everything about them varied one factor at a time around `base-solo`, so each
effect can be read against the same person, room, camera and dance. 640×480, 30 fps, 22.5 s:
offstage 0.5 s, walk in from the left 2 s, **neutral hold 4 s** (calibration needs 2.5 s
still; with the walk→hold blend ~3.5 s of it is usable), then 16 s of dance (`setup` 0-6.5 s,
`dance` 6.5-22.5 s). The base player is an adult woman, 1.65 m, asian body/skin, red top and
jeans, in `living_room` (clutter 0.5) under `bright_even`, camera 1.0 m high at 3.2 m, 65°,
frontal, dancing AIST++ middle hip-hop (`gMH_sFM_cAll_d22_mMH3_ch04` from 4 s).

How to read it:

- Every variant names its base; compare it with that base (mostly `base-solo`). Exceptions:
  `look-*-dim` compare with `light-dim_evening`; `look-dark-on-dark` is a variant of
  `light-dim_evening`; `sens-dim-*` are post-only variants of `light-dim_evening`.
- Two-factor scenes, on purpose: `bg-studio` (studio room and the player 0.9 m left so the
  mirror reflection shows beside her), `look-tall` (male body and clothes), `cam-high-1.8`
  (look-at 0.85 m so the player stays framed), `cam-portrait` (50° across the short side),
  `cam-fov-120-near` (lens and 2.0 m: the ultrawide as it's used; `cam-fov-120` alone leaves
  the player ~105 px tall and Lite finds nobody in any frame, so the near one separates size
  from distortion).
- `sens-*` and `base-genre-mh` are post-only: the same render as their base, so they're not
  independent samples (and `base-genre-mh` is `base-solo`'s pixels).
- The skin scenes keep the base's stature (MakeHuman's race morph alone would make the
  african body 17 cm and the caucasian 11 cm taller).
- Rendered with generator 1.2 (webcam-like Standard view transform with per-preset exposure,
  calm hold sway) at 12 EEVEE samples (`--samples 12`; ~1.75× faster than the default 24,
  slightly more render grain, below webcam sensor noise). The multiplayer section's scenes
  use the default 24.
- Known rendering artefacts: EEVEE's soft shadows of a moving body are stippled (most visible
  under `ceiling_only`'s small light); `party` leaves the player a near silhouette (all three
  lights are behind her); `bg-mirror`'s reflection is mostly hidden behind the player (the
  mirror is straight behind a frontal camera), so it's the mild everyday case, and `bg-studio`
  is the one with a visible reflection; `bg-clutter-0`/`-1` barely differ from the base at
  this framing (the clutter knob mostly adds book stacks); `look-heavy` (weight 0.95) is a
  moderately heavier build, not an extreme one.

Lite results: `$TRACKBENCH_DATA/reports/single-lite.md` (`report.ts`, all prefixes below).

| Scene id | Category | Base | Factor varied | Hypothesis |
|---|---|---|---|---|
| `base-solo` | baseline | — | — | Reference: Lite should find, number and calibrate one well-lit frontal adult; every sweep is read against it. |
| `base-genre-br` | baseline | `base-solo` | dance: break (sFM) | Footwork and low stances lower the hips; does the score loss stay near the base? |
| `base-genre-ho` | baseline | `base-solo` | dance: house | Fast footwork: ankle/knee errors and leg swaps. |
| `base-genre-jb` | baseline | `base-solo` | dance: ballet jazz | Turns and arms overhead: back views mid-turn and left/right swaps. |
| `base-genre-js` | baseline | `base-solo` | dance: street jazz | Kicks, turns and arm lines: mixed difficulty. |
| `base-genre-kr` | baseline | `base-solo` | dance: krump | Fast, aggressive arm swings and chest pops: wrist/elbow jitter and swaps. |
| `base-genre-lh` | baseline | `base-solo` | dance: LA hip-hop | Groove-heavy torso motion with moderate arms. |
| `base-genre-lo` | baseline | `base-solo` | dance: lock | Points and wrist rolls in front of the body: elbow/wrist errors. |
| `base-genre-mh` | baseline | `base-solo` | dance: middle hip-hop (= base render) | Same pixels as base-solo; the genre table's middle hip-hop row. |
| `base-genre-po` | baseline | `base-solo` | dance: pop | Small, sharp hits with slow wrists: the easiest genre for the tracker? |
| `base-genre-wa` | baseline | `base-solo` | dance: waack | Fast arms, often overhead and behind the head: wrist loss, left/right arm swaps, motion blur. |
| `cam-dist-2.6` | camera | `base-solo` | distance 3.2 → 2.6 m | A typical small room: ankles near the frame bottom. |
| `cam-far-5.0` | camera | `base-solo` | distance 3.2 → 5.0 m | A small player: joint accuracy falls with pixel size. |
| `cam-far-6.5` | camera | `base-solo` | distance 3.2 → 6.5 m | A ~130 px player: near Lite's detection limit? |
| `cam-fov-120-near` | camera | `base-solo` | hfov 65 → 120° (barrel distortion) and distance 3.2 → 2.0 m | The ultrawide as used: the player a usable size but warped, feet near the curved bottom edge. |
| `cam-fov-120` | camera | `base-solo` | hfov 65 → 120° (barrel distortion) | Ultrawide: a small, warped player; GT runs through the same lens model. |
| `cam-fov-90` | camera | `base-solo` | hfov 65 → 90° | Wider lens: the player smaller, no distortion. |
| `cam-high-1.8` | camera | `base-solo` | height 1.0 → 1.8 m, look-at 0.85 m | Looking down from a shelf: foreshortened legs, head large. |
| `cam-low-0.3` | camera | `base-solo` | height 1.0 → 0.3 m | Looking up from the floor: foreshortened torso, big legs. |
| `cam-near-2.0` | camera | `base-solo` | distance 3.2 → 2.0 m | Feet (and raised hands) out of frame: does tracking survive cropped legs and does calibration (needs ankles) fail? |
| `cam-portrait` | camera | `base-solo` | portrait 480×640, hfov 65 → 50° | Phone on its side: the game gets a tall frame. |
| `cam-roll-6` | camera | `base-solo` | roll 0 → 6° | A crooked phone: rotated body. |
| `cam-shake-bump` | camera | `base-solo` | shake 0.5° 2 Hz + bump (4° pan, 2° tilt) at 14 s | Handheld wobble and a knocked camera: jitter and a sudden global shift. |
| `cam-yaw-30` | camera | `base-solo` | yaw 0 → 30° | Mild three-quarter view. |
| `cam-yaw-55` | camera | `base-solo` | yaw 0 → 55° | Nearly side-on: far-side limbs hidden, left/right swaps. |
| `light-backlit_window` | lighting | `base-solo` | lighting bright_even → backlit_window (window behind, weak fill) | Near silhouette: front features lost, edges strong. |
| `light-ceiling_only` | lighting | `base-solo` | lighting bright_even → ceiling_only (one overhead source) | Hard top light: dark face and legs, strong shadows. |
| `light-daylight_side` | lighting | `base-solo` | lighting bright_even → daylight_side (strong side daylight) | Strong side light: one side bright, the other in shadow. |
| `light-dim_evening` | lighting | `base-solo` | lighting bright_even → dim_evening (dim warm lamp) | Low light: noisy, dark limbs; recall and wrist confidence drop. |
| `light-flicker` | lighting | `base-solo` | lighting bright_even → flicker (11 Hz flicker) | Frame-to-frame brightness changes: jitter, looks. |
| `light-mixed_temp` | lighting | `base-solo` | lighting bright_even → mixed_temp (cool + warm sources) | Two colour temperatures across the body. |
| `light-overexposed` | lighting | `base-solo` | lighting bright_even → overexposed (+1 EV over the base exposure) | Blown highlights: low-contrast limbs. |
| `light-party` | lighting | `base-solo` | lighting bright_even → party (moving coloured lights) | Saturated moving colours: shading changes every frame. |
| `light-tv_glow` | lighting | `base-solo` | lighting bright_even → tv_glow (TV light only) | Very dark, blue-lit player: near the detection floor. |
| `look-child` | appearance | `base-solo` | age 0.5 → 0.2 (~1.3 m) | A child in an adult framing: smaller body, different proportions. |
| `look-dark-on-dark` | appearance | `light-dim_evening` | clothes → black (vs light-dim_evening) | Black clothes in a dim room: a dark silhouette on a dark background. |
| `look-dress` | appearance | `base-solo` | + knee-length dress | Hidden hips and thighs. |
| `look-hair-long` | appearance | `base-solo` | hair bob02 → long01 | Long hair over the shoulders and ears. |
| `look-hat` | appearance | `base-solo` | + fedora | A hat over the head/face. |
| `look-heavy` | appearance | `base-solo` | weight 0.5 → 0.95, muscle 0.3 | A heavy body: hip/shoulder joint placement. |
| `look-long-skirt` | appearance | `base-solo` | + ankle-length skirt | Hidden hips, knees and ankles: leg joints guessed. |
| `look-skin-african-dim` | appearance | `base-solo` | race/skin → african, light → dim_evening | Dark skin in dim light: compare with light-dim_evening (asian) and look-skin-caucasian-dim. |
| `look-skin-african` | appearance | `base-solo` | race/skin asian → african | Dark skin in good light: does recall/accuracy hold (fairness)? |
| `look-skin-caucasian-dim` | appearance | `base-solo` | race/skin → caucasian, light → dim_evening | Light skin in dim light (fairness reference). |
| `look-skin-caucasian` | appearance | `base-solo` | race/skin asian → caucasian | Light skin in good light (fairness reference). |
| `look-tall` | appearance | `base-solo` | male, ~1.93 m | A tall player: head near the top edge. |
| `look-wall-match` | appearance | `base-solo` | clothes recoloured to the wall's off-white | Low figure-ground contrast. |
| `bg-backyard` | background | `base-solo` | room → backyard | Outdoors: sky light and foliage. |
| `bg-clutter-0` | background | `base-solo` | clutter 0.5 → 0 | A bare room (easiest background). |
| `bg-clutter-1` | background | `base-solo` | clutter 0.5 → 1 | Busy background. |
| `bg-mannequin-coats` | background | `base-solo` | + mannequin + coat rack | Person-like objects as distractors. |
| `bg-mirror` | background | `base-solo` | + mirror behind | A mirror straight behind a frontal player: the reflection is mostly hidden by the player, so this is the common, mild case (visible on the walk-in and wide moves). |
| `bg-open-plan` | background | `base-solo` | room → open_plan | A deep, busy background (kitchen, dining). |
| `bg-people-images` | background | `base-solo` | + TV showing a dancer + dancer poster | Pictures of people: distractor detections steal the one-person budget? |
| `bg-studio` | background | `base-solo` | room → dance_studio (mirror wall) + player 0.9 m left of centre | A full-size reflection beside the player: a second person-shaped detection (duplicate/distractor FPs, wrong person followed). |
| `bg-wallpaper` | background | `base-solo` | + patterned wallpaper | Texture behind the limbs. |
| `bg-window` | background | `base-solo` | + window behind | Bright window behind the player (in bright_even light). |
| `mot-arms-up` | motion | `base-solo` | arms-up holds + waack with arms overhead | Wrists above the head: wrist loss and arm swaps. |
| `mot-back` | motion | `base-solo` | dance facing 0 → 180° | Back view: Lite labels left/right by the face side, so whole-body swaps; recall without a face. |
| `mot-fast` | motion | `base-solo` | speed 1.0 → 1.25 | Faster limbs: blur and the tracker's motion gate. |
| `mot-floor` | motion | `base-solo` | dance → break floor work | Low, horizontal and inverted poses: detection loss and wrong skeletons. |
| `mot-jumps` | motion | `base-solo` | dance → leaps and stomps | Airborne frames: vertical motion, foot blur. |
| `mot-side` | motion | `base-solo` | dance facing 0 → 90° | Side-on: far limbs hidden. |
| `mot-slow` | motion | `base-solo` | speed 1.0 → 0.8 | Slower motion (reference). |
| `mot-spins` | motion | `base-solo` | dance → ballet-jazz turn sequences | Continuous turns: identity of left/right flips each half-turn. |
| `sens-auto-exposure` | sensor | `base-solo` | + auto-exposure breathing 0.7 EV | Brightness drift: looks and confidence. |
| `sens-chroma` | sensor | `base-solo` | + chroma subsampling | Colour bleeding at edges. |
| `sens-defocus` | sensor | `base-solo` | + 2.5 px defocus | Soft focus: small joints blurred. |
| `sens-dim-gain-jpeg` | sensor | `light-dim_evening` | light-dim_evening + gain, chroma, JPEG 50 | A cheap webcam at night. |
| `sens-dim-gain` | sensor | `light-dim_evening` | light-dim_evening + gain 2 EV, noise 8 | A dark room pushed up: heavy noise. |
| `sens-downscale` | sensor | `base-solo` | + half resolution | Low-detail sensor. |
| `sens-fps-15` | sensor | `base-solo` | + 15 fps | Half the frame rate: motion gating and the score's pose rate. |
| `sens-jpeg30` | sensor | `base-solo` | + JPEG q30 | Compression blocks on the limbs. |
| `sens-motion-blur` | sensor | `base-solo` | + 80% shutter blur | Smeared fast limbs. |
| `sens-noise` | sensor | `base-solo` | + noise σ8 | Sensor noise. |
| `sens-rolling-shutter` | sensor | `base-solo` | + rolling shutter 8 px | Shear (GT warped with it). |
| `sens-vignette` | sensor | `base-solo` | + vignette 0.6 | Dark edges where the player walks in. |
| `sens-wb-3000` | sensor | `base-solo` | + white_balance 3000 K | An orange cast (daylight balance under warm light): clothes/skin colours shift. |

## Crossings, crowding and off-centre

Two off-centre pairs (`mp2-offcentre-left`, `-right`, the two rows before `mp2-close-offcentre` below) came from the first
review of two-player strips; then 14 additional scenes at 640×480, 30 fps, 24 s, with `setup` from 0–7 s (2 s walk,
5 s neutral calibration hold) and `dance` from 7–24 s. Crossings are part of the dance
phase; players resume dancing at their exchanged spots. Front/back walking lanes and
staggered dancing depths create image overlap without asking people to walk through each
other. All people are adults; the contrasting look-alikes measure 1.617 m (slim) and
1.905 m (broad) in the generated metadata. The two passer scenes explicitly retain `players: 1` / `2`
and give the extra person `role: "bystander"`; their offscreen entrances/exits are intentional.
The passer's one-second pause is an occlusion event, not a calibration hold.

Cameras retain the bases' frontal, landscape conventions, 1 m height, bright-even light,
and furnished living room. Distances are 4.5 m for pairs, 5.8 m for trios and 6.1 m for
quads unless listed below. The near off-centre pair uses a 75° horizontal field of view
and a 1.05 m look-at height to fit wide arm motions; all other scenes use 65° and 0.95 m.
Street jazz, pop, lock, LA hip-hop, house and waack clips supply varied motion.
`mp2-cross-alike-heights` preserves the existing `mp2-cross-alike` camera, entry, clips and
crossing timing, changing only height/build. The other scenes use shorter entry walks so
players stay framed during setup. The near scene’s foreground entry is only 0.25 m:
a longer approach clipped the shoe soles at the bottom of the frame before the hold.

| Scene id | Category | What varies | Hypothesis |
|---|---|---|---|
| `mp3-cross-adjacent` | multiplayer | Left neighbours swap at 12–17 s; lock, third player popping | A swap should preserve both moving identities and the stationary third identity. |
| `mp3-cross-middle` | multiplayer | Outer pair swap at 12–18 s on opposite sides of the centre player's depth; LA hip-hop/pop | Three simultaneous overlapping projections should not exchange the centre player's identity. |
| `mp4-cross-adjacent` | multiplayer | Players 2 and 3 swap at 12–17 s; street jazz/pop | Crossing the central strip boundary should preserve all four identities. |
| `mp4-cross-edge` | multiplayer | Two leftmost players swap at 12–17 s near the left edge; pop/lock | Identity recovery should work away from the picture centre. |
| `mp4-bunched-edge` | multiplayer | Two players 0.7 m apart laterally near the left edge, 0.75 m apart in depth; two others spread out | A pair occupying roughly one fifth of the width should both be found despite a four-player crop layout. |
| `mp4-cross-alike` | multiplayer | Same crossing as `mp4-cross-adjacent`, with identical bodies and clothes on the middle pair | Old-position reassignment should be exposed when appearance cannot resolve the crossing. |
| `mp3-cross-alike-heights` | multiplayer | Same crossing as `mp3-cross-adjacent`, matching outfits on a short slim and tall broad pair | Body geometry should help retain identity when clothing matches. |
| `mp2-cross-alike-heights` | multiplayer | Existing alike-pair crossing, with clearly different heights/builds | Height/build cues should improve on the identical-body crossing's old-order ambiguity. |
| `mp2-offcentre-left` | multiplayer | Both players in the left 40% of the picture (a webcam off to one side) | Two-player strips, which assume one player per side, must not lose either player. |
| `mp2-offcentre-right` | multiplayer | Players at about 55% and 80% of the picture's width, one across the left strip's cut edge | A player standing on a strip's cut edge must stay whole and found. |
| `mp2-close-offcentre` | multiplayer | 0.7 m lateral spacing, 0.65 m depth stagger, both in right 40%; pop | Finding close neighbours must not rely on one person standing in each picture half. |
| `mp2-close-far` | multiplayer | Same close spacing at a 5.5 m camera; pop | Small close silhouettes should remain separate and calibratable. |
| `mp2-offcentre-near` | multiplayer | Both bodies in left half, 3 m camera, 75° FOV, 1 m depth stagger; waack | Large moving arm extents should not make off-centre player crops lose either person. |
| `mp2-passerby-front-slow` | bystander | 5 m camera; slow foreground passer at 10–19 s, 1 s pause in front of p1; house/lock | Prolonged occlusion must not let a bystander steal a player number. |
| `mp1-passerby-front` | bystander | Solo LA hip-hop player; foreground passer at 11–16 s | The sole track should return to the dancer after occlusion rather than follow the passer. |
| `mp3-arm-overlap` | multiplayer | 0.78 m neighbour lateral spacing; centre dancer 1.6 m behind others; street jazz/waack | Overlapping arm projections should not merge people or attach limbs to neighbours. |

Rendered data and GT-overlay videos live in
`/Volumes/development/aerodance-trackbench/scenes/<id>/`.
Contact sheets are `contact-sheet.jpg` in each scene directory and emphasize setup, crossing
or occlusion, and the post-event dance. No estimator results are included in this batch.

Render validation: all 14 scenes have 720 frames, masks and video frames (10,080 frames
in total), current resolved specs and `READY` markers. Every contact sheet was visually
reviewed. Adult mesh heights are 1.617–1.905 m; no player landmark or silhouette touches
an image boundary in the final renders. Bystanders deliberately enter/leave through the
side edges. The near-scene entrance was shortened and re-rendered; no scenes were dropped.
