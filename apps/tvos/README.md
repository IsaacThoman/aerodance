# aerodance for Apple TV on JavaScriptCore (experimental)

A tvOS app that runs the game's own JavaScript in the public `JavaScriptCore.framework`, with
WebGL 2 implemented on OpenGL ES 3.0 and the 2D canvas on CoreGraphics. It uses public APIs only
(tvOS's WebKit is private), so it could go to the App Store. OpenGL ES is deprecated on tvOS but
still ships.

It runs the production game unmodified (`apps/web/src/main.tsx`: React DOM, React Three Fiber,
three.js) and the Aero benchmark (`apps/tvos/bench/`), with a paired phone as the camera and
the Siri Remote.

## How it works

- **`src/Host.mm`**: a thread with a run loop that owns a JavaScriptCore context. It evaluates
  `runtime.js` and then the app's script, calls `requestAnimationFrame` callbacks from a
  `CADisplayLink`, runs timers, and exposes the natives in `runtime/native.ts` as JSC C API
  callbacks: command submission, image decoding (ImageIO), bundled files and HTTP, storage
  (`NSUserDefaults`), digests (CommonCrypto), fonts and text measuring (CoreText).
- **`runtime/`**: a small browser. `dom.ts` is enough of the DOM for React DOM and R3F's
  `<Canvas>`; `web.ts` has timers, `fetch`, `URL`, `Blob`, `TextEncoder`, storage and crypto;
  `audio.ts` is the Web Audio the game uses (gain automation, buffer sources, `decodeAudioData`)
  over the mixer in `src/Audio.mm`.
- **WebGL 2** (`runtime/webgl.ts`): calls that return nothing are encoded into a command buffer
  in shared memory (`runtime/ops.ts` lists the commands); object handles are numbered in
  JavaScript, so creating a buffer or texture doesn't wait. The buffer is handed over once a
  frame; calls that need an answer (`getParameter`, link status, `readPixels`) hand it over
  first and wait. `src/Executor.mm` runs the GL commands; WebGL's default framebuffer is an FBO
  (4x MSAA when antialiased) resolved into a `CAEAGLLayer` on present.
- **2D canvas** (`runtime/canvas2d.ts`, `src/Canvas2D.mm`): drawn by CoreGraphics in the same
  command stream, so a texture made from a canvas always sees what was drawn before it.
- **Modes** (`mode` in the launch config): `2` runs the commands on a render thread a frame
  behind (the default), `1` on the JavaScript thread at the end of each frame, `0` as each call
  is made (one native call per WebGL call, for comparison).

The game is built as one classic script (`vite.config.ts`), since the host has no module
loader. Fonts are bundled: Inter (as the web build loads it from Google Fonts) and Nunito.

## The phone camera

The Apple TV has no camera, so the camera is a phone, paired as on the web (README's Phone
camera section): Enter on the calibration screen shows a QR code for the deployed site's
`/pair/#<code>`. The app has no WebRTC, so the phone's poses and
its preview pictures come through the pairing server's relay (`packages/pairing/relay.ts`), on
the runtime's `WebSocket` and `EventSource` (`runtime/net.ts`, `src/Net.mm`, on URLSession).
`site` in the launch config (`build --site`) is that deployed game: its pairing server, and the
phone page the QR code opens. The app has no webcam, so the phone is its camera from the start.

## Build and run

Requirements:

- A Mac with Xcode 27 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- An Apple TV 4K of any generation on tvOS 26 or later (the first generation, from 2017, stops at
  tvOS 26), paired with the Mac. tvOS has no device capability that excludes the Apple TV HD
  (A8), so it can install the app too, but it isn't supported. On the Apple TV, open Settings →
  Remotes and Devices → Remote App and Devices; then pair from Xcode's Devices window, or run
  `xcrun devicectl manage pair --device <name>` and type the code the TV shows. The tvOS
  simulator needs none of this.
- A paid Apple Developer team, signed in to Xcode. Builds use `TVOS_TEAM_ID` (default
  `PX72AL9366`) and `TVOS_BUNDLE_ID` (default `com.isaacthoman.aerodance`, shared with the
  planned iPhone and iPad app so they're one App Store listing); other teams need their own
  bundle ID. The first build registers the Apple TV with the team. tvOS may ask you to turn on
  Developer Mode (Settings → Privacy & Security) and restart.

`npm run tvos -- <command>` is the same as `node scripts/tvos.ts <command>`.

```sh
node scripts/tvos.ts build --game              # runtime, benchmark and game; app for the Apple TV
node scripts/tvos.ts build --game --sim        # ...for the tvOS simulator
node scripts/tvos.ts build --game --release    # the release configuration (see below)
node scripts/tvos.ts archive --version 0.2.0 --upload   # archive it and upload it to TestFlight
node scripts/tvos.ts build --game --site https://24.aerodance.party   # pair through a PR preview
node scripts/tvos.ts build --game --ghost      # play with the autoplay ghost instead of a phone
node scripts/tvos.ts run --device <udid> --config '{"script":"game.js","url":"http://aerodance.local/","site":"https://aerodance.party","fit":"fill","pixelated":true}'
node scripts/tvos.ts run --sim <udid> --config '{"script":"bench/aero-bench.js","fit":"contain","bench":{}}'
```

Without `--config` (and when opened from the home screen) the app runs `www/config.json`: the
game after `build --game`, the Aero benchmark otherwise.

The home-screen icon is a layered parallax icon from [`assets/tv-icon`](../../assets/README.md)
(`ICON` in `scripts/tvos.ts`, now `falls-sky-soft-glass`). `build` turns its layers into the App
Store and home-screen image stacks in `src/generated/Assets.xcassets`.

The static Top Shelf banner is Meadow duet from [`assets/top-shelf`](../../assets/README.md#top-shelf-banners)
(`TOP_SHELF` in `scripts/tvos.ts`). `build` copies the standard and wide renders at 1× and 2×
into the same brand asset, so tvOS displays the meadow when the app is selected in the top row.

The launch screen is [`assets/splash1-logo.png`](../../assets/README.md) (`SPLASH` in
`scripts/tvos.ts`). The app keeps it up until the game's menu has faded in (`ready` in
`runtime/native.ts`), so it covers the first seconds of loading, then fades it out.

`node apps/tvos/tests/phone.tvos.ts` (after `npm run build` and `build --game --sim`)
pairs a phone page in Chromium, with a synthetic camera and the real MediaPipe model, with the
app in a tvOS simulator through a local pairing server, and plays the game from it: pairing and
the phone's picture on the calibration screen, calibration, a song scored from its poses, and
the phone reloading. The simulator draws OpenGL ES in software, about a frame a second on the
stage, so a run there takes several minutes. `--device <udid>` (after `build --game`) runs it on
an Apple TV, and `--site <origin>` pairs through a deployed site such as a PR preview.

The launch config (JSON):

| Key | Meaning |
| --- | --- |
| `script` | The script to run, under `www/`: `game.js`, `bench/aero-bench.js`, `bench/bridge.js`, `bench/canvas-test.js` |
| `url` | The page's URL (`location`); its origin maps to the bundled files |
| `site` | The deployed game's origin, where phones pair (`globalThis.__aerodanceSite`) |
| `mode` | `0` direct, `1` batched, `2` threaded (default) |
| `fit`, `pixelated` | `fill` stretches the canvas to the screen (the game), `contain` letterboxes it |
| `bench` | Runs the Aero benchmark with this `__benchConfig`; reports gain host timings |
| `report` | URL that benchmark results, or the game's frame stats every 2 s, are POSTed to |
| `drive` | Remote key presses for unattended runs, waiting on the canvas's `data-*` state: `[["wait", {"menuReady": "true"}], ["key", "Enter"], ...]` |
| `logUrl` | URL that console output is POSTed to |
| `fps` | Caps the frame rate (default 60); 30 paces evenly when frames take 20–40 ms |
| `gpuTiming` | `glFinish` after every frame, to time the GPU |
| `glDebug` | Check `glGetError` after every GL command |

`launch` with `devicectl ... --console` attaches a debugger, which makes JavaScript about 1.5x
slower; measure without it and read the console through `logUrl`.

## Performance

On an Apple TV 4K (3rd generation, A15, tvOS 27) the game holds 60 fps on every screen:
about 6 ms of JavaScript a frame on the main menu (up to ~12 ms while the city is in view), about
5.5 ms in gameplay, and the Aero benchmark at 59.9 fps. JavaScript runs interpreted (no JIT on
tvOS), so frame cost tracks the number of objects and draws. The first visit to a stage stalls
for about 5 s while it builds. [docs/apple-tv.md](../../docs/apple-tv.md) has the measurements
and how this compares with the other approaches. The 1st (A10X) and 2nd (A12) generations
haven't been measured on hardware yet.

## Release builds

Development builds add `NSLocalNetworkUsageDescription` and `NSAppTransportSecurity`
`NSAllowsLocalNetworking` to `Info.plist`, so the `report` and `logUrl` options can reach a Mac on
the local network. `build --release` leaves both out, which is what an App Store build should ship;
the report and log options then have nowhere to send to and stay off. The shipped game pairs phones
through `site` over HTTPS. `src/PrivacyInfo.xcprivacy` is the privacy manifest: no tracking, no
data collected, and two required-reason APIs, `NSUserDefaults` for storage (CA92.1) and
`mach_absolute_time` for the clock (35F9.1).

`archive --version <x.y.z>` bundles the game as `build --game --release` does and archives the app,
then exports it for App Store Connect, or uploads it to TestFlight with `--upload`; the iPhone and
iPad app's README (Release builds) has the build number and signing details.

## Known gaps

- The phone camera needs the pairing server for as long as it's paired (the relay), and the
  phone's preview pictures pass through it.
- The `DynamicsCompressor` is a pass-through with a hard clip at full scale.
- `KHR_parallel_shader_compile` isn't offered, so shaders compile on first use, as in WebKit.
