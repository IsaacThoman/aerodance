# Character

The glass dancer shared by the game, Dance Studio and the thumbnail renderer.

- `Character.tsx`: the character component.
- `retarget.ts`: `createPoseApplier`, one pose applier for recorded, edited and live poses.
- `skinBounds.ts`: keeps each glass part's bounding sphere on its bone, so the parts sort and cull where they are.
- `calibration.ts`, `liveCalibration.ts`: per-player body calibration for recorded and live (webcam) sessions.
- `livePoseFilter.ts`: display-only smoothing of live poses.
- `balloonPop.ts`: the character popping like a balloon, its skin tearing open, drawn in its own shaders (`Character`'s `popRef`). The menu dancers pop this way when a player leaves.
- `motion.ts`: playback of the silent menu capture (`assets/dance.adpose`), including the loop seam.
- `assets/aero-character.glb`: the model, with seven bones and four stock clips (Dance, Idle, Walk, Wave). `Character` plays a clip (`Idle` by default) only when it has no pose to apply.
- `assets/dance.adpose`: the two-dancer capture behind the menu dancers, results screen and thumbnails.
- `source/`: the editable Blender file and the deterministic generator that exports the GLB.

`npm test` covers the model (`tests/model.test.ts`) and capture playback and retargeting (`tests/motion.test.ts`).

## Retargeting

This is stylized camera-space 2.5D retargeting of MediaPipe's 33 landmarks, not calibrated 3D motion capture.

- Each actor has its own skeleton clone, so one character's pose never overwrites another's.
- A median torso length sets each actor's scale; the image aspect corrects horizontal coordinates.
- Hips drive lateral movement, bounce and depth (MediaPipe measures depth from the hips, so only authored poses step toward or away from the camera). Shoulders and hips drive the torso's lean (any way when their landmarks are confident, otherwise at most 37°), its tip toward the camera (from how short the torso looks against its calibrated length; never for body-relative calibration, whose scale comes from that same length), and its yaw, round to facing away when the shoulders cross over and the nose is behind the ears. Face landmarks drive head yaw, nod and tilt, wrists drive floating hand centers, and ankles drive the feet above a stage-height floor. The body rises to clear the floor however it turns. Bone-pivot offsets and parent transforms are accounted for.
- MediaPipe's relative depth is damped and clamped for stable hand and foot depth. There is no inferred room trajectory, finger animation, elbow/knee rig, or solved foot contact; the model only has a body, a detached head, two hands and two feet.
- The gel is blended without writing depth, so three.js draws its parts in the order of their bounding spheres. `skinBounds.ts` keeps each part's sphere on its bone, so a hand held in front of the body draws in front of it.
- Anatomical right maps to the asset's screen-left limb for a frontal recording.

## The menu capture (`assets/dance.adpose`)

A `take` pose file ([docs/pose-binary-format.md](../../docs/pose-binary-format.md)) of the two foreground dancers in the first 14 seconds of a supplied 1620×1080 video (SHA-256 `30e427b8185d7b4c80693007bbeca43e911f6c54520b7aabaf7f542d40389857`), 420 samples. It was tracked offline with MediaPipe Pose Landmarker Full, with geometric identity tracking between frames, interpolation of low-confidence joints, and Gaussian smoothing. The file keeps that provenance, plus the 14 s loop length as `durationMs`; joint confidence is unknown. The final 0.35 seconds crossfade into the first pose for a continuous loop.

To capture a new routine, import the video in Dance Studio (`tools/choreography`). The original Python tracker is in this repository's history: `git show 69ff74c:temp/frutiger-character/README.md` describes it, and its code is under `temp/frutiger-character/scripts/` at that commit.

## Rebuilding the model

With [Blender](https://www.blender.org/) installed, from the repository root:

```sh
npm run character:build
```

It regenerates `source/aero-character.blend` and exports `assets/aero-character.glb`. Run `npm test` afterwards; the model tests check the silhouette, skinning and clips.
