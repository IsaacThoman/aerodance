# aerodance

React + three.js (via [@react-three/fiber](https://r3f.docs.pmnd.rs/)) rendered in a full-screen canvas. The game is a static site: pose tracking and scoring run in the browser, and best scores and settings are saved in the browser, so production serves the build with nginx. The one backend is a small pairing service that introduces a phone to the game when the phone is the camera ([phone camera](#phone-camera)).

See [how scores are calculated](docs/scoring.md) and [the plan for finishing the game](docs/game-completion-plan.md).

See [the browser webcam plan](docs/browser-webcam-plan.md) for shared game/editor webcam input and selectable in-browser MediaPipe Lite, Full, and Heavy models.

See [the song and dance authoring workflow](docs/song-dance-authoring-workflow.md) for the proposed Docker-hosted editor, pose format, raw landmark editing, Frutiger playback, and portable song bundle contract.

The editor is implemented as [Dance Studio](tools/choreography/README.md).
Run `docker compose -f tools/choreography/compose.yaml up --build -d` and open
http://localhost:8082 to record/import, edit, preview, save, and export song bundles.
Dance Studio is also static: projects autosave in browser storage (IndexedDB and
OPFS). Download project backups to keep or transfer your work; see its README for
migration from older disk-based deployments.

## Aero background

The canvas shows a looping Frutiger Aero drone flight (glass skyline, clouds, hot-air balloons, gulls, flower meadow). The display is one letterboxed 16:9 frame rendered at a fixed 640x480 buffer and scaled up with `image-rendering: pixelated`; the HUD sits inside the frame.

- `client/src/aero/aeroBackground.ts` builds the world. `createAeroWorld({ renderer, scene, camera, speed, quality })` returns `{ update(dt), render(), setSpeed, dispose }` for use inside an existing renderer; `createAeroBackground(canvas, options)` is a standalone full-canvas version.
- `client/src/aero/AeroWorld.tsx` plugs it into the Fiber `<Canvas>` (used by `Scene.tsx`): `<AeroWorld speed={1} quality="auto" />`. It renders the frame itself, so it uses whatever buffer size `FixedRenderResolution` sets.
- The loop starts low over the meadow facing the skyline (`start` 0.08). Downtown, the east/west districts and the north district across the lake all sit on one 70 m street grid; the lake uses a reflective water surface with boats and quays.
- `quality="low"` thins out grass, flowers and leaf detail for weaker GPUs; `auto` picks it on touch devices.

### Sound

`client/src/audio/mixer.ts` runs all audio through one Web Audio context. Settings → Sound drives it: **Master** (everything), **Music** (all music, menu and in-game), **Effects** (sound effects), **Menu music** (switches off just the menu's background track; in-game songs go straight to the music channel) and **Mute all** (silences everything). Settings are saved per browser (`menu/soundSettings.ts`). The game currently ships no menu music or sound effects, so only songs play through it; `client/src/audio/loopingMusic.ts` can loop a menu track on the Menu music channel.

## Main UI flow

**Start → One Player / Two Players → Song Select → song preview → Dance! → results**, all drawn in-engine. Back (or Escape) from Song Select returns to the player count, and every screen works with the mouse, touch and the keyboard: the arrows (or Tab) move a pearl focus ring that starts on the screen's main action, Enter or Space press, Left/Right also step the volume sliders and switch cameras, and Escape goes back.

- **Connect Client** (`client/src/connect/`): the status pill in the top-right corner of Settings opens a card for the pose input: camera selection and in-browser MediaPipe **Lite / Full / Heavy** tracking for both player modes. Start camera requests permission; the mirrored setup preview shows player placement. Model/camera changes restart tracking and release the old camera. The last camera is **Phone camera**: Pair phone shows a QR code and a six-digit code ([phone camera](#phone-camera)). For a scored run without a camera, open the game with `?input=ghost`: an autoplay ghost copies each routine (`&ghostLagMs=300` dances late).
- **Song Select** (`client/src/game/SongSelect.tsx`) lists the published songs four to a page. Extract Dance Studio's song ZIPs into `client/public/songs/`: Song Select finds the exported folders without manifest edits (`scripts/songCatalog.ts`), and builds generate the catalog for static hosting, so rebuild or redeploy to publish changes. The repo ships one song, **Demo Track 1**: a routine we recorded ourselves, set to generated dark noise. Bundles are fully verified before they play ([game song bundles](docs/game-song-bundles.md)).
- **Preview:** a song's music plays through the mixer (ducking any menu music) with its reference dancers on the song's **dance stage**, rendered inside the game canvas (`client/src/stage/StageView.tsx`, stages from `packages/stages`). The music loops on its own while the stage camera slowly circles the dancers (`club` swings side to side instead), and swings back to the front when Dance! starts. Each song picks its stage in Dance Studio (players can't change it) and defaults to `openreef`. Best scores show on the list.
- **Dance!** (`client/src/game/GameScreen.tsx`, `GameSession.ts`): with the webcam, a calibration screen first: the setup preview, which starts the camera when pressed, above the same camera picker as Connect Client (`client/src/connect/cameraSetup.ts`), while every player holds still for 2.5 seconds. The tracking model is chosen in Connect Client (Lite unless changed). Replays get a ready check instead (every player tracked for a second, or **Start now**). Then **3, 2, 1** from the song's scheduled start, with the music and reference dancers starting together at zero. Each player's own glass character copies them live in a top corner (player 1 left, player 2 right; `client/src/stage/LivePanels.tsx`) with their score, combo and a Perfect / Good / OK / Miss pop-up every second. Escape, the pause button or a hidden tab pauses; Resume counts down again at the same spot. The results screen shows the winner or the solo score, grade, judgements and a new best, then **Play again** or **Song select**.
- **Timing and scoring:** everything runs on the song's audible clock (`client/src/audio/songPlayer.ts`). Each live pose is placed at the song position audible when the camera captured it, using the webcam frame's browser timestamp, and scored 750 ms behind the song so late poses still count. The scorer (`packages/score/`) compares limb directions and movement every 100 ms against the player's own track; [docs/scoring.md](docs/scoring.md) has the details. `?record` downloads each song's live poses as a recording, and `?input=recording&recording=<url>` replays one.

Containerized build, unit and browser-flow checks (use `podman` in place of `docker`
when using Podman):

```sh
docker build --target test -t aerodance-ui-test .
docker build --target ui-test -t aerodance-ui-browser-test .
docker run --rm aerodance-ui-browser-test
docker build --target webcam-test -t aerodance-webcam-test .
docker run --rm aerodance-webcam-test
```

CI runs the game's browser flow and Dance Studio's browser-storage, project-loading, video-import and duet tests. The tests that need real-time tracking (`webcam`, `webcam-calibration`, `phone` and Studio's `browser.ts`) drop stale frames on CI's 2-core runners, so run them locally or with the Docker targets above before merging changes to capture, calibration or recording.

The browser flow (`client/tests/ui-flow.browser.ts`) clicks the canvas in design units and reads the state each overlay reports on its `data-*` attributes. It skips GPU rasterization in software-only containers; set `UI_RENDER=1` for a full rendered check on a capable GPU.

Webcam requires **HTTPS or localhost**; a plain HTTP LAN address cannot request
camera access. Models and the matching WASM runtime are prepared during development
startup/build and served locally by both apps. The first preparation downloads
about 46 MB of pinned models; later local builds reuse verified `.cache/` assets.
Only the chosen model loads in the browser. Frames stay local; Dance Studio saves
pose records to browser storage when recording. Stop, switching source, leaving the page, or hiding
the webcam tab releases the camera. Inference uses a worker and prefers CPU when
WebGL is rendered in software; the status shows the active model, delegate, and
tracking rate. Heavy needs more processing capacity; slow results never count as
fresh player detection.

After both builds, `node client/tests/webcam.browser.ts` (with Playwright installed)
checks the actual models, a synthetic two-person camera stream, Studio recording,
export, and game bundle preview. Physical duet accuracy, hardware performance,
and browser/device coverage still need manual validation.

## Phone camera

A phone can be the camera instead of a webcam: pick **Phone camera** with the camera arrows (Connect Client or the calibration screen) and press **Pair phone**. The game shows a QR code for `/phone/#<code>` and the six-digit code to type at `/phone` instead. The phone page (`client/phone/`, `client/src/phone/`) is drawn in-engine like the game: a keypad for the code, then setup with a preview of the camera picture and tracked skeletons or a **Mirror** of the players' glass characters, front/back camera, and the tracking model. **Ready** (or the song starting) blacks out the screen while the phone keeps tracking; a tap brings the preview back.

- **Tracking on the phone, poses over WebRTC.** The phone runs the same `WebcamPoseSource` and MediaPipe models as the game, and sends only the pose records (about 1 KB each) over a WebRTC data channel that never resends late ones. Video leaves the phone only while the game shows a setup preview (calibration, or Connect Client open): a small copy of its camera (at most 320 pixels on its long side, 12 frames a second, 250 kbps) on the connection's video track, under the skeletons from the poses, which can run ahead of it. Camera frames follow the phone's orientation, so a phone held upright tracks in portrait.
- **Clock sync.** The game pings the phone twice a second and places each pose on its own clock from the quickest recent round trip (`packages/pairing/clock.ts`), so scoring and calibration work as they do for a webcam. Records carry `timingMethod: 'remote-clock-sync'` and the error bound in `timing.uncertaintyMs`.
- **Pairing** (`packages/pairing/`): a small Node server (`node packages/pairing/main.ts`, port 3001, running beside nginx in the app container) introduces the two through server-sent events and posts, then drops out; nginx proxies `/pair/` to it, and the Vite dev and preview servers serve it themselves. Rooms are in memory, end a minute after the game stops listening, and take one phone at a time; a phone that reloads or drops reconnects by itself, and the same code re-pairs once a phone has gone (the game frees its place when it loses it). A connected phone keeps tracking if the pairing service restarts. Each side may only relay its own signals, waiting signals are capped, and joins pause for a minute after 300 wrong codes, so codes can't be guessed at speed. Phones and games get a public STUN server; set `PAIRING_ICE_SERVERS` (a JSON array of `RTCIceServer`s) on the app to add a TURN server for networks where the two can't reach each other directly. Anyone who can create a room receives those entries, so prefer TURN credentials that expire. Same Wi-Fi works best.
- **HTTPS.** The phone's camera needs HTTPS, and the phone has to reach the game's address, so a `localhost` game can't pair (the pairing card says so). Test on a deployment (PR previews work), or put the dev server behind an HTTPS tunnel (`npm run dev -- --host` and a tunnel to port 5173).

`client/tests/phone-pairing.test.ts` drives the game's and the phone's ends against the real pairing server with a loopback WebRTC stand-in. After a build, `node client/tests/phone.browser.ts` pairs a phone page with the game in Chromium over real WebRTC and real MediaPipe tracking, calibrates and plays a song from its poses, and reconnects. Real phones, networks and battery life still need manual testing.

## Apple TV (experimental)

[`client-tvos/`](client-tvos/README.md) is a tvOS app that runs the production build on an Apple TV in WebKit, with the autoplay ghost and the Siri Remote. tvOS doesn't let apps use WebKit, so the app reaches it through private API: it installs on your own paired Apple TVs (`npm run tvos -- deploy`) but can never go on the App Store. It runs at about 20 fps on an Apple TV 4K, and the phone camera doesn't work there yet (no WebRTC); its README has the details and the App Store-safe alternatives.

## Shared packages

The dance stages live in [`packages/stages`](packages/stages/README.md) and the glass character, its retargeting and the menu dance capture in [`packages/character`](packages/character/README.md). The game, Dance Studio and the thumbnail renderer share them.

## Thumbnails

27 in-engine 3:2 thumbnails (2160×1440) of the six dance stages, with and without the "aerodance." wordmark, are in `tools/thumbnails/with-logo/` and `tools/thumbnails/no-logo/`. They use the game's own pixel grid, each pixel an exact 4×3 block. See [its README](tools/thumbnails/README.md) to re-render them or add shots.

## Stack

| Layer    | Tech                                      |
| -------- | ----------------------------------------- |
| Language | TypeScript (strict), run directly by Node 24 and Vite |
| Client   | React 19, three.js, @react-three/fiber, Vite |
| Hosting  | Static build served by nginx; a Node pairing service for the phone camera |
| Runtime  | Docker Compose                            |

## In-engine UI

All menus, Song Select, Connect Client and the game screens are drawn on 2D canvases that share the render buffer, so they get the same pixels and stretch as the world. `client/src/ui/useCanvasUI.ts` handles the overlay (canvas texture, design-unit layout, hit testing, press/hover/drag, scrolling, opt-in keyboard navigation with one cursor shared across overlays; `client/src/ui/focusRing.ts` draws its ring) and `client/src/ui/draw.ts` holds the aero drawing kit (bubble pills, glass panels, headers, the title, icons, status lights, progress bars).

- **Fullscreen:** the main menu shows a fullscreen bubble in the bottom-right corner (`client/src/menu/FullscreenButton.tsx`). It slides off the right edge on submenus and slides back in on return to the main menu. Press Esc to exit fullscreen. Safari on macOS is supported, and the existing 16:9 letterboxing and fixed render resolution are preserved.

## Run locally with Docker Compose

To rebuild and deploy the main app locally in the background:

```sh
./deploy.sh
```

The script runs from any working directory, uses Podman when available (otherwise
Docker), and checks that the app responds after startup. Set `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman` to choose the runtime explicitly. Each deployment rebuilds
the app image and replaces the app container so Podman Compose serves the new build.
This script deploys locally; public hosting uses Coolify below.

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build
```

Open http://localhost:3000. The app container also runs the phone camera's pairing server on `127.0.0.1:3001` (`pairing-start.sh`, restarted if it stops), and nginx proxies `/pair/` to it. The local Compose file publishes the app on `127.0.0.1:3000` (override with `PORT`, for example in `.env` copied from `.env.example`). The app always listens on port `3000` inside its container, where nginx serves the build (`nginx.conf`).

## Deploy with Coolify

The base `compose.yaml` publishes no host ports. The app serves the static build on container port `3000`.

1. Create a Git-based application in Coolify with the Docker Compose build strategy, using `compose.yaml` at the repository root. Use normal Compose deployment so Coolify generates the proxy labels and networking.
2. Assign the domain to service `app` with internal port `3000`, for example `https://aerodance.example.com:3000`. Coolify routes HTTPS through Traefik on public port `443` to the app's internal port.
3. Deploy using only the base Compose file. Include `compose.local.yaml` only for local development.

See [Coolify's Docker Compose documentation](https://coolify.io/docs/applications/builds/docker-compose) for deployment and domain configuration.

### Pull request previews

Bee Coolify deploys `dev`, the primary branch, at https://aerodance.tech. Its GitHub App automatically builds previews for repository members' pull requests targeting `dev`, updates them when commits are pushed, and removes them when the PR is closed or merged.

The preview URL template is `{{pr_id}}-aerodance.deathgrips.org`, so PR #3 is available at https://3-aerodance.deathgrips.org. Wildcard DNS for `*.deathgrips.org` routes these hosts to Bee through Cloudflare. Set service `app` domains to internal port `3000` in Coolify; previews inherit that port from the production domain configuration.

## Local development

```sh
npm install
npm run dev
```

- Vite dev server: http://localhost:5173
- `npm run build` builds the game into `dist/`; `npm run preview` serves the build locally.
- `node scripts/play.ts start` keeps the game open in a GPU-rendered headless Chromium for interactive testing: click menu buttons, wait for screens and take screenshots from the command line or a coding agent. See [interactive testing](docs/interactive-testing.md).
- `npm run lint`, `npm run typecheck` and `npm test` are what CI runs first. Browser tests run in Docker in CI (see above); to run one locally after `npm run build`, use `node client/tests/ui-flow.browser.ts`, with `CHROMIUM_PATH` pointing at a Chromium if Playwright's own isn't installed.

### TypeScript

Everything is TypeScript with `strict` on, and nothing is compiled ahead of time: Vite bundles the browser code, and Node runs `.ts` files directly by stripping their types (migration tools, unit tests and scripts). So:

- Use only erasable syntax (no `enum`, `namespace` or constructor parameter properties; `tsconfig.json` enforces this), and `import type` for type-only imports.
- Write relative imports with their real `.ts`/`.tsx` extension. Node can't run `.tsx`, so anything Node imports stays `.ts`.
- Validate untrusted data (JSON files, API bodies, recordings) with the assertion functions next to each format, such as `assertSong` in `packages/pose/song.ts`, instead of casting.
