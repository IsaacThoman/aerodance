# aerodance studio

Where a song's dance is made, at `/studio/` on the game's own origin. You make a routine by
**dancing it, then fixing it**: record each section with the camera (or bring in a video), keep
the take as the motion, correct the moments that are wrong with poses layered on top, dance it
back through the game's scorer, and send it to the game.

```sh
npm run dev                      # then open http://localhost:5173/studio/
node scripts/play.ts start --url /studio/     # a driven, GPU-rendered browser (docs/interactive-testing.md)
```

## How it's put together

| Where | What |
|---|---|
| `packages/dance/` | The engine: the project format, takes and clips, evaluation, edit ops, compile, checks, playtest analysis, beat detection, bundles and the project store. No DOM; the `dance` CLI (`tools/dance`) uses the same code. |
| `core/` | What every station shares: the open project (`session.ts`), the song clock (`transport.ts`), the camera and recording (`camera.ts`, `capture.ts`, `live.ts`), the coach view (`Viewport.tsx`), the timeline, the transport bar, UI pieces (`ui.tsx`) and hooks. |
| `stations/<name>/` | One folder per station: Song, Record, Fix, Playtest, Share (`stations/index.ts` lists them). |
| `Library.tsx`, `StudioApp.tsx` | The list of dances, and the shell around an open one. |
| `studio.css` | The look: the game's sky and frosted glass, Inter type. A station's own styles live in its folder. |

A project is a folder (`dance.json`, `sources/`, `attempts/`, `.dance/` history; the layout
`docs/dance-format.md` describes) in the browser's private filesystem. `dance.json` is an
`aerodance.dance` v2 document.

## The model in one screen

- A **take** (`sources.takes`) is captured motion: poses from the camera stamped in song time
  (`clock: 'song'`), or tracked from the project's video (`clock: 'video'`). Take files are never
  rewritten; what plays is a cleaned view (`packages/dance/takes.ts`).
- A dancer's **clips** place takes on its timeline (`kind: 'take'`), or replay a stretch of any
  dancer (`kind: 'ref'`: a repeated chorus, a mirrored partner; it stays linked to its source).
  Later clips in the list cover earlier ones; fades blend them.
- **Fixes** are sparse keys on an additive layer over the clips (`fix` op): move a hand at one
  moment and it eases in and out, the elbow following.
- **Contacts**, **style**, **exclusions** (unscored) and **approvals** (score a joint the tracker
  was unsure of) apply on top, as for keyed dances.
- `compileDance` bakes all of it into the game's choreography; `buildSongBundle` wraps that with
  the music as the bundle the game imports.

## Rules for station code

1. **Every edit is ops through the session.** `session.apply(ops, label)` saves the next
   revision (undoable, labelled for the undo button) and never throws for a bad edit: it
   resolves `null` and sets `state.error`, which the shell shows. For a drag in progress,
   `session.preview(ops)` shows the result without saving; `session.preview(null)` clears it;
   apply on release. Op reference: `docs/dance-cli.md` and `packages/dance/ops.ts` (`clip`,
   `fix`, `take`, `approve`, `exclude`, `contact`, `phrase`, `song`, `dancer`, …).
2. **Read state with the hooks** (`core/hooks.ts`): `useProject()` gives `{ dance, shown, takes,
   attempts, undo, redo, busy, error }` (`dance` is saved, `shown` includes a preview);
   `useTransport()`, `useSongTime()`, `useEvaluators()`, `useCamera()`; `useView()` /
   `useViewStore()` hold the selected dancer, the selected stretch of the song and the coach
   view's look, shared across stations.
3. **Times are song milliseconds** everywhere in the UI. A dancer's own clock (what ops take for
   that dancer's keys, clips, contacts, exclusions) is song time minus its `timeOffsetMs`, which
   the Studio leaves at 0.
4. **Use `core/ui.tsx`** (`Button`, `Panel`, `Field`, `Segmented`, `Note`, `Empty`, `Dialog`,
   `Meter`, `FileButton`, `Icon`) and `StationLayout`, `TransportBar`, `Timeline` + `Lane` +
   `Span`, `DancerLanes` (a lane per dancer with its clips; `extra` draws a station's own marks
   over them), `Viewport` (its `live` prop makes dancers follow the camera), `CameraPanel` and
   `CameraPreview`. `core/compile.ts` gives the dance as the game will load it (`compileNow`,
   `useGameBundle`), `core/findings.ts` its open issues. Don't restyle shared pieces per station.
5. **Slow work** (decoding, tracking, compiling a whole song) goes through
   `session.busy(label, run)` so the shell shows what's happening, and off the main thread
   where it would freeze the page.
6. **Words**: plain, short, about the dance ("Record this part again"), never about the
   machinery ("clip", "op", "landmark" stay out of the interface).
7. The root element reports state as `data-*` for scripts (`data-station`, `data-revision`,
   `data-busy`, `data-clips`, …); a station adds what a test would wait on to an element of its
   own with `data-*`, and scripts read it with `play.ts eval`.

## Trying things without dancing

In development the page has `window.studio`: `studio.session`, `studio.view`, and
`studio.demo(dancer = 0, options)` which records a stand-in performer's take of the whole song
and places it (with a stretch where tracking was lost and one where it was unsure, so the Fix
station has something to show). `scripts/play.ts`'s fixture camera stands still dancers in front
of the camera: enough to test recording and scoring flows.

```sh
export PLAY_SESSION=my-session
node scripts/play.ts start --url /studio/
node scripts/play.ts click --locator 'text=Make your first dance'
node scripts/play.ts type 'Test' && node scripts/play.ts click --locator '.dialog .btn-primary'
node scripts/play.ts wait screen=project
node scripts/play.ts upload '.dropzone input[type=file]' /path/to/song.mp3
node scripts/play.ts wait audio=ready 'revision>1'
node scripts/play.ts eval 'window.studio.demo()'
node scripts/play.ts shot          # then look at the PNG
```

A play.ts session starts with an empty library each time (a fresh browser profile).

## Checks

```sh
npm run typecheck && npm run lint
npm test                                   # includes packages/dance/tests (beats, store, bundles, playtests)
npm run dance:test                         # the engine through the CLI's tests: clips, ops, compile, interop with the store
npm run build && node apps/web/tests/studio.browser.ts   # the whole flow in Chromium, against the build
```

The browser test makes a dance, adds a silent MP3 it generates, records a take with a synthetic
camera the real tracker follows, settles an item in Fix, drags a joint, playtests, adds the song to
the game and checks the game has it. `UI_GPU=1 UI_ANGLE=metal` runs it on the GPU on a Mac. It is
part of the Docker `webcam-test` target, beside the other tests that need a camera.
