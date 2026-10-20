# AeroDance pose binary format (`.adpose`), v1

> **Status: implemented.** The codec is `packages/pose/binary.ts`. It replaces the
> JSON skeletal formats listed below. Song, catalog, project and checksum
> metadata stay JSON. Where the implementation settles something this document
> left open, see [Implementation notes](#implementation-notes).

## Why

`client/public/songs/demo-track-1/choreography.json` is 12.4 MB for 30 s of
dance, 34× its audio. Most of that size comes from four things:

- **Keyed JSON objects.** Each landmark is spelled out as
  `{"x":…,"y":…,"z":…,"visibility":…,"presence":…}`, about 47 bytes of keys per
  joint.
- **Excess precision.** Values are written as float64 with 16–17 digits.
  MediaPipe outputs float32, and tracking noise is far coarser than that.
- **Stored interpolation.** The compiler resamples to a 30 Hz grid, so 897 of
  the 1,219 samples are `resampled` frames the player could recompute itself.
  Tested against the demo: the 322 frames that are not pure interpolation
  rebuild the rest with a maximum error of 2e-11.
- **Dense quality masks.** `landmarkOrigins` and `scoreEligible` take 1.7 MB.
  `scoreEligible` is derivable on every measured joint in the demo.

The same pose shape is also repeated across five JSON envelopes (protocol v2,
webcam record, video record, take, track, choreography, and the replay
recording). Each one is validated separately and carries per-session constants
on every frame.

This format uses one container for all of them, with fixed-size, quantized
frame records. The demo choreography comes to about **156 KB, roughly 80×
smaller** (see [Size](#size)).

## What it replaces

| Today (JSON) | Kind | Clock |
|---|---|---|
| `choreography.json` in song bundles (`aerodance.choreography` v1) | `choreography` | song |
| Studio `takes/<id>.json` (`aerodance.take` v1), `packages/character/assets/dance.json` | `take` | take |
| Studio track snapshots (`aerodance.track` v1) | `track` | take |
| Studio `capture/<id>/records.ndjson` (webcam/video envelopes) | `capture` | media |
| Game replay recordings (`aerodance.pose-recording` NDJSON) | `recording` | song |

Protocol v2 (`ProtocolPoseRecord`, the Android wire format) is retired along
with the Android client and gets no binary counterpart. Live webcam poses move
from the worker to the main thread as in-memory objects. They are only encoded
when recorded.

## Conventions

- All numbers are little-endian.
- `f64`/`f32` are IEEE 754 floats. `u8`…`u32` and `i16` are integers.
- `str` is a `u16` byte length followed by that many UTF-8 bytes, with no
  terminator.
- Times are `f64` milliseconds, the same values the code uses today. A frame
  time means whatever the header's `clock` says.
- Landmarks are MediaPipe pose-33: 33 joints in `JOINT_NAMES` order, image
  space, x right, y down, z away from the camera, depth relative to image
  width. Stored data is never mirrored.

## File layout

```
magic      8 bytes   0x89 'A' 'D' 'P' 'O' 'S' 'E' 0x0A
chunk*               until end of file
```

The 0x89 byte marks the file as binary, and the trailing `\n` catches
line-ending conversion, as in PNG.

Each chunk is:

```
tag        4 bytes   ASCII
length     u32       payload bytes, excluding padding
payload    length bytes
padding    0–7 zero bytes, so the next chunk starts on an 8-byte boundary
```

The magic and every chunk header are 8 bytes, and payloads are padded to 8
bytes. Every payload therefore starts 8-byte aligned, and frame data can be read
with typed-array views without copying.

**Unknown chunks.** An uppercase first letter in a tag (`HEAD`, `FRMS`) marks a
critical chunk. A reader that doesn't know a critical tag must reject the file.
A lowercase first letter (`prov`) marks an ancillary chunk, which unknown
readers skip.

**Truncation.** If a chunk's length runs past the end of the file, the file is
truncated. Validation rejects it. Capture recovery may instead drop that last
chunk and keep everything before it.

### Chunk order

1. `HEAD` comes first, exactly once.
2. Metadata chunks (`SONG`, `TRAK`, `MARK`, `CALF`, `prov`) come before the
   first `FRMS`.
3. `FRMS` and `EVNT` chunks follow. There may be any number of each. Their order
   in the file is their order in time, and readers concatenate the `FRMS`
   chunks.

This lets the Studio recorder append one `FRMS` chunk per upload batch, with
`EVNT` chunks between batches, and never rewrite earlier bytes. A finished
choreography normally has a single `FRMS` chunk.

## `HEAD`: required

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | u16 | `formatVersion` | `1` |
| 2 | u8 | `kind` | 1 `choreography`, 2 `take`, 3 `track`, 4 `capture`, 5 `recording` |
| 3 | u8 | `clock` | Meaning of frame time: 1 song, 2 take, 3 media |
| 4 | u8 | `playerSlots` | `1` to `4`; the number of pose slots per frame. Only a `recording` has more than `2` |
| 5 | u8 | `landmarkSet` | `1` = MediaPipe pose-33 (`landmarkCount` 33) |
| 6 | u8 | `flags` | bit 0: frames carry joint flags (see [Quality](#quality)); other bits 0 |
| 7 | u8 | `modelId` | 0 unknown, 1 `lite`, 2 `full`, 3 `heavy` |
| 8 | u16 | `inputWidth` | Capture frame size in pixels |
| 10 | u16 | `inputHeight` | |
| 12 | f32 | `positionStep` | Quantization step for positions; default `1/16384` |
| 16 | u8 | `extensionCount` | Number of extra per-frame clock fields |
| 17 | u8[] | `extensionIds` | `extensionCount` field IDs, in frame order |
| … | 0–7 bytes | padding | To an 8-byte boundary |
| … | f64[] | `extensionBases` | One base time in ms per extension field, in the same order |

`playerSlots` is the slot count, not the number of dancers present. A slot can
be empty in any frame. A `track` file has one slot; the player it holds is named
in `TRAK`. A game `recording` has one per player, up to four (three and four
players dance a duet's parts again; see
[three and four players](three-and-four-players.md)); every other kind is a duet
at most.

### Frame extension fields

These hold the extra clocks that raw captures and replay recordings keep as
timing evidence. Each one is an `i32` appended to every frame, in the order
`extensionIds` lists them. It stores microseconds relative to that field's base
in `HEAD.extensionBases`:

```
encode: q = round((valueMs − baseMs) × 1000)
decode: valueMs = baseMs + q / 1000
```

The writer sets each base to the field's value in the first frame. The `i32`
range then covers ±35.7 minutes from that first value, at 1 µs resolution,
which matches the precision the clocks have today. A value outside that range
is an encoding error, not a clamp. Webcam captures and replay recordings last
one song, and video captures don't use extension fields, so the range is not a
practical limit.

| ID | Field | Replaces |
|---|---|---|
| 1 | `frameBrowserTimeMs` | `WebcamRecord.frameBrowserTimeMs` |
| 2 | `resultBrowserTimeMs` | `WebcamRecord.resultBrowserTimeMs` |
| 3 | `receivedBrowserTimeMs` | `PoseEnvelope.receivedBrowserTimeMs` |
| 4 | `audioPositionAtFrameMs` | `PoseEnvelope.audioPositionAtFrameMs` |
| 5 | `audioPositionAtReceiptMs` | `PoseEnvelope.audioPositionAtReceiptMs` |
| 6 | `captureBrowserTimeMs` | Replay recording's `captureBrowserTimeMs` |

Every field has the same size, so readers skip IDs they don't know. Writers
must not repeat an ID.

`PoseEnvelope.audioPlaybackRate` is not a frame field.
`webcamTakeFromRecords` already rejects a capture whose rate changes, so it's
stored once, in [`CAPT`](#capt-required-for-capture).

## `FRMS`: frames

```
frameCount  u32
reserved    u32   0
frame[frameCount]
```

Every frame in a file has the same byte size, the stride. With `P` =
`playerSlots`, `J` = 33 and `E` = `extensionCount`:

| Offset | Type | Field |
|---|---|---|
| 0 | f64 | `timeMs` |
| 8 | u8 | `presentMask`: bit p set when slot p holds a pose |
| 9 | u8 | `reviewedMask`: bit p set when slot p's pose is reviewed |
| 10 | u8 | `frameFlags`: bit 0 = video timing by `seek-time` (clear = `decoded-frame`); other bits 0 |
| 11 | u8 | reserved, 0 |
| 12 | u32 | `seq`: source record sequence number, 0 when not applicable |
| 16 | i16[P][J][3] | positions x, y, z |
| … | u8[P][J] | confidence, `min(visibility, presence)` |
| … | u8[P][J] | joint flags, only when `HEAD.flags` bit 0 is set |
| … | i32[E] | extension fields |
| … | 0–7 bytes | padding to a multiple of 8 |

| Stride | No joint flags | With joint flags |
|---|---|---|
| 1 slot | 248 B | 280 B |
| 2 slots | 480 B | 544 B |

Extension fields add 4 B each before padding. A two-player webcam capture uses
fields 1–5, so its stride is 480 + 20 = 500, padded to 504 B.

**Absent poses.** When a slot's bit in `presentMask` is clear, its positions,
confidences and flags must be all zero, and readers ignore them. This keeps
indexing fixed, `((frame × P + slot) × J + joint)`, at the cost of 231 B per
absent pose (264 B with joint flags).

**Frame order.** Frame times must be finite and strictly increasing across all
`FRMS` chunks.

### Positions

`q = clamp(round(v / positionStep), -32767, 32767)` and `v = q × positionStep`.
The value `-32768` is reserved.

With the default step of `1/16384`:

- The range is ±2.0, in image-width units for x and z and image-height units
  for y.
- The resolution is 6.1e-5, about 0.04 px on a 640 px frame.

Real data spans −0.84 to 0.93 (the demo choreography and the menu `dance.json`).
Anything outside ±2 is a far-off-screen joint and is clamped.

### Confidence

Each joint stores one confidence, `c = min(visibility, presence)`. That's the
only form any consumer uses: the scorer, calibration, the live filter, the slot
picker and video import. Writers compute it from MediaPipe's two values. If
either one is null, `c` is null.

Values 0–254 encode `round(c × 254)`, so the decoded value is `q / 254`. The
value 255 encodes `null`, for unknown confidence.

The 0.5 threshold every caller uses encodes as exactly 127. Derived eligibility
(below) compares the quantized bytes, so encoding and decoding always agree. A
confidence just under 0.5, such as 0.499, rounds up to 127 and counts as
confident. That shift is accepted.

Decided: separate `visibility` and `presence` are not stored. Storing both
would cost 66 B per two-player frame (12%) for a distinction nothing uses. Two
things follow:

- The Pose Inspector shows a single "Confidence" readout.
- New recordings can no longer tell an occluded joint from an off-screen one. If
  scoring ever needs that, it requires a new format version.

### Quality

Joint flag byte:

| Bits | Meaning |
|---|---|
| 0–2 | Origin: 0 `measured`, 2 `edited`, 3 `gap-repaired`, 4 `missing-confidence`; 1 (`resampled`) is never stored |
| 3 | `scoreEligible` |
| 4–7 | Reserved, 0 |

If `HEAD.flags` bit 0 is **clear**, there are no joint flag bytes, and readers
derive quality exactly as `qualityFor` does today:

- The origin is `missing-confidence` when the confidence is null, and
  `measured` otherwise.
- `scoreEligible` = origin is `measured` and confidence ≥
  `SONG.confidenceThreshold` (or ≥ 127 when there is no `SONG`).

Writers set bit 0 only when some joint differs from that derivation, for
example after edits, gap repair or review. The demo choreography doesn't need
it.

`TRAK` exclusion intervals still clear eligibility at sample time without
changing the stored flags, as `sampleSong` does now.

### Interpolated frames are not stored

A `choreography` (and a `track`) stores only frames that hold at least one
non-`resampled` joint, plus the two endpoint anchors at `playableStartMs` and
`playableEndMs`. The sampler interpolates everything in between, as
`sampleSnapshot` already does.

A frame whose joints are all `resampled` is dropped only when interpolating its
kept neighbours reproduces it: positions within 1e-6, confidence within 1/508,
and the same origins, eligibility and `reviewed` flag. Otherwise it's kept. A
`resampled` frame at an edit-range boundary, such as the edge of a mirror or
swap, can't be rebuilt from its neighbours. The check makes dropping lossless
and idempotent, so encoding a decoded file gives the same bytes. A kept
`resampled` frame decodes as `measured`, because origin 1 is never stored. No
reader treats the two differently. Interpolated joints report origin `resampled`
and keep the current rules: kept origins propagate, and eligibility is the AND
of both neighbors.

As today, interpolation never bridges a gap longer than
`SONG.maxInterpolationGapMs` and never crosses an absent pose. The compiler's
30 Hz grid becomes an internal sampling detail and is not written out.
`targetRateHz` leaves the format.

## Metadata chunks

### `SONG`: required for `choreography`, otherwise not allowed

| Type | Field |
|---|---|
| str | `songId` |
| f64 | `durationMs` |
| f64 | `playableStartMs` |
| f64 | `playableEndMs` |
| u16 | `maxInterpolationGapMs`, from 1 to 200 |
| u8 | `confidenceThreshold`, quantized as confidence (127 = 0.5) |

The game still cross-checks `songId` and the three times against `song.json`.

### `TRAK`: one per slot; required for `choreography` and `track`

| Type | Field |
|---|---|
| u8 | `slot` |
| u8 | `playerId`: `0` or `1` |
| str | `label` |
| u8 | `calibrationProfile`: 0 none, 1 or 2 matching `profileVersion` |
| f32 ×6 | `torsoLength`, `baseHip.x`, `baseHip.y`, `baseHip.z`, `floorY`, `bodyTorsoLength` (NaN when absent) |
| u8 | `cameraScaleMode`: 0 none, 1 `body-relative` |
| u16 | `exclusionCount` |
| (f64, f64, str)[] | `startMs`, `endMs`, `reason` for each exclusion |

The calibration's input size is `HEAD.inputWidth`/`inputHeight`. In a
choreography, `TRAK` slot 0 must be player 0 and slot 1 must be player 1, the
same as the current "both tracks" rule.

### `MARK`: optional, `choreography` only

```
u16 count, then (f64 timeMs, u8 kind (0 beat, 1 phrase, 2 note), str label)[]
```

### `CALF`: video `take`/`capture` only

The frame the dancers were calibrated on (`CalibrationFrame`). It has the same
`frameCount` header and frame layout as `FRMS`, and `frameCount` must be 1. Its
time is `mediaTimeMs`.

### `CAPT`: required for `capture`

Per-session constants that every raw record repeats today:

| Type | Field | Replaces |
|---|---|---|
| u8 | `sourceKind`: 1 webcam, 2 video | `capture.json` `sourceKind` |
| str | `sessionId` | `sessionId` on every record |
| f64 | `audioPlaybackRate`, NaN for video | `audioPlaybackRate` on every envelope |

The model, input size and player count are in `HEAD`. The record `schema`,
`schemaVersion`, `type` and `timingMethod` strings go away: the file kind,
`sourceKind` and `frameFlags` bit 0 cover them.

A raw capture keeps every record exactly as received:

- One frame per pose record, in arrival order.
- Nothing is dropped, resampled or gap-filled. `takeFromRecords` still adds
  the 200 ms gap markers when it builds the take.
- `seq` is the record's own sequence number, so sequence gaps can still be
  counted.

The frame time is the record's `mediaTimeMs`. The other webcam clocks are
extension fields 1–5.

Two things that are in the JSON envelopes today are not kept:

- **Separate visibility and presence.** Captures follow the
  [Confidence](#confidence) decision and store only the minimum.
- **Float precision beyond quantization.** Positions are quantized, as in every
  other kind.

The capture file is still the original measurements, so the take can always be
rebuilt from it.

### `EVNT`: `capture` only

Capture lifecycle events, stored in the file order they happened between frame
batches:

| Type | Field |
|---|---|
| f64 | `receivedBrowserTimeMs` |
| f64 | `audioPositionAtReceiptMs` |
| u8 | `type`: 1 `audio-start-scheduled`, 2 `audio-stop`, 3 `source-stopped` |
| f64 ×3 | `audioContextStartTime`, `positionMs`, `rate` (NaN unless type 1) |
| str | `reason`, empty for none |

An `EVNT` payload is a `u16` count followed by that many events. The
`ordinal` counter in today's envelopes isn't stored, because chunk order plus
frame order already gives it.

### `prov`: optional

UTF-8 JSON with the free-form provenance (`TakeProvenance`,
`CompileProvenance`, the replay recording header). It's ancillary: the game
never needs it to play or score.

Decided: this is the one JSON island in the format, kept on purpose.
Provenance is open-ended and small (about 1 KB per source take), and only Studio
reads it. Studio's review checks read `synthetic`, `source`, `alignmentMethod`,
`durationMs`, `modelId` and `sourceRateHz` from it (`tools/choreography/core.ts`),
so the codec must keep it byte-for-byte when it round-trips a file.

## Per-kind requirements

| Kind | Clock | Slots | Required | Allowed | Extensions |
|---|---|---|---|---|---|
| `choreography` | song | 2 | `SONG`, `TRAK`×2, `FRMS` | `MARK`, `prov` | none |
| `take` | take | 1–2 | `FRMS` | `CALF`, `prov` | none |
| `track` | take | 1 | `TRAK`, `FRMS` | `prov` | none |
| `capture` (webcam) | media | 1–2 | `CAPT`, `FRMS` | `EVNT`, `prov` | 1–5 |
| `capture` (video) | media | 2 | `CAPT`, `FRMS` | `CALF`, `prov` | none |
| `recording` | song | 1–2 | `FRMS` | `prov` | 6 |

Take metadata that isn't skeletal stays in the Studio project's JSON: `takeId`,
`name`, `source`, `offsetMs`, `timeScale`, `createdAt`, `status`,
`interruptionReason` and `sha256`. The take's `.adpose` file holds only the
pose data and capture provenance. These fields live in each project's take
summary, which is Studio project format 3.

## Size

Demo choreography: 322 stored frames × 480 B, plus about 1 KB of metadata,
comes to about **156 KB**, down from 12,455,997 B (≈80×). For comparison,
gzipping the current JSON only reaches 3.7 MB. A 3-minute song at the demo's
~10 Hz capture rate needs about 0.9 MB.

A raw webcam capture of the same 30 s dance is about 318 records. As NDJSON
envelopes that's about 11.3 KB each, roughly 3.6 MB. In binary it's 318 × 504 B
≈ **160 KB (≈22×)**. Raw captures keep every measured frame, so they can't drop
interpolated frames the way choreography does. That's why the ratio is smaller.

Decided on compression:

- **No compression inside the format.** v1 stays uncompressed, so files load
  without copying, support random access, and can be appended to during
  capture.
- **Compress in transport.** `nginx.conf` serves `.adpose` as
  `application/octet-stream` with `gzip on` for that type. Studio ZIP backups
  already deflate their entries.

Positions dominate the remaining size. If long songs ever need it, a format v2
could delta-encode positions per joint and add a compression chunk flag.

## Reader API (`packages/pose/binary.ts`)

```ts
interface PoseFrames {
  kind: PoseFileKind; clock: 'song' | 'take' | 'media';
  playerSlots: 1 | 2 | 3 | 4; input: FrameSize; modelId: PoseModelId | null;
  times: Float64Array;          // [frame]
  present: Uint8Array;          // [frame] bitmask
  reviewed: Uint8Array;         // [frame] bitmask
  seq: Uint32Array;             // [frame]
  positions: Float32Array;      // [frame][slot][joint][xyz], dequantized once on load
  confidence: Uint8Array;       // [frame][slot][joint], raw bytes (255 = null)
  jointFlags: Uint8Array | null;
  extensions: Map<ExtensionId, Float64Array>;   // decoded to absolute ms
  capture?: { sourceKind: 'webcam' | 'video'; sessionId: string; audioPlaybackRate: number | null };
  song?: SongHeader; tracks?: TrackHeader[]; markers?: Marker[];
  calibrationFrame?: PoseFrames; events?: CaptureEvent[]; provenance?: unknown;
}
function decodePoseFile(bytes: Uint8Array): PoseFrames;   // validates; throws on bad input
function encodePoseFile(frames: PoseFrames): Uint8Array;
class PoseFileWriter { start(calibrationFrame?): Uint8Array; frames(inputs): Uint8Array; events(events): Uint8Array; }
```

- **Sampling over typed arrays.** `sampleFrames` (used by `sampleSong`) does a
  binary search on `times`, then a lerp over 99 floats per slot. No per-frame
  `structuredClone`.
- **Object adapter.** `framesToPoses(frames, i)` and `framesToSamples` return
  `Pose[]`/`PoseQuality[]` for the character, Studio UI and other object
  consumers. `Landmark` has a single `confidence` field.
- **Validation.** It's one pass over fixed-size records: check the header and
  sizes, then confirm times increase, absent slots are zero, and flag bytes are
  in range. Protocol v2 and its validator are gone. The JSON validators that
  remain only read files from earlier versions (see
  [Implementation notes](#implementation-notes)).
- **Limits.** The 16 KiB per-record cap goes away, since frame size is fixed by
  the header (at most 568 B). Readers still enforce a file-size limit (the
  existing bundle limits) and must check `frameCount × stride` against the
  chunk length before allocating.

## Migration

All five steps are done. A `song.json` with choreography schema 1 (JSON) still
loads for one release.

1. **Codec.** Add `packages/pose/binary.ts` with the encoder, decoder, writer,
   typed-array sampler and `Pose[]` adapter. Add round-trip tests against the
   demo choreography: positions within half a step, confidence within 1/508 of
   `min(visibility, presence)`, and every dropped grid frame reproduced by interpolation.
2. **Song bundles.** `song.json` gets
   `choreography: { path: "choreography.adpose", schemaVersion: 2 }`. The game
   loader accepts schema 1 (JSON) and 2 (binary) for one release, then drops 1.
   Studio's exporter writes 2. Convert `demo-track-1` and the test fixtures.
3. **Studio storage.** Takes, tracks and raw captures are stored as `.adpose`:
   `capture/<id>/capture.adpose` replaces `records.ndjson`, and
   `takes/<id>.adpose` replaces `takes/<id>.json`.
   - The recorder writes `HEAD`/`CAPT` when a capture starts. Each upload batch
     is then a run of `FRMS`/`EVNT` chunk bytes appended to the file, instead of
     JSON envelopes.
   - `takeFromRecords` reads the decoded capture.
   - `provenance.rawSha256` hashes the `.adpose` capture bytes.
   - Projects from earlier Studio versions are no longer opened or converted
     (they were converted on load at first; that support has been removed).
   - Project ZIP backups include the `.adpose` files.
4. **Menu dancers and replay.** Convert `packages/character/assets/dance.json`
   (3.1 MB) to a `take` file. `createPoseRecorder` writes a `recording` file
   instead of NDJSON.
5. **Cleanup.** Delete protocol v2 (`protocol.ts`, `NdjsonDecoder`) and the
   per-envelope validators once nothing reads them. Extend
   `tools/pose/migrate-legacy.ts` to convert any JSON format to `.adpose`.

## Implementation notes

Where the implementation settles details this document left open:

1. **Verified frame dropping.** Choreography and track files drop a
   `resampled`-only frame only when interpolation reproduces it (see
   [Interpolated frames](#interpolated-frames-are-not-stored)). The demo
   choreography is 154,832 B.
2. **Joint flags.** A writer compares each joint's flags with the derivation
   from its float confidence (`c ≥ threshold / 254`), not from the rounded byte.
   Edits, repairs and reviews set `HEAD.flags` bit 0, but the 0.499 → 127
   rounding alone doesn't. A reader derives quality from the byte, as
   [Confidence](#confidence) describes.
3. **Studio stores files, edits objects.** In memory, Studio's `Take`,
   `TrackData` and compiled timeline keep `Pose[]` samples, since the timeline,
   review and gap tools step through them. Storage encodes on write and decodes
   on read. A track snapshot is kept in memory in its stored form, quantized and
   with interpolable frames dropped. That way a reload compiles the same
   routine, and re-uploading a snapshot gives identical bytes for the
   immutability check.
4. **Project format 3 and captures.** Projects that hold `.adpose` takes and
   tracks are format 3. Studio doesn't open or convert projects in formats 1
   and 2. `capture/<id>/capture.json` stays JSON: name, model status, the
   capture header the recorder declared at start, and the take summary after
   finalizing. Each upload batch is the raw bytes of `FRMS`/`EVNT` chunks,
   checked against that header and stored as `batches/<n>.bin`. Retries must
   match byte for byte. Finalizing joins the header chunks (plus `CALF` for
   video) and the batches into `capture.adpose`, which `provenance.rawSha256`
   hashes. Old `records.ndjson` captures aren't read. Extension fields count µs from bases taken when the capture starts,
   so one capture can run about 35 minutes.
5. **Recordings.** The frame time is `songTimeMs`, rounded to 0.1 ms. Extension
   6 holds `captureBrowserTimeMs`. The source's timing method is constant for a
   session, so it goes in `prov` with `songId` and `recordedAt`. A frame at an
   already-recorded song time is dropped.
6. **Menu loop length.** A `take` file has no duration. The menu capture's
   `prov` records its 14 s loop as `durationMs`, as video takes record the
   video's duration. Without one, the loop ends one frame interval after the
   last frame.
7. **Readers of earlier formats.** Each one only converts:
   - `packages/pose/legacy.ts`: dance capture JSON.
   - `packages/pose/song.ts`: choreography schema 1, for one release.
   - Studio's JSON take import.
   - `tools/pose/migrate-legacy.ts`: converts any of these, and old NDJSON pose
     recordings, to `.adpose`.

   `packages/pose/webcamRecord.ts` stays, because it's the live webcam record
   type.

## Decisions

| Question | Decision |
|---|---|
| Provenance encoding | JSON in the ancillary `prov` chunk (see [`prov`](#prov-optional)) |
| Visibility and presence | One `min()` confidence byte per joint (see [Confidence](#confidence)) |
| Compression | None inside the format; HTTP compression when served (see [Size](#size)) |
| Raw captures | Kept alongside the takes derived from them, as compact `capture` files (see [`CAPT`](#capt-required-for-capture)). Takes stay immutable, and the raw timing evidence stays available for re-deriving alignment. |
