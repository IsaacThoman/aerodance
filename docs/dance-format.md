# Dance projects (`aerodance.dance`), v1

> **Status: implemented** in [`tools/dance`](../tools/dance/README.md). The CLI is documented in
> [dance-cli.md](dance-cli.md).

A dance project is the editable animation behind a song's choreography: the keys, curves, holds,
planted feet, phrases and timing an animator chose, and the video, audio and tracked poses they were
chosen against. The game never reads it. `dance export` compiles it into the game's sampled
[`.adpose` choreography](pose-binary-format.md), which can't be turned back into keys.

The Studio's capture projects ([`tools/choreography`](../tools/choreography/README.md), project
format 3) stay as they are: they hold recorded takes and corrections to them. A dance project holds
animation made from scratch or drafted from tracking, and both export the same song bundles.

## Why a new format

`.adpose` stores what to play: a pose every few dozen milliseconds. An animator works with intent
instead: "the left hand arrives here on beat 17 and holds for half a beat", "the right foot stays
planted from 4 s to 6 s", "shift this phrase 80 ms earlier", "the second dancer mirrors the first".
Sampled poses lose all of it, and they hold every joint independently, so moving a hand leaves its
forearm wherever it was. The dance format keeps the decisions and derives the poses from them.

## A project on disk

```
my-dance/
  dance.json                  the dance: the only file an edit changes
  sources/video.webm          the reference video (copied in, or referenced with --link)
  sources/proxy.webm          a browser-playable copy for the Studio, when the original may not play
  sources/audio.wav           the song audio
  sources/tracking-3fa9….adpose  poses tracked from the video (named by content)
  .dance/                     undo history, caches and renders; safe to delete (and git-ignored)
```

`dance.json` is plain, readable JSON, written one key per line so it diffs well. Edits through the
CLI or the Studio bump its `revision`, keep the previous revision for undo, and are rejected if they
were made against an older revision (see [Editing](dance-cli.md#editing)).

## Coordinates and units

Everything uses the game's coordinates, so tracked poses, keys and exported frames line up:

- **Positions** are MediaPipe image coordinates of `frame` (the video's pixel size): `x` from 0 at
  the left edge to 1 at the right, `y` from 0 at the top to 1 at the bottom, `z` away from the
  camera, in frame widths, with 0 at the hips. Stored data is never mirrored: **the dancer's left
  is image right** in a frontal video.
- **Lengths** (`body`) are in frame heights, measured with `x` scaled by the aspect
  (`width / height`), so a limb has the same length whichever way it points.
- **Angles** are degrees.
- **Times** are milliseconds. A dancer's keys, contacts and exclusions are on its own clock: song
  time minus its `timeOffsetMs`. Song-level times (playable range, phrases, markers) are song time.

## The rig

Each dancer is animated with 13 points and 4 angles (`format.ts` `POINTS`, `SCALARS`):

| Control | What it is |
|---|---|
| `head` | Between the ears |
| `leftShoulder`, `rightShoulder`, `leftHip`, `rightHip` | The torso |
| `leftElbow`, `rightElbow`, `leftKnee`, `rightKnee` | Mid joints (see below) |
| `leftWrist`, `rightWrist`, `leftAnkle`, `rightAnkle` | Hands and feet |
| `turn` | Body facing; positive turns toward the dancer's left (their right shoulder comes forward) |
| `headYaw`, `headPitch`, `headRoll` | Head turn (positive: to the dancer's left), tilt up, tilt toward the left shoulder |

These are the joints the scorer compares (shoulders, elbows, wrists, hips, knees, ankles; see
[scoring](scoring.md)) plus the head the character's head follows. The other 20 MediaPipe landmarks
are derived (`rig.ts`): the face from the head point and angles, the hand knuckles along the forearm,
the heel and toes from the ankle and the body's turn. Points without a keyed `z` take depth from the
`turn`: shoulders and hips rotate with it, and limbs follow their shoulder or hip.

Groups name sets of controls in ops: `all`, `body`, `headAngles`, `torso`, `shoulders`, `hips`,
`arms`, `leftArm`, `rightArm`, `legs`, `leftLeg`, `rightLeg`, `hands`, `feet`, `elbows`, `knees`.

## How a pose is evaluated

`evaluate.ts` turns a dancer's data into a pose at any time, the same way in the CLI, the Studio and
export:

1. **Base layer.** Shoulders, hips, wrists, ankles and the angles come from their keys. A control
   with no keys stays in the neutral stance (`neutralPose`) at the dancer's `home`.
2. **Additive layers** add their weighted offsets. A group offset such as `body` moves the group's
   shoulders, hips, wrists and ankles; the elbows, knees and head follow them.
3. **Contacts** plant a wrist or ankle where it was at the contact's start (or at `position`), easing
   on and off over `blendMs`.
4. **The head** rides on the shoulders: its keys are stored as absolute positions but interpolated
   as offsets from the shoulder midpoint, so moving the torso carries it. Without keys it sits a
   neck's length up the torso.
5. **Elbows and knees** are interpolated against their limb. At each key the joint is measured as
   two on-screen segment lengths and a bend side relative to the shoulder→wrist (hip→ankle) line,
   and those are interpolated, so a keyed elbow is exactly where it was keyed at its key and the arm
   stays whole while the wrist moves. Where the limb folds (wrist close to the shoulder) that line's
   direction is unstable, so the joint blends into a bone turning with the torso. Unkeyed, elbows
   and knees bend naturally from `body`'s lengths, partly on screen and partly toward the camera.
6. **Depths** without keys follow the `turn`.

### Curves

A key is `{ "t": ms, "v": value, "interp"?: …, "ease"?: … }`. Points are `[x, y]` or `[x, y, z]`;
angles are numbers.

- `interp` shapes the segment after the key: `smooth` (the default, a cubic), `linear`, or `hold`
  (a step at the next key).
- `ease` sets the velocity at the key: `auto` (the default) flows through it but goes flat at a
  turning point and never overshoots; `stop` settles into the key and leaves from rest; `sharp` hits
  it, arriving and leaving with each side's own velocity.
- Before its first key and after its last, a channel holds. The first and last keys start and end
  at rest, and so do keys next to a `hold`.

## `dance.json`

```jsonc
{
  "schema": "aerodance.dance", "schemaVersion": 1,
  "revision": 12, "createdAt": "…", "updatedAt": "…",
  "song": {
    "title": "Dare", "artist": "Gorillaz", "songwriters": [], "choreographers": [],
    "difficulty": "normal", "stage": "club", "tags": [], "description": "",
    "bpm": 120, "beatOffsetMs": 250,              // beat 1 is at 250 ms ("b1" in times)
    "durationMs": 63400, "playableStartMs": 9750, "playableEndMs": 15750
  },
  "frame": { "width": 640, "height": 360 },
  "sources": {
    "video": { "path": "sources/video.webm", "sha256": "…", "bytes": 2768908, "mimeType": "video/webm",
      "width": 640, "height": 360, "fps": 30, "durationMs": 63332,
      "startMs": 0, "rate": 1,                     // song time of the video's first frame; video ms per song ms
      "proxy": null },
    "audio": { "path": "sources/audio.wav", "sha256": "…", "bytes": 12172878, "mimeType": "audio/wav", "durationMs": 63400 },
    "tracking": [
      { "id": "t1", "path": "sources/tracking-3fa9c2e1b7d0.adpose", "sha256": "…", "bytes": 52184, "mimeType": "application/octet-stream",
        "model": "lite", "createdAt": "…", "fps": 30, "dancers": ["P1"] }   // the dancer each tracked slot follows
    ]
  },
  "dancers": [
    {
      "id": "P1", "label": "Dancer 1",
      "timeOffsetMs": 0,
      "home": [0.5, 0.53],                          // hip midpoint of the neutral stance
      "body": { "shoulderWidth": 0.13, "hipWidth": 0.07, "torso": 0.17, "neck": 0.07, "head": 0.06,
                "upperArm": 0.11, "forearm": 0.11, "thigh": 0.18, "shin": 0.12, "hand": 0.04, "foot": 0.1 },
      "calibration": null,                          // or { torsoLength, baseHip: [x, y, z], floorY } (see Export)
      "layers": [
        { "id": "base", "label": "Base", "mode": "absolute", "enabled": true, "weight": 1, "channels": {
          "leftWrist": [
            {"t": 10250, "v": [0.544, 0.5]},
            {"t": 10750, "v": [0.647, 0.405]},
            {"t": 11000, "v": [0.647, 0.405], "interp": "hold"}
          ],
          "headRoll": [{"t": 11750, "v": 10}]
        } },
        { "id": "fix", "label": "Fixes", "mode": "additive", "enabled": true, "weight": 1, "channels": {
          "body": [{"t": 4000, "v": [0, 0]}, {"t": 4150, "v": [0.01, 0]}, {"t": 4300, "v": [0, 0]}]
        } }
      ],
      "contacts": [ { "id": "c1", "control": "rightAnkle", "startMs": 10250, "endMs": 15250, "blendMs": 100, "position": null } ],
      "exclusions": [ { "id": "x1", "startMs": 2000, "endMs": 3000, "reason": "legs out of frame", "controls": ["legs"] } ]
    }
  ],
  "phrases": [ { "id": "ph1", "label": "Chorus", "startMs": 10250, "endMs": 15250, "dancer": null } ],
  "markers": [ { "id": "m1", "timeMs": 10250, "kind": "beat", "label": "" } ]
}
```

Validation (`format.ts` `assertDance`) names the first bad field: keys in strictly increasing time,
values of the right shape, layer 0 absolute and the rest additive, unique IDs, contacts on the same
control that don't overlap (their blends may), one to four dancers, a known stage.

Field notes:

- **`song.bpm`, `beatOffsetMs`** make beat times (`b17`) available everywhere a time is taken, and
  draw the beat grid in the Studio and on contact sheets.
- **`dancers[].layers`**: an additive layer's channels may be controls or point groups, and hold
  offsets rather than positions. `weight` scales them; `enabled: false` mutes the layer.
- **`dancers[].exclusions`**: with `controls: null` the whole dancer goes unscored over the
  interval; with controls, only their landmarks (e.g. `legs` while the legs are out of frame).
- **`sources.tracking`** files are `take` [.adpose](pose-binary-format.md) files on the video's clock,
  one pose slot per tracked person.

## Export

`compile.ts` evaluates every dancer on a 60 Hz grid, plus every key, contact and exclusion boundary,
over the playable range. It keeps a frame only where the game's straight-line interpolation between
the frames kept around it would be more than 0.0015 frame units off for any joint (about a pixel at
640 wide), and never leaves more than 150 ms between frames, because the game treats gaps over 200 ms
as missing poses. A 5-second phrase of quick arm moves keeps about 150 frames.

Every exported joint is marked `edited`, reviewed and eligible for scoring, except where an
exclusion says otherwise: whole-dancer exclusions become the track's unscored intervals, partial ones
clear the joints' eligibility flags.

Each track's calibration (how the game's character retargets the poses) is `dancers[].calibration`
when set, otherwise measured from the compiled poses: the median torso length and floor as
`calibratePoses` measures them, and the median hip position, so a dancer who travels stays centred on
their spot on stage.

`bundle.ts` writes the same song bundle Dance Studio exports (`song.json`, `choreography.adpose`, the
audio and `checksums.json`), with the song ID derived the same way from the audio and motion, and
checks it with the game's own catalog and choreography validators before writing it.

## Versioning

`schemaVersion` is 1. A change that older tools would misread gets a new version; tools reject
versions they don't know rather than guess.
