# Dance (animation tools)

Animate Aerodance dancers to a video by hand, from the command line or in the Studio, and export
songs the game plays. Made for coding agents as much as for people: every edit is a JSON op, every
view can be rendered to an image, and the checks and the game's own scorer say where the animation
and the video disagree.

- [docs/dance-cli.md](../../docs/dance-cli.md): the workflow, the commands, the ops and the Studio.
- [docs/video-dance-conversion.md](../../docs/video-dance-conversion.md): the full conversion process, combining authored choreography, tracked detail, constraints, and review.
- [docs/dance-format.md](../../docs/dance-format.md): the `aerodance.dance` project format.

```sh
node tools/dance/cli.ts init ~/dances/mine --video dance.mp4 --dancers 2 --title "…" --artist "…"
node tools/dance/cli.ts frames ~/dances/mine --range 4s:8s --views source --grid
node tools/dance/cli.ts apply ~/dances/mine patch.json
node tools/dance/cli.ts studio ~/dances/mine
node tools/dance/cli.ts studio ~/dances/new   # no dance there yet: the Studio makes one, from a video, a song or the webcam
```

Needs FFmpeg on `PATH` and Playwright's Chromium (`npx playwright install chromium`).

## Code

The engine is in [`packages/dance`](../../packages/dance), shared with
[aerodance studio](../../docs/studio.md) (the app at `/studio/` where dances are recorded, fixed and
playtested). The files of the same names here re-export it, so imports from `tools/dance` keep
working.

| In `packages/dance` | |
|---|---|
| `format.ts` | The format's types, defaults and validation |
| `rig.ts` | Controls ↔ MediaPipe landmarks: neutral stance, limb solving, derived face/hands/feet, fitting from tracking |
| `takes.ts` | Captured motion: decoding and cleaning takes, a take clip's pose in the dance's frame |
| `evaluate.ts` | A dancer's pose at any time: clips, layers, contacts, head and limb following |
| `ops.ts` | Every edit, applied atomically with a change summary |
| `time.ts` | Time and range parsing (ms, seconds, m:ss, beats), song ↔ video clocks |
| `compile.ts`, `bundle.ts` | Export to `.adpose` choreography and song bundles |
| `check.ts`, `score.ts`, `playtest.ts` | Review findings, comparison with tracking, the game's scorer, and where a player's attempt lost points |
| `tracking.ts` | Tracked poses |
| `store.ts` | A project in any file store (the Studio's, in the browser) |
| `fromSong.ts` | A finished song opened as a dance |
| `beats.ts` | A song's tempo, downbeat and sections from its audio |
| `scenes.tsx` | The 3D views the Studios and the renderer share |

| Here | |
|---|---|
| `project.ts` | The project folder on disk: revisions, lock, undo/redo, retries, sources |
| `bundle.ts` | Building a bundle from a project folder, and installing it in the game |
| `media.ts` | FFmpeg |
| `server.ts` | The bridge: the Studio's API, live revisions, and the headless renderer/tracker the CLI uses |
| `cli.ts` | The `dance` command |
| `studio/` | The animation Studio (`index.html`) and the renderer page (`render.html`) |

## Checks

```sh
npm run dance:test                       # unit tests (engine, ops, project, export, scoring, CLI)
npm run dance:build                      # the Studio's production build (tools/dance/dist)
node tools/dance/tests/studio.browser.ts # the Studio, renderer and tracking in Chromium
```

The browser test uses the repository's solo video fixture. Without a GPU, set
`PLAY_BROWSER_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader"`;
`DANCE_DIST=1` serves the built Studio, as CI does.
