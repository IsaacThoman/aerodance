# First-generation Apple TV 4K performance — 2026-10-24

Measured on the paired physical AppleTV6,2 (A10X), tvOS 26.6. The game presents at a
maximum of 60 FPS; frame work below 16.7 ms provides headroom rather than displayed FPS
above 60. The render buffer remains 640×480, with the existing widescreen composition,
Full stats, shadows, bloom, reflection cadence, geometry, animation rates and 40-tap glass blur.

## Hardware results

All 24 final scenarios completed. Most stage screens average 59–60 FPS. The four-player
selection and song list, and Club gameplay, remain below 60; the target is not fully met.

| Menu screen | FPS before → after | Mean JS ms before → after |
| --- | --- | --- |
| Main, idle | 51.0 → 60.0 | 14.0 → 12.5 |
| Main, focused | 41.1 → 60.0 | 14.2 → 12.5 |
| Players, two dancers | 39.4 → 59.7 | 17.1 → 14.4 |
| Players, four dancers | 35.5 → 57.0 | 20.4 → 17.3 |
| Settings | 59.1 → 60.0 | 11.5 → 11.1 |
| Song list (2 → 4 players) | 55.4 → 58.3 | 15.2 → 16.8 |

Stage baseline uses two players; the final run uses four players, with the same duet
reference routine and an additional live mirror per player. Values below are mean FPS.

| Stage | Preview before → after | Gameplay before → after | Results before → after |
| --- | --- | --- | --- |
| sanctuary | 59.8 → 60.0 | 59.8 → 59.8 | 40.5 → 60.0 |
| reef | 40.1 → 60.0 | 59.8 → 59.6 | 40.1 → 59.8 |
| openreef | 59.9 → 60.0 | 60.0 → 59.8 | 39.8 → 59.8 |
| falls | 59.6 → 60.0 | 59.6 → 59.8 | 55.2 → 59.8 |
| club | 39.9 → 60.0 | 58.5 → 58.8 | 40.0 → 59.6 |
| beach | 60.0 → 60.0 | 60.0 → 59.9 | 59.4 → 60.0 |

Four-player selection averages 17.3 ms of JS per frame, and its song list 16.8 ms,
against a 16.7 ms frame budget. Club gameplay averages 58.8 FPS. Cold stage construction
and shader compilation still hitch. These short steady windows do not certify every
camera angle, first-load transitions or a long thermal soak. GPU duration was not isolated.

The native main-menu copy counter fell from about 10.6 ms before the blit change to
0.08 ms afterward. The CPU reference loop was 1.884–1.909 seconds across baseline runs
and 1.891 seconds in the final run.

## Changes

- Pose packets no longer set state on the entire React game tree. Song Select reads
  the latest source view in its existing frame loop; scoring, calibration, mirror
  poses and stats retain their direct source subscriptions/readers. Detected player
  slots still update on the next frame. This also applies to live camera input.
- A10X's `glCopyTexSubImage2D` blocks the render thread for roughly 10.6 ms while copying
  the drawable for glass UI. A private framebuffer lets a same-format GPU blit carry that
  dependency without stopping CPU command replay. The fast path covers only complete,
  in-bounds, level-zero RGBA8 texture copies from the non-MSAA drawable. Other copies use
  the existing implementation. Scissor, read/draw framebuffer bindings, texture binding
  and write masks retain their original state. The private framebuffer releases the
  texture attachment immediately after the blit.
- Character mesh parts share their identical bone palette within each cloned dancer.
  SkeletonUtils previously created a separate skeleton for every part. Independent
  dancers and different bone palettes remain independent. Unmounted dancers release
  their bone textures.
- Inactive accessories leave the scene graph until selected. Hiding them previously
  still updated 15 skinned mesh matrices and bind inverses per dancer, every frame.
  Selection restores the original parts and parents. The shipped mesh-local transforms
  are frozen; their world transforms still follow the rig. Pose placement updates the
  bone subtree and computes each shared parent inverse once, leaving mesh traversal to
  the renderer.
- The shipped rigid skin has one nonzero influence per vertex. Its main materials fetch
  that bone matrix once, retaining three.js's position/normal math; blended skins keep
  the general shader. Shadow materials retain their original shaders.
- Glass blur retains all 40 sample locations and weights. Its constant Vogel disk is
  evaluated once, with float intermediates, rather than doing trigonometry and
  exponentials in every fragment.

## Measurement

Baseline game source: `d2225fb`. Compared builds use the same file-report transport and
development song fixtures; final native reports additionally separate copy/presentation
CPU timings. Native frame reports are collected without a debugger.
Because this Mac's LAN receiver dropped connections, `--file-report` appends reports to
the app's cache and pulls them over the paired device connection every four seconds.

The stage fixtures copy the shipped 30-second demo routine onto all six stage IDs, with
validated choreography headers and regenerated checksums. They exercise the real song
preview, scored ghost gameplay, and results UI. They are generated only in a diagnostic
app bundle; a normal build removes them. Source songs remain unchanged.

Baseline menu/Sanctuary measurements used 12 seconds with four seconds of settling;
other baseline and all final measurements used ten seconds with three seconds of settling.
Each measurement discards the first two-second report after its mark and checks the
reported screen/stage/phase. Means are weighted by native frame count; interval means
use frames minus one. Reported p95 maxima are maxima of two-second windows, not pooled
percentiles. Native command replay includes GPU/display waits and overlaps JavaScript;
do not add the two timings or describe replay time as isolated GPU time.

These are live flights and separately launched runs, not paired identical camera frames.
The baseline combines three runs. Two were stopped after navigation-helper focus/pagination
issues, retaining only complete, state-matched marked windows; those helper issues were
fixed before the final complete run. Baseline stages use two players; final stages and
the final song list use four. Idle/focused main, player-selection and Settings samples
compare the same player counts. Small differences near the 60 FPS cap are not evidence
of a meaningful speedup.

## Validation

The 326-test suite, TypeScript checks for the game and tvOS runtime, production builds,
ESLint and whitespace checks pass. Six physical-device stage screenshots were captured
in unmarked gameplay windows, outside the measured samples.

- Native copy tests ran on the A10X with blits enabled and disabled. All 12 cases in
  each run matched every copied byte, with no GL errors, across three copy sizes,
  nonzero source origins, scissor on/off, partial-copy fallback, alpha values, and
  preserved bindings/write masks.
- Character tests compare every deformed vertex, bind transform and float bone palette
  against the previous clone implementation across all four shipped animation clips
  and four times per clip. Separate palettes and dancers are also tested.
- Accessories match the previous visible skins and deformed vertices through all five
  appearance selections and moving, mirrored, nonuniformly scaled parents. A further
  3,196 sampled poses compare every world matrix exactly with the baseline retargeter.
- Desktop GPU comparisons of the constant blur kernel cover 12 radius/pane-count
  combinations on a seeded noisy texture. Maximum channel difference is 1/255.
  Character GPU comparisons cover 48 clip/time/view combinations; tiny rounding
  differences occur in isolated pixels, while CPU deformation is exact.
- Browser checks cover two/four players, entrances, cast changes, preview, scored ghost
  gameplay, pause/resume, results, return navigation and both display aspects. Existing
  sampler-type warnings during stage precompilation also reproduce in the full baseline
  web build; they remain an existing browser limitation.

## Reproduce

```sh
node scripts/tvos.ts build --game --bench-scenes
node scripts/menu-bench.ts --device <udid> --label a10x --scenes --players 4 --file-report --seconds 10 --warmup 3
```

`--stages reef,club` limits a run to selected stages. Raw reports, signed comparison
bundles and screenshots stay under `.cache/`, outside git. `apps/tvos/bench/copyTest.ts`
is the native copy regression; launch `bench/copy-test.js` with `report: "file"`, with
`copyBlit` true and false, then inspect the `copy-test` result in
`Library/Caches/aerodance-bench.ndjson`.
