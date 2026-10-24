# aerodance for iPhone and iPad, on the TV (experimental)

An iPhone and iPad app that runs the production web build in `WKWebView` and shows it on a TV:
an Apple TV through AirPlay, or any TV through an HDMI adapter. While the game is on the TV, the
phone becomes its remote. With no TV it plays on the phone's own screen, by touch.

Unlike the Apple TV app in `apps/tvos/`, this uses public APIs only (WebKit, AVKit, Network, CoreMotion, UniformTypeIdentifiers),
so it can go to the App Store. iOS WebKit also has a JIT, which tvOS
WebKit doesn't, and the game runs on the phone's GPU: the Apple TV only shows the video.

## How it works

`src/main.m` is the whole app:

- **Local server.** The production build (`dist/`) is bundled as `www/` and served from
  `http://127.0.0.1:8417`. Loopback makes the page a secure context, which `crypto.subtle` (song
  bundles) and `getUserMedia` (the camera) need. The port is fixed because saved scores and
  settings belong to the page's origin. Inter, which the web build loads from Google Fonts, is
  bundled too (`scripts/apple.ts`), so the game looks the same offline. Pose tracking uses Lite,
  the only supported model. `src/inject.js` drops retired model preferences from older versions.
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
- **Remote.** While the game is on the TV, the phone shows the remote: a page of the game's own
  (`/remote/`, `apps/web/src/remote/`) in a second web view, drawn in-engine like the game and the
  phone camera page, at the same low resolution. It has arrows around OK, and Back (Pause or
  Resume while a song is on), which the app turns into the key events the canvas UI understands
  (`src/inject.js`), like the Apple TV app does with the Siri Remote. Buttons act on touch, with a
  tap of haptics, and arrows repeat while held. The status line says what the TV shows, and the
  volume is the phone's volume buttons (the TV's, while AirPlaying). The remote loads from the
  local server the first time the game goes to a TV, and again if it can't. Invisible labels over
  the drawn buttons let VoiceOver (and the UI tests) find them; touches go through to the canvas.
- **AirPlay buttons.** The game's main menu (on the phone) and the remote draw an AirPlay button
  in-engine; the app lays an invisible `AVRoutePickerView` over each, where the page says it is
  (`window.__aerodanceAirPlayAt(rect)` from the game, a message from the remote), so a tap opens
  the system's AirPlay menu.
- **Audio** uses the playback category (and `navigator.audioSession.type = 'playback'`), so it
  plays with the ring switch on silent and follows the AirPlay route to the TV.
- **Camera.** The game's own pose tracking (MediaPipe in the page) can use the phone's camera:
  the app has a camera usage description and grants the page's camera requests, video only.
  While the game is on a TV its picture is upright the way the device is held, though the
  iPhone's remote stays upright. WebKit turns camera pictures upright for the screen a web view is on
  (the TV's never turns), one way for the whole app, so the page turns the picture the rest of the
  way itself (`cameraTurner` in `apps/web/src/host.ts`) from the host state's `held` and `screens`.
- The phone doesn't lock while the app is open.
- **App icon.** [`assets/app-icon/aerodance.icon`](../../assets/README.md#phone-app-icons), an Icon
  Composer document, is the app icon (`ASSETCATALOG_COMPILER_APPICON_NAME`). Xcode compiles its
  layers into the Liquid Glass icon, with its dark, tinted and clear looks, and renders flat
  PNGs from it for iOS before 26. Edit it in Icon Composer (in Xcode's Open Developer Tool menu).
- **Screen.** On the iPhone the game is landscape only (the app launches sideways even from a
  portrait home screen); while the game is on a TV, the remote is upright only, and the app turns
  the screen to it however the phone is held (and back to landscape when the TV goes). The iPad
  takes every orientation and window size (Split View, Stage Manager; no `UIRequiresFullScreen`)
  and the page letterboxes itself. The web view is edge to edge (`viewport-fit=cover`), so the
  page gets the notch and home indicator as `env(safe-area-inset-*)`; while the game is on the
  phone, the status bar is hidden and the home indicator hides itself.
- **Host state.** `globalThis.__aerodanceHost` is `{ interrupted, tv, screen, held, screens }`, set before the game's
  scripts run, and every change also fires
  `window.dispatchEvent(new CustomEvent('aerodance-host', { detail: { interrupted, tv, screen, held, screens } }))`.
  `screen` is where the game's picture is: `'phone'` or `'tv'` (wherever the sound goes).
  `held` is which way up the device is held, all in `window.orientation`'s terms: 0 upright, 90
  turned counterclockwise, -90 clockwise, 180 upside down. While the game is on a TV it comes from
  gravity (CoreMotion's accelerometer, which needs no permission), because Orientation Lock keeps
  `UIDevice` upright; lying flat, it's the way it last was. (The simulator has no accelerometer, so
  there it's `UIDevice`'s.) `screens` is `{ game, phone }`: which way up the game's screen
  (the TV's is always upright) and the phone's own are.
  `interrupted` is true from the start to the end of an audio interruption (a call, Siri, an
  alarm); at the end the app reactivates its audio session if iOS says to resume, and the game
  waits for the player's next tap either way. `tv` is true while the game is on an external display and its sound goes
  there too (an AirPlay or HDMI audio route): mirroring delays the TV's picture as much as its
  sound, so the game draws without taking the output latency off its clock there, while judging
  still does (`apps/web/src/audio/songPlayer.ts`). An HDMI picture with the sound on AirPods isn't
  `tv`. The simulator's TV-out screen keeps the sound on the Mac, so `tv` stays false there. A page that loads or reloads later
  (after `webViewWebContentProcessDidTerminate`) starts with the current state.
- **Imported songs.** Settings → Songs imports Dance Studio export ZIPs, as in a browser, but
  the app keeps them, since WebKit may clear the page's storage: as ZIPs in `Documents`, which
  the Files app shows as On My iPhone › aerodance (`UIFileSharingEnabled`), so a song saved
  there from Files, AirDrop or a Mac is imported too, and deleting it there removes it. The local
  server serves the folder under `/app/songs/` (list, read, save in one go, delete) to requests
  with a key made at launch (`X-Aerodance-Key`), which only the game's page gets
  (`globalThis.__aerodanceSongs`): other apps on the device can reach 127.0.0.1 too. The page
  checks every song itself (`apps/web/src/songs/appSongs.ts`). Import song posts
  `{ pickSong: true }` and the app opens the system's file picker on the phone (over the remote
  while the game is on a TV), copies the ZIP for the page to read from `/app/incoming/`, and
  answers with `window.__aerodanceSongPicked({ url, name })` (or `null`). The page's `confirm()`
  and `alert()` (replacing or removing a song) show as the app's alerts, on the phone too.
- **Saved data.** Scores and settings live in the page's `localStorage`. The app also keeps a copy
  of every key starting with `aerodance` in `NSUserDefaults` (per port), updated whenever the page
  changes one, and puts back any key the page has lost before the game starts, in case WebKit
  clears the site's data. A key the page still has is never overwritten.
- **Privacy manifest.** `src/PrivacyInfo.xcprivacy`: no tracking, no data collected (camera frames
  are tracked on the device), and two required-reason APIs: `NSUserDefaults` (reason CA92.1, the
  app's own data) and the imported songs' modification times (C617.1, files in the app's container).

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
npm run ios -- archive --version 0.2.0 --upload   # archive it and upload it to TestFlight
npm run ios -- sim --site https://24.aerodance.party   # pair phones through a PR preview
```

Simulators share the Mac's loopback, so two running the app at once would share port 8417; give
each its own with `--port <port>` (saved scores and settings belong to the port).

## Release builds

Development builds take the launch options above (`--path`, `--report`, `--flow`, `--drive`,
`--clear-website-data`, `--port`, and `--songs-key <key>`, which fixes the imported songs' key for
tests that call the routes themselves), are
inspectable in Safari's Web Inspector, and add `NSAllowsLocalNetworking` to `Info.plist` so
`--report` can reach the Mac. (Every build has `NSLocalNetworkUsageDescription`: a paired phone on
the same Wi-Fi connects to the app directly.) `build --release`
leaves all of that out: it's the configuration an App Store build uses.

`archive --version <x.y.z>` builds that configuration and archives it with that version
(`CFBundleShortVersionString`) and a build number (`CFBundleVersion`: `--build-number`, else the
Unix time, which keeps increasing). It then exports the archive for App Store Connect, signed
by Xcode with the team's cloud-managed distribution certificate: into `build/export/`, or with
`--upload` to App Store Connect, where it appears in TestFlight once processed. Xcode signs in
with the account signed in to Xcode, or with an App Store Connect API key (an Admin key, for the
distribution certificate) when `APP_STORE_CONNECT_API_KEY_PATH` (the `.p8` file),
`APP_STORE_CONNECT_API_KEY_ID` and `APP_STORE_CONNECT_API_ISSUER_ID` are set. Other builds are
`0.1 (1)`.

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
`/bench/aero-bench.html` is the Aero world benchmark (`apps/tvos/bench/`), when it has been built.

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
clang -fobjc-arc -framework Foundation -framework CoreGraphics apps/ios/tools/simscreen.m -o /tmp/simscreen
/tmp/simscreen <simulator UDID> on 1920 1080   # list | on <w> <h> | off
xcrun simctl io <simulator UDID> screenshot --display=external tv.png
```

## Testing

`tests/` has UI tests (XCTest) that drive the installed app in a simulator by its bundle ID, with
real touches: it launches and reaches the main menu, an iPhone holds it in landscape even upright,
Let's dance (for one player, the dial's starting count) and the first song tapped at their `layout.ts` positions open the song preview, an
iPad turns portrait, landscape and back, and a TV connected (through `tools/simscreen.m`) while
the device is held sideways shows the remote with every control on screen, upright on an iPhone,
the game is told how the device is held as it turns (for its camera's picture), and the game comes back in landscape when the TV goes. One plays a whole song on the TV with the
remote's buttons only: the menus, the players dial, Back, Pause and Resume, and the TV going and
coming back mid-song, which the song plays through. The main menu's AirPlay picker sits over the
game's AirPlay bubble. And a song ZIP saved to the app's folder lists in Settings → Songs, Import
song picks one in the system's picker (the same song, so the replace dialog shows), the song
plays from Song Select and survives a relaunch that clears the page's website data, and
removing it deletes its ZIP.

```sh
node scripts/ios.ts sim --device <UDID> --port 8423 --path '/?input=ghost'   # build and install
node apps/ios/tests/ui.ios.ts --device <UDID> --port 8423   # [--out <dir>] [--only test3TapsThroughToSongPreview]
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
