# Rasputin pose cleanup validation

Validated on 2026-10-18 using the supplied `Just Dance 2 Rasputin.mp4`.
The source video and generated captures/overlays remain local; this document
records the reproducible configuration and findings.

- Source SHA-256: `36a181b00680a2297755861a19c29ca952cde366e4d5b5d5536b06f97364900c`
- Source: 1920 × 1080, AV1, 294.454 seconds, approximately 29.97 fps.
- Inference: MediaPipe Tasks Vision 1.1.0, Heavy, GPU, solo P1, target 30 Hz.
- Heavy model SHA-256: `64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b`
- Entire source processed: 8,824 distinct decoded frames.
- Cleanup v1: confidence threshold 0.5, maximum repair interval 200 ms,
  centered smoothing windows 120 ms XY and 180 ms Z.
- Metrics window: 25–278 seconds, excluding menus and outro.

## Results

| Measurement in reviewed window | Raw | Cleaned |
| --- | ---: | ---: |
| Present poses | 7,555 | 7,561 |
| Missing poses | 27 | 21 |
| 95th-percentile temporal deviation, torso lengths | 0.1614 | 0.0705 |
| 99th-percentile temporal deviation, torso lengths | 0.5299 | 0.1810 |
| Joint-frame deviations greater than 0.6 torso lengths | 693 | 85 |

Temporal deviation is the XY distance between a joint and time-weighted linear
interpolation of its neighboring frames, divided by median torso length. The
measurement includes shoulders, elbows, wrists, hips, knees, and ankles.
Large deviations decreased by 87.7%; the 99th percentile decreased by 65.9%.
These are temporal stability proxies, not labeled pose accuracy.

Across the full source, cleanup smoothed 243,449 joint samples, reconstructed
1,379 joint samples, and repaired six short pose gaps. It left 6,911 joint
samples and 23 pose gaps unresolved, including expected absence in menus/outro.
Checks passed for preserved timestamps, no removed detected poses, unchanged
measured confidence, and mandatory scoring review of reconstructed joints.

## Visual findings and limits

Targeted inspection covered 42 source frames with raw/cleaned overlays.

- Overlapping or hidden hands still produce incorrect low-confidence wrists
  around 28.562 s and 34.201 s. Unsupported long unreliable stretches remain
  available for manual review.
- Around 217.084 s, the detector flips anatomical left/right arm labels relative
  to adjacent frames. Pointwise reconstruction reduces the temporal spike but
  can still put a wrist away from the visible hand. Smoother geometry can remain
  incorrect.
- At 10.277 s, the detector tracks dancers in song-selection thumbnails. These
  are outside the intended choreography; use the actual dance's playable range.
- Normal poses and the low squat near 200.033 s remain recognizable in the
  reviewed overlays. No manually labeled joint ground truth was provided.

The original AV1 file was processed without transcoding. Chromium required
software video decoding; FFmpeg extracted review images because repeated browser
seeks failed. This validates solo capture and cleanup; separate duet regressions
cover continuous per-side recovery.

## Reproduce

Requires a Studio build, Playwright Chromium, FFmpeg, and the original local file:

```sh
npm run studio:build
VALIDATION_GPU=1 node tools/choreography/tests/video-quality.browser.ts \
  "/path/to/Just Dance 2 Rasputin.mp4" .cache/rasputin-validation --range=25:278
```

Omit `VALIDATION_GPU=1` for CPU inference. Add `--reuse` to regenerate metrics and
overlays from captures already saved in the output directory. The generated
`report.html`, `report.json`, `raw.adpose`, and `cleaned.adpose` are ignored local
artifacts. The cleaned take can be imported into Studio for further review.
