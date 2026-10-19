# Aero world benchmark

A benchmark that any JavaScript host can run, for comparing ways of running aerodance on Apple TV.
`aeroBench.ts` builds the game's Aero world (the menu background: plain three.js, 640×480, no
React) and measures it at high and then low quality.

```sh
node scripts/tvos.ts bench     # → client-tvos/bench/dist/aero-bench.{html,js}
```

`deploy` ships the bundle in the Apple TV app at `/bench/aero-bench.html`. Query parameters
`?scenarios=high,low&warmupS=5&measureS=30&label=…&report=<url>` configure it in a page.

## Host contract

The bundle is a classic IIFE script. It needs:

- a canvas: `globalThis.__benchCanvas`, else the page's first `<canvas>`, else
  `document.createElement('canvas')`. It needs `getContext('webgl2')`, and the Aero world draws
  some textures on 2D canvases made with `document.createElement('canvas')`;
- `requestAnimationFrame` and `performance.now`.

Hosts without `location` can configure it with `globalThis.__benchConfig` (same keys as the
query parameters, plus `width` and `height`) before the script runs. Results go to
`globalThis.__benchReport(json)` when the host defines it, otherwise POSTed to
`globalThis.__benchReportUrl` (or `?report=`), and always to `console.log` with a `BENCH ` prefix.

## Reports

One JSON object per message:

- `{"type":"start", label, loopMs, config, userAgent}`. `loopMs` times a tight numeric loop:
  about 285 ms with a JIT and 565 ms without on an M5 Pro. Only compare it between hosts on the
  same device.
- `{"type":"scenario", label, gpu, scenario: "aero-high" | "aero-low", fps, frameMs: {p50, p95,
  p99, max}, cpuMs: {mean, p95}, drawsPerFrame, trianglesPerFrame, buildMs, firstFrameMs}`.
  `cpuMs` is the time spent in the world's update and render calls. It counts JavaScript and
  WebGL command submission, not the GPU's own work.
- `{"type":"done", label, results: [...]}`, or `{"type":"error", message}`.
