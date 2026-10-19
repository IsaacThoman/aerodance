# aerodance for Apple TV (experimental)

A tvOS app that runs the production web build on an Apple TV, in WebKit's `WKWebView`. It plays
with the autoplay ghost (`?input=ghost`) and the Siri Remote; there is no camera input yet.

**This is for development installs only. It can never ship on the App Store or TestFlight.**
WebKit isn't part of the public tvOS SDK, although tvOS ships it, so the app loads it at runtime
and drives it through the Objective-C runtime. App Store Review Guideline 2.5.1 allows public APIs
only, and builds that reference non-public APIs are refused on upload (`ITMS-90338`) or in review.
Installing a development build on your own registered Apple TVs is fine. Apple can also change
or remove the private WebKit in any tvOS update.

## How it works

`src/main.m` is the whole app:

- **Local server.** The production build (`dist/`, without the pose-tracking models, since the
  Apple TV has no camera) is bundled as `www/` and served from `http://127.0.0.1:8417`. Loopback
  makes the page a secure context, which `crypto.subtle` needs to verify song bundles. The port is
  fixed because saved scores and settings belong to the page's origin.
- **Web view.** A full-screen `WKWebView` that ignores the TV safe area. Media can play without a
  tap, which also lets Web Audio start.
- **Remote.** The web view doesn't turn remote presses into key events, so the app does, through
  `src/inject.js`. Clicking or swiping moves the focus ring (arrow keys), clicking the centre
  presses (Enter), and Menu or Play/Pause goes back or pauses (Escape). On the main menu, Menu is
  left to tvOS, which returns to the home screen.
- **No screen saver** while the app is open.

## Requirements

- A Mac with Xcode 27 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- An Apple TV on tvOS 27, paired with the Mac. On the Apple TV, open Settings → Remotes and
  Devices → Remote App and Devices; then pair from Xcode's Devices window, or run
  `xcrun devicectl manage pair --device <name>` and type the code the TV shows.
- A paid Apple Developer team, signed in to Xcode. Builds use `TVOS_TEAM_ID` (default
  `PX72AL9366`) and `TVOS_BUNDLE_ID` (default `com.isaacthoman.aerodance.tv`); other teams need
  their own bundle ID. The first build registers the Apple TV with the team. tvOS may ask you to
  turn on Developer Mode (Settings → Privacy & Security) and restart.

## Deploy

```sh
npm run tvos -- devices                      # paired Apple TVs
npm run tvos -- deploy                       # build the game and the app, install, launch
npm run tvos -- deploy --report              # ...and print frame stats every two seconds
npm run tvos -- launch --path '/' --report   # relaunch the installed app on another page
```

`--device <name>` picks the Apple TV when more than one is paired. The app is signed with a
development profile, which lasts about a year; deploy again to renew it.

`--report` sends the frame rate, the JavaScript time per frame and the draw calls per frame from
the Apple TV to this Mac (port 8765), along with a short JavaScript loop benchmark taken at
launch, and any errors the page throws. Opened from the home screen, the app reports nothing.

With `--report`, `?drive=` in the page drives the game for a benchmark and reports
`{"type":"done"}` when it's finished: `--path '/?drive=menu'` idles on the main menu for a
minute, `--path '/?input=ghost&drive=play'` goes from the main menu through One Player, the first
song's preview and Dance! to the results.

The app sets the game's `tv` graphics tier (see `client/src/quality.ts`); `?quality=high` in
the page overrides it. Each app on an Apple TV needs its own `TVOS_PORT` (default 8417) for the
page's local server, or one app's page can be served by another app's server.

## What doesn't work yet

- **Phone camera.** tvOS WebKit has no WebRTC (`RTCPeerConnection` is missing), which the phone
  link uses. A WebSocket relay through the pairing server would replace it
  (`packages/pairing/browser/peer.ts` already takes the connection as a parameter).
- **Webcam.** The Apple TV has no camera API for the web view.
- **Speed.** On an Apple TV 4K (3rd generation, A15, tvOS 27.0) the main menu runs at about
  15 fps at `a1e8312` and about 20 fps after the Aero tree and lake changes in `554887b`. It
  spends about 25–30 ms of JavaScript on about 900 draw calls a frame (about 3.5 ms in the tvOS
  simulator on an M5 Pro). The launch benchmark takes about 1,050–1,230 ms against 283 ms with a
  JIT and 565 ms without one on the M5 Pro, which suggests tvOS WebKit runs JavaScript without a
  JIT; that is inferred from timing, not confirmed. Fewer draw calls is the main lever.
  Since then the Aero world draws about 200 objects a frame instead of 1,000 (instanced clouds,
  gulls, butterflies, bubbles, boats and balloons; batched static meshes) and about 1–2 million
  triangles instead of 6 (trees culled and simplified by area), and the app picks the `tv` tier:
  the main menu runs at about 45–50 fps over the meadow (JS about 10 ms a frame) and a song at
  about 55 fps. Downtown, where the lake reflection doubles the work, is the slowest stretch.
  Both the JavaScript and the GPU (mostly vertex work: trees, grass) still matter there.
- **First stage load.** In the simulator, the first visit to a stage stalled for 15–20 seconds
  while its shaders compiled, and about 2 seconds once WebKit's shader cache was warm. tvOS can
  purge that cache.
- **Saves.** WebKit keeps site data under the app's `Library/`, which tvOS may purge; best scores
  and settings would need copying to `NSUserDefaults` or iCloud to be safe.
- **App icon.** None yet, so the home screen shows a blank tile.

## Getting it onto the App Store

That needs public APIs only, which rules out WebKit on tvOS. The options:

- An iPhone/iPad app (where `WKWebView` is public) that shows the game on the Apple TV as an
  AirPlay external display. Same code; adds the AirPlay delay.
- A tvOS app that runs the game's JavaScript in the public JavaScriptCore (or Hermes) with native
  graphics (three.js's WebGPU renderer on Dawn, or WebGL over Metal) and Skia for the canvas UI.
  No JIT there either, so expect speeds like this app's.
- A native renderer (Swift with RealityKit or Metal, or an engine such as Godot or Unity).
- Streaming video from an iPad or Mac to a tvOS player app.
