# How scores are calculated

This document describes scorer version 2 (`SCORER_VERSION` in
[`packages/score/scorer.ts`](../packages/score/scorer.ts)). Any change that would move
scores must bump that version; best scores are saved per version.

## In one paragraph

Every 100 ms of song time, each player's live pose is compared with the choreography
track of the dancer they follow (their cast: player 1 with track 0 and player 2 with track
1 unless they pick others, and players sharing a dancer are each compared with its track;
see [three and four players](three-and-four-players.md)). The comparison uses
the directions of their limbs as seen by the camera, plus how those limbs are moving.
The player gets the best match within ±150 ms of the beat, with a small penalty beyond
±50 ms. Each 100 ms interval is worth an equal share of 1,000,000 points. Every second
the intervals are grouped into a judgement (Perfect, Good, OK, Miss or Lost tracking),
which drives the pop-ups and the combo.

## Inputs

- **Reference.** The bundle's choreography, sampled with `sampleSong` (bounded
  interpolation, never across gaps over 200 ms). Joints the authoring tools marked
  ineligible (`quality.scoreEligible`) and the track's `unscorableIntervals` never count.
- **Live poses.** Every pose record from the pose source, placed at the song position
  that was audible when the camera captured it, not when the pose arrived:
  - Webcam: the browser time the video frame was observed (`frameBrowserTimeMs`).
  - The browser time then goes through the song player's audible clock (`songTimeAt`,
    from `AudioContext.getOutputTimestamp`, or `currentTime - outputLatency`).
- **Late arrivals.** Intervals are scored 750 ms behind the song (`LATE_ALLOWANCE_MS`),
  so poses delayed by camera buffering or pose tracking still count. The results wait for the same
  allowance after the song ends, as heard: the audio renders its end the output latency earlier
  (up to a second or two with AirPlay), and the song plays on until then.

## Features

[`packages/score/features.ts`](../packages/score/features.ts) turns a pose into unit
direction vectors, in image space corrected for aspect ratio, for ten limbs:

| Limb | Joints (MediaPipe pose-33) | Weight |
| --- | --- | --- |
| Upper arms, forearms (left and right) | 11-13, 13-15, 12-14, 14-16 | 1.0 each |
| Thighs, shins (left and right) | 23-25, 25-27, 24-26, 26-28 | 0.7 each |
| Torso | shoulder midpoint to hip midpoint | 0.6 |
| Shoulder line | 11-12 | 0.4 |

Directions don't depend on height, distance from the camera or where the player stands,
so no torso scaling or calibration is needed. Arms carry the most weight because they
carry most of the choreography and are tracked most reliably. A live joint counts unless its
confidence (min of visibility and presence) is below 0.1 (`MIN_CONFIDENCE` in `features.ts`),
compared in the recording format's quantised confidence steps so live and replayed poses count
the same joints. Version 1 dropped joints below 0.5. Untracked limbs score 0, and the tracker
is unsure of many joints that are in the right place, so 0.5 cost players points for tracking
rather than dancing. On trackbench's first 117 synthetic scenes, 0.1 alone cut MediaPipe Lite's
score lost to tracking from 14.2% to 9.4%, and no scene scored worse. With everything in this
branch, over 133 scenes, dancing the wrong moves scores about what it would with perfect
tracking (25.8% against 25.3%), and so does standing still (29.8% against 29.7%; a few points
more where the legs are off the picture) ([trackbench
report](../tools/trackbench/REPORT.md#scoring-unsure-joints-were-thrown-away)). Version 2 also
keeps a limb the tracker loses for a moment (below). Players compare directly with the stored,
unmirrored pose: the coach is only mirrored on screen
(`coachMode: "mirror-player"`), and dancing the mirror image loses points.

## One interval (100 ms)

For interval time `t`, the live directions at `t` (interpolated between samples up to
350 ms apart, or the nearest sample within 120 ms; a limb the tracker lost keeps its direction
from the last sample within 300 ms that had it) are compared with the reference at
`t + shift`, for shifts of 0, ±50, ±100 and ±150 ms:

- **Pose match.** For each reference limb, `exp(-(θ / 0.8)²)`, where θ is the angle in
  radians between the live and reference directions (15° → 0.90, 30° → 0.66,
  60° → 0.18). The weighted mean is taken over the reference limbs; a limb the player's
  camera can't see scores 0.
- **Movement match.** For reference limbs whose direction changed by at least 0.2
  (about 11°) over the previous 300 ms: `max(0, 1 - |Δlive - Δref| / |Δref|)`. Holding
  still while the coach moves scores 0 here. When moving limbs weigh at least 1, the
  interval score is 60% pose and 40% movement.
- **Timing.** Shifts beyond ±50 ms are multiplied down linearly, to 0.85 at ±150 ms.
  The best shifted score is kept, and its shift feeds the average timing offset
  (`meanOffsetMs`).

An interval is **scorable** when the reference shows at least half of the total limb
weight. This is decided from the reference alone, so missing live tracking never shrinks
the possible score. An interval where the player shows less than 30% of the reference's
limb weight is **lost**: it scores 0.

## Points, judgements and grades

- **Points.** Each scorable interval is worth `1,000,000 / scorable intervals`. Its
  share is `(score - 0.3) / (0.85 - 0.3)`, clamped to 0..1. That means 0.85 or better
  earns full points and 0.3 or less earns none. The total is rounded to a whole number.
- **Judgements.** Ten intervals make one judgement. Perfect needs a mean of 0.8 or more,
  Good 0.65, OK 0.45, and anything lower is a Miss. A second with at least 60% of its
  intervals lost is **Lost tracking**.
- **Combo.** Consecutive judgements other than Miss and Lost tracking.
- **Grade.** From accuracy (points earned out of 1,000,000): S 90%, A 80%, B 65%,
  C 50%, otherwise F.
- **Coverage.** The share of scored intervals where the player was tracked. Below 80%,
  the results screen says so.

## Evidence and limits

[`packages/score/tests/scorer.test.ts`](../packages/score/tests/scorer.test.ts) uses the
captured test routine's real tracking data. It checks these orderings. At 9 poses/s,
timing jitter 30 ms and seed 1 (except the frame-rate comparison), the scores rounded to 0.1% are:

| Attempt (both tracks) | Scorer v2 |
| --- | --- |
| Copying the routine exactly, at 5, 9 or 30 poses/s | 99.1–100%, S |
| 100 ms late | 98.9–99.5%, with the offset measured |
| 200 ms late | 83.2–94.7% |
| 400 ms late | 48.4–78.2% |
| Mirror image of the routine | 71.0–81.8% |
| Holding one pose throughout | 32.5–53.4% |
| Half the song out of view | 47.7–48.5% |
| Nobody in view | 0 |

The tests also check that frame rate, duplicate records and out-of-order delivery leave
the score unchanged, and that one-player mode scores player 1 exactly as two-player
mode does.

These numbers come from synthetic attempts built out of the reference itself. The
thresholds (σ, the points curve, the judgement cut-offs) have **not yet been tuned
against people dancing**: no human-labelled set of attempts exists yet, which is the
next step. Play with `?record` in the URL to download
each song's live poses as a recording. Replay one with
`?input=recording&recording=<url>`, and score a batch of recordings to compare against
human rankings. Timing allowances must never be tuned to raise scores.
