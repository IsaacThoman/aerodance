# Converting dance videos into expressive Aerodance songs

The process that produced the reviewed animation combines three kinds of work: an animator interprets the choreography and authors the large movements, filtered tracking supplies smaller variations, and explicit constraints preserve contacts and interactions. The result is baked into a character performance that the game plays alongside its human scoring choreography.

The artistic input is a movement score: what each dancer does, when the accents land, where they move, and which body parts carry the action. An agent creates this by inspecting the video and the rendered characters. Repeating the process for a new video requires a new movement score and visual review. Once those decisions, source files, settings, and code are saved, the bake can be reproduced.

**Implementation status at publication (2026-10-26):** the reference conversion used local extensions to [`tools/dance`](../tools/dance/README.md) that have not yet been merged into `dev`. Direct character performances, their shared sampler and character applier, and the optional performance bundle asset require those extensions. The `performance` op and native playback examples below will not work in a stock `dev` checkout. The tracking cleanup, movement generators, detail blending, and geometric validation are project-local scripts, rather than distributed tools. There is currently no general `dance convert` or `dance blend` command.

This is a record of the reviewed process and its implementation requirements. The general acquisition, human-pose editing, inspection, and export commands are available through the existing CLI. Replaying the complete native performance also requires the saved extension code, private helpers, artistic inputs, and media described below; this guide alone is not a runnable conversion pipeline.

## Keep three representations

Keep the reference video, the human choreography, and the character performance independently editable.

- **Reference:** immutable video, audio, raw detections, cleaned tracking, actor assignments, and their hashes. Tracking measures visible movement and supplies evidence for timing.
- **Human choreography:** `dancers[].layers`, contacts, body calibration, timing, styles, and scoring exclusions. The compiler exports these as `choreography.adpose`. These are the landmarks used by overlays and scoring.
- **Character performance:** `dancers[].performance`, containing direct poses of the body, head, two hands, and two feet. The compiler exports these as `performance.json`. These poses control the coach's appearance while a clip is active.

Native performance takes precedence over landmark retargeting. Its positions and proportions can be exaggerated without rewriting the scoring skeleton. Human-pose styles still affect the evaluated human choreography; native poses specify their own visible exaggeration. Decide explicitly which human styles and scoring exclusions a new conversion should use.

`check`, `compare`, and `score` inspect the human choreography. A good tracking score does not establish that a native character performance is readable, natural, or clear of the floor. Review and validate that performance separately.

In the reference implementation, the following files share the native performance across editing, preview, and playback. Paths for files not yet in `dev` are listed as code rather than repository links:

- `packages/pose/performance.ts` defines and validates native clips and compiles their curves for seeking and playback.
- `packages/character/performance.ts` applies them to the rig; [`Character.tsx`](../packages/character/Character.tsx) selects native or human-pose playback when extended.
- [`tools/dance/format.ts`](../tools/dance/format.ts) and [`ops.ts`](../tools/dance/ops.ts) store and edit clips atomically. The Studio and headless renderer sample the same performance.
- `tools/dance/performance.ts` maps dancer clocks to song time; the extended [`bundle.ts`](../tools/dance/bundle.ts) writes the performance asset and includes it in song identity and checksums.
- [`loadBundle.ts`](../apps/web/src/songs/loadBundle.ts) verifies the asset, and [`Dancers.tsx`](../packages/stages/shared/Dancers.tsx) samples it on the game's song clock.

## Capture the inputs and environment

Keep dance projects, footage, authoring scripts, previews, and evidence outside the repository. Save reusable game/tool code and general documentation in the repository. Record the source URL, downloaded file hash, dimensions, frame timestamps, model hash, dependency versions, code revision, and any uncommitted implementation changes needed to replay the result.

For a new video, a starting layout is:

```text
~/dances/new-dance/
  dance.json
  sources/
  authoring/
    movement-score.json
    author-motion.mjs
    authored-baseline.json
    detail-settings.json
    protected-ranges.json
    generated-patch.json
    validation/
    previews/
  .dance/revisions/
  .dance/exports/
```

For an online reference, download once and retain that file. These commands are an acquisition example; set the URL and metadata for the new source:

```sh
export DANCE_PROJECT="$HOME/dances/new-dance"
export DANCE_MEDIA="$HOME/dances/new-dance-media"
export DANCE_VIDEO_URL='SOURCE_URL'
mkdir -p "$DANCE_MEDIA"

yt-dlp -f 'bv[height<=1080]+ba/b[height<=1080]' \
  --merge-output-format mkv --remux-video mkv \
  -o "$DANCE_MEDIA/source.%(ext)s" "$DANCE_VIDEO_URL"

ffprobe -v error -show_streams -show_format "$DANCE_MEDIA/source.mkv"
node tools/dance/cli.ts init "$DANCE_PROJECT" \
  --video "$DANCE_MEDIA/source.mkv" --dancers 2 \
  --title 'Song title' --artist 'Artist'
```

The CLI copies and hashes sources, extracts audio unless configured otherwise, and can make a browser-playable proxy. Preserve full-resolution footage for reading small gestures. Use the proxy for responsive playback.

The reviewed conversion also used an optional Python environment with MediaPipe Heavy, NumPy, OpenCV, and librosa. The built-in `track` command uses the supported browser Lite model. Heavy inference was a separate local tool, not a hidden CLI model flag. Cache its detections and model bytes when reproducibility matters; a later inference run or dependency version can produce different landmarks.

## Establish timing and actor identity

Inspect audio onsets and several clear movement accents to choose BPM and beat offset. Verify alignment near the beginning, middle, and end. A single offset cannot correct tempo drift. Measure the final audio after any trimming or fades and set the song's declared duration and playable interval deliberately.

The clocks are related by:

```text
beatTimeMs(b) = beatOffsetMs + (b - 1) * 60000 / bpm
videoMs = (songMs - video.startMs) * video.rate
dancerMs = songMs - dancer.timeOffsetMs
```

Keys and performance clips live on each dancer's clock. Tracking lives on the video's clock. Export adds each dancer's offset to its performance. The reference helper scripts assume zero dancer offsets; adapt their sampling before using them with another clock arrangement.

Give dancers stable role IDs before authoring. Record the relationship between source tracking slots, project dancers, anatomical left/right, and the mirrored stage. A person keeps the same identity when crossing the picture or turning around. Screen position alone cannot provide that identity.

## Prepare tracking as usable reference

For straightforward footage, begin with the supported commands:

```sh
node tools/dance/cli.ts track "$DANCE_PROJECT" --fps 30
node tools/dance/cli.ts apply "$DANCE_PROJECT" \
  --op '{"op":"draft","dancer":"P1","smoothMs":40,"tolerance":0.004}' \
  --op '{"op":"draft","dancer":"P2","smoothMs":40,"tolerance":0.004}'
```

Drafting creates editable human keys and can fit body proportions. Review the result against the actual footage before treating it as a scoring reference.

Crowded footage required more work in the reference conversion:

1. Run offline Heavy detection on overlapping crops, with fresh detections rather than relying on one drifting video-mode track.
2. Convert crop coordinates back to the full picture, including scaling depth by crop width relative to frame width.
3. Collect candidates from additional crops guided by the first pass's body centres. The guide positions the search; it does not establish that a detection belongs to that actor.
4. Assign identities across time using appearance, confidence, continuity, and an explicit missing-person state. A sequence-wide assignment was more reliable than picking the nearest candidate independently in every frame.
5. Repair short left/right label flips, isolated jumps, and implausible skeletons. Fill only bounded gaps and retain uncertainty. Apply light smoothing within valid runs.
6. Import the cleaned track as a new immutable `.adpose` take and explicitly map its slots to dancer IDs.

The local scripts encoded costume colours, crop regions, aspect ratio, and motion assumptions for that footage. Those settings must change for another source. In particular, the cleanup rejected inverted skeletons because the observed routine did not include inversions; that rule would discard valid choreography in a routine with handstands or rolls.

Do not fill a long occlusion with an invented tracked action. The authored character performance can continue through the occlusion while the tracking contribution fades away. Review human scoring data and exclusions independently.

## Read the whole routine and write a movement score

Start the persistent GPU session through the repository's interactive workflow:

```sh
node scripts/play.ts start --dance "$DANCE_PROJECT"
```

Check the printed renderer. The reference run used ANGLE Metal on an Apple GPU. Software rendering changes the practicality of visual iteration substantially.

Survey the complete video in manageable contact sheets, then inspect difficult phrases at finer intervals:

```sh
node tools/dance/cli.ts frames "$DANCE_PROJECT" \
  --range 4s:24s --every 500 --views source --width 420 \
  --out "$DANCE_PROJECT/authoring/previews/source-survey.png"

node tools/dance/cli.ts frames "$DANCE_PROJECT" \
  --range b17:b25 --every 113.6 --views source --grid --width 650 \
  --out "$DANCE_PROJECT/authoring/previews/phrase-detail.png"
```

The second example assumes a beat grid has been set; choose the sampling interval for the actual tempo. A sheet holds at most 48 times. Read the PNGs, including frames between the main beats. Sampling only the same phase of a repeated step can make moving feet appear stationary.

For each phrase, record:

- Its start, end, musical accents, anticipation, and recovery.
- Each dancer's action and role, including asymmetry between them.
- The visible silhouette: diagonal reach, crossed hands, overhead circle, side kick, low passage, turn, or held pose.
- Stage travel, facing, depth order, and contacts.
- The body parts allowed to move and those that must stay steady.
- Variations in repeated sections and any interval that needs a protected custom solution.

The reviewed routine used 52 authored movement phrases plus a separately authored floor passage. It reused movement helpers for repeated actions, with timing and per-dancer variations supplied by the score. An agent still inspected the entire reference rather than assuming every repeated section was identical.

## Author the large movements directly

The glass character has a root and six visible parts. It has no visible elbows or knees. Communicate an action through hand and foot placement, body lean and travel, head placement, and silhouette. A copied human knee bend may need a clearer foot lift and weight shift to read on this character.

With the reference extensions installed, use native pose controls. Positions are absolute model-space part centres before coach reflection: x right, y up, z toward the camera. Neutral body pivot is `[0,1.1,0]`, head centre is `[0,2.7,0]`, and foot centres are around y `0.3`. Anatomical left is x positive when facing front. Body and head rotations are absolute XYZ degrees.

Moving the body alone does not carry independently positioned hands, feet, or head. Author coherent relationships explicitly. Let grounded feet remain planted while the torso shifts; carry the neck with the torso; let the head orient independently where the action calls for it. The hands and feet currently have position and scale controls, without independently authored rotation controls.

For a mirrored duet at the default spots, the displayed horizontal position is `spotX - nativeX`. Stage placement can also apply scale and rotation. Review actual stage output before assuming that a model-space path has the intended screen direction.

A small external generator can construct a complete pose and emit a supported op:

```js
const rest = neutralCharacterPose();
const reach = structuredClone(rest);
reach.leftHand = [1.25, 3.65, 0.60];
reach.rightHand = [0.25, 1.90, 0.85];
const patch = { ops: [{
  op: 'performance', dancer: 'P1', id: 'diagonal-reach',
  start: 'b17', end: 'b21',
  keys: [
    { t: 'b17', pose: rest },
    { t: 'b18', pose: reach, ease: 'sharp' },
    { t: 'b19', pose: reach, ease: 'stop' },
    { t: 'b21', pose: rest }
  ]
}] };
```

Import `neutralCharacterPose` from `packages/pose/performance.ts`, write the patch outside the repository, and apply it with the current revision guard:

```sh
node tools/dance/cli.ts apply "$DANCE_PROJECT" \
  "$DANCE_PROJECT/authoring/generated-patch.json" --expect-revision CURRENT_REVISION
```

Clips contain complete poses, have keys at both boundaries, and cannot overlap. They can share a boundary. Match position, orientation, and scale at that boundary. Equivalent Euler angles may differ by a full turn; compare orientations as quaternions and unwrap turns before interpolation.

Block distinct poses, then shape how they connect. Start a high reach early enough to arrive on the accent. Add holds where the source holds. Use `sharp` for an intentional hit and `stop` for a settle, rather than stopping every channel at every key. Short call-and-response passages and resets benefited from explicit intermediate hand paths. Freeze an unblended authored baseline before adding tracked detail.

## Add tracked secondary motion

The fully authored pass gave readable paths but looked mechanical. The final pass added smaller tracked motion around that baseline. It was generated from the saved baseline every time, so repeated runs did not accumulate offsets.

For a tracked feature `F(t)`, the local helper computed:

```text
filtered(t) = Gaussian55ms(median3(F))(t)
trend(t) = Gaussian340ms(filtered)(t)
detail(t) = filtered(t) - trend(t)
offset(t) = envelope(t) * confidence(t) * limit * tanh(gain * detail(t) / limit)
```

The Gaussian times are standard deviations, with kernels extending about three standard deviations each way. These are the tested tuning values for this conversion, rather than universal settings for every video.

Features included hip displacement, torso lean/pitch/twist, head motion relative to the torso, and wrist/ankle positions relative to the hips in a torso-aligned frame. Torso proportions normalized the tracked values into character units. Depth received a smaller contribution because it was less stable in the footage.

The tuned gains were hip shift `0.78`, bounce `0.85`, torso roll `0.70`, pitch `0.32`, yaw `0.28`, hands `0.55`, feet `0.22`, and head detail `0.20`. Component limits were `0.16` model units for hip shift/bounce, `9°` roll, `5°` pitch/yaw, `0.28` hand displacement, `0.10` foot displacement, and `2.4°` independent head detail. Combined displacement can exceed an individual component limit.

The helper also:

- Weighted each group by its least-confident contributing landmarks, using a smooth transition from confidence `0.30` to `0.85` and 90 ms confidence smoothing.
- Allowed tracking interpolation over gaps up to 150 ms. Missing-feature fallback faded with distance from a valid pose over 180 ms.
- Applied body rotation through quaternions. The neck followed the body; head orientation followed 60% of the body change plus independent detail. Hands followed 65% plus wrist detail.
- Applied foot detail only while the authored foot was airborne, fading it in above y `0.31` over `0.24` model units.
- Reduced detail to 20% during close turns and exchanges. It disabled detail entirely across the protected low interaction, including its approach and recovery, with 450 ms fades around the protected range.
- Baked the result on a 30 fps grid while retaining authored key times and exact boundaries.

These operations currently live in the conversion's private helper. A reusable implementation should take input paths, actor maps, time mappings, settings, interaction classes, and protected ranges as configuration. Copying the helper unchanged will also copy its assumptions about two dancers, zero offsets, the rig, and specific clip IDs.

## Solve contacts and multi-dancer staging explicitly

Apply contact and clearance constraints after adding detail. A low interaction needs a complete approach, hold, and recovery. Protecting only its middle leaves the surrounding motion able to disturb the result.

The final low passage required the approaching dancer to move behind the standing dancer, lower fully before advancing underneath, and keep the body directly behind the head along depth. The head stayed steady while the hands supplied the pounding rhythm. The standing dancer needed enough space beneath the body even at the extremes of side leans. The low dancer retreated behind the standing dancer before rising and stepping back to the normal spot.

The character's proportions required authored changes to height, spacing, and scale. Those choices were judged in the rendered duet. Two separated head centres did not establish that one head cleared the other dancer's torso.

For floor clearance, check the complete visible hand surface. The final helper used:

```text
handCentreY >= 0.33 * handScale + 0.10
```

The actual palm mesh extended about `0.330000057` units below its specified centre. With the current dancer group's `0.015` floor offset, the final sampled minimum surface clearance was approximately `0.115` model units. Remeasure for another rig or hand orientation. This is a baked authoring constraint, not a general runtime collision system.

Keep reviewed custom clips in the authored baseline. Regenerating the rest of the song should copy those clips and their shared boundary poses, including the approach and recovery. Assert that the protected outputs remain unchanged. The reference conversion added this protection to both the main authoring generator and the detail pass.

## Validate the geometry and the appearance

Use several complementary checks:

1. Validate schemas, finite values, clip ordering, full playable coverage, and matching boundaries. Check rotations as orientations, not just Euler numbers.
2. Verify that native edits leave the reviewed human layers, contacts, and scoring decisions intact.
3. Sample between keys and at key boundaries. Measure complete palm/foot surfaces, grounded-foot drift, unreasonable velocities, and constraints such as a steady head.
4. During interactions, inspect cross-dancer head/body and body/body bounds, including entry, side leans, and exit. Bounding boxes are a conservative clearance test; they are not a complete collision solver.
5. Read source/character comparisons and rendered motion. Review broad sections, dense samples around transitions, and the actual game stage at its normal camera and size.

For CPU checks on this skinned model, update it as the renderer does:

```js
applyPerformance(pose);
model.updateMatrixWorld(true);
for (const skeleton of uniqueSkeletons) skeleton.update();
mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
```

`SkinnedMesh.updateMatrixWorld` refreshes its inverse bind transform. Substituting a generic `updateWorldMatrix` traversal can skip that override and give incorrect bounds, especially beneath mirrored stage parents. Validate the validation code against known poses.

Some visual errors also required game support. Independent head/hand placement beneath a squashed and rotated body needed exact local matrices, including shear, to cancel the parent transform. Transparent rigidly skinned parts needed moving bounding-sphere centres so depth sorting followed the pose. Restoring ordinary retargeted playback after a native clip required restoring bone transforms. The reference extension implements and tests these changes in `packages/character/performance.ts` and `packages/character/tests/performance.test.ts`; the shared [skin bounds helper](../packages/character/skinBounds.ts) is already in `dev`.

The final review combined full-routine overviews, detailed motion sheets, short comparisons, stage frames, and loader checks. Each found a different class of problem. Earlier centre-height and head-only checks missed issues that the rendered sequence exposed. Geometric validity remains one acceptance condition alongside choreography, rhythm, readability, and the user's review.

## Render and export a pinned version

Render a short representative comparison before spending time on the full song:

```sh
node tools/dance/cli.ts render "$DANCE_PROJECT" --range b17:b33 --fps 30 \
  --views source,character --mirror --width 800 \
  --out "$DANCE_PROJECT/authoring/previews/phrase.mp4"

node tools/dance/cli.ts frames "$DANCE_PROJECT" --at b18,b22,b30 \
  --views stage --width 800 \
  --out "$DANCE_PROJECT/authoring/previews/stage.png"
```

Keep the project revision fixed while rendering. The current renderer caps a job at 3,600 frames, equivalent to 120 seconds at 30 fps. Split longer songs on exact frame boundaries, concatenate the video, and mux audio from the original source at the correct starting time. Check the joined duration, frame rate, dimensions, boundary frames, and audio alignment. The reference machine's FFmpeg lacked `drawtext`; comparison labels were rendered separately in a browser canvas.

Export and install with:

```sh
node tools/dance/cli.ts export "$DANCE_PROJECT" --install
```

The bundle contains metadata, audio, human choreography, optional native performance, and checksums. The song ID includes the audio and played/scored motion, including native performance. Installation replaces the folder this project previously installed. Keep these local media bundles out of git.

Load the exported result with the same catalog and bundle loader the game uses. Check that decoded performance equals the project's exported performance and that all required hashes verify. Then inspect playback through [`scripts/play.ts`](interactive-testing.md). The installed metadata and its checksums can change when exporting later; for deterministic motion verification, compare the performance and choreography rather than requiring a byte-identical ZIP with publication timestamps.

```sh
node scripts/play.ts stop
```

## What to retain and repeat

Retain the immutable sources and detections, model and environment versions, actor map, beat/video/dancer clock mappings, reviewed human choreography, movement score and generator, clean authored baseline, detail settings, protected clips, constraint code, final patch, validation reports, approved project snapshot, and final previews.

For the next video, reuse acquisition, inspection, project operations, curve evaluation, native posing, filtering, validation machinery, and export. Re-author the semantic score, actor-specific staging, contacts, and difficult interactions. Adapt appearance-based identity and cleanup assumptions to the new footage. Review repeated moves for variations and keep feedback as explicit constraints in the saved score.

The reference conversion demonstrated a repeatable authoring-and-baking method. Promoting the private helpers into a general tool would require extracting their hardcoded paths and choreography assumptions into configuration, versioning that configuration, and exposing the same constraints and protected ranges through the CLI or Studio. Preserve the reviewed result and its replay inputs while doing that extraction.
