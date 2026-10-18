# Dance Studio

Static song/choreography editor for Aerodance. Projects autosave in the browser;
reference poses use the game's `{playerId, landmarks}` pose format. No backend,
account, or game database is needed.
See the [format/workflow reference](../../docs/song-dance-authoring-workflow.md).

## Run

From the repository root:

```sh
docker compose -f tools/choreography/compose.yaml up --build -d
```

Open **http://localhost:8082**. The container serves static files with nginx and
has no project data volume. Audio, takes, raw recorder batches and track snapshots
live in the browser's private filesystem (OPFS); project metadata, revision snapshots
and asset pointers live in IndexedDB. Metadata changes commit atomically after
asset writes finish. Web Locks serialize saves across tabs; revision conflicts
require reloading rather than overwriting another tab's edits.

Use **Backup** to download a portable project ZIP and import it on another device.
The footer shows estimated site storage usage and offers **Keep browser storage**
to request protection from automatic eviction. Browsers may decline that request.
Clearing site data removes projects even when persistence was granted. Private
browsing storage is temporary. Projects belong to the browser profile and origin
(scheme, hostname, and port); changing any of those does not move the library.
There is no automatic cloud sync. Quota failures preserve the last committed
project and report an error. Backup can download that saved revision even if
current edits cannot save; its message makes the omission explicit.

For local development:

```sh
npm ci
npm run studio:dev
```

Open http://localhost:5177. To check the production static build, run
`npm run studio:build`, then `npm run studio:start` and open http://localhost:8082.
Serve `tools/choreography/dist/` with any static HTTPS host. The game and Studio
can use separate domains; publishing a song remains an explicit export/install step.
The Studio needs HTTPS or localhost, IndexedDB, OPFS writable files, and Web Locks.
No API proxy or server environment variables are required.

### Migrate existing disk projects

Before replacing an older Studio deployment, use its **Backup** button for each
project, then import those ZIPs into the static Studio. Existing project formats 1
and 2 remain supported and are converted to format 3 on restore. Browser backups
also work with the legacy disk tool.
Docker/Podman named volumes from old versions remain on disk but are no longer
mounted by the static deployment; retain them until backups are verified.

For a disk workspace accessible on the host, export every project without starting
a server:

```sh
STUDIO_DATA_DIR=/path/to/old/studio-data npm run studio:backup-disk -- /path/to/backups
```

The command creates one project ZIP per project ID and refuses to overwrite existing
backups. Projects in formats 1 and 2 are backed up with their JSON files as stored. Import the ZIPs through **Import pose recording**. Unsupported future
project formats fail validation and remain untouched. The optional disk adapter
and HTTP harness are retained for migration and regression checks; they are not
part of the production image.

## Create a routine

1. Create a project, import music, and enter **Song details**. Duration is measured
   by the browser audio decoder. Set the real artist, authors/choreographers, the
   **Stage** the game shows the routine on (`openreef` by default), and
   distribution licenses or permissions.
2. Import a pose JSON, or start the webcam and **Record new take**.
   Choose a camera and **Lite / Full / Heavy**, then **Start camera**
   and allow permission. Recording stays disabled until the first pose result
   arrives, even if neither player is detected. You can start the countdown and
   then step into position. **Cancel connection** stops the wait. Set
   **Recording delay (seconds)** from 0 to 60 (default 3). A visible countdown
   gives you time to get into position before music and movement capture start.
   **Cancel countdown** stops the wait without adding a take. The mirrored setup preview labels the two camera-side
   slots. Camera/model preferences are remembered in this browser. Changes restart
   tracking; controls are locked during recording and countdown. Use HTTPS or
   localhost for camera access. Models run in a worker; the status shows GPU/CPU
   and measured pose cadence. Video stays local; recording saves pose records.
   Stand upright with shoulders, hips, and feet visible while body calibration
   collects 20 reliable frames per player. The preview compensates for changes in
   apparent body size when you step back, including the floor and hip anchor.
   Use **Recalibrate body** at your final dancing position if the starting stance
   was poor. This button is locked during recording. Webcam exports retain
   the same distance compensation for playback; older bundles retain
   their original calibration mode. This handles body size in the image, rather
   than correcting optical lens distortion.
   For a prerecorded video, choose **Import video**, select **Lite / Full / Heavy**,
   and scrub or play the source until you find an upright stance with shoulders,
   hips, and feet clearly visible. Choose **Use current frame for calibration**,
   then **Process video**. The selected frame calibrates every captured dancer;
   detected dancers remain visible in the calibration overlay even when their
   body confidence is too low. Each label explains whether that dancer is ready
   or needs a clearer frame; processing requires every shown dancer to be ready.
   if another dancer appears later, choose a frame containing both and **Save take**
   without processing the poses again. Detection uses the webcam's two left/right
   regions. The importer creates a new library take; use its menu to assign tracks.
   Inference runs locally and waits for each sampled frame, up to 30 samples/second.
   When whole-frame inference misses a dancer, the importer searches that side
   more closely, including the body area in portrait footage. Recovered poses
   retain the original video coordinates and the selected model.
   Slow models take longer rather than losing samples. Progress and **Cancel import**
   are available. MP4, WebM, MOV, and other formats work when the browser supports
   their codecs; videos must be no longer than one hour. Song audio stays unchanged,
   and video timestamps start at song time zero; adjust alignment with track offsets.
   Source footage is available only while the import panel is open. Saved projects
   and backups retain poses, model provenance, and the selected calibration, including
   after track edits or deleting the library take.
3. Scrub the waveform, step samples, or play at 0.25/0.5/1 speed. Switch between
   Skeleton, Frutiger, and Both. The two preview characters have independent rigs.
   Choose **Live view** to preview webcam poses without recording or importing
   music. Start the camera in the capture panel first, then step into view. Live
   poses are read-only in all three display modes; music can play for rehearsal.
   Choose **Playback** to return to the timeline and edit the routine. Recording
   automatically uses the live preview.
4. Select a player/joint and drag it in Skeleton/Both, or type XYZ. Choose a
   **Point group** to move the head, either hand, both hands, either foot, both feet, or the whole skeleton
   together by dragging any highlighted point. Each group move is one undo step. Confidence is
   read-only. A joint keyframe blends over 150 ms on either side. Undo/redo preserves
   the source take. Drag the selection start/end handles on the waveform to select a timeline
   range (arrow keys adjust a focused handle) to swap tracks, mirror, smooth, repair
   a short gap, approve references, or exclude reference scoring.
5. Select a take to open **Take view**, a read-only preview immediately before
   **Live view**. Scrub, step, and play the take without changing the routine.
   Take playback also works without music. A completed recording opens its new
   take automatically. Imports and recordings remain in the library until assigned.
   Open its **⋯** menu and choose **Overwrite P1 track**, **Overwrite P2 track**, or
   **Overwrite both tracks**. Each action copies the corresponding source player
   into independent track storage and uses the take's original audio alignment;
   it replaces the entire destination track, including its edits.
   Adjust each track's **Offset (seconds)** independently in Playback. Positive
   offsets delay poses; negative offsets advance them. Poses before song time zero
   are omitted from playback/export but retained for later realignment. Track
   offsets, edits, overwrite, clear, and interpolation support undo/redo.
6. Check music/pose alignment near both ends, set the playable range if needed,
   then confirm alignment in Song details. Review references and missing intervals
   in **Review**. Approvals require a reason; exclusions always override approvals.
7. **Export song** downloads a deterministic runtime ZIP containing song.json,
   choreography.adpose, audio, and checksums. Export rejects unresolved metadata,
   timing review, long missing references, rights, and empty score coverage.

Changes autosave after a short idle interval. **Save** forces persistence.
This editor uses project format 3 and migrates format 1 and 2 projects when opened.
Saved projects in unsupported formats are
reported and skipped at startup; the next compatible project opens instead.
If none can be opened, **Create new project** starts a separate project. Incompatible
projects stay in browser storage and require an editor that supports their project format.
Project format versions are separate from the supported character calibration
profiles 1 and 2.
Revision conflicts report an error; reloading fetches the saved project instead
of silently overwriting it. Upload/capture errors show in the message bar. Hidden
tabs and lost pose connections interrupt recording; acknowledged source data
stays in browser storage. Failed captures retain their acknowledged batches until
the project is deleted; do not clear site data to recover from a recording error.

The committed capture at
`packages/character/assets/dance.json` is useful for trying the
editor. It has no per-joint confidence, so review/approve its reference poses
explicitly before publication. It has no music.

**Interpolate P1/P2 missing intervals** fills every bounded gap on that player
track, including gaps longer than one second. It preserves available poses and
linearly interpolates missing XYZ coordinates at 30 Hz. Missing beginnings and
endings remain unchanged because they lack two endpoints. Generated poses have
unknown confidence and scoring remains disabled until explicitly approved.
The existing **Repair short gap** action still repairs a selected range within
one second. Interpolation does not modify the library take.

All deletion actions ask for confirmation. **Delete P1/P2 track** clears only that
track and resets its offset; it is undoable. **Delete** in a take's menu removes
that take and its raw capture while preserving assigned track poses and their
source provenance. **Delete project/song** permanently removes the whole routine,
including audio, tracks, takes, capture files, and revisions. It opens another
project, or a blank project when the library is empty. Deleting a project or a take
cannot be undone; use **Backup** before deleting material you want to retain.

### Project storage

Project format 3 stores pose data as `.adpose` files (see
[docs/pose-binary-format.md](../../docs/pose-binary-format.md)); project, capture
and revision metadata stay JSON:

| Path | Contents |
|---|---|
| `project.json`, `revisions/<n>.json` | The project; each take's summary holds its name, source, alignment, model status and file hash |
| `takes/<takeId>.adpose` | A library take (`take` file); immutable |
| `tracks/<dataId>.adpose` | An immutable track snapshot (`track` file); frames that interpolation reproduces are dropped |
| `capture/<takeId>/capture.json` | Capture name, model status and file header; `sealed` marks it finalized |
| `capture/<takeId>/batches/<n>.bin` | Acknowledged upload batches (`FRMS`/`EVNT` chunks) until the capture is finalized |
| `capture/<takeId>/capture.adpose` | The raw capture the take was built from (`capture` file); `provenance.rawSha256` hashes it |
| `assets/<sha256>.<ext>` | Song audio |

Snapshots are kept as stored, quantized to 1/16384 of the frame, so an edited
routine compiles the same after a reload. Backups include snapshots required by
current tracks and edit history, so they still restore after source takes are
deleted. Format 1 and 2 projects are converted when opened, and old backups on
restore: JSON takes and snapshots become `.adpose` files, and raw `records.ndjson`
captures become `capture.adpose` (captures that can't be converted, such as
Android ones, stay NDJSON). Their takes keep the `rawSha256` of the original NDJSON.
Migrating a format 1 project's clip tracks to snapshots preserves the current
routine, review masks, original comparison poses, and pre-zero data; it starts a
fresh edit history.

The Frutiger rig is stylized 2.5D; elbows/knees remain editable in the
skeleton even though the character has no articulated elbow/knee bones.
The character uses the original wrist and foot mapping. Live Frutiger previews
smooth landmark movement and distance estimates for display; skeletons, saved
takes, edits, and recorded playback use their original coordinates. Distance
compensation uses the torso's image size so noisy inferred depth cannot resize
the whole character. Recalibrate after choosing your dancing position.

## Install a song in the game

Extract the song ZIP **into** `client/public/songs/`. The archive already contains
`<songId>/`, so the result should be `client/public/songs/<songId>/song.json`, with
choreography, audio, and checksums beside it. The folder name must match the
exported `songId`. No manual manifest entry is needed.

The game discovers exported folders automatically. In development and the
production Express server, the catalog is scanned whenever Song Select opens.
Reopen Song Select after installing or replacing a song. Incomplete or invalid
bundles are skipped with a server/build warning; the game still verifies all
runtime file checksums when loading a selected song.

`npm run build` generates `dist/songs/manifest.json` for static hosting and copies
the song folders. Rebuild/redeploy after changing `client/public/songs/` for a
deployed game. On a running Express deployment, complete folders added directly
to `dist/songs/` are detected without a rebuild or server restart. Container
installations need those files inside the container, through a rebuilt image or
a mounted songs directory.

Re-exporting a song preserves its song ID and updates its bundle revision.
Replace its complete folder; discovery reads the new revision from `song.json`.
The runtime bundle contains both tracks; one-player mode selects track 0. Editor
export does not deploy or publish automatically. The game owns character assets.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run studio:test
npm run studio:build
npm run build
node tools/choreography/tests/browser-storage.browser.ts
node tools/choreography/tests/browser.ts
node tools/choreography/tests/video-import.browser.ts
node tools/choreography/tests/video-duet.browser.ts
node tools/choreography/tests/project-loading.browser.ts
docker build -f tools/choreography/Dockerfile --target test -t studio-test .
docker build -f tools/choreography/Dockerfile --target ui-test -t studio-browser-test .
docker run --rm studio-browser-test
```

The browser test uses a real decoded WAV, imports the committed take, edits a
joint, checks undo/redo, reviews both tracks, saves/reopens, plays music, exports
a ZIP, renders Frutiger characters, and checks mobile layout. Shared workspace/compiler tests
cover missing tracking, capture discontinuities, revision conflicts, idempotent
batches, backup restore, deterministic bundle checksums, and unsafe archives.

## Current limits

- Webcam capture uses browser frame observations and an audio-clock anchor,
  preserving video frame intervals through variable inference delays. Camera
  buffering and audio output delay remain uncalibrated; review start/end alignment.
  Takes retain model/hash, runtime version, delegate, timing method, and cadence.
  Webcam fixtures cover Chromium runtime/capture integration; real duet accuracy,
  hardware performance, and Safari/Firefox/mobile compatibility need manual checks.

- Takes captured by earlier editor versions still open, compile, and export; the
  take list shows them as **legacy capture**. Raw NDJSON pose streams can no
  longer be imported or recorded.
- The editor imports `.adpose` takes and song choreography, legacy JSON, its
  own project backups, and browser-decodable videos. Video import runs the same local models as the webcam; the optional
  Python tracker remains an offline tool.
- Automatic normalization of different camera placements, articulated IK, and
  curve/clip transition controls are future work; review poses after overwriting
  a track. Each independent player track retains its own inference dimensions.
- Audio decode/write validation uses the local browser's measured duration. Server
  transcoding and format-independent audio inspection are not implemented.
- Publication requires some eligible poses on both tracks and explicit gap review.
  Final scoring thresholds/minimum coverage belong to the game's scoring evaluation.
- Browser storage is local to each profile and origin. Backups are required for
  transfer and recovery after clearing site data. Browser storage regression tests
  cover cross-tab conflicts, quota rollback, atomic restore, and disk ZIP compatibility.
