# aerodance for iPhone and iPad, on the TV (experimental)

An iPhone and iPad app that runs the production web build in `WKWebView` and shows it on a TV:
an Apple TV through AirPlay, or any TV through an HDMI adapter. While the game is on the TV, the
phone becomes its remote. With no TV it plays on the phone's own screen, by touch.

Unlike the Apple TV app in `client-tvos/`, this uses public APIs only (WebKit, AVKit,
MediaPlayer, Network), so it can go to the App Store. iOS WebKit also has a JIT, which tvOS
WebKit doesn't, and the game runs on the phone's GPU: the Apple TV only shows the video.

## How it works

`src/main.m` is the whole app:

- **Local server.** The production build (`dist/`) is bundled as `www/` and served from
  `http://127.0.0.1:8417`. Loopback makes the page a secure context, which `crypto.subtle` (song
  bundles) and `getUserMedia` (the camera) need. The port is fixed because saved scores and
  settings belong to the page's origin. Inter, which the web build loads from Google Fonts, is
  bundled too (`scripts/apple.ts`), so the game looks the same offline. Of the pose-tracking
  models only Lite comes along: it's the one the game's camera uses (the Full and Heavy choices
  are on the phone page, which the app doesn't open), and `src/inject.js` drops a saved choice of
  the others so the camera uses Lite.
- **Keeping the server up.** iOS can take a suspended app's listening socket back, and another app
  can hold the port at launch. The server listens on 127.0.0.1 only; whenever it fails or stops it
  starts again (after 0.25 s, backing off to 8 s), and on returning to the foreground it's
  restarted at once if it isn't ready. Pages only load from a ready server, and a page that
  couldn't load, or finished while the server was down, loads again once it's back.
- **Phone camera.** A phone pairs through the deployed site (`--site`, default
  https://aerodance.party) as with the Apple TV app: the build writes it to `www/app.json` and
  `src/inject.js` sets `globalThis.__aerodanceSite`.
- **One web view, two screens.** When a display connects, iOS gives the app a second window scene
  (role `UIWindowSceneSessionRoleExternalDisplayNonInteractive`, registered with
  `UIViewController.registerSceneAccessory` on iOS 27, which no longer offers it otherwise).
  The game's web view moves into that scene's window and keeps running; nothing reloads. The page
  chooses 4:3 or 16:9 letterboxing for the available screen. When the display goes, the web view moves back to the phone.
- **Remote.** While the game is on the TV, the phone shows arrows, OK and Back (Pause during a
  song), which `src/inject.js` turns into the key events the canvas UI understands, like the
  Apple TV app does with the Siri Remote. Arrows repeat while held. Below them are the system
  volume (the TV's, while AirPlaying) and an AirPlay button. The status line shows the TV's
  resolution, the current screen and the frame rate.
- **Audio** uses the playback category (and `navigator.audioSession.type = 'playback'`), so it
  plays with the ring switch on silent and follows the AirPlay route to the TV.
- **Camera.** The game's own pose tracking (MediaPipe in the page) can use the phone's camera:
  the app has a camera usage description and grants the page's camera requests, video only.
- The phone doesn't lock while the app is open.
- **Screen.** On the iPhone the game is landscape only (the app launches sideways even from a
  portrait home screen); while the game is on a TV, the remote is upright only, and the app turns
  the screen to it however the phone is held (and back to landscape when the TV goes). The iPad
  takes every orientation and window size (Split View, Stage Manager; no `UIRequiresFullScreen`)
  and the page letterboxes itself. The web view is edge to edge (`viewport-fit=cover`), so the
  page gets the notch and home indicator as `env(safe-area-inset-*)`; while the game is on the
  phone, the status bar is hidden and the home indicator hides itself.
- **Host state.** `globalThis.__aerodanceHost` is `{ interrupted, tv }`, set before the game's
  scripts run, and every change also fires
  `window.dispatchEvent(new CustomEvent('aerodance-host', { detail: { interrupted, tv } }))`.
  `interrupted` is true from the start to the end of an audio interruption (a call, Siri, an
  alarm); at the end the app reactivates its audio session if iOS says to resume, and the game
  waits for the player's next tap either way. `tv` is true while the game is on an external display and its sound goes
  there too (an AirPlay or HDMI audio route): mirroring delays the TV's picture as much as its
  sound, so the game draws without taking the output latency off its clock there, while judging
  still does (`client/src/audio/songPlayer.ts`). An HDMI picture with the sound on AirPods isn't
  `tv`. The simulator's TV-out screen keeps the sound on the Mac, so `tv` stays false there. A page that loads or reloads later
  (after `webViewWebContentProcessDidTerminate`) starts with the current state.
- **Saved data.** Scores and settings live in the page's `localStorage`. The app also keeps a copy
  of every key starting with `aerodance` in `NSUserDefaults` (per port), updated whenever the page
  changes one, and puts back any key the page has lost before the game starts, in case WebKit
  clears the site's data. A key the page still has is never overwritten.
- **Privacy manifest.** `src/PrivacyInfo.xcprivacy`: no tracking, no data collected (camera frames
  are tracked on the device), and `NSUserDefaults` (reason CA92.1, the app's own data) as the one
  required-reason API.

## Requirements

- A Mac with Xcode 27 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- An iPhone or iPad on iOS 17 or later, paired with the Mac (Xcode's Devices window), with
  Developer Mode on.
- A paid Apple Developer team, signed in to Xcode. Builds use `IOS_TEAM_ID` (default
  `PX72AL9366`) and `IOS_BUNDLE_ID` (default `com.isaacthoman.aerodance`, the Apple TV app's, so
  the two are one App Store listing with universal purchase).

## Deploy

```sh
npm run ios -- devices                       # paired iPhones and iPads
npm run ios -- deploy                        # build the game and the app, install, launch
npm run ios -- deploy --report               # ...and print frame stats every two seconds
npm run ios -- launch --path '/?input=ghost' --report --flow   # play a song by itself
npm run ios -- sim --device <simulator>      # the same in a simulator
npm run ios -- build --release               # the release configuration (see Release builds)
npm run ios -- sim --site https://24.aerodance.party   # pair phones through a PR preview
```

Simulators share the Mac's loopback, so two running the app at once would share port 8417; give
each its own with `--port <port>` (saved scores and settings belong to the port).

## Release builds

Development builds take the launch options above (`--path`, `--report`, `--flow`, `--drive`,
`--clear-website-data`, `--port`), are
inspectable in Safari's Web Inspector, and add `NSAllowsLocalNetworking` to `Info.plist` so
`--report` can reach the Mac. (Every build has `NSLocalNetworkUsageDescription`: a paired phone on
the same Wi-Fi connects to the app directly.) `build --release`
leaves all of that out: it's the configuration an App Store build will use, but not yet an App
Store build. Archiving and exporting, uploading to TestFlight, an app icon and build numbers
(`CFBundleVersion` is always 1) come later.

`--report` sends the frame rate, the 95th-percentile frame time, the JavaScript time per frame,
the draw calls per frame and the device's thermal state (`ProcessInfo.thermalState`, and Low Power
Mode) to this Mac (port 8766); `--report-to <url>` sends them elsewhere. It also prints the page's
safe area insets, the host state and the saved keys.
`--flow` presses through one player (the dial's starting count), the first song and Dance! to the results, for benchmarks.
`--drive '<json>'` plays steps in the Apple TV app's format, waiting on the canvas's `data-*`
state between them, plus taps in the current canvas layout's design units: 1200×900 for Standard (4:3),
1600×900 for Widescreen (16:9), reported as `dataset.displayMode`. Each step is reported:

```sh
npm run ios -- sim --path '/?input=ghost' --report --drive '[["wait", {"menuScreen": "main", "menuReady": "true"}], ["tap", 348, 534], ["wait", {"menuScreen": "players"}, 5000], ["key", "Enter"], ["sleep", 500], ["report", "mark"]]'
```

`--clear-website-data` deletes the page's website data before it loads, to check that saved
scores and settings come back from the app's copy.
`/bench/aero-bench.html` is the Aero world benchmark (`client-tvos/bench/`), when it has been built.

## Playing on an Apple TV

1. Open aerodance on the phone.
2. Open Control Center, tap Screen Mirroring and choose the Apple TV. The game moves to the TV
   and the phone shows the remote. (The app's AirPlay button picks where the sound goes; whether
   it also starts Screen Mirroring hasn't been checked.)
3. To stop, choose Stop Mirroring in Control Center; the game comes back to the phone.

An HDMI adapter works the same way, without step 2.

## Testing the TV screen in the simulator

The iOS simulator has a TV-out screen that Simulator.app's I/O → External Displays menu turns on.
Without Simulator.app, `tools/simscreen.m` does the same through CoreSimulator (a Mac-only test
tool; the app doesn't use it):

```sh
clang -fobjc-arc -framework Foundation -framework CoreGraphics client-ios/tools/simscreen.m -o /tmp/simscreen
/tmp/simscreen <simulator UDID> on 1920 1080   # list | on <w> <h> | off
xcrun simctl io <simulator UDID> screenshot --display=external tv.png
```

## Testing

`tests/` has UI tests (XCTest) that drive the installed app in a simulator by its bundle ID, with
real touches: it launches and reaches the main menu, an iPhone holds it in landscape even upright,
Let's dance (for one player, the dial's starting count) and the first song tapped at their `layout.ts` positions open the song preview, an
iPad turns portrait, landscape and back, and a TV connected (through `tools/simscreen.m`) while
the device is held sideways shows the remote with every control on screen, upright on an iPhone,
and the game comes back in landscape when the TV goes.

```sh
node scripts/ios.ts sim --device <UDID> --port 8423 --path '/?input=ghost'   # build and install
node client-ios/tests/ui.ios.ts --device <UDID> --port 8423   # [--out <dir>] [--only test3TapsThroughToSongPreview]
```

`ui.ios.ts` generates the test project (`tests/project.yml`) in a temporary directory and runs
`xcodebuild test`. The game draws its UI on a canvas, so the tests wait on its `data-*` state,
which the app reports (`--report`) to a small server in `ui.ios.ts`, and tap design units mapped
into the game's 16:9 frame, found in a screenshot. Screenshots go to `--out` (default
`aerodance-ios-ui` in the system's temporary directory).

Development builds also let you take the local server away, as iOS might, to check it comes back:

```sh
xcrun simctl spawn <UDID> notifyutil -p aerodance.drop-server   # stops it for 4 s
xcrun simctl spawn <UDID> notifyutil -p aerodance.reload        # meanwhile, reload the page
```

## What doesn't work yet

- **AirPlay delay.** Screen Mirroring adds video and audio latency (both delayed together, so
  they stay in sync with each other). Judging takes WebKit's reported output latency off the
  song clock (`tv` above); whether WebKit reports the AirPlay latency there is unmeasured.
- **Other apps' audio at launch.** The app uses the playback audio category, and the game's audio
  context starts with the page, so opening aerodance may stop music or a podcast that was playing
  before any song does. Unchecked on a device.
- **Camera while on the TV.** Tracking on the phone that also renders and encodes the mirror is
  untested for speed, and the phone must face the player, which makes it a poor remote.
- **App icon.** None yet.
