# trackbench generator

Turns a scene spec (`tools/trackbench/scenes/<id>.json`, see `../CONTRACT.md`) into frames,
masks and ground truth. The environment, camera and sensor post-processing are separate
(`environment.py`, `camera.py`, `../post/`; see `ENVIRONMENT.md`).

## Running it

```sh
python3 tools/trackbench/render.py <id-or-spec.json> [...] [--jobs 3] [--preview] [--gt-only]
```

- Resolves the spec (`base` chain deep-merged, defaults filled) and writes it as `spec.json`.
- A variant whose only differences from its base are `post` (and labels: id, description,
  category, phases) symlinks the base's `render/` and `masks/`, copies its `gt.jsonl` and
  `meta.json`, and only runs post. The base is rendered first if it isn't already.
- Otherwise it runs `--jobs` Blender processes on contiguous frame chunks under
  `caffeinate -dimsu` (background GPU jobs crawl without it), merges `gt.parts/` and
  `meta.parts/` into `gt.jsonl` and `meta.json`, then runs `post/degrade.py` (or plain JPEG q95
  if it's missing), then `post/geometric_gt.py` (warps GT and masks when the lens or a rolling
  shutter moves the picture; see Ground truth), and with `--preview` writes `preview.mp4` with
  the GT skeletons drawn.
- `READY` is removed at the start and written at the end. `--skip-done` skips scenes that are
  `READY` with the spec's current render key (resumable batch runs).
- A spec's optional `render` block sets `motion_blur_shutter` (fraction of a frame, overriding
  the lighting preset's 0.35/0.85; a webcam indoors exposes 1/60-1/30 s) and `samples` (EEVEE
  samples, unless `--samples` is given).
- `--gt-only` recomputes GT from the existing render's masks (no rendering): use it after GT
  code changes.
- Each process logs to `logs/generate-<a>-<b>.log`.

One chunk by hand, e.g. to look at a few frames:

```sh
blender -b -P tools/trackbench/blender/generate.py -- <spec.json|id> --out <dir> \
    [--frames a-b] [--step N] [--no-render] [--gt-only] [--save-blend scene.blend] [--samples N]
```

Overlay contact sheets (in the venv, `$TRACKBENCH_DATA/.venv/bin/python`):

```sh
python tools/trackbench/blender/preview.py <scene_dir> --sheet out.jpg --frames 1,60,120 [--mask] [--zoom] [--src render]
```

Overlays are drawn on `frames/` (the camera picture GT matches) unless `--src render`.

Left side orange, right side blue. Filled dot = visible, hollow = self-occluded, red x =
occluded by another person or object. Out-of-frame points aren't drawn.

## Spec extensions the generator understands

People (`people[i]`):

- `body`: MPFB macros `gender age weight muscle height proportions` (0..1; age 0.1875 ≈ 11
  years, 0.5 = 25), optional `cupsize firmness`, and `race` weights. Children are just a low
  `age`. **Adult proportions need `age` ≥ 0.5**: MakeHuman blends its 1-, 11-, 25- and 90-year
  target shapes linearly in `age` (0, 0.1875, 0.5, 1), so age 0.35 (nominally ~18 years) is
  half the 11-year-old's shape and ~15 cm short. Standing height of the body mesh (the meta's
  `height_m`; add ~2-3 cm for shoes), race weights ⅓ each, weight/muscle/proportions 0.5:

  | `age` (height 0.5) | 0.1 | 0.1875 | 0.25 | 0.3 | 0.35 | 0.42 | 0.5-1.0 |
  |---|---|---|---|---|---|---|---|
  | female, m | 0.98 | 1.27 | 1.33 | 1.39 | 1.44 | 1.51 | 1.58-1.59 |
  | male, m | 1.04 | 1.36 | 1.44 | 1.50 | 1.55 | 1.64 | 1.70-1.73 |

  | `height` (age 0.5) | 0 | 0.25 | 0.4 | 0.5 | 0.6 | 0.65 | 0.7 | 0.75 | 1.0 |
  |---|---|---|---|---|---|---|---|---|---|
  | female, m | 1.24 | 1.42 | 1.53 | 1.59 | 1.72 | 1.79 | 1.86 | 1.94 | 2.29 |
  | male, m | 1.37 | 1.56 | 1.66 | 1.73 | 1.86 | 1.93 | 2.00 | 2.07 | 2.43 |

  `height` is steeper above 0.5. Race moves it a lot: at age 0.5, height 0.62, an all-asian
  female is 1.65 m, all-caucasian 1.76 m and all-african 1.83 m (at 0.5: 1.50 / 1.61 / 1.67 m).
  Keep stature equal when only skin/race should differ (the single-player suite uses height
  0.62 asian, 0.54 caucasian, 0.47 african for 1.65 m). So `_sample-duo`'s p1 (female, asian, age 0.35,
  height 0.45) is 1.35 m: a young teenager's build, not an adult. For adults use age 0.5-0.8
  and height 0.45-0.7 (≈1.55-1.95 m); `meta.json`'s `people[].height_m` reports each one.
- `skin`: a MakeHuman skin folder. The default matches gender, age band and the main race.
- `hair`, `eyebrows` (default `eyebrow001`), `eyelashes` (default `eyelashes01`).
- `outfit.clothes`: MakeHuman clothes folder names, plus the procedural loose garments
  `tb_skirt` (knee length), `tb_long_skirt` (ankle length) and `tb_dress` (knee skirt with the
  top recoloured the same). They're made from the basemesh's own skirt helper (so they fit
  every body), pushed out into a flare, skinned to the root and both thighs/shins (cloth
  between the legs rather than wrapped round each), with a little solidify thickness. They
  hide hips and knees the way real skirts do.
- `outfit.recolor`: `{key: "#rrggbb"}`, keys `top`, `bottom`, `shoes`, `hat`, `hair`, `skirt`,
  `all`. The garment texture's luminance, divided by its mean over that region, multiplies the
  colour, so folds, seams and prints stay and only the hue/brightness changes. Two people with
  the same garments and recolour are dressed identically. Top/bottom come from the garment's
  mesh islands (a suit's shirt and trousers are separate islands); a one-piece garment that
  spans both is split at the waist.
- `place` `{x, y, facing_deg}`. `facing_deg` 0 faces the camera's default position (stage
  −y); positive turns the person to their left (counter-clockwise seen from above), so +90
  faces image right. Camera `yaw_deg` orbits the camera; it doesn't turn people.
- `travel`: scale on the mocap's root wander about the dancer's spot (0 = on the spot).

Timeline segments (back to back from t = 0; the last one without a `duration_s` lasts to the
end):

- `offstage`: hidden (keyframed `hide_render`) and left out of `gt.jsonl`.
- `walk` `{from?, to?, duration_s}`: a straight path from `from` (default: where the person is)
  to `to` (default: `place`). It eases in and out, faces the walking direction, and uses a
  procedural gait: hip flexion sized to the stride, knee flexion in swing, ankle roll, opposite
  arm swing, pelvis yaw and spine counter-rotation, and a slight lean. The step length follows
  speed and leg length, so the feet barely slide.
- `hold` `{pose: neutral | a-pose | t-pose | arms-up | seated, facing_deg?, sway_m?}`: a static pose with slight
  breathing sway (a frozen image isn't realistic): pelvis ±1 cm sideways, ±1.5° yaw and ±1° roll
  (0.23 Hz, the spine counter-rolling), arms ±0.8° (0.31 Hz), head nod ±2°. On `base-solo`
  (torso ~72 px) that's ≤ 0.06 torso lengths peak to peak at the calibration joints. Until
  generator 1.2 the arms swung ±2°: a wrist moved 0.12 torso lengths against the game's 0.15
  stillness tolerance, and MediaPipe Lite never completed calibration on a 4 s hold. `seated` bends hips and knees 90° and grounds
  the feet; place it on a suitably sized seat. `sway_m` defaults to 0.01; additional sway is
  upper-body lean so a fidget does not translate both feet across the floor.
- `dance` `{clip, clip_start_s, duration_s, speed, mirror, facing_deg?}`: AIST++ motion at the
  person's current spot. Holds and dances happen where the previous walk ended (or at `place`).

- `pingpong` `{duration_s, hand?, events? | auto?, stance_m?, liveliness?, grip?}`: a table-tennis
  player facing the camera (the Table Tennis minigame): a ready stance with strokes and serves.
  See **Table tennis** below.

Person keys for table tennis: `hand` (`right` default, or `left`: the paddle hand; the motion is
mirrored for left-handers) and `paddle` (`true` or `{forehand, backhand, wood}` hex colours):
a paddle prop in that hand (`humans.make_paddle`).

Segments blend over 0.3 s, centred on the boundary: a per-joint slerp of the SMPL-style local
rotations and a lerp of the hip position. The blend is longer when the heading changes a lot,
up to 0.8 s for a half turn, so turning to face the camera after walking in looks natural.

## Motion (`motion.py`, `smpl.py`)

Every segment produces SMPL-style poses: 24 joint rotations (the root's global, the rest
local, all in the stage frame) plus the hip midpoint. One retarget puts them on the rig.
Each mapped MPFB bone takes its SMPL joint's world rotation, applied to the bone's T-pose
orientation. That orientation is the rest orientation swung onto the SMPL template's T-pose
direction for the limb bones (directions from the SMPL neutral template joints), and the MPFB
rest orientation for the root, pelvis, spine, neck, head and clavicles. Unmapped bones (fingers,
toes, face) keep their rest pose relative to their parent. Limb directions therefore follow the
mocap exactly, whatever the bone lengths. Mapping:

| MPFB | SMPL joint |
|---|---|
| root, pelvis.L/R, spine05, spine04 | pelvis (0) |
| spine03 / spine02 / spine01 | spine1 (3) / spine2 (6) / spine3 (9) |
| neck01-03 / head | neck (12) / head (15) |
| clavicle, shoulder01 | collar (13/14) |
| upperarm01-02 / lowerarm01-02 / wrist | shoulder (16/17) / elbow (18/19) / wrist (20/21) |
| upperleg01-02 / lowerleg01-02 / foot | hip (1/2) / knee (4/5) / ankle (7/8) |

- **Scale**: the mocap's translation is scaled by this person's leg length over the SMPL
  template's (AIST++ fits only a global scale, so its dancers have the template's
  proportions). Children and tall people keep their feet where they should be.
- **Floor**: walks and holds put the lowest contact point (shoe soles under heel and toe, from
  the person's actual shoes) exactly on the floor every frame. Each dance gets one height offset
  per clip. On the frames where AIST++'s triangulated ankles are lowest (within 1 cm of the
  clip's 5th percentile, i.e. a foot flat on the floor), the rig's lower ankle is put at its
  standing height above the soles. Jumps and relevés then keep the height the keypoints show.
  A per-clip floor works because the SMPL fit's ankle heights track keypoints3d to ~1 cm (std
  over a clip, 5 clips checked). Clips without keypoints use the 3rd-percentile lowest contact
  instead. Contacts include knees, hands, elbows, hips and head for floor work. Nothing goes
  through the floor on any frame.

  Result: the lowest foot vertex (inside the shoe) is a median 2.2 cm up in walks, holds and the
  duo/quad dances (the sole's thickness). The solo's ballet jazz is a median 6.4 cm up: it's on
  its toes or in the air much of the time, and its keypoint ankles are a median 4.8 cm above
  flat in that window.
- **Heading**: a dance segment is turned so that the circular mean of the dancer's pelvis
  heading over the segment equals `facing_deg`. Root wander is taken about the segment's mean
  position, rotated the same way and scaled by `travel`.
- **Mirror** reflects the SMPL motion: left and right joints swap, axis-angle (x, y, z) becomes
  (x, −y, −z), and translation x is negated.
- **Resampling**: 60 fps → scene fps with slerp between neighbouring mocap frames (any
  `speed`). Past the clip's end, the last frame holds (with a warning).

### Verification (`checks/retarget_check.py`)

The check drives the real Blender rig (pose bones set from the solver, evaluated by Blender)
with every 12th frame of one clip per genre (10 clips, ~1,600 frames, plus mirrored copies).
It compares 3D limb directions with:

| limb | vs SMPL skeleton (same poses), median / p90 | vs AIST++ keypoints3d, median / p90 |
|---|---|---|
| upper arms L/R | 0.0° / 0.02° | 3.7° / 6.9°, 2.3° / 4.7° |
| forearms L/R | 0.0° / 0.02° | 2.3° / 4.6°, 3.4° / 4.9° |
| thighs L/R | 0.0° / 0.02° | 8.1° / 9.7°, 9.1° / 10.2° |
| shins L/R | 0.0° / 0.02° | 4.3° / 4.8°, 4.0° / 4.5° |
| shoulder line | 2.5° / 7.6° | 2.7° / 7.9° |
| hip line | 1.0° (constant) | 3.0° / 6.2° |

- The retarget reproduces the SMPL limbs exactly.
- The differences from keypoints3d are the SMPL fit's own: SMPL FK of the same frames against
  keypoints3d gives the same numbers, e.g. thighs 8° (COCO hips sit higher and wider than
  SMPL's) and arms 3-4°.
- The shoulder line differs from SMPL's because MPFB's shoulders are narrower relative to its
  collars. Giving the clavicles SMPL's direction didn't help (2.9° median).
- Mirrored clips have the same errors against mirrored keypoints (no left/right mix-up).
- The NumPy forward kinematics used for grounding matches Blender's to 0.02 mm.

## Table tennis (`pingpong.py`)

There is no licence-clean full-body racket mocap (CMU has none; AMASS is non-commercial; the
published table-tennis capture sets aren't downloadable), so the strokes are procedural, keyed
the way an animator would and solved onto the rig:

- **Channels**, keyed per stroke at its ready start, backswing end, contact, follow-through end
  and ready again (wide strokes add a mid-recovery key for the step back): torso yaw, forward and
  side lean (45 % in the pelvis, the rest over the three spine joints; neck and head counter-turn
  so the face stays to the screen), knee bend (hip drop), weight shift (hip over one foot), each
  foot's step (wide reaches lift one foot ~7 cm and replant it ~28 cm out), and per arm a wrist
  target relative to its shoulder in the chest's heading frame, an elbow hint, the palm's facing,
  wrist flex and deviation, and how open the free hand is. Values are cubic Hermite splines with
  Catmull-Rom tangents (zero at ready keys): the hand keeps moving through the backswing's turn
  and is fastest at contact. Small sine noise (crouch ±1 cm, yaw ±2°, wrists ±1.5 cm, 0.35-3 Hz)
  keeps the ready stance alive. Each stroke perturbs its keys (wrist ±2.5 cm, yaw ±4°) and its
  timing (backswing ×0.85-1.2, recovery ×0.85-1.25), seeded.
- **Kinds** (right-handed templates): `forehand` (drive: torso turns ~35° back and ~30° through,
  elbow out, follow-through up to the left of the face), `backhand` (paddle comes in front of the
  belly, elbow forward, wrist cocked, unrolls forward), `push` and `block` (compact, gentle),
  `loop` (deep knee bend and 50° turn, low backswing, finishes above the head), `wide_forehand`
  and `wide_backhand` (step out, lunge, arm nearly straight), `low` (crouch to a ball at knee
  height), and `serve` as the game has it: the free hand raised above its shoulder, palm up as if
  holding the ball, for 0.7-1.3 s, then a short swing as it drops.
- **Solving**: the torso goes through `RigModel.solve` for the shoulders and hip joints. Legs:
  two-bone IK with the MPFB bone lengths to the planted feet (stance 0.46 m, right foot 5 cm
  back, toes out 12°), knees forward and a little out, feet flat; the hips are lowered if a leg
  can't reach. Arms: two-bone IK to the wrist target with the elbow hint; the forearm turns (85°
  supination to 95° pronation from the handshake position) to face the palm as keyed, and the
  wrist bends up to 60° for the rest (a laid-back wrist on forehands). Written for a right-hander
  at the origin facing the camera, mirrored for a left-hander (`smpl.MIRROR`), then turned to
  `facing_deg` and moved to the spot. Checked by reading the palm normal back off the evaluated
  Blender rig at every contact: within ~10° of the key on every stroke kind.
- **Speed**: each stroke's forward swing (and, less, its backswing and follow-through) is retimed
  until the paddle wrist's peak speed in the stage frame (on the solved wrist targets, sampled at
  240 Hz) equals the stroke's `speed_mps` (it converges to ±0.01 m/s; meta records the result).
- **Rallies**: `events: [{t_s, kind, speed_mps, hold_s?, reach?: [dr, du]}]` (times are when the
  stroke leaves ready, relative to the segment; a stroke never starts before the last one's
  recovery ends), or `auto: {start_s, speed_mps: [lo, hi], gap_s: [lo, hi], mix: {kind: weight},
  rally: [min, max] strokes, pause_s: [lo, hi], serve: true}`: a serve, a run of strokes with
  irregular gaps (pushes and blocks capped at 1.6-2.8 m/s, loops pushed to the top of the range),
  a pause, a serve again.
- **Fingers** (animated only in `pingpong` segments; every other scene keeps unkeyed rest-pose
  fingers): curls about each finger bone's local x. The paddle hand is closed round a handle,
  `paddle` (shakehand: middle, ring and little fingers wrapped 72-90°, index 40° along the blade,
  thumb on the face) or a looser empty `fist`; the free hand is `relaxed`, slerped to `open` as
  it's raised to serve. They blend over 0.3 s from and to the rest hands of walk segments.
- **Paddle prop**: a 15 x 15.8 x 0.7 cm blade (red forehand rubber on the palm side, black
  backhand) and a 10 x 2.8 x 2.3 cm wooden handle, parented to the wrist bone, the handle
  across the palm's diagonal inside the curled fingers, the blade beyond the thumb-index web.
  Tagged `tb_kind = "prop"`; not in the masks; an occluder in GT (rebuilt per frame).
- **Phases** (GT `phase`): `swing`, `serve`, `ready` (see CONTRACT.md).

How realistic: at webcam scale the strokes read as table tennis (weight shift, torso rotation,
elbow leading, follow-through, wrist laid back on forehands; contact sheets in
`$TRACKBENCH_DATA/scenes/pp*/contact-sheet.jpg`). It is still keyframed motion: smoother and more
repeatable than a person's, the forearm twists as one piece from the elbow, the shoulder girdle
(clavicles) doesn't move, and fingers only curl (no spread). Close up, the grip is plausible but
the handle and fingers can intersect a little. MediaPipe's Hand Landmarker finds 93 % of the GT
hands on `pp1-base` (98 % in ready, 81 % mid-swing) with a median wrist error of 5 px at
1280x960, and Pose Lite finds the player in every frame (`checks/hand_check.py`,
`checks/mp_check.py`).

## Humans (`humans.py`)

- MPFB `deserialize_from_dict` builds each person with the `default` rig, high-poly eyes and
  the ENHANCED_SSS skin.
- Objects are renamed `P<k>.*` and tagged `tb_kind = "person"`, `tb_person = k`.
- Every material, and every node group inside it, is copied per person, and MPFB's originals
  are deleted. MPFB looks materials and groups up by name, so otherwise the second human got
  the first one's skin. The skin's diffuse texture is also set explicitly from the person's
  `.mhmat`.
- Subdivision is off for render and viewport: invisible at 640x480, and it cost ~0.9 s/frame
  with four people.

## Ground truth (`gt.py`)

**Keypoints.**
- Joint centres (11-16, 23-28) are bone heads of `upperarm01`, `lowerarm01`, `wrist`,
  `upperleg01`, `lowerleg01` and `foot`.
- The hand points (17-22) are knuckle joint centres: `finger5-1` (pinky MCP), `finger2-1`
  (index MCP) and `finger1-2` (thumb MCP). MediaPipe puts them there: on the solo sample Lite
  is 0.07-0.09 torso lengths from these and 0.15-0.19 from the fingertips (CONTRACT v1.1).
- Face and foot points are basemesh vertices. Their positions are computed every frame with
  the armature's linear blend skinning (the modifier isn't dual-quaternion), using the
  vertex's rest position with shape keys mixed in. This is exact for the unsubdivided mesh.

| pose-33 | vertex | where |
|---|---|---|
| 0 nose | 5054 | nose tip (most forward midline vertex of the head) |
| 1 / 4 eye inner | 6880 / 96 | inner corner (eyelid ring vertex nearest the midline) |
| 2 / 5 eye | 14607 / 14679 | front of the eye helper (pupil centre) |
| 3 / 6 eye outer | 6936 / 158 | outer corner |
| 7 / 8 ear | 12243 / 5646 | centre of the ear (vertex of the `ears` group nearest its centroid) |
| 9 / 10 mouth | 7302 / 561 | mouth corners (outermost `lips` vertex), left / right |
| 29 / 30 heel | 12453 / 5856 | back of the heel |
| 31 / 32 foot index | 11551 / 4933 | toe tip (most forward foot vertex) |

They were found geometrically on the rest basemesh (left = +x) and checked on zoomed renders.
The unused fingertip vertices are pinky 9171/2503, index 8595/1927 and thumb 9348/2680.

**Lens and rolling shutter.** Blender's projection is a pinhole; for hfov > 90° post adds barrel
distortion, and the `rolling_shutter` post operation shears rows. `render.py` then runs
`post/geometric_gt.py`, which keeps the pinhole GT and masks as `gt.pinhole.jsonl` and
`masks.pinhole/` and rewrites `gt.jsonl` and `masks/` through `degrade.distort_points` and
`distort_mask`: kp x/y moved (depth, `kp3d` and vis codes kept), vis 3 where a point leaves the
picture, `bbox` from the warped mask, `visible_frac` scaled by the share of the person's mask
pixels that stay in the picture, `in_frame` false if nothing of them is left. A point outside
the raw render stays 3 even if the lens pulls it into a corner (the picture there is replicated
border pixels). Post-only variants start from their base's pinhole GT/masks, so a rolling-
shutter variant of a pinhole base and a pinhole variant of an ultrawide base are both right.
Checked by overlay on `cam-fov-120` and `sens-rolling-shutter` (`preview.py` draws on
`frames/`, the camera picture, by default).

**2D projection** uses the scene camera's `view_frame` (sensor fit, shift and the final
resolution, so portrait frames are right). x, y are normalized to the full unmirrored frame
with (0, 0) at the top left. depth is the distance along the view axis. `kp3d` is stage
coordinates.

**Hands (table-tennis scenes).** Hand-21 points are pose-bone heads (`wrist`, `finger1-1..3`,
`finger2..5-1..3`) and the last finger bones' tails (tips), read from the evaluated rig. Their
vis codes use the joint rule below with each point's own bones (the bones meeting at that joint)
and a reach of 2-3.5 cm (6 cm for the wrist): another finger in front is 1. A paddle blade more
than 4 mm in front of a point is 2 (the 2 cm other-surface margin would miss a blade lying on the
fingers). The paddle's `center`/`normal` come from the prop's world matrix. `preview.py` draws
the hands (`--hands out.jpg`: close-ups of every hand, cut like the game cuts them) and the
paddle's normal; `checks/hand_check.py` runs the Hand Landmarker on those cuts against the GT;
`audit/check_gt.py <scene>` re-projects hand `kp3d`, checks hand vis against the masks and the
paddle against its hand.

**Visibility.**
- 3: outside the frame or behind the camera.
- Otherwise a ray from the camera centre to the point is cast against BVHs of:
  - the person's own body and clothes (evaluated, deformed; hair, eyes, brows and lashes are
    not occluders);
  - the other people;
  - the environment (one static world-space BVH; rebuilt per frame only if an environment
    object is animated).
- The first hit decides:
  - 2: another person or an environment/distractor surface more than 2 cm before the point.
  - Joint centres sit inside the body, so the ray always hits the person's own skin or clothes
    first. That counts as the joint's own surface (0) if the hit face's dominant deform bone is
    one of the joint's own bones and the face is within reach of the joint. Otherwise it's 1.

    | joints | reach |
    |---|---|
    | shoulders | 16 cm |
    | elbows | 9 cm |
    | wrists | 7 cm |
    | knuckles | 5 cm |
    | hips | 20 cm |
    | knees | 11 cm |
    | ankles | 9 cm |

    So an arm across the chest hides the far shoulder (1), and a loose skirt 15 cm in front
    of a knee hides it (1).
  - Surface points: any own surface more than 1.5 cm in front hides them (3 cm for ears,
    4-5 cm for heels/toes, which sit inside shoes) → 1.

Checked against the renderer's masks (`checks/vis_check.py`: vis 0 points must land on their
own mask, vis 2 points behind people on the occluder's). Also checked by eye on zoomed crops:
- profile faces (far eye, ear and mouth corner hollow, near side filled);
- feet behind a side table (red);
- the duo's crossing.

**Masks.**
- Every person material gets a shader AOV output: one-hot colour AOVs, three people per AOV.
- Each AOV goes through its own compositor File Output node to a half-float EXR (Blender 5.2's
  multilayer File Output writes only its first input). It's decoded per frame into
  `masks/NNNNNN.png`: value k+1 for `people[k]` where that person's coverage is ≥ 0.5 and the
  largest, else 0.
- The masks are exact, including alpha-blended hair and other people's clothes, and cost ~10 ms
  a frame.
- `bbox` is the mask's extent.
- `visible_frac` is the fraction of the person's unoccluded silhouette (rays through a ~90-row
  pixel grid over their projected box, hitting their own body and clothes) that the mask shows
  as theirs.
- `in_frame` is true if any silhouette sample or mask pixel is in the frame.
- People offstage are omitted from the frame's line.

## Speed (M5 Pro, 640x480, EEVEE, environment's 24 samples + motion blur)

| scene | render s/frame per process (3 running) | GT s/frame | wall s/frame, --jobs 3 |
|---|---|---|---|
| solo (1 person, 180 frames) | 0.65 | 0.055 | 0.26 |
| duo (2 people, 300 frames) | 0.84 | 0.066 | 0.32 |
| quad (4 people, 240 frames) | 0.99 | 0.059 | 0.38 |

A single process alone renders the quad at ~0.54 s/frame. Setup is about 1 s per human per
process. Motion blur (the environment's setting) is the largest remaining cost: ~0.35 s/frame
with four people. Subdivision used to be (see Humans).

## Known limitations

- Hair isn't an occluder in the ray test (its cards are alpha-textured), so ears under long
  hair count as visible. The masks do include hair.
- The procedural skirt is skinned, not simulated: it doesn't swing on spins.
- Finger poses aren't animated outside `pingpong` segments (AIST++ has no hand motion); hands
  stay relaxed.
- Gait is procedural: fine at webcam scale, but no mocap walk.
- (Fixed in generator 1.1: dark skins rendered lighter and colours washed out under the bright
  presets; see ENVIRONMENT.md, Lights and EEVEE.)
