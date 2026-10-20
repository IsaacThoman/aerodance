// Injected into the game page by the iPhone/iPad app (main.m), before the game's own scripts run.
(() => {
  const post = msg => { try { window.webkit.messageHandlers.aerodance.postMessage(msg); } catch { /* not inside the app */ } };
  const canvas = () => document.querySelector('.canvas-frame canvas');

  // What the app knew when this page started (main.m installScripts): the host state, its copy of
  // the saved scores and settings, and a --drive script.
  const start = globalThis.__aerodanceStart ?? {};
  delete globalThis.__aerodanceStart;

  // The deployed site this app pairs phones through (PhonePoseSource): its pairing server, and the
  // phone page its QR code opens.
  const site = '__SITE__';
  if (site) globalThis.__aerodanceSite = site;

  // What the game should know about the app: interrupted (a phone call, Siri or an alarm has the
  // audio) and tv (the game is on an external display, whose picture is as late as its sound). The
  // page reads globalThis.__aerodanceHost and listens for 'aerodance-host' events; the app calls
  // __aerodanceSetHost whenever either changes.
  const hostState = s => ({ interrupted: !!s?.interrupted, tv: !!s?.tv });
  globalThis.__aerodanceHost = hostState(start.host);
  window.__aerodanceSetHost = s => {
    const next = hostState(s), now = globalThis.__aerodanceHost;
    if (next.interrupted === now.interrupted && next.tv === now.tv) return;
    globalThis.__aerodanceHost = next;
    window.dispatchEvent(new CustomEvent('aerodance-host', { detail: { ...next } }));
  };

  // Saved scores and settings live in localStorage, which WebKit may clear. The app keeps a copy of
  // every aerodance* key: keys the page has lost come back from it here, before the game reads
  // them (never over a key the page still has), and every change is sent to the app.
  const ours = k => typeof k === 'string' && k.startsWith('aerodance');
  try {
    const saved = start.saved ?? {}, restored = Object.keys(saved).filter(k => ours(k) && localStorage.getItem(k) === null);
    for (const k of restored) localStorage.setItem(k, saved[k]);
    // The app bundles only the Lite pose model (scripts/ios.ts), so a webcam model saved as Full or
    // Heavy (which only the phone page offers) goes before the game reads it, and Lite is used.
    const MODEL = 'aerodance-webcam-model', model = localStorage.getItem(MODEL);
    if (model !== null && model !== 'lite') localStorage.removeItem(MODEL);
    const all = model !== null && model !== 'lite' ? { [MODEL]: null } : {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (ours(k)) all[k] = localStorage.getItem(k); }
    post({ storage: all, restored });
    // Changes go to the app in batches: a volume slider being dragged saves on every step, and each
    // message rewrites the app's copy. Hiding the page (the app going to the background) sends at once.
    let changed = {}, timer = 0;
    const flush = () => { clearTimeout(timer); timer = 0; if (Object.keys(changed).length) post({ storage: changed }); changed = {}; };
    const queue = (k, v) => { changed[k] = v; timer ||= setTimeout(flush, 500); };
    addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    addEventListener('pagehide', flush);
    const { setItem, removeItem, clear } = Storage.prototype;
    Storage.prototype.setItem = function (k, v) {
      setItem.call(this, k, v);
      if (this === localStorage && ours(String(k))) queue(String(k), String(v));
    };
    Storage.prototype.removeItem = function (k) {
      removeItem.call(this, k);
      if (this === localStorage && ours(String(k))) queue(String(k), null);
    };
    Storage.prototype.clear = function () {
      const gone = this === localStorage ? Object.keys(this).filter(ours) : [];
      clear.call(this);
      for (const k of gone) queue(k, null);
    };
  } catch { /* storage unavailable */ }

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
  // viewport-fit=cover keeps the page edge to edge, with the notch and home indicator in env(safe-area-inset-*).
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
  const report = msg => { if (reportUrl) fetch(reportUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify(msg) }).catch(() => {}); };
  const R = { type: 'frames', label: 'airplay-ios', device: navigator.userAgent, longFrames: 0,
    // What the game needs from the page's origin: a secure context for song checks and the camera.
    secureContext: window.isSecureContext, subtle: !!globalThis.crypto?.subtle, camera: !!navigator.mediaDevices?.getUserMedia };
  const raf = window.requestAnimationFrame.bind(window);
  let jsMs = 0, jsWorst = 0, draws = 0, frames = 0, prev = performance.now(), last = prev, dts = [], probe = null, firstReport = true;
  if (reportUrl) {
    // JIT check: ~285 ms with JIT, ~565 ms without on an M5 Pro; the ratio matters, not the number.
    const t = performance.now(); let s = 0; for (let i = 0; i < 2e7; i++) s += (i * 1.0000001) % 7;
    R.numericLoopMs = +(performance.now() - t).toFixed(1); R.sink = s > 0;
    window.requestAnimationFrame = cb => raf(ts => { const a = performance.now(); try { cb(ts); } finally { const d = performance.now() - a; jsMs += d; if (d > jsWorst) jsWorst = d; } });
    const G = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
    if (G) for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) { const o = G[m]; G[m] = function (...a) { draws++; return o.apply(this, a); }; }
    addEventListener('keydown', e => { R.lastKey = [e.key, Math.round(performance.now())]; }, true);
    addEventListener('aerodance-host', e => { R.hostEvent = [e.detail, Math.round(performance.now())]; });
    // The safe area as the page sees it (env(safe-area-inset-*)), to check it reaches the page.
    addEventListener('DOMContentLoaded', () => {
      probe = document.createElement('div');
      probe.style.cssText = 'position: fixed; visibility: hidden; pointer-events: none; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
      document.body.append(probe);
    });
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
      // Heat and Low Power Mode come from the app (main.m tellPage).
      const device = window.__aerodanceDevice ?? {};
      Object.assign(R, { jsMsPerFrame: +(jsMs / n).toFixed(2), jsWorstMs: +jsWorst.toFixed(1), drawsPerFrame: Math.round(draws / n),
        dataset: { ...(canvas()?.dataset ?? {}) }, thermal: device.thermal, lowPower: device.lowPower, host: globalThis.__aerodanceHost });
      if (probe) { const c = getComputedStyle(probe); R.safeArea = [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map(parseFloat).join(' '); }
      // The saved scores and settings, once a run, to check they survive.
      if (firstReport) { firstReport = false; R.storage = {}; try { for (const k of Object.keys(localStorage).filter(ours)) R.storage[k] = localStorage.getItem(k); } catch { /* storage unavailable */ } } else delete R.storage;
      if (!R.gl) { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); R.gl = gl ? (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none'; }
      report(R);
    }
    frames = 0; jsMs = 0; jsWorst = 0; draws = 0; dts = []; last = now;
  }, 2000);

  const sleep = ms => new Promise(done => setTimeout(done, ms));

  // --drive runs a script in the Apple TV app's launch-config format (client-tvos/runtime/report.ts),
  // waiting on the canvas's data-* state between steps, plus taps for the touch screen:
  //   ["wait", {"menuReady": "true"}, timeoutMs?], ["key", "Enter"], ["tap", x, y], ["sleep", ms], ["report", mark]
  // Taps use the current layout's design units: 1200×900 (4:3) or 1600×900 (16:9).
  // Each step is reported.
  const tap = (x, y) => {
    const el = canvas(), frame = document.querySelector('.canvas-frame')?.getBoundingClientRect();
    if (!el || !frame) return false;
    const width = el.dataset.displayMode === 'standard' ? 1200 : 1600;
    const at = { clientX: frame.left + (x / width) * frame.width, clientY: frame.top + (y / 900) * frame.height };
    const init = { ...at, bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointermove', { ...init, button: -1 }));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', init));
    return true;
  };
  const drive = async steps => {
    const t0 = performance.now(), label = R.label, dataset = () => ({ ...(canvas()?.dataset ?? {}) });
    for (const [i, step] of steps.entries()) {
      const begun = performance.now();
      if (step[0] === 'key') window.__aerodanceKey(String(step[1]));
      else if (step[0] === 'tap') {
        if (!tap(Number(step[1]), Number(step[2]))) { report({ type: 'error', label, message: `drive step ${i}: no canvas to tap`, dataset: dataset() }); return; }
      } else if (step[0] === 'sleep') await sleep(Number(step[1]));
      else if (step[0] === 'report') R.mark = String(step[1]);
      else if (step[0] === 'wait') {
        const want = step[1] ?? {}, timeout = step[2] ?? 60000;
        const ok = () => { const d = canvas()?.dataset ?? {}; return Object.entries(want).every(([k, v]) => d[k] === String(v)); };
        while (!ok()) {
          if (performance.now() - begun > timeout) { report({ type: 'error', label, message: `drive step ${i}: timed out waiting for ${JSON.stringify(want)}`, dataset: dataset() }); return; }
          await sleep(100);
        }
      } else { report({ type: 'error', label, message: `drive step ${i}: unknown step ${JSON.stringify(step)}` }); return; }
      report({ type: 'drive', label, index: i, step, t: Math.round(performance.now()), waitedMs: Math.round(performance.now() - begun), display: window.__aerodanceDisplay ?? 'phone' });
    }
    report({ type: 'done', label, ms: Math.round(performance.now() - t0) });
  };
  if (Array.isArray(start.drive)) addEventListener('DOMContentLoaded', () => { drive(start.drive); });

  // --flow plays the full-game flow with the remote's keys, for benchmarks (open the game with
  // ?input=ghost): one player (the dial's starting count), the first song, Dance!, then the results. Each step is reported.
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
    report({ type: 'flow', label: R.label, step: name, t: Math.round(now), waitedMs: Math.round(now - since), display: window.__aerodanceDisplay ?? 'phone' });
    // Let a screen settle for a moment before pressing on, as a person would.
    if (key) setTimeout(() => window.__aerodanceKey(key), 1000);
    since = now;
    if (++step === steps.length) clearInterval(flow);
  }, 100);
})();
