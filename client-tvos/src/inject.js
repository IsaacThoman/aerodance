// Injected into the game page by the Apple TV app (main.m), before the game's own scripts run.
(() => {
  // Remote buttons arrive as key events the canvas UI already understands.
  window.__aerodanceKey = key => {
    const init = { key, code: key, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  };

  // Tell the app whether the main menu is showing, so Menu there returns to the home screen.
  const post = msg => { try { window.webkit.messageHandlers.aerodance.postMessage(msg); } catch { /* not inside the app */ } };
  let atRoot = null;
  setInterval(() => {
    const d = document.querySelector('.canvas-frame canvas')?.dataset ?? {};
    const now = d.menuScreen === 'main' && d.connectOpen !== 'true';
    if (now !== atRoot) { atRoot = now; post({ atRoot: now }); }
  }, 250);

  // Optional diagnostics, sent to the --report URL given at launch (scripts/tvos.ts --report).
  const reportUrl = '__REPORT_URL__';
  if (!reportUrl) return;
  const R = { device: navigator.userAgent, longFrames: 0 };
  const send = () => fetch(reportUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify(R) }).catch(() => {});
  // JIT check: ~285 ms with JIT, ~565 ms without on an M5 Pro; the ratio matters, not the number.
  let t = performance.now(), s = 0; for (let i = 0; i < 2e7; i++) s += (i * 1.0000001) % 7;
  R.numericLoopMs = +(performance.now() - t).toFixed(1); R.sink = s > 0;
  let jsMs = 0, jsWorst = 0, draws = 0, frames = 0, worst = 0, prev = performance.now(), last = prev;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(ts => { const a = performance.now(); try { cb(ts); } finally { const d = performance.now() - a; jsMs += d; if (d > jsWorst) jsWorst = d; } });
  const G = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (G) for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) { const o = G[m]; G[m] = function (...a) { draws++; return o.apply(this, a); }; }
  const tick = ts => { frames++; const dt = ts - prev; prev = ts; if (dt > worst) worst = dt; if (dt > 25) R.longFrames++; raf(tick); };
  raf(tick);
  setInterval(() => {
    const now = performance.now(), n = Math.max(1, frames);
    Object.assign(R, { t: Math.round(now), fps: +(frames * 1000 / (now - last)).toFixed(1), worstFrameMs: +worst.toFixed(1),
      jsMsPerFrame: +(jsMs / n).toFixed(2), jsWorstMs: +jsWorst.toFixed(1), drawsPerFrame: Math.round(draws / n),
      dataset: { ...(document.querySelector('.canvas-frame canvas')?.dataset ?? {}) } });
    if (!R.gl) { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); R.gl = gl ? (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none'; }
    frames = 0; jsMs = 0; jsWorst = 0; draws = 0; worst = 0; last = now;
    send();
  }, 2000);
  addEventListener('keydown', e => { R.lastKey = [e.key, Math.round(performance.now())]; }, true);

  // Optional benchmark drivers, chosen with the page's ?drive= (scripts/tvos.ts --path):
  // drive=menu idles on the main menu for a minute; drive=play goes from the main menu through
  // One Player, the first song's preview and Dance! (play with ?input=ghost) to the results.
  // Each sends {type: 'done'} to the report URL when it's finished.
  const drive = new URLSearchParams(location.search).get('drive');
  if (!drive) return;
  const state = () => document.querySelector('.canvas-frame canvas')?.dataset ?? {};
  const steps = drive === 'menu'
    ? [{ when: d => d.menuScreen === 'main' && d.menuReady === 'true', hold: 60000 }]
    : [
        { when: d => d.menuScreen === 'main' && d.menuReady === 'true', hold: 20000, key: 'Enter' },
        { when: d => d.menuScreen === 'players' && d.menuReady === 'true', hold: 1000, key: 'Enter' },
        { when: d => d.songScreen === 'list' && d.songReady === 'true' && d.catalog === 'ready', hold: 1000, key: 'Enter' },
        { when: d => d.songScreen === 'preview' && d.previewState === 'playing' && d.stageReady === 'true', hold: 15000, key: 'Enter' },
        { when: d => d.gamePhase === 'ready', hold: 1000, key: 'Enter' },
        { when: d => d.gamePhase === 'results', hold: 15000 },
      ];
  let step = 0, since = 0;
  const started = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const s = steps[step];
    if (!since && s.when(state())) since = now;
    if (since && now - since >= s.hold) {
      if (s.key) window.__aerodanceKey(s.key);
      step++; since = 0;
      R.driveStep = step;
    }
    if (step === steps.length || now - started > 600000) {
      clearInterval(timer);
      setTimeout(() => fetch(reportUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ type: 'done', drive, steps: step }) }).catch(() => {}), 2100);
    }
  }, 100);
})();
