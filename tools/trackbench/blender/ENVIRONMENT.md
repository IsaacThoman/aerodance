# trackbench environments and webcam simulation

`environment.build_environment(spec, rng)` builds only environment/distractor objects;
`environment.render_settings(spec, scene)` configures EEVEE;
`camera.setup_camera(spec, scene)` creates the animated camera and sets final resolution/fps.
Call camera setup before building the environment, then render settings before rendering.
All created objects carry `tb_kind="environment"`, except person-shaped props and mirrors,
which carry `tb_kind="distractor"`. Existing `tb_kind="person"` objects are never modified.
Room, lighting, camera and post option names are validated; unknown options fail.

## Assets and reproduction

```sh
python3 tools/trackbench/blender/assets_fetch.py
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/trackbench/blender/env_gallery.py -- --props
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/trackbench/blender/env_gallery.py
/Volumes/development/aerodance-trackbench/.venv/bin/python tools/trackbench/post/gallery.py
/Volumes/development/aerodance-trackbench/.venv/bin/python tools/trackbench/blender/env_inspect.py
/Volumes/development/aerodance-trackbench/.venv/bin/python -m unittest discover -s tools/trackbench/post
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/trackbench/blender/env_test.py
```

`TRACKBENCH_DATA` defaults to `/Volumes/development/aerodance-trackbench`. No downloads,
images, caches, Blender projects or generated output belong in the repository.
The fetcher uses Poly Haven's public assets/files APIs, downloads only the 14 assets used by
the presets, selects 1K textures/HDRIs and native Blender model files, downloads their exact
texture dependencies, resumes `.part` downloads with curl, verifies file size and MD5, and
atomically replaces completed files. Repeated runs verify and reuse the cache (~60 MB).
The cache's `downloads/polyhaven/manifest.json` records URLs, hashes, sizes, authors and
CC0-1.0 licensing per asset. See [Poly Haven licensing](https://polyhaven.com/license).
There is no network access during scene generation: missing assets fail with the fetch command.

Assets: `sofa_03`, `modern_coffee_table_01`, `modern_wooden_cabinet`,
`wooden_bookshelf_worn`, `potted_plant_02`, `desk_lamp_arm_01`, `vintage_day_bed`,
`dining_table`, `wood_floor`, `white_plaster_02`, `concrete_floor`,
`patterned_plaster_wall`, `kiara_interior`, `residential_garden`.
Imported furniture is uniformly scaled by its bounding width, placed on the floor and retains
its PBR materials. Floors/walls use metre-space PBR mapping. Walls are plaster with subtle
texture, bevelled edges and skirting; ceilings are 2.6 m. Camera-facing walls are omitted so
normal 2.5–4 m camera distances remain usable. General rooms are 6.6 m wide and 7 m deep;
small room is 4.1 × 6.15 m; open plan extends to 10.5 m deep. The origin is the play-area
centre on the floor, not the centre of the room. Default rear wall is at y=2.5 m.

The people in TV/poster textures are rendered from the supplied clothed MPFB/AIST++ prototype;
`env_gallery.py -- --props` writes `downloads/trackbench-props/{people,poster}.png`.
These require the existing MakeHuman installation and a downloaded gJB AIST++ motion.
The generated textures use MakeHuman CC0 system assets and AIST++ CC BY 4.0 annotations;
credit AIST++ when distributing footage or textures. Props have no player GT identity.

## Rooms

| `room.preset` | Contents |
|---|---|
| `living_room` | Sofa, coffee table at the side, TV cabinet, shelf, plant, floor lamp, woven rug, framed abstract art, side window |
| `bedroom` | Wicker daybed, duvet and pillow, bedside cabinet/lamp, low storage unit |
| `plain_wall` | Plaster, wood floor, skirting; no furniture |
| `small_room` | Living-room furniture moved close to the dancer; rear wall at y=1.65 m |
| `dance_studio` | Wood floor and actual planar reflective mirror wall |
| `basement` | Concrete wall/floor, shelf, exposed utility pipes; use `dim_evening` for a dim basement |
| `open_plan` | Living area with kitchen cabinets/counter and dining table in a deep background |
| `backyard` | Concrete patio, potted plants and residential-garden outdoor HDRI |

`room.clutter` is 0–1 (default .5): it adds seeded stacks of books, and enables shelf/plant
at thresholds. Core furniture remains at zero. Architecture and furniture are intentionally
separate from light presets; any room can be tested under any light.

## Features

`room.features` is a list; features can be combined. They never add player instances.

| Feature | Implementation |
|---|---|
| `mirror_behind` | Metal/near-zero-roughness mirror, frame and EEVEE planar reflection probe, ray tracing enabled; reflects actual animated scene |
| `tv_with_people` | Framed emissive screen with a rendered clothed dancer |
| `poster_people` | Portrait-format print of a clothed dancer |
| `coat_rack` | Stand, hanging coats and sleeves tagged as distractors |
| `mannequin` | Static full MakeHuman body in an ivory material, tagged distractor |
| `window_behind` | Rear-wall opening, bright glass and mullions; no solid wall behind the opening |
| `doorway` | Real 1.5 m-wide, 2.2 m-high opening at x=.7–2.2 m, rear corridor beyond, suitable for bystanders |
| `patterned_wallpaper` | Poly Haven patterned plaster material across the room walls |

The studio automatically adds a mirror; `backlit_window` adds a window; `tv_glow` adds a
people screen. Very dense feature combinations may overlap furniture or wall decorations;
presets and individually tested features are the curated cases.

## Lights and EEVEE

| `lighting.preset` | Sources |
|---|---|
| `bright_even` | Two broad front/side lights plus interior HDRI ambient |
| `daylight_side` | Strong cool light from the left, weak fill |
| `backlit_window` | Large rear window source and very weak front fill |
| `dim_evening` | One low, warm source; dark corners |
| `ceiling_only` | Small overhead source and hard shadows |
| `tv_glow` | Dark ambient with a cool screen-area source |
| `party` | Red, blue and green sources moving continuously across the room |
| `flicker` | Broad sources modulated by a sampled sinusoid (11 Hz default) |
| `mixed_temp` | Cool side daylight plus a warm lamp on the opposite side |
| `overexposed` | Bright-even sources and +2.5 EV camera exposure |

`exposure_ev` adds to exposure; `color_temp_k` is 1000–15000 K and sets the primary light
colour (default per preset); with mixed/party/TV it shifts the colour balance while retaining
colour differences. `flicker_hz` overrides the flicker rate for any preset; zero disables it
except on the explicit `flicker` preset, where it selects the 11 Hz default. This is sampled
per frame, so exact mains frequencies can alias at 30 fps; use 11, 59 or 119 Hz to expose
beat effects. Row-dependent brightness banding is not simulated.

EEVEE uses 24 samples, the Standard (plain sRGB) view transform and physical shadows. The
camera's exposure is `exposure_ev` plus a per-preset offset standing in for a webcam's auto
exposure (`AUTO_EXPOSURE_EV`): −1 EV for `bright_even`, `daylight_side` and `mixed_temp`, 0
for `flicker` (its lights average about −0.9 EV of `bright_even`'s), 0 for `overexposed` (1 EV
over `bright_even`), and 0 for the dark presets (a webcam's gain is maxed out there; use the
`gain` post operation for its noise). Until 2026-11-01 (generator 1.0) it was AgX/Medium High
Contrast at 0 EV (+2.5 for `overexposed`): `bright_even`'s key light is ~2.6 m from the dancer
and ~5 m from the rear wall, so the dancer sat ~1.5 stops hot, and AgX's highlight
desaturation washed clothes out (a `#c03030` shirt rendered `#f48784`, salmon) and lightened
dark skin (cheek ~`#bd6c4f` on a texture averaging `#60382a`). At Standard/−1 EV the same shirt is
`#eb444e` and the cheek `#914d39`; frame means stay webcam-like (~120-125 of 255 in the
living room). Renders before and after aren't comparable: `spec_utils.GENERATOR_VERSION` is
part of the render key. Motion blur shutter is
.35 frame in ordinary light and .85 frame in dim-evening/TV light. Ray tracing is enabled
only for mirrors/studios, with a planar probe. Area lights have zero specular contribution
so the camera sees plausible reflections rather than unphysical giant lamp discs.

## Camera and ground truth

| Option | Meaning/default |
|---|---|
| `height_m` | Lens z, default 1 m |
| `distance_m` | Horizontal distance from look-at x/y, default 3.2 m, positive |
| `yaw_deg` | Orbit around look-at x/y; positive puts camera on stage-right |
| `look_at` | Stage target `[0,0,.95]` |
| `hfov_deg` | Final horizontal FOV, default 65°, supported 15–120° |
| `roll_deg` | Rotation around optical axis, default 0 |
| `orientation` | `landscape` or `portrait`; portrait swaps the supplied resolution |
| `shake` | Null or `{amp_deg, freq_hz}`; seeded smooth two-frequency rotational noise |
| `events` | `{type:"bump", t_s, yaw_deg?, pitch_deg?, roll_deg?}`; local rotation changes cumulatively and stays |

Camera starts at `(look_at.x + distance*sin(yaw), look_at.y - distance*cos(yaw), height)`.
Sensor fit is explicitly horizontal, including portrait. FPS supports fractional values via
`fps_base`. Dense animation samples interpolate linearly; the interval before a bump is held
constant so it cannot drift into the previous frame. Frame n is at `(n-1)/fps`.
Positive bump yaw pans right; positive pitch looks up. `yaw_deg` outside events is an orbit,
not a pan. There is no camera translation during shake/bump.

**Integration requirement:** Blender projection is the undistorted pinhole projection.
For FOV >90° post always adds barrel distortion, even when `post` is empty. GT must call:

```python
from post.degrade import distort_points, distort_mask
kp_xy = distort_points(kp_xy, spec, frame=frame_number)
instance_mask = distort_mask(instance_mask, spec, frame=frame_number)
```

Use the warped mask to compute bounding boxes and in-frame/visibility fields. Depth and 3D
points do not change. Extra columns passed in `distort_points` are preserved. Inputs may be
any NumPy-shaped array ending in xy (or xy + extra columns); filter null landmarks first.
Points are not clipped, allowing the caller to mark them outside the image. Mask sampling
uses nearest neighbours and preserves instance IDs; blur and compression do not change IDs.
Keep raw `render/` and raw `masks/` immutable when making post variants; regenerate GT xy,
bboxes and visibility from the original geometry/masks for the variant. A copied base GT
file is insufficient if geometric post options differ.

The lens model uses `k=.12*max(0,(hfov_deg-90)/30)`. In aspect-corrected image coordinates,
`q=(xy-.5)*[2,2*h/w]`, the forward mapping is `q' = q*(1+k)/(1+k*dot(q,q))`.
It fixes the centre and left/right midpoints, preserving horizontal FOV. RGB remapping uses
the analytic inverse and bilinear sampling. A small amount of corner coverage lies outside
the raw rectangular render: RGB replicates border pixels; masks use background there.
This is an explicit edge approximation, not a fisheye renderer or overscan model.
For strict border GT studies, render with extra coverage in a future generator version.

## Post-processing

```sh
/Volumes/development/aerodance-trackbench/.venv/bin/python tools/trackbench/post/degrade.py /path/to/scene
```

Reads resolved `spec.json`, processes `render/*.png`, writes `frames/NNNNNN.jpg` and
`post-meta.json` (retained frame numbers, source/output FPS, lens parameter and operations).
Old numbered JPEGs are removed on rerun so dropped frames cannot remain stale. PNGs/GT are
never modified. Operations run in list order. Randomness derives independently from spec
seed, original frame number and operation index; processing a subset does not shift noise.
Core pixel operations use only NumPy. Pillow handles PNG/JPEG codecs. Empty post produces
quality-95 JPEG with 4:2:0 chroma, after automatic lens distortion if required.

| `type` | Parameters/defaults and meaning |
|---|---|
| `noise` | `sigma:6`: Poisson shot + Gaussian read noise in linear space; sigma approximately linear 8-bit SD at 18% grey, split 80% shot/20% read variance |
| `gain` | `ev:-2, noise:8`: attenuate linear sensor exposure, add shot/read noise, subtract .003 black floor, amplify back; negative EV increases noisy/crushed shadow recovery |
| `jpeg` | `quality:40`, 1–100; actual JPEG roundtrip and 4:2:0 blocks, retained directly when last pixel op |
| `motion_blur` | `shutter_frac:.5`, 0–1; linear-light integration of current and adjacent renders; neighbours receive all preceding operations too |
| `defocus` | `radius_px:2`, 0–50; separable Gaussian PSF (radius parameter is sigma) |
| `white_balance` | `kelvin:3000`; RGB gains relative to 6500 K in linear light |
| `fps` | Required `fps`, >0 and ≤source fps; keeps first source frame in each target-time bucket |
| `downscale` | `factor:.5`, .01–1; antialias, downsample and restore original dimensions, matching webcam low-detail output; normalized GT stays valid |
| `vignette` | `strength:.4`, 0–1; radial linear-light attenuation |
| `auto_exposure` | `amplitude_ev:.6, period_s:4`; sinusoidal exposure breathing |
| `auto_white_balance` | `amplitude_k:1200, period_s:5`; sinusoidal colour-temperature breathing around 6500 K |
| `chroma_subsample` | No parameters; explicit half-resolution Cb/Cr and reconstruction |
| `rolling_shutter` | `strength_px:4, frequency_hz:2`; row-dependent horizontal shear with time-varying sign |

`fps` keeps original numbers (30→15 gives 1,3,5,…), not compact numbering. GT can keep all
source lines: consumers must join by frame number and use source timestamps, not array index.
Rolling shutter adds `strength_px/width * (y-.5) * sin(2*pi*frequency_hz*t)` to normalized x.
`distort_points` and `distort_mask` include it automatically, after the lens, in post order.

Temporal blur is a neighbouring-frame approximation and can produce ghost images rather
than continuous swept limbs. Prefer Blender's geometry motion blur for primary experiments.
Auto exposure/white balance are controlled deterministic drift, not feedback from image
histograms. Rolling shutter is a camera-shear approximation; it does not resample independently
moving limbs at different times. Noise is a generic model, not a calibrated webcam profile.
Masks remain geometric and do not try to label partially transparent temporal blur trails.

## Verification artifacts

All stills are under `/Volumes/development/aerodance-trackbench/gallery/environment/`:

- `<room>--{bright_even,daylight_side,dim_evening}/frames/000020.jpg`: every room × three lights.
- `light--<lighting>/frames/000020.jpg`: the other seven lighting presets.
- `feature--<feature>/frames/000020.jpg`: every feature in isolation.
- `camera--{low,near,distant,narrow,look_at,portrait,ultrawide,roll,high,shake,bump}/frames/000020.jpg`.
- `post--<type>/frames/000020.jpg`: each sensor operation (fps has a retained numbered frame).
- `contact-{1,2,3,4,5}.jpg`: room/lighting/feature/camera contact sheets.
- `contact-post.jpg`: sensor contact sheet.
- `render-report.json`: per-case first and second render wall times and asset metadata.
- `detection-report.json`: per-case MediaPipe Lite results and CPU inference times.

Gallery timings include PNG writing and pose evaluation, measured for two consecutive dancing
frames after environment setup. First render includes some shader/probe startup; second is the
warm measurement. A single clothed MPFB person is dancing the gJB AIST++ prototype, viewed from
behind at frame 20; these are still-image detection checks, not tracking success rates or
bystander-confusion tests. Model: `models/pose_landmarker_lite.task`, Tasks IMAGE mode,
`num_poses=4`, detection/presence thresholds .5. The game's usual 1/2-person budget can behave
differently. Inspect the full images, not only the contact-sheet thumbnails.

No shared contract fields were renamed or removed. Additive environment extensions are
recorded in CONTRACT.md’s change log: four extra post operations, `post-meta.json`, automatic
>90° lens warp, and the required geometric GT integration described above.

## Measured gallery results (2026-11-01, M5 Pro, Blender 5.2.3)

All 100 measured renders finished below 1 second, including PNG writing. Warm renders
ranged from 0.527 to 0.880 s; the slowest first render was 0.999 s. Room rows below
are warm seconds for bright-even / daylight-side / dim-evening; Lite detections are
listed in the same order.

| Room | Seconds/frame | Lite pose counts |
|---|---|---|
| living_room | 0.750 / 0.760 / 0.747 | 1 / 1 / 1 |
| bedroom | 0.578 / 0.585 / 0.598 | 1 / 1 / 1 |
| plain_wall | 0.569 / 0.571 / 0.527 | 1 / 1 / 1 |
| small_room | 0.758 / 0.827 / 0.789 | 1 / 1 / 1 |
| dance_studio | 0.772 / 0.729 / 0.691 | 1 / 1 / 1 |
| basement | 0.553 / 0.549 / 0.569 | 1 / 1 / 1 |
| open_plan | 0.746 / 0.769 / 0.880 | 1 / 1 / 1 |
| backyard | 0.612 / 0.607 / 0.577 | 1 / 1 / 1 |

| Other gallery case | Warm seconds/frame | Lite pose count |
|---|---|---|
| light--backlit_window | 0.765 | 1 |
| light--ceiling_only | 0.751 | 1 |
| light--tv_glow | 0.755 | 1 |
| light--party | 0.796 | 1 |
| light--flicker | 0.759 | 1 |
| light--mixed_temp | 0.772 | 1 |
| light--overexposed | 0.764 | 1 |
| feature--mirror_behind | 0.775 | 1 |
| feature--tv_with_people | 0.569 | 1 |
| feature--poster_people | 0.539 | 1 |
| feature--coat_rack | 0.531 | 1 |
| feature--mannequin | 0.666 | 1 |
| feature--window_behind | 0.530 | 1 |
| feature--doorway | 0.533 | 1 |
| feature--patterned_wallpaper | 0.534 | 1 |
| camera--low | 0.746 | 1 |
| camera--near | 0.765 | 1 |
| camera--distant | 0.759 | 1 |
| camera--narrow | 0.760 | 1 |
| camera--look_at | 0.751 | 1 |
| camera--portrait | 0.756 | 1 |
| camera--ultrawide | 0.772 | 0 |
| camera--roll | 0.772 | 1 |
| camera--high | 0.758 | 1 |
| camera--shake | 0.763 | 1 |
| camera--bump | 0.724 | 1 |

The single scene still with no pose was `camera--ultrawide` (120° FOV). All eight
features, including the mirror and mannequin, returned exactly one pose in the tested
still: they did not trigger an additional detection at this scale/pose. These results
do not establish failure rates over motion or the absence of distractor traps.

Sensor still detections: auto_exposure=1, auto_white_balance=1, chroma_subsample=1, defocus=1, downscale=1, fps=1, gain=1, jpeg=1, motion_blur=1, noise=1, rolling_shutter=1, vignette=1, white_balance=1.

All five scene contact sheets and the sensor contact sheet were opened and visually
inspected. Fixed during review: oversized mirror light discs, cabinet/shelf overlap,
undersized bed, and a side light incorrectly outside the small-room wall.

11 NumPy/core and CLI tests pass, plus Blender camera assertions for horizontal FOV in
both orientations, bump persistence, invalid options and mirror settings.
