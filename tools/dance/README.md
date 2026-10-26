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
```

Needs FFmpeg on `PATH` and Playwright's Chromium (`npx playwright install chromium`).

## Code

| File | |
|---|---|
| `format.ts` | The format's types, defaults and validation |
| `curves.ts` | Keyframe interpolation |
| `rig.ts` | Controls ↔ MediaPipe landmarks: neutral stance, limb solving, derived face/hands/feet, fitting from tracking |
| `evaluate.ts` | A dancer's pose at any time: layers, contacts, head and limb following |
| `ops.ts` | Every edit, applied atomically with a change summary |
| `time.ts` | Time and range parsing (ms, seconds, m:ss, beats), song ↔ video clocks |
| `project.ts` | The project folder: revisions, lock, undo/redo, retries, sources |
| `compile.ts`, `bundle.ts` | Export to `.adpose` choreography and song bundles |
| `check.ts`, `score.ts` | Review findings, comparison with tracking, and the game's scorer |
| `tracking.ts`, `media.ts` | Tracked poses; FFmpeg |
| `server.ts` | The bridge: the Studio's API, live revisions, and the headless renderer/tracker the CLI uses |
| `cli.ts` | The `dance` command |
| `studio/` | The Studio (`index.html`) and the renderer page (`render.html`) |

## Checks

```sh
npm run dance:test                       # unit tests (engine, ops, project, export, scoring, CLI)
npm run dance:build                      # the Studio's production build (tools/dance/dist)
node tools/dance/tests/studio.browser.ts # the Studio, renderer and tracking in Chromium
```

The browser test uses the repository's solo video fixture. Without a GPU, set
`PLAY_BROWSER_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader"`;
`DANCE_DIST=1` serves the built Studio, as CI does.
