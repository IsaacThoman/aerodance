# Menu performance investigation — 2026-10-24

Baseline: `780bc64` (`dev`). Scope: title menu, player selection with two/four dancers,
Settings, and the song list. Target: the first Apple TV 4K (A10X), retaining the existing
visuals. Hardware measurements used Peev, an Apple TV 4K (third generation, A15).

The changes reduce rendering and animation work without lowering resolution, density,
geometry detail, shader quality, blur taps, shadow quality, reflection refresh rate, or
animation cadence. **A consistent 2× end-to-end speedup and first-generation hardware
performance have not been established.**

## Where the work went

- **Spatial cells were also draw boundaries.** Grass, flowers, stems, tulips and lamps
  each drew separately per visible cell. Keep those exact cell bounds, but concatenate
  visible index/instance blocks into one draw per field/material. Only a change in the
  visible set repacks/uploads a buffer. Grass retains its original `gl_VertexID` values.
  An enclosing bound avoids per-cell tests once a whole field leaves the view.
  Lamps include all cells while rebuilding the cached shadow map; these fields remain
  excluded from lake reflections as before.
- **Frozen objects still had their world matrices multiplied.** The stationary scene's
  default local matrix update forced descendant world updates, including hidden shadow
  trees. Freeze the scene's local matrix and restore its setting on disposal. A nested
  lake capture reuses the outer render's already-current world matrices.
- **City batching expanded indexed geometry.** Retain authored vertices and indices,
  preserving normals, UV seams, materials and triangle order. Mixed inputs receive
  identity indices; no vertex welding or geometric approximation is used.
- **Every bubble reached the GPU.** Conservatively sphere-cull off-screen instances
  after advancing and sorting every bubble. Surviving bubbles retain their original
  positions and transparency order. A small bounding-sphere margin covers float rounding
  at clip edges.
- **Menu playback sampled both people and built unused quality metadata.** Retargeters
  now sample only their dancer into private reusable pose storage. Public samples still
  own their output. Fully hidden menu dancers suspend pose/effect callbacks.
- **The focus ring redrew static artwork 15 times a second.** Cache the overlay's
  content before the ring is drawn. Settled ring-only frames restore that native-size
  canvas and draw the same animated ring. Changing content and short rows, where the
  ring overlaps the artwork, keep the original combined rasterization to preserve
  antialiased edges. This adds one canvas per overlay, without another GPU pass.

## Paired background measurements

Both revisions ran in the **same Peev process**, using the same three.js renderer,
640×480 buffer, 16:9 camera, deterministic animation steps and independent world state.
Each view warmed up for 30 paired frames, then measured 120 pairs, alternating which
revision rendered first. The baseline world came from the revision above.

| Flight start | JS update/render, before → after | CPU speedup | Draws, before → after | Submitted triangles, before → after |
| --- | --- | --- | --- | --- |
| 0.08, meadow approach | 6.81 → 4.56 ms | 1.49× | 240 → 102 | 996k → 945k |
| 0.20, downtown | 8.09 → 6.31 ms | 1.28× | 154 → 118 | 1,213k → 1,105k |
| 0.70, broad countryside view | 8.55 → 5.50 ms | 1.55× | 337 → 107 | 1,891k → 1,805k |
| 0.90, meadow return | 6.47 → 4.04 ms | 1.60× | 230 → 91 | 1,395k → 1,277k |

Each paired render also finished with a one-pixel readback. Update/render plus that
completion wait fell from 17.27 → 16.05, 20.25 → 18.62, 26.79 → 20.43, and
18.06 → 15.26 ms respectively (about 7–24%). These are deliberately synchronized
diagnostics, **not normal FPS or isolated GPU timestamps**. They exclude dancers/UI
and do not imply a corresponding increase in the shipped game's capped FPS.

Separate launches showed substantial variation in a fixed numeric CPU reference loop
(0.96–1.61 s during exploration). Paired measurements avoid treating that variation
as an optimization gain. Full-screen comparisons should also repeat baseline/change
runs and record the reference loop, saved graphics preferences and exact screen state.

## Full menu measurements

The six-screen helper below used six seconds of settling and sixteen seconds per
scenario. Seven complete two-second windows remain after dropping each first partial
window. Both builds retained the device's saved **Full stats** setting and ran without
a phone connected. These are live flights, not locked identical camera frames.
The fixed CPU reference loop was 1.302 s before and 1.293 s after (less than 1% apart).

| Screen | Mean JS, before → after | FPS, before → after |
| --- | --- | --- |
| Title, idle | 7.95 → 6.28 ms | 60.0 → 59.8 |
| Title, keyboard focus | 9.69 → 8.36 ms | 58.2 → 59.8 |
| Players, two dancers | 12.80 → 8.27 ms | 53.1 → 60.0 |
| Players, four dancers | 16.97 → 12.81 ms | 47.6 → 57.6 |
| Settings | 6.43 → 5.87 ms | 60.0 → 60.0 |
| Song list | 16.47 → 7.65 ms | 44.5 → 45.6 |

These are the baseline run and the final run after whole-field rejection was added.
GPU/presentation variation remains significant: earlier optimized song-list runs measured
55–60 FPS. The final song-list run spent 21.55 ms on average in render-command replay,
including presentation blocking, despite only 7.65 ms of JS. CPU savings alone therefore
do not establish a fixed FPS uplift. The paired background measurements separate those
changes more reliably than comparing capped FPS across separate launches.

Changing the sky's draw order did not produce a reliable GPU win in a separate experiment;
the existing order is retained.

## Validation

- Ten deterministic background comparisons: starts 0.08, 0.20, 0.45, 0.70 and 0.90,
  in both 4:3 and 16:9, at 640×480 on Chromium/ANGLE Metal. **Zero differing RGB
  pixels** against the baseline; this includes lake/shadow rendering. Frames advance
  through the same 120 fixed 1/60-second steps before capture.
- Cell tests compare actual selected matrices, colors and indices with the previous
  cell meshes through moving camera frustums, empty/visible transitions, unchanged
  buffer versions and shadow rebuilding.
- City tests expand the result back into triangle order and compare all vertex
  attributes exactly, including mixed inputs and indices exceeding 65,535.
- Motion tests compare complete tracks, interpolation, seam blending, negative/looped
  time, seeks, missing slots/gaps, confidences, and resulting bone matrices exactly.
- The real UI hook was checked on GPU canvases: pressed controls and short settings
  rows retain exact pixels; a settled button performs no content redraws over 240
  animation frames. Its cached bitmap introduces at most 1.79/255 premultiplied-channel
  rounding in the sampled frames. These tiny canvas-copy differences are distinct from
  the pixel-identical 3D background comparisons.
- Browser flow checks exercise both display aspects, player changes and entrance/pop
  effects, settings, song selection, stage preview, calibration, scored ghost songs,
  pause/resume, results and returning to the menus.
- The first-generation Apple TV 4K simulator on tvOS 26 completed main → players →
  settings → song list using the full world. Its software renderer is a compatibility
  check; its frame rate does not represent A10X performance.

## Reproduce full menu measurements

```sh
npm ci
node scripts/tvos.ts build --game
node scripts/menu-bench.ts --device <udid> --label optimized
```

Build the baseline in a separate checkout at `780bc64`, retain its signed
`aerodance.app`, then use the **same** benchmark script and device:

```sh
node scripts/menu-bench.ts --device <udid> --label baseline --app /absolute/path/to/baseline/aerodance.app
```

The helper installs the supplied build and launches without a debugger/`--console`.
It measures idle/focused title, two/four players, Settings and the song list, preserving
saved preferences. `--host` overrides the Mac's detected LAN address. Use a development
permission build: `--release` excludes the local network access needed for reports.
`--sim <udid>` supports compatibility runs. Run `--help` for timing/output options.

Raw reports and summaries go under `.cache/menu-bench/<label>/`, outside git. Summaries
drop each mark's first partial window, check reported screen state and weight means by
frame count. Their `maxWindow*P95Ms` fields are the largest two-second-window p95,
not pooled percentiles. `execMs` includes command replay, CoreGraphics/driver work and
presentation blocking; it is not GPU time and must not be added to overlapping JS time.
`--profile` and `--gpu-timing` are diagnostic runs that perturb performance.

Use `node scripts/play.ts` for interactive inspection and screenshots. Keep raw evidence
in `.cache/`; the report and regression tests are the durable record.

The next hardware check is a physical first-generation Apple TV 4K. The A15 measurements
show reduced work but cannot certify 60 FPS, four-player performance or thermal behavior
on an A10X.

That hardware follow-up is now recorded in [A10X performance](a10x-performance.md),
including the native framebuffer-copy bottleneck and measurements of every stage.
