# Running aerodance on Apple TV

How the game gets onto an Apple TV, what was tried, and what was measured. All numbers are from
an Apple TV 4K (3rd generation, A15) on tvOS 27.0, rendering the game's 640×480 frame, collected
in October 2026.

## What ships

[`client-tvos/jsc/`](../client-tvos/jsc/README.md) runs the production game's own JavaScript in
the public JavaScriptCore framework, with WebGL 2 implemented on OpenGL ES 3.0 and the 2D canvas
on CoreGraphics. It uses public APIs only, so it can go through App Review. With the `tv` quality
tier (`?quality=tv`, which the app opens) it holds 60 fps on every screen:

| Screen | fps | p95 frame | JavaScript per frame | Draws |
| --- | --- | --- | --- | --- |
| Aero benchmark, `tv` / high / low | 59.9 / 59.8 / 59.9 | 16.7 ms | 6.0 / 6.4 / 6.9 ms | 177 / 191 / 184 |
| Main menu, 45 s idle | 60 | 16.7 ms | 6.5–11.8 ms | 177–272 |
| Club stage preview | 60 | 16.7 ms | 5.4 ms | 113 |
| Gameplay (ghost input) | 60 | 16.7 ms | 5.5 ms | 122 |
| Results | 60 | 16.7 ms | 5.2 ms | 119 |

Opening a stage for the first time stalls for about 5 s while it builds and compiles.

[`client-tvos/`](../client-tvos/README.md) is the same game in tvOS's WebKit, which apps can only
reach through private API: development installs only, never the App Store. It is kept for
comparison and debugging.

## Why JavaScript is slow there

tvOS has no JIT for anyone. A CPU sample of WebKit's WebContent process on the device shows every
JavaScript frame inside JavaScriptCore's interpreter, none in JIT memory; third-party
JavaScriptCore and Hermes have no JIT either. Without one, three.js's per-frame work costs about
16 times as much as on a desktop browser, so the cost of a frame grows with the number of
objects and draws, not with what they draw. The A15's GPU is limited by triangles.

So the game needed both: fewer draws and objects (the Aero world went from about 1,000 draws and
6 M triangles a frame to about 190 draws and 0.9–1.6 M, with instancing, tree cells with culling
and levels of detail, static batching and cheaper grass; desktop quality looks the same), and a
host that doesn't add cost per WebGL call (the JavaScriptCore app writes calls into a shared
command buffer, about 0.2–0.3 µs a call, and replays them on a render thread).

## Everything that was tried

Seven approaches were built and measured in parallel. Frame rates are Aero benchmark high / low,
then the main menu and gameplay. "Original" means the web game before the draw-call work.

| Approach | App Store | Aero high / low | Menu | Gameplay | Notes |
| --- | --- | --- | --- | --- | --- |
| tvOS WebKit (private), original | No | 18.4 / 22.9 | ~20 | ~38 | JS ~24 ms + GPU ~28 ms a frame |
| tvOS WebKit (private), fewer draws + `tv` tier | No | 52.2 / 59.0 (`tv` 59.3) | ~51 | ~58 | WebKit's GPU-process round trips cost the rest |
| JavaScriptCore + OpenGL ES, original | Yes | 35.5 / 41.4 | 30–33 | 58–60 | menu limited by JavaScript |
| **JavaScriptCore + OpenGL ES, fewer draws + `tv` tier** | **Yes** | **59.8 / 59.9** | **60** | **60** | **what ships** |
| Native Swift + Metal, content exported from the web game | Yes | 59.9 / 59.9 (≈200 uncapped) | 60 | 60 | menu and the club stage only; stage animation is a recording |
| React Native (Hermes) + WebGPU (Dawn) + three's `WebGPURenderer` | Yes | 19.8 / 18.4 | 15–23 | ~36 | three's WebGPU renderer costs ~2x the CPU of WebGL without a JIT |
| tvOS WebKit (private) with WebGPU enabled | No | 18.6–20.3 | 18–20 | 36–48 | WebGPU calls cost ~2.5x WebGL calls in tvOS WebKit |
| Streaming from a Mac (WebCodecs H.264 over UDP) | Yes (TV side) | – | 59 | 57 | 53 ms capture to screen, 78 ms press to screen; needs a second device rendering |
| iPhone app (public WebKit, JIT) on the TV via AirPlay | Yes | – | – | – | works in the simulator; not measured on devices; AirPlay adds 100–200 ms |

Other findings:

- The native Metal renderer shows the ceiling: about 6 ms of GPU and 2.4 ms of CPU a frame
  uncapped. Reaching full parity that way (all stages, every screen, live stage logic) was
  estimated at 3–5 weeks, and every content change would need re-exporting.
- Hermes interprets somewhat faster than tvOS's JavaScriptCore (a numeric loop: 0.78–0.99 s
  against 1.09 s); React Native's own JavaScriptCore build was the slowest (1.8 s).
- Apps that serve the game from the same loopback port can load each other's pages on the
  Apple TV; give each app its own port.
- On iOS 27 an app has to register an external-display scene accessory
  (`UISceneAccessory externalNonInteractiveSceneAccessoryWithConfiguration:`) before AirPlay or
  HDMI scenes arrive.

## Not done yet

- Real-phone measurements. The phone camera works through the pairing server's relay (the
  JavaScriptCore app has no WebRTC; see README's Phone camera section), tested with a phone page in
  Chromium against the app in the simulator and on the Apple TV, but not yet with a real iPhone
  over home Wi-Fi.
- OpenGL ES is deprecated on tvOS. If it goes, only the JavaScriptCore app's GL replay layer
  (about 1,000 lines) needs moving to Metal.
- App icon, top shelf image, and an App Store build pipeline.
