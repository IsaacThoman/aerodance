# Game song bundles and pose migration

The game now reads the directory bundle contract in
[song-dance-authoring-workflow.md](song-dance-authoring-workflow.md).
The first integration is a music/reference-character preview in Song Select, on
the song's dance stage. Countdown, live character panels, calibrated audible
timing, scoring, and results are still pending. The preview plays the audio
through the mixer's music bus and samples the dancers at the audio clock's song
time (less output latency), pauses when the tab is hidden, and stops at the
playable endpoint. It does not use the silent demo's loop or seam blend.

## Install an exported bundle

Unpack the runtime ZIP into `apps/web/public/songs/`, retaining its `<songId>/`
folder with `song.json`, `choreography.adpose`, audio, optional cover, and
`checksums.json`. The folder name must match `songId`. No manual catalog update
is needed: the Vite development server generates `songs/manifest.json` from
exported folders on each catalog request. Reopen Song Select to see changes. Invalid metadata, missing files, mismatched file sizes,
and invalid metadata checksums cause a folder to be skipped with a warning.
The loader still performs full runtime integrity/schema checks when selected.

Builds generate the same catalog in `dist/songs/manifest.json` for static hosting.
Rebuild/redeploy after changing the source songs directory.
Exported metadata supplies title, artist, duration, player counts, revision,
difficulty, stage, optional cover, and a SHA-256 pin for `song.json`. The preview
opens on the song's stage, or `openreef` when it has none. Re-exported songs
are discovered with their updated revision. Install the complete directory before
opening Song Select. The game does not extract ZIP files or publish editor
projects. The repo ships one song, **Demo Track 1** (`apps/web/public/songs/demo-track-1/`):
a 30-second duet we recorded ourselves on the `club` stage, set to generated
brown noise so the bundle carries no licensed music.

## Import a song in the browser

Players can add a song without rebuilding the game: **Import song**, under the Song
Select list, takes the ZIP Dance Studio's **Export song** downloads
(`<songId>-r<revision>.aerodance-song.zip`). A ZIP of the exported folder made by the
Finder or Explorer works too. The game checks it as fully as playing it would, then saves
it in the browser's IndexedDB, so it's still there next visit. Imported songs list after
the published ones, marked **Custom**; an imported song's preview has **Remove**.

- Importing the same or an older revision of a song already imported asks before replacing it.
- An imported song can share a published song's ID: both are listed, and the imported one's
  best scores are kept under `custom:<songId>`.
- Only the files `checksums.json` lists are kept. The folder's name doesn't matter;
  `song.json` names the song. A saved song whose `song.json` or `checksums.json` no longer
  checks out is left out of the list, with a console warning; damaged music or choreography
  is reported when the song is opened, as for a published song.
- Importing is checked on the page itself: a ZIP takes several times its size in memory
  while it's checked.
- The Apple TV app (no IndexedDB or file picker) and the iPhone/iPad app (WebKit may clear
  its storage) don't offer importing. Browsers that clear site data clear imported songs.

Code: `apps/web/src/songs/customSongs.ts` (import, storage, loading),
`packages/pose/song.ts` `catalogEntry` (the folder checks shared with
`scripts/songCatalog.ts`) and `packages/pose/zip.ts` (shared with Dance Studio).

Catalog paths resolve relative to the catalog; media paths resolve relative to
`song.json`. Only safe relative file paths are accepted. The loader checks
schema/profile support, catalog identity and revision, song/choreography time
agreement, both tracks, calibration, sample quality, file lengths and SHA-256 for
all referenced runtime files. Requests include the selected bundle revision.
Downloads have per-file and total declared-size limits. Errors appear in Song
Select and allow retry; leaving the screen cancels the pending request.

### Choreography files

`song.json` names the choreography as
`{ "path": "choreography.adpose", "schemaVersion": 2 }`: a `choreography` pose
file ([pose-binary-format.md](pose-binary-format.md)). The demo's is 155 KB, down
from 12.4 MB of JSON. For one release the loader also accepts schema 1,
`choreography.json`. Convert an older bundle in place with:

```sh
node tools/pose/migrate-legacy.ts apps/web/public/songs/<songId>
```

This writes `choreography.adpose`, bumps `bundleRevision`, rewrites
`checksums.json`, and removes the JSON. The same tool converts `?record` NDJSON
pose recordings (`node tools/pose/migrate-legacy.ts in.ndjson out.adpose`). `?record` now
downloads `<songId>-poses.adpose`, which `?input=recording&recording=<url>`
replays.

One-player preview selects player ID 0 from the same choreography. Two-player
preview selects IDs 0 and 1, and three or four players dance those two parts again
(players 3 and 4 copy IDs 0 and 1, `partOf`). The shared finite sampler preserves absence and
refuses interpolation over gaps longer than the authored limit (at most 200 ms).
Authored exclusions clear score eligibility without changing the visual pose.
Coach reflection is visual only; stored anatomy and player IDs remain unchanged.
Audio is decoded from the verified in-memory Blob and released when preview closes.

Code:

- `packages/pose/song.ts`: catalog/song validation, bundle cross-checks, finite sampling.
- `apps/web/src/songs/loadBundle.ts`: bounded HTTP loading and file integrity.
- `apps/web/src/game/SongSelect.tsx`: the in-engine list and preview.
- `apps/web/src/audio/songPlayer.ts`: finite music on the mixer, clamped to the playable range.
- `apps/web/src/stage/StageView.tsx` and `packages/stages/shared/Dancers.tsx`: the stage and its independent Frutiger dancers.

## Migrated silent capture

The menu dancers' capture (`packages/character/assets/dance.adpose`) is a `take`
pose file ([docs/pose-binary-format.md](pose-binary-format.md)) of 420 two-player
frames on the take clock. A take file has no duration, so its provenance records
the 14 s loop as `durationMs`; the loader falls back to one frame past the last.

The old tuple's fourth component was a combined, smoothed confidence. Migration
doesn't keep it: every joint's confidence is unknown (byte 255), which makes it
unscorable. Source/model/settings/report remain provenance, including the
limitation that the old smoothed capture cannot recover original gaps or repairs.
This silent take is a preview, not a published song.

Convert an older capture (the version 1 tuple format or take JSON) with:

```sh
node tools/pose/migrate-legacy.ts old-dance.json new-take.adpose
```

Runtime preview still loops, while game bundle sampling is finite.

## Checks

```sh
npm test
npm run build
node apps/web/tests/ui-flow.browser.ts # requires Playwright and Chromium
node apps/web/tests/custom-songs.browser.ts # CUSTOM_SONGS_BROWSER=webkit for WebKit
```

Tests cover migration, wire-payload compatibility, integrity failures, revision
pinning, unsafe paths, cancellation, missing-player/gap behavior, exclusions,
track-0 equivalence, independent skeletons, both browser preview modes, and finite
music playback. Browser fixtures are private synthetic assets; they do not populate
the public catalog. Browser checks also load installed authored bundles and play
their audio in both supported player modes. Device timing still requires validation.
