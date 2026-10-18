# Interactive testing

`scripts/play.ts` runs the game (or Dance Studio) in a GPU-rendered Chromium that stays
open in the background, so you, a script or a coding agent can drive it a step at a time:
click a menu button, wait for a screen, take a screenshot, look, decide, carry on. It
complements the browser tests (`client/tests/*.browser.ts`), which run a fixed flow and exit.

```sh
npm install
node scripts/play.ts start                       # Vite dev server + headless Chromium on the GPU
node scripts/play.ts click START
node scripts/play.ts wait menuScreen=players menuReady=true
node scripts/play.ts click ONE_PLAYER
node scripts/play.ts wait songScreen=list songReady=true catalog=ready
node scripts/play.ts click rowRect.0             # the first song
node scripts/play.ts wait previewState=playing stageReady=true
node scripts/play.ts shot --frame                # prints the PNG's path
node scripts/play.ts stop
```

`npm run play -- <command>` does the same thing.

## Choosing a renderer

The game is a full-screen three.js canvas that also draws all of its menus, so the
browser needs real WebGL speed to be usable. These were measured on an Apple M5 Pro
(macOS) at 1280×800:

| Option | Renderer | Frame rate | Main menu ready | Verdict |
| --- | --- | --- | --- | --- |
| Playwright Chromium, headless, `--use-angle=metal` | ANGLE Metal (GPU) | 60 fps | ~1.5 s | **Used by `play.ts`** |
| Playwright Chromium, headed window | ANGLE Metal (GPU) | 60 fps | ~1.4 s | `play.ts start --headed` |
| Playwright headless shell, default flags | SwiftShader (CPU) | ~1 fps | ~13 s | Too slow to interact with |
| The browser tests' `UI_GPU=1` flags (`--use-angle=gl`) | — | — | never | The menu never became ready on macOS |
| Browser panes embedded in agent tools | SwiftShader (CPU) | ~1 fps | — | Too slow; screenshots time out |
| The Docker `ui-test` images | SwiftShader in a Linux VM, draws stubbed | — | — | Right for CI flow checks, not for looking at the game |

Headless Chromium on macOS uses SwiftShader unless it is told to use Metal, and that is
the whole difference between 1 fps and 60 fps. `start` prints the renderer it got and
warns when it's software. On Linux and Windows it passes the usual GPU flags
(`--ignore-gpu-blocklist`; `--use-angle=d3d11` on Windows), but those platforms haven't
been measured. Add flags with `PLAY_BROWSER_ARGS` if the renderer comes out as SwiftShader.

For a person just playing, `npm run dev` and a normal browser are still the simplest route.

## The session

`start` launches a background process that owns a Vite server and one Chromium page,
writes `.cache/play/session.json` and returns once the main menu is ready. Each later
command connects to it, does one thing and prints the result. The page keeps its state
between commands, and with the dev server, edits to the source hot-reload into it.

```sh
node scripts/play.ts start [--studio] [--dist] [--headed] [--url /?input=ghost]
                           [--size 1280x800] [--camera fixture|deny|none]
```

- `--studio` runs Dance Studio instead of the game.
- `--dist` builds and serves the production bundle (`vite build` + `vite preview`),
  for checking what actually ships.
- `--headed` opens a visible window that you can play in while the commands still work.
  Closing the window ends the session.
- `--url` is the page to open, e.g. `/?input=ghost` for the autoplay ghost.
- `--size` sets the viewport. The default, 1280×800, matches the browser tests: a
  1280×720 game frame starting 40 px down.
- `--camera` sets the webcam (see below). The default is `fixture`.

Running `start` again replaces the session. Sessions live in the checkout's `.cache/play/`,
so separate worktrees can run their own at the same time; the server takes the first free
port from 5300 (4300 with `--dist`). `.cache/play/daemon.log` has the server's output.
`status` reports the URL, renderer and current frame rate.

## Commands

| Command | Does |
| --- | --- |
| `state` | Prints the game canvas's `data-*` attributes as JSON (Studio: the URL and title) |
| `click <target>` | Clicks a layout target or a design point `x,y` (see below) |
| `click --locator <selector>` | Clicks a DOM element with a [Playwright selector](https://playwright.dev/docs/other-locators), mainly for Studio, e.g. `'role=button[name="Save"]'` |
| `hover <target>` | Moves the mouse onto a target |
| `key <key>...` | Presses keys in order: `Enter`, `Escape`, `ArrowDown`, … |
| `type <text>` | Types into the focused element |
| `wait <condition>... [--timeout ms]` | Waits until every condition holds, then prints the state. Conditions: `key=value`, `key~regex`, `key>number`, `key<number`. The default timeout is 30 s |
| `shot [file.png] [--frame]` | Screenshot of the page, or of just the game frame. Without a file it goes to `.cache/play/shots/` |
| `goto <path or url>` | Loads a page and waits until it is ready (e.g. `goto '/?input=ghost'`) |
| `reload` | Reloads and waits until ready |
| `eval <js>` | Evaluates an expression in the page and prints the result |
| `logs [--clear]` | Console messages, page errors, failed requests and page loads so far |
| `camera <0\|1\|2>` | How many dancers the fixture camera shows |
| `resize <w>x<h>` | Changes the viewport, e.g. `resize 390x844` for a phone |
| `targets` | Lists every layout target |
| `stop` | Closes the browser and the server |

### Clicking the canvas

Every game screen is drawn on the canvas in 1600×900 design units, and the layout
modules (`client/src/menu/layout.ts`, `client/src/game/layout.ts`,
`client/src/connect/layout.ts`) export the position of each control. `click` takes their
names and clicks the middle of the rect or circle, wherever the letterboxed frame is:

- `START`, `DANCE`, `PILL`, `GAME_PAUSE`: a name exported by only one module
- `menu.BACK`, `game.BACK`: a module prefix where names clash
- `MODEL_RECTS.1`, `GAME_CALIBRATION_CAMERA.primary`: entries inside an export
- `rowRect.2`: layout functions, called with the number
- `800,450`: any point in design units

### Reading the state

Each screen reports what it shows on the canvas's `data-*` attributes, which is what the
browser tests assert on, and `wait` and `state` read the same attributes. The useful ones:

- Menus: `menuScreen` (`main`, `players`, `settings`), `menuReady`
- Connect Client: `connectOpen`, `connectReady`, `connectStatus`, `connectModel`, `connectMessage`
- Song Select: `songScreen` (`list`, `preview`), `songReady`, `catalog`, `songCount`, `playerSlots`, `previewState`, `previewTimeMs`
- Stage: `stage`, `stageReady`
- A song: `gamePhase` (`calibrating`, `ready`, `countdown`, `playing`, `paused`, `results`), `gameTimeMs`, `gameScores`, `gameCalibrationPlayers`, `gameCalibrationProgress`, `gameCameraStatus`

Wait on `menuReady=true` or `songReady=true` after changing screens: these become `true`
once the screen's entrance animation has finished and it accepts clicks.

### Camera

Headless Chromium has no webcam, so by default (`--camera fixture`) the page gets a
synthetic one, as in the webcam browser tests: the MediaPipe fixture photo
(`client/tests/fixtures/mediapipe-pose.jpg`) drawn once per dancer. Real MediaPipe tracks
it, so Connect Client, calibration and scoring all run for real. `camera 0|1|2` changes
how many dancers are in shot; start with two for a two-player song, or one for a solo.
`--camera deny` makes every camera request fail with a permission error, and
`--camera none` leaves the browser alone (headless has no camera, so requests fail).

For a scored run without any camera, open `/?input=ghost`: an autoplay ghost copies each
routine (see the main README).

## Examples

A whole two-player song with the ghost:

```sh
node scripts/play.ts goto '/?input=ghost'
node scripts/play.ts click START
node scripts/play.ts wait menuScreen=players menuReady=true
node scripts/play.ts click TWO_PLAYERS
node scripts/play.ts wait songReady=true 'playerSlots=Detected|Detected'
node scripts/play.ts click rowRect.0
node scripts/play.ts wait songScreen=preview songReady=true
node scripts/play.ts click DANCE
node scripts/play.ts wait gamePhase=results --timeout 90000   # prints gameScores
node scripts/play.ts shot --frame
```

Calibrating one player with the fixture camera, from a song's preview:

```sh
node scripts/play.ts camera 1
node scripts/play.ts click DANCE
node scripts/play.ts wait gamePhase=calibrating gameReady=true
node scripts/play.ts click GAME_CALIBRATION_CAMERA.primary   # Start camera
node scripts/play.ts wait gameCameraStatus=connected
node scripts/play.ts wait gamePhase=countdown --timeout 60000  # after the 2.5 s hold
```

Dance Studio:

```sh
node scripts/play.ts start --studio
node scripts/play.ts click --locator 'role=button[name="Song details"]'
node scripts/play.ts shot
```

## Troubleshooting

- **The game suddenly went back to the main menu.** The page reloaded. `logs` shows a
  `[navigated]` line for every page load. Vite reloads the page when it finds a dependency
  it hasn't pre-bundled; both Vite configs pre-bundle `@mediapipe/tasks-vision` because only
  the pose worker imports it, and Vite's scan doesn't look inside workers. Source edits
  hot-reload too, and some of them reload the whole page.
- **No Chromium found / the Playwright install hangs.** `play.ts` uses Playwright's own
  Chromium if it is installed, and otherwise the newest Chromium in Playwright's cache
  (`~/Library/Caches/ms-playwright` on macOS), so a build installed by another checkout
  works. Set `CHROMIUM_PATH` to use a particular one.
- **The renderer is SwiftShader.** The GPU flags didn't take; see
  [Choosing a renderer](#choosing-a-renderer). Expect only a few frames per second.
- **A command times out.** `state` shows where the game actually is, and `logs` shows
  errors. Long waits (a whole song, loading a stage the first time) need a longer
  `--timeout`.
- **Sound.** Headless Chromium is muted; use `--headed` to hear it.
- **Changed `play.ts` itself?** Run `start` again so the background process loads the new code.
