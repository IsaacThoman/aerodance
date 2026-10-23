# Dance Studio

Static song/choreography editor for Aerodance. Projects autosave in the browser;
reference poses use the game's `{playerId, landmarks}` pose format. No backend,
account, or game database is needed.
See the [format/workflow reference](../../docs/song-dance-authoring-workflow.md).

## Run

From the repository root:

```sh
docker compose -f tools/choreography/compose.yaml -f tools/choreography/compose.local.yaml up --build -d
```

Open **http://localhost:8082** (set `STUDIO_PORT` to change it). The container
serves static files with nginx and has no project data volume. Audio, takes, raw recorder batches and track snapshots
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
Serve `tools/choreography/dist/` with any static HTTPS host, or deploy the container
with Coolify (below). The game and Studio can use separate domains; publishing a song remains an explicit export/install step.
The Studio needs HTTPS or localhost, IndexedDB, OPFS writable files, and Web Locks.
No API proxy or server environment variables are required.

### Deploy with Coolify

The base `compose.yaml` publishes no host ports; the container serves the build on
port `3000` with its own `nginx.conf`.

1. Create a separate Git-based application in Coolify with the Docker Compose build
   strategy, base directory `/` and Compose file `/tools/choreography/compose.yaml`.
   The build context is the repository root.
2. Assign the domain to service `studio` with internal port `3000`, for example
   `https://studio.example.com:3000`. Traefik terminates HTTPS, which the Studio needs.
   The Studio is built for `/`, so give it its own hostname rather than a path on the
   game's. Projects stay with the origin, so changing the domain later leaves existing
   projects behind on the old one.
3. Deploy using only the base Compose file. Include `compose.local.yaml` only for
   local use. For pull request previews, use a template that doesn't collide with the
   game's `{{pr_id}}.aerodance.party`, such as `studio-{{pr_id}}.aerodance.party`
   (one level deep, so the existing wildcard DNS covers it).

### Projects from earlier versions

This editor opens only project format 3. Projects and backups from earlier
Studio versions (formats 1 and 2, with JSON takes and NDJSON captures) are listed
as unsupported and left untouched; they can't be opened, restored or converted.
The optional disk adapter and HTTP harness are kept for regression checks; they
are not part of the production image.

## Create a routine

1. Create a project, import music, and enter **Song details**. Duration is measured
   by the browser audio decoder. Set the real artist, authors/choreographers, the
   **Stage** the game shows the routine on (`openreef` by default), and
   distribution licenses or permissions.
2. Import a pose JSON, or start the webcam and **Record new take**.
   Choose **Both players**, **P1 only**, or **P2 only**, a camera and
   **Lite / Full / Heavy**, then **Start camera**
   and allow permission. Recording stays disabled until the first pose result
   arrives, even if neither player is detected. You can start the countdown and
   then step into position. **Cancel connection** stops the wait. Set
   **Recording delay (seconds)** from 0 to 60 (default 3). A visible countdown
   gives you time to get into position before music and movement capture start.
   **Cancel countdown** stops the wait without adding a take. The mirrored setup preview labels the two camera-side
   slots. Solo mode follows one dancer anywhere in the whole frame and labels
   them as the selected player; only that player's calibration is needed.
   Switching player mode restarts tracking and calibration.
   Camera/model preferences are remembered in this browser. Changes restart
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
   For a prerecorded video, choose **Import video**, choose **Both players** or
   solo **P1 only / P2 only**, select **Lite / Full / Heavy** (Heavy is the default),
   and scrub or play the source until you find an upright stance with shoulders,
   hips, and feet clearly visible. Choose **Use current frame for calibration**,
   then **Process video**. The selected frame calibrates every captured dancer;
   detected dancers remain visible in the calibration overlay even when their
   body confidence is too low. Each label explains whether that dancer is ready
   or needs a clearer frame; processing requires every shown dancer to be ready.
   if another dancer appears later, choose a frame containing both and **Save take**
   without processing the poses again. Two-player detection uses the webcam's
   left/right regions; solo detection uses the whole frame. The importer creates
   a new library take; use its menu to assign tracks.
   Inference runs locally and waits for each sampled frame, up to 30 samples/second.
   Two-player imports continuously track each side in separate VIDEO workers
   alongside the whole-frame pass. Crops stay fixed from calibration, including
   room for raised arms and feet. Recovery checks torso continuity and retains
   the original video coordinates and selected model. Left/right slot assignment
   is unchanged; this does not track identities across the center divider.
   **Clean up poses after detection** defaults on: it rejects isolated joint spikes,
   repairs supported gaps bounded by reliable poses no more than 200 ms apart, and
   applies centered confidence-weighted smoothing (120 ms XY, 180 ms depth).
   Fast linear movements retain their timing. Longer gaps and abrupt torso changes
   are not bridged; unresolved joints and gaps are reported for review.
   Raw captures remain unchanged in backups. Cleaned takes store the cleanup version,
   settings, and counts. Smoothed reliable measurements keep their confidence and
   previous scoring eligibility. Repaired joints have unknown confidence and require
   explicit approval before scoring. Uncheck cleanup to save original detections.
   Slow models take longer rather than losing samples. Progress and **Cancel import**
   are available. MP4, WebM, MOV, and other formats work when the browser supports
   their codecs; videos must be no longer than one hour. Song audio stays unchanged
   unless you check **Use video audio as song audio**. That option extracts the
   primary audio track into a WAV asset and replaces music only when the take and
   audio can be saved together. Missing or unsupported audio and the 128 MiB audio
   size limit report an error; uncheck the option to import poses alone.
   Audio timestamps retain their alignment with video, including leading silence.
   Video timestamps start at song time zero; adjust alignment with track offsets.
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
   **Clean up selected range** applies the same cleanup to the selected player's
   existing track as one undoable edit. It reads context outside the selection but
   only changes samples inside it. **Smooth** uses confidence-aware smoothing without
   filling gaps. Existing scoring exclusions and the source library take are preserved.
   To update a track's body calibration while editing, scrub to an upright pose,
   open the selected player's **Options**, and choose **Recalibrate body from
   current frame**. It uses the edited skeleton at the playhead, with shoulders,
   hips, and ankles clearly tracked, as the body reference for the whole track.
   Calibration is saved with the track and supports undo/redo.
5. Select a take to open **Take view**, a read-only preview immediately before
   **Live view**. Scrub, step, and play the take without changing the routine.
   Take playback also works without music. A completed recording opens its new
   take automatically. Imports and recordings remain in the library until assigned.
   Open its **⋯** menu and choose **Overwrite P1 track**, **Overwrite P2 track**, or
   **Overwrite both tracks**. Each action copies the corresponding source player
   into independent track storage and uses the take's original audio alignment;
   it replaces the entire destination track, including its edits.
   To create a two-person dance from one dancer, assign the solo take to its player,
   open that player's **Options**, then choose **Mirror P1 track to P2** or
   **Mirror P2 track to P1**. This replaces the other track with a reflected copy
   of the complete edited source, preserving timing and gaps. It is one undo step.
   The tracks are independent afterward; source changes require mirroring again.
   Review and approve reflected poses before scoring. All exported bundles still
   contain both player tracks and require coverage for both players.
   Adjust each track's **Offset (seconds)** independently in Playback. Positive
   offsets delay poses; negative offsets advance them. Poses before song time zero
   are omitted from playback/export but retained for later realignment. Track
   offsets, edits, overwrite, clear, and interpolation support undo/redo.
6. Check music/pose alignment near both ends, set the playable range if needed,
   then confirm alignment in Song details. Review references and missing intervals
   in **Review**. Approvals require a reason; exclusions always override approvals.
7. **Export song** downloads a deterministic runtime ZIP containing song.json,
   choreography.adpose, audio, and checksums. Export rejects unresolved metadata,
   timing review, long missing references, and empty score coverage.

The Project sidebar opens Import, Configuration, and History as separate panels.
Select P1/P2 above the preview or from a timeline lane. The selected player expands to show
an **Options** button to the right of its label, which opens track tools for that player.
In Live view, camera setup and recording delay are in Configuration, with Record/Stop beside playback.
Capture controls are hidden in Playback and Take views.
The timeline marks the playable bounds separately from the editing selection; use **Set playable range**
to apply a selection. Export writes `unknown` for both licenses without requiring license entries;
project backups retain any existing rights metadata.

Changes autosave after a short idle interval. **Save** forces persistence.
This editor uses project format 3. Saved projects in other formats are
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
`packages/character/assets/dance.adpose` is useful for trying the
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
deleted.

The Frutiger rig is stylized 2.5D; elbows/knees remain editable in the
skeleton even though the character has no articulated elbow/knee bones.
The character uses the original wrist and foot mapping. Live Frutiger previews
smooth landmark movement and distance estimates for display; skeletons, saved
takes, edits, and recorded playback use their original coordinates. Distance
compensation uses the torso's image size so noisy inferred depth cannot resize
the whole character. Recalibrate after choosing your dancing position.

## Install a song in the game

Extract the song ZIP **into** `apps/web/public/songs/`. The archive already contains
`<songId>/`, so the result should be `apps/web/public/songs/<songId>/song.json`, with
choreography, audio, and checksums beside it. The folder name must match the
exported `songId`, which is a hash of the song's audio and motion: changing the
dance gives it a new ID, while metadata edits keep it. No manual manifest entry is needed.

The game discovers exported folders automatically. In development and the
production Express server, the catalog is scanned whenever Song Select opens.
Reopen Song Select after installing or replacing a song. Incomplete or invalid
bundles are skipped with a server/build warning; the game still verifies all
runtime file checksums when loading a selected song.

`npm run build` generates `dist/songs/manifest.json` for static hosting and copies
the song folders. Rebuild/redeploy after changing `apps/web/public/songs/` for a
deployed game. On a running Express deployment, complete folders added directly
to `dist/songs/` are detected without a rebuild or server restart. Container
installations need those files inside the container, through a rebuilt image or
a mounted songs directory.

To play a song without installing it, choose **Import song** in the game's Song
Select and pick the exported ZIP. It's saved in that browser only; see
[game song bundles](../../docs/game-song-bundles.md#import-a-song-in-the-browser).

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
node tools/choreography/tests/editor.browser.ts
node tools/choreography/tests/video-import.browser.ts
node tools/choreography/tests/video-duet.browser.ts
node tools/choreography/tests/project-loading.browser.ts
docker build -f tools/choreography/Dockerfile --target test -t studio-test .
docker build -f tools/choreography/Dockerfile --target ui-test -t studio-browser-test .
docker run --rm studio-browser-test
```

To validate local moving footage without adding it to the repository, build the
Studio and run `node tools/choreography/tests/video-quality.browser.ts "/path/video.mp4" .cache/video-quality`.
The harness processes the complete source with Heavy at 30 fps in solo P1 mode,
saves raw/cleaned `.adpose` captures, checks timing and scoring invariants, and
writes `report.html` with metrics and source overlays. Set `VALIDATION_GPU=1` to
use an available local GPU; the default uses software graphics and CPU inference.
An optional `--range=25:278` separates an explicitly reviewed dance window from
menus and credits. `--reuse` regenerates the report from saved captures without
repeating inference. Review frames use FFmpeg because browser seeking can be
unreliable for AV1. Temporal stability measurements are not labeled pose accuracy.

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

- Projects, takes and raw captures from earlier editor versions can't be
  opened or imported; only legacy dance and take JSON files import as takes.
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
