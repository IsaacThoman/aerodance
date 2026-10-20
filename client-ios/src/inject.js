// Injected into the game page by the iPhone/iPad app (main.m), before the game's own scripts run.
(() => {
  const post = msg => { try { window.webkit.messageHandlers.aerodance.postMessage(msg); } catch { /* not inside the app */ } };
  const canvas = () => document.querySelector('.canvas-frame canvas');

  // The deployed site this app pairs phones through (PhonePoseSource): its pairing server, and the
  // phone page its QR code opens.
  const site = '__SITE__';
  if (site) globalThis.__aerodanceSite = site;

  // The phone's remote buttons arrive as the key events the canvas UI already understands.
  window.__aerodanceKey = key => {
    const init = { key, code: key, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  };

  // Web Audio on iOS is "ambient" by default: the ring switch mutes it and it doesn't take the
  // AirPlay route. The game is the app's main sound, so make it playback audio.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older WebKit */ }

  // A game, not a page: no pinch or double-tap zoom, no text selection or callouts on long press.
  addEventListener('DOMContentLoaded', () => {
    document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    const style = document.createElement('style');
    style.textContent = '.canvas-frame canvas { touch-action: none; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }';
    document.head.append(style);
  });

  // Tell the app which screen is showing, for the remote's status line.
  const KEYS = ['menuScreen', 'menuReady', 'songScreen', 'songReady', 'gamePhase', 'resultsScreen', 'connectOpen', 'stage'];
  let sent = '';
  setInterval(() => {
    const d = canvas()?.dataset ?? {};
    const page = Object.fromEntries(KEYS.filter(k => d[k] !== undefined && d[k] !== '').map(k => [k, d[k]]));
    const json = JSON.stringify(page);
    if (json !== sent) { sent = json; post({ page }); }
  }, 250);

  // Frame rate, always (for the remote's status line, every two seconds). With a --report URL
  // (scripts/ios.ts --report), also JavaScript time and draw calls per frame, sent to the Mac.
  const reportUrl = '__REPORT_URL__';
  const R = { type: 'frames', label: 'airplay-ios', device: navigator.userAgent, longFrames: 0,
    // What the game needs from the page's origin: a secure context for song checks and the camera.
    secureContext: window.isSecureContext, subtle: !!globalThis.crypto?.subtle, camera: !!navigator.mediaDevices?.getUserMedia };
  const raf = window.requestAnimationFrame.bind(window);
  let jsMs = 0, jsWorst = 0, draws = 0, frames = 0, prev = performance.now(), last = prev, dts = [];
  if (reportUrl) {
    // JIT check: ~285 ms with JIT, ~565 ms without on an M5 Pro; the ratio matters, not the number.
    const t = performance.now(); let s = 0; for (let i = 0; i < 2e7; i++) s += (i * 1.0000001) % 7;
    R.numericLoopMs = +(performance.now() - t).toFixed(1); R.sink = s > 0;
    window.requestAnimationFrame = cb => raf(ts => { const a = performance.now(); try { cb(ts); } finally { const d = performance.now() - a; jsMs += d; if (d > jsWorst) jsWorst = d; } });
    const G = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
    if (G) for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) { const o = G[m]; G[m] = function (...a) { draws++; return o.apply(this, a); }; }
    addEventListener('keydown', e => { R.lastKey = [e.key, Math.round(performance.now())]; }, true);
  }
  const tick = ts => { frames++; const dt = ts - prev; prev = ts; dts.push(dt); if (dt > 25) R.longFrames++; raf(tick); };
  raf(tick);
  setInterval(() => {
    const now = performance.now(), n = Math.max(1, frames);
    const sorted = dts.sort((a, b) => a - b), pct = p => +(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0).toFixed(1);
    Object.assign(R, { t: Math.round(now), fps: +(frames * 1000 / (now - last)).toFixed(1), frameMs: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
      display: window.__aerodanceDisplay ?? 'phone', viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}` });
    post({ fps: R.fps });
    if (reportUrl) {
      Object.assign(R, { jsMsPerFrame: +(jsMs / n).toFixed(2), jsWorstMs: +jsWorst.toFixed(1), drawsPerFrame: Math.round(draws / n),
        dataset: { ...(canvas()?.dataset ?? {}) } });
      if (!R.gl) { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); R.gl = gl ? (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none'; }
      fetch(reportUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify(R) }).catch(() => {});
    }
    frames = 0; jsMs = 0; jsWorst = 0; draws = 0; dts = []; last = now;
  }, 2000);

  // --flow plays the full-game flow with the remote's keys, for benchmarks (open the game with
  // ?input=ghost): One Player, the first song, Dance!, then the results. Each step is reported.
  const flowOn = '__FLOW__';
  if (flowOn !== '1') return;
  const steps = [
    ['menu', d => d.menuScreen === 'main' && d.menuReady === 'true', 'Enter'],
    ['players', d => d.menuScreen === 'players' && d.menuReady === 'true', 'Enter'],
    ['song list', d => d.songScreen === 'list' && d.songReady === 'true' && d.catalog === 'ready', 'Enter'],
    ['preview', d => d.previewState === 'playing' && d.stageReady === 'true', 'Enter'],
    ['countdown', d => d.gamePhase === 'countdown', null],
    ['playing', d => d.gamePhase === 'playing', null],
    ['results', d => d.resultsScreen === 'stage', null],
  ];
  let step = 0, since = performance.now();
  const flow = setInterval(() => {
    const [name, ready, key] = steps[step];
    if (!ready(canvas()?.dataset ?? {})) return;
    const now = performance.now();
    const msg = { type: 'flow', label: R.label, step: name, t: Math.round(now), waitedMs: Math.round(now - since), display: window.__aerodanceDisplay ?? 'phone' };
    if (reportUrl) fetch(reportUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify(msg) }).catch(() => {});
    // Let a screen settle for a moment before pressing on, as a person would.
    if (key) setTimeout(() => window.__aerodanceKey(key), 1000);
    since = now;
    if (++step === steps.length) clearInterval(flow);
  }, 100);
})();
