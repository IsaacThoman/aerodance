# trackbench: shared contract (v1)

trackbench is a benchmark for aerodance's player tracking. Blender renders synthetic webcam
footage of realistic people (MPFB/MakeHuman humans dancing real AIST++ motion capture), with
exact per-frame ground truth. Harnesses run the game's real pose pipeline (and candidate
replacement pose estimators) over that footage and measure what players would feel: people
found, joint accuracy, identity swaps, calibration time, and above all **score lost to
tracking**.

Several agents build this in parallel, so this file fixes the interfaces between the parts.
Change it only in consultation with the orchestrator, and note any change at the bottom.

## Where things live

| What | Where |
|---|---|
| Code (committed) | `tools/trackbench/` in the aerodance repo |
| Data root (never committed) | `$TRACKBENCH_DATA`, default `/Volumes/development/aerodance-trackbench` |
| Python venv (numpy, scipy, opencv, pillow, onnxruntime, mediapipe, rtmlib) | `$TRACKBENCH_DATA/.venv` (Python 3.12, made with `uv`) |
| Downloads (AIST++ motions + keypoints3d, MakeHuman CC0 assets) | `$TRACKBENCH_DATA/downloads/` |
| Rendered scenes | `$TRACKBENCH_DATA/scenes/<scene-id>/` |
| Estimator/tracker outputs | `$TRACKBENCH_DATA/runs/<estimator-id>/<scene-id>/` |
| Model weights | `$TRACKBENCH_DATA/models/` |
| Blender | `/Applications/Blender.app/Contents/MacOS/Blender` (5.2.3; `blender` on PATH also works) |

Licences: AIST++ annotations are CC BY 4.0 (credit them); MakeHuman system assets are CC0. The
aerodance repo is proprietary: don't commit any data, weights, renders, or AGPL code.

MPFB (the MakeHuman Blender extension) is installed in the user's Blender 5.2, with the
MakeHuman CC0 assets in its user data directory
(`~/Library/Application Support/Blender/5.2/extensions/.user/blender_org/mpfb/data`). Import it
in scripts as `from bl_ext.blender_org.mpfb.services.humanservice import HumanService`.
`blender/proto_smoke.py` (one clothed human) and `blender/proto_retarget.py` (AIST++ SMPL
motion retargeted onto MPFB's `default` rig) are working prototypes, about 3 s per human and
0.8 s per 640x480 EEVEE frame. MediaPipe Lite (the game's model) detects these people.

## Coordinates and conventions

- **Stage coordinates** (spec and 3D GT), metres, Blender world space: origin on the floor at
  the centre of the play area; **+x is to the right as the camera sees it**, **+y is away from
  the camera** (depth), +z up. A camera at the default place stands at `(0, -distance, height)`
  looking toward `+y`.
- **Image coordinates** (2D GT, detections): normalized `x, y` in `[0, 1]` of the full,
  **unmirrored** frame, `(0, 0)` at top left, exactly like MediaPipe's normalized landmarks. The
  game mirrors only its preview; its tracker and scorer see unmirrored frames.
- **Left/right** is the subject's own (MediaPipe index 11 is the person's left shoulder; MPFB
  bone `upperarm01.L` is the character's left).
- **Joint layout**: MediaPipe pose-33 indices everywhere (0 nose, 1-3 left eye inner/eye/outer,
  4-6 right eye inner/eye/outer, 7/8 left/right ear, 9/10 mouth left/right, 11/12 shoulders,
  13/14 elbows, 15/16 wrists, 17/18 pinky, 19/20 index, 21/22 thumb, 23/24 hips, 25/26 knees,
  27/28 ankles, 29/30 heels, 31/32 foot index (toe tip)). Models with fewer joints leave the
  others `null`.
- Frames are 1-based; frame `n` is shown at `t_ms = (n - 1) * 1000 / fps`.

## Scene spec (`tools/trackbench/scenes/<id>.json`)

One JSON file per scene; meant to be edited by hand. Everything optional has a default.

```jsonc
{
  "id": "solo-frontal-jb",            // = file name, [a-z0-9-]
  "category": "baseline",             // see "Categories" below
  "description": "One player, frontal, bright room, jazz dance.",
  "seed": 1,                          // all randomness (clutter, recolours) derives from it
  "duration_s": 12,
  "fps": 30,
  "resolution": [640, 480],           // what the game asks the webcam for
  "players": 1,                       // the game's player count for this scene (what the tracker is told)

  "camera": {
    "height_m": 1.0,                  // lens height above the floor
    "distance_m": 3.2,                // horizontal distance to the look-at point
    "yaw_deg": 0,                     // orbit around the look-at point; + moves the camera to the right
    "look_at": [0, 0, 0.95],
    "hfov_deg": 65,                   // horizontal field of view of the final frame
    "roll_deg": 0,
    "orientation": "landscape",       // "portrait" swaps resolution (a phone on its side)
    "shake": null,                    // {"amp_deg": 0.3, "freq_hz": 2} handheld/bumped wobble
    "events": []                      // e.g. [{"t_s": 6, "type": "bump", "yaw_deg": 4, "pitch_deg": -2}]
  },
  "room": {
    "preset": "living_room",          // the environment module defines the presets
    "clutter": 0.5,                   // 0..1
    "features": []                    // e.g. ["mirror_behind", "tv_with_people", "poster_people", "coat_rack", "window_behind"]
  },
  "lighting": {
    "preset": "bright_even",          // the environment module defines the presets
    "exposure_ev": 0,
    "color_temp_k": 4500,
    "flicker_hz": 0
  },
  "people": [
    {
      "id": "p1",                     // stable identity used in GT
      "role": "player",               // "player" | "bystander"
      "body": {"gender": 0.0, "age": 0.45, "weight": 0.5, "muscle": 0.5, "height": 0.5, "proportions": 0.5,
               "race": {"african": 1, "asian": 0, "caucasian": 0}},
      "skin": "young_african_female", // MakeHuman skin folder name
      "hair": "ponytail01",           // MakeHuman hair folder name, or null
      "outfit": {
        "clothes": ["female_casualsuit01", "shoes02"],   // MakeHuman clothes folder names
        "recolor": {"top": "#c03030", "bottom": "#202020"} // optional tints (generator decides how)
      },
      "place": {"x": 0, "y": 0, "facing_deg": 0},       // facing 0 = toward the camera
      "travel": 0.3,                  // scale on mocap root travel (AIST++ dancers wander); 0 = dance on the spot
      "timeline": [                   // back to back from t = 0; anything after the last segment holds it
        {"type": "offstage", "duration_s": 1.0},
        {"type": "walk", "from": [-2.5, 0.5], "to": [0, 0], "duration_s": 2.5},
        {"type": "hold", "pose": "neutral", "duration_s": 3.0},          // neutral | a-pose | t-pose | arms-up
        {"type": "dance", "clip": "gJB_sBM_cAll_d07_mJB1_ch02", "clip_start_s": 4.0, "duration_s": 8, "speed": 1.0, "mirror": false},
        {"type": "walk", "to": [3, 1], "duration_s": 2},
        // {"type": "pingpong", "duration_s": 18, "auto": {...}}   table tennis (blender/GENERATOR.md)
        {"type": "offstage"}
      ]
    }
  ],
  "phases": [                         // optional labels the harness uses (calibration timing, dance-only metrics)
    {"name": "setup", "start_s": 0, "end_s": 4},
    {"name": "dance", "start_s": 4, "end_s": 12}
  ],
  "post": []                          // sensor degradations applied after render, see below
}
```

`dance` clips are AIST++ motion names (`$TRACKBENCH_DATA/downloads/aist/motions/<name>.pkl`, 60
fps SMPL). Their 10 genres are the name's prefix: gBR break, gPO pop, gLO lock, gMH middle hip-hop,
gLH LA hip-hop, gHO house, gWA waack, gKR krump, gJS street jazz, gJB ballet jazz. Transitions
between segments blend over a short time so poses don't snap.

**Variants.** A spec may instead say `"base": "<other-id>"` plus overrides (deep merged) and/or
`post`; a variant that changes only `post` reuses the base's render and applies the
degradations to its frames.

## Scene output (`$TRACKBENCH_DATA/scenes/<id>/`)

```
spec.json          the resolved spec (defaults filled in)
meta.json          camera intrinsics/extrinsics, fps, resolution, frame count, people, phases, generator version, render time
frames/000001.jpg  the camera picture, JPEG quality 95 (post degradations applied here)
render/000001.png  lossless render (kept so post variants can be made; deletable)
masks/000001.png   8-bit instance mask: 0 background, k = people[k-1] (optional but wanted)
gt.jsonl           one line per frame, below
preview.mp4        frames with GT skeletons drawn, for eyeballing (optional)
```

`gt.jsonl` line:

```jsonc
{"frame": 1, "t_ms": 0,
 "people": [
   {"id": "p1", "role": "player", "index": 0,        // index into spec.people
    "kp":   [[x, y, depth_m, vis], ...33],            // normalized image coords; depth = camera-space distance along the view axis
    "kp3d": [[X, Y, Z], ...33],                       // stage coordinates, metres
    "bbox": [x0, y0, x1, y1],                         // normalized, from the instance mask (or projected mesh if no mask), clipped to the frame; null if unseen
    "visible_frac": 0.93,                             // fraction of the person's pixels not hidden by others (from masks), null if unknown
    "in_frame": true,                                 // any of the person's pixels in frame
    "phase": "dance"}                                 // segment type at this frame: offstage|walk|hold|dance
 ]}
```

Table-tennis scenes (any person with a `pingpong` segment, or `"gt": {"hands": true}` in the
spec) add optional fields to each person:

```jsonc
    "hands": {"left":  {"kp": [[x, y, depth_m, vis], ...21], "kp3d": [[X, Y, Z], ...21]},
              "right": {"kp": [...21], "kp3d": [...21]}},   // MediaPipe hand-21 order, the body's conventions
    "paddle": {"hand": "right", "center": [X, Y, Z], "normal": [X, Y, Z]},  // only for a person holding a paddle prop
    "phase": "ready"                                  // pingpong frames: ready | swing | serve
```

- **hands**: both hands every frame the person is on stage, in MediaPipe's hand-21 order (0 wrist;
  thumb 1 CMC, 2 MCP, 3 IP, 4 tip; index 5-8, middle 9-12, ring 13-16, pinky 17-20: MCP, PIP, DIP,
  tip). `left`/`right` are the person's own hands. `kp` and `kp3d` follow the body's `kp`/`kp3d`
  exactly (normalized unmirrored image x, y; depth along the view axis; vis codes 0-3; stage
  metres; lens/rolling-shutter warps applied the same way). Joints are the rig's joint centres;
  tips are the end of the last finger bone, inside the finger pad ~0.5 cm under the skin. Hand
  vis 0 means the ray from the camera first meets skin of that joint's own bones near it; 1 =
  hidden by the person's own body (another finger, the palm seen from the back, the other hand,
  a sleeve); 2 = hidden by a paddle blade (from 4 mm in front), another person or an object.
- **paddle**: a person may hold a table-tennis paddle prop. `center` is the blade's centre and
  `normal` the unit normal of its forehand (red) face, which faces where the palm faces
  (shakehand grip); stage coordinates. The paddle is not part of anyone's mask (mask 0); its
  blade is an occluder for every keypoint (vis 2). Blade 15.0 x 15.8 cm, handle 10 cm.
- **phase** in a `pingpong` segment: `swing` from leaving the ready stance to the end of the
  follow-through, `serve` from raising the free hand to the end of the serve's follow-through,
  `ready` otherwise (including the recovery back to ready).

`meta.json`'s `people[]` entries of table-tennis players add `hand` (the paddle hand), `paddle`
(bool), `paddle_size_m` and `strokes`: `[{kind, start_s, contact_s, swing_end_s, end_s,
target_speed_mps, peak_speed_mps}]` in scene seconds (`contact_s` is the paddle wrist's fastest
moment; `peak_speed_mps` its measured peak speed in the stage frame).

`vis` codes: `0` visible, `1` self-occluded (the person's own body is in front of it), `2`
occluded by another person or object, `3` outside the frame. People entirely off stage may be
omitted from a frame.

**Joint definitions.** Shoulders, elbows, wrists, hips, knees and ankles are the rig's joint
centres (bone heads of MPFB's `default` rig: `upperarm01`, `lowerarm01`, `wrist`,
`upperleg01`, `lowerleg01`, `foot`). The hand points (17-22) are knuckle joint centres, where
MediaPipe puts them: bone heads of `finger5-1` (pinky MCP), `finger2-1` (index MCP) and
`finger1-2` (thumb MCP). Face and foot (29-32) points are fixed vertices of the MakeHuman
basemesh (its topology is the same for every body): nose tip, eye centres and corners, ear
canals, mouth corners, heel back and toe tip. Models label
some joints differently from anatomical centres (COCO hips sit higher and wider), so the
harness reports errors both raw and with each model's mean per-joint offset removed.

## Detections (`$TRACKBENCH_DATA/runs/<estimator-id>/<scene-id>/detections.jsonl`)

What a pose estimator reports, before any player tracking. One line per frame processed:

```jsonc
{"frame": 1, "t_ms": 0, "inference_ms": 12.3,
 "people": [{"kp": [[x, y, z, conf] | null, ...33], "score": 0.91}],
 "looks": [[...] | null]}                // optional: appearance.ts samples, one per person (the game's worker gives them)
```

`conf` is the joint's confidence in `[0, 1]` (MediaPipe: `min(visibility, presence)`, as the game
uses). `z` is the model's relative depth if it has one, else `0`. Coordinates are normalized to
the full frame even if the model ran on crops or strips. Estimator ids are short and stable,
e.g. `mp-lite-game` (the game's own worker in Chromium), `mp-full`, `mp-heavy`, `rtmo-s`,
`rtmpose-m`, `movenet-mp`, `apple-vision`, `yolo11n-pose`. A sibling `run.json` records the model,
its version/hash, the runtime (e.g. "Chromium 1243 Metal, WebGL delegate" or "onnxruntime 1.x
CoreML EP"), the machine and the settings.

## Tracked poses (`.../tracked.jsonl`) and metrics (`.../metrics.json`)

The harness feeds detections through the game's `PlayerTracker`
(`packages/pose/browser/tracker.ts`) in time order, exactly as the game does, and writes one
line per frame: `{"frame", "t_ms", "poses": [{"playerId", "kp": [[x, y, z, conf], ...33]}]}`.
For the game's own worker the tracker runs in the loop (the worker's strips need the
tracker's player count per frame). `metrics.json` holds the measures the harness README
defines; `report` commands aggregate them across scenes and estimators.

## Categories

`baseline`, `camera` (height, distance, angle, fov, portrait, framing that cuts feet or heads,
shake/bumps), `lighting` (dim, backlit, harsh, coloured, flicker, exposure), `appearance`
(clothes, colours that match the background, body types, children, hair), `background`
(clutter, mirrors, TVs/posters with people, person-like objects), `motion` (spins, back view,
floor work, jumps, arms overhead, crossing arms, speed), `multiplayer` (2-4 players: spacing,
depth, crossings, look-alikes, occlusion), `bystander` (walk-throughs, sitting, standing near
the camera), `pingpong` (table tennis in front of the webcam: hands, paddles, fast arms; the
`pp-*` scenes), `setup` (walking in, calibration hold, late joiners, leaving and returning,
someone too close), `sensor` (noise, low light gain, blur, compression, low fps, white balance).

## Post degradations (`post`)

Applied in order to `render/` PNGs to make `frames/` JPEGs (Python, `tools/trackbench/post/`):
`{"type": "noise", "sigma": 6}`, `{"type": "gain", "ev": -2, "noise": 8}` (dark room pushed up),
`{"type": "jpeg", "quality": 40}`, `{"type": "motion_blur", "shutter_frac": 0.5}` (needs the
render's neighbour frames; or rendered with Blender motion blur instead),
`{"type": "defocus", "radius_px": 2}`, `{"type": "white_balance", "kelvin": 3000}`,
`{"type": "fps", "fps": 15}` (drops frames; GT keeps matching frame numbers), `{"type":
"downscale", "factor": 0.5}`, `{"type": "vignette", "strength": 0.4}`.

## Change log

- v1 (2026-11-01): first version.
- v1.1 (2026-11-01, generator): hand points 17-22 are the pinky/index/thumb knuckles (MCP joint
  centres), not fingertips. MediaPipe Lite on the rendered samples sits a median 0.07-0.09 torso
  lengths from the knuckles and 0.15-0.19 from the fingertips, so the fingertips were a
  definition mismatch.

- v1 environment extension (2026-11-01): environment/camera interfaces are unchanged. Post additionally supports `auto_exposure`, `auto_white_balance`, `chroma_subsample`, and `rolling_shutter`; detailed parameters are in `blender/ENVIRONMENT.md`. FOV above 90 degrees automatically applies barrel distortion. GT must call `post.degrade.distort_points(points, spec, frame=...)` and derive image-space boxes from `distort_mask(mask, spec, frame=...)` for the same lens/rolling-shutter mapping. `post-meta.json` records retained original frame numbers (fps drops never renumber), source/output fps, lens coefficient and operations. Post variants changing geometric effects must regenerate image-space GT from original projections/masks.

- v1 harness additions (2026-11-01, additive; `harness/README.md` has the details). Estimator ids for the game's own
  worker: `mp-<lite|full|heavy>-game`, with `-rt` for the realtime (frame-dropping) simulation. `detections.jsonl`
  lines may also carry `roundtrip_ms`, and in realtime runs `sent_ms`, `received_ms` (when the result arrived; the
  tracker stage replays in that order) and `dropped: true` (the game discarded the result as 500 ms old); `score`
  may be null. `tracked.jsonl` lines are `{frame, t_ms, received_ms, poses, lined, calib?, reset?, dropped?}`:
  `lined` is whether the tracker has numbered the players, `calib` the replayed `WebcamCalibration` state,
  `reset` a GameSession setup line-up retry; a tracked joint's `conf` may be null (unknown, as the game keeps it).
  Harness data: `runs/<estimator>/_offsets.json` (mean per-joint offsets), `cache/looks128/` (128-wide frame
  pixels for looks), `dist-snapshot-<sha>/` (the built game the worker runs from), `reports/`.
- v1.2 (2026-11-01, single-player suite): the lens/rolling-shutter GT integration is implemented
  (`post/geometric_gt.py`, run by `render.py`). For such scenes `gt.jsonl` and `masks/` describe
  the distorted camera picture; the pinhole versions are kept as `gt.pinhole.jsonl` and
  `masks.pinhole/`. Rendering changed to a webcam-like picture (Standard view transform,
  per-preset auto exposure; ENVIRONMENT.md): generator 1.1, which is part of `render_key`, so
  renders made with 1.0 are re-rendered rather than reused as post-only bases.
- v1.4 (2026-11-09, table-tennis scenes, additive): optional `hands` (hand-21 GT) and `paddle`
  per person, `phase` values `ready`/`swing`/`serve`, `meta.json` `people[].hand/paddle/strokes`,
  the `pingpong` timeline segment, person `hand` and `paddle`, and spec `render`
  (`motion_blur_shutter`, `samples`) and `gt.hands` keys. Category `pingpong`. Scenes without
  them are unchanged (GT byte-identical).
- v1.3 (2026-11-01, single-player suite): generator 1.2 halves the hold's arm drift (GENERATOR.md,
  Timeline segments): with the old ±2° a wrist moved 0.12 torso lengths, so Lite never calibrated
  on base-solo's 4 s hold. Holds rendered with 1.0/1.1 sway more than real people holding still.
- v1.4 (2026-11-09, ping-pong; additive, all optional). **GT**: a `gt.jsonl` person may carry
  `"hands": {"left": {"kp": [[x, y, depth_m, vis] x21], "kp3d": [[X, Y, Z] x21]}, "right": {...}}`
  (MediaPipe hand-21 order, the body's kp/kp3d conventions) and `"paddle": {"hand": "right",
  "center": [X, Y, Z], "normal": [X, Y, Z]}` (stage metres). A spec's `resolution` may be
  `[1280, 960]`; `phase` gains `ready`, `swing` and `serve`. **Detections** from a run with a
  tracking detail (`run-game --detail`) add, per person in `people`'s order, `world: [[X, Y, Z]
  x33] | null` (MediaPipe world landmarks: metres round the hips, x right in the picture, y down,
  z away) and, while the hand model runs, `hands: [[{side, score, kp: [[x, y, z] x21], world:
  [[X, Y, Z] x21]}]]` (webcamRecord.ts TrackedHand: kp in the picture, 0-1 unmirrored, z from the
  wrist; world metres round the hand). **Tracked** poses then carry `world` and `hands` as the
  game's `LivePose` has them. `run.json` gains `settings.detail`, `settings.input` (the size fed to
  the worker, `--input-size`), `hands: {state, events, dropped_at_ms}` and `completed`/`error` (a
  run whose worker dies keeps what it tracked). **Real clips without GT** live in
  `$TRACKBENCH_DATA/clips/<id>/` (frames + spec.json, no gt.jsonl), so suite runs that expect GT
  don't pick them up. `pingpong.json` beside `metrics.json` holds the ping-pong measures
  (`PINGPONG.md`).
