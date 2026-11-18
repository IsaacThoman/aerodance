import { chooseSource } from './codec.ts';
import { holdsVideo, onMotionChange, pauseButton, reducedMotion, watchVisible } from './motion.ts';

// The stage viewer. Each stage has a still and a short clip; the tabs choose one, and left alone
// the viewer tours them: it plays each stage's clip and moves on to the next. The tour stops while
// the page holds still (src/motion.ts), and its button is one of the page's pause buttons: it stops
// and starts the tour along with everything else that moves. The tabs still change stage while
// it's stopped.
//
// A change of stage never waits on screen for a clip to load. The next stage's clip loads, whole,
// while the one before plays (only that one: they're megabytes each), is started out of sight to
// see that it plays, and comes in only once it's showing new frames: the clip on show fades out
// over it, playing on until it's gone. A clip that's late leaves the one on show playing, round
// again if need be, until it's ready. The tour runs on the clock of the clip on show, not a timer,
// and cuts on the footage's own beat: each clip comes in FADE seconds before the end of the one
// before, and the clips are cut so that those last and first FADE seconds are the same moment of
// the song.

/** The crossfade from one stage to the next, in seconds. stages.css reads it as --fade. */
const FADE = 0.6;
/** A stage whose clip won't play shows its still this long instead. */
const STILL = 6.5;
/** How long before its fade the next clip is started out of sight, to see that it plays. */
const WARM = 1;
const STEPS: Record<string, number | undefined> = { ArrowRight: 1, ArrowLeft: -1 };

// Each stage's full-size still. Only the first is in the page to begin with: the others start as
// their thumbnail and get theirs when they're about to be shown.
const STILLS = import.meta.glob<string>('../media/stages/*.webp', { eager: true, query: '?url', import: 'default' });

type Clip = {
  tab: HTMLButtonElement;
  slide: HTMLElement;
  video: HTMLVideoElement;
  /**
   * On its way in: not started; started out of sight to see that it plays; seen to, and paused
   * back at its start to wait for its cue; or started again on its cue.
   */
  phase: 'idle' | 'warming' | 'held' | 'starting';
  /** Its clip: not asked for; on its way; here, whole; or loading as the browser sees fit (not to be fetched). */
  loading: 'no' | 'fetching' | 'whole' | 'streaming';
  /** It won't play (refused, or it didn't load): its still stands in for it. */
  broken: boolean;
  /** Where it was last asked to play from, and whether it has fired 'playing' and shown new frames since. */
  from: number;
  started: boolean;
  framed: boolean;
  /** Which ask the frame watch belongs to, so an old one stops. */
  watch: number;
};

const loaded = (clip: Clip) => clip.loading === 'whole' || clip.loading === 'streaming';

/** Whether a clip can play to its end without stopping to load: it's all here, or the browser thinks it will be. */
const ready = (clip: Clip) => clip.loading === 'whole' || (clip.loading === 'streaming' && clip.video.readyState === clip.video.HAVE_ENOUGH_DATA);

/**
 * Whether a clip asked to play is playing: it has fired 'playing', shown two frames newer than
 * where it started (which requestVideoFrameCallback reports, where there is one) and its clock has
 * moved. canplay isn't enough: a clip can say it can play and sit on its first frame for a while.
 */
const rolling = (clip: Clip) =>
  clip.started && clip.framed && !clip.video.paused && clip.video.readyState >= clip.video.HAVE_FUTURE_DATA && clip.video.currentTime > clip.from;

export function initStages() {
  const section = document.querySelector<HTMLElement>('[data-stages]');
  if (!section) return;
  const tabs = [...section.querySelectorAll<HTMLButtonElement>('.stab')];
  const panel = section.querySelector<HTMLElement>('.stages__info')!;
  const tablist = section.querySelector<HTMLElement>('.stages__tabs')!;
  const toggle = section.querySelector<HTMLButtonElement>('[data-stages-toggle]')!;
  const clips: Clip[] = tabs.map((tab) => {
    const slide = section.querySelector<HTMLElement>(`[data-slide="${tab.dataset.stage}"]`)!;
    return { tab, slide, video: slide.querySelector('video')!, phase: 'idle', loading: 'no', broken: false, from: 0, started: false, framed: false, watch: 0 };
  });
  section.style.setProperty('--fade', `${FADE}s`);

  // The stage on show; the one whose tab is chosen, which a press changes at once, though its
  // stage only shows once its clip plays; and the clip on its way in, if any.
  let shown = 0;
  let chosen = 0;
  let next = -1;
  // The stage fading out on top of the one on show, and when it's gone.
  let leaving = -1;
  let fadeEnds = 0;
  // Whether the next clip missed its cue (it was late), so comes in as soon as it can.
  let late = false;
  // How long before its cue a clip is started, for its clock to be at its start on the cue: about
  // how long a warmed-up clip takes to start, a frame or two, then put right by however far each
  // change of the tour was from its cue. (A clip's first start is slower, and no guide.)
  let lead = 0.025;
  // How long a still standing in for a clip has been up.
  let still = 0;
  let visible = false;
  let near = false;
  // While the pointer or the keyboard is on the tabs, the stage on show stays (its clip loops).
  let hovered = false;
  let focused = false;
  let paused = holdsVideo();
  // Whether each clip has its source in the page's encoding (src/codec.ts): until then none loads.
  let sourced = false;
  let raf = 0;
  let last = 0;

  // Swaps a slide's thumbnail for its full still, once that has loaded and decoded (so the
  // picture never goes blank between the two).
  const fetchStill = (i: number) => {
    const image = clips[i].slide.querySelector('img')!;
    const full = STILLS[`../media/stages/${tabs[i].dataset.stage}.webp`];
    if (!full || image.dataset.still) return;
    image.dataset.still = 'full';
    const loading = new Image();
    loading.src = full;
    const swap = () => { image.src = full; };
    loading.decode().then(swap, swap);
  };

  // Starts a stage's clip loading, once, unless the page holds still or saves data. It's fetched
  // whole and played from memory, as a clip shown before it has all loaded would stop half way
  // on a slow connection, on screen, and a browser left to load a paused clip itself stops short
  // (Chrome at a couple of megabytes). Its preload goes up only once that's its source: before,
  // the browser would start loading the file itself alongside the fetch.
  const load = (i: number) => {
    const clip = clips[i];
    if (!sourced || clip.loading !== 'no' || holdsVideo()) return;
    clip.loading = 'fetching';
    const { video } = clip;
    fetch(video.src, { priority: 'low' })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`${response.status}`))))
      .then((whole) => {
        video.src = URL.createObjectURL(whole);
        video.preload = 'auto';
        clip.loading = 'whole';
      }, () => {
        // Not to be fetched (from another origin, say): the browser loads it as it would.
        video.preload = 'auto';
        video.load();
        clip.loading = 'streaming';
      });
  };

  const fail = (clip: Clip) => {
    clip.broken = true;
    clip.phase = 'idle';
    clip.slide.classList.remove('is-playing');
  };

  // Asks a clip to play, noting where from so `rolling` can tell when it really is.
  const roll = (clip: Clip) => {
    const { video } = clip;
    clip.from = video.currentTime;
    clip.started = !video.paused;
    clip.framed = !('requestVideoFrameCallback' in video);
    if (!clip.framed) {
      const watch = ++clip.watch;
      let frames = 0;
      const seen: VideoFrameRequestCallback = (_, frame) => {
        if (watch !== clip.watch) return;
        if (frame.mediaTime > clip.from) frames++;
        if (frames >= 2) clip.framed = true;
        else video.requestVideoFrameCallback(seen);
      };
      video.requestVideoFrameCallback(seen);
    }
    video.play().catch((error: unknown) => {
      // Cut short by a pause, that's fine. Refused (autoplay, on a phone in Low Power Mode say)
      // or unplayable, its still stands in for it.
      if (!(error instanceof DOMException && error.name === 'AbortError')) fail(clip);
    });
  };

  // Puts a clip away: paused, out of sight and back at its start, to open from there next time.
  const stop = (i: number) => {
    const clip = clips[i];
    clip.phase = 'idle';
    clip.slide.classList.remove('is-playing');
    clip.video.pause();
    if (clip.video.currentTime) clip.video.currentTime = 0;
  };

  const selectTab = (i: number) => {
    tabs.forEach((tab, j) => {
      const active = j === i;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.style.removeProperty('--progress');
    });
    const tab = tabs[i];
    panel.setAttribute('aria-labelledby', tab.id);
    // On a phone the tabs are a strip: keep the chosen one in sight.
    if (tablist.scrollWidth > tablist.clientWidth) tablist.scrollTo({ left: tab.offsetLeft - (tablist.clientWidth - tab.offsetWidth) / 2, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  const endFade = () => {
    if (leaving < 0) return;
    const { slide } = clips[leaving];
    // Without its transition, the slide is gone at once, if the fade was cut short.
    slide.classList.remove('is-leaving');
    slide.style.removeProperty('--fade');
    stop(leaving);
    leaving = -1;
  };

  // Puts stage i on show. The stage on show until now fades out on top of it over FADE, or over
  // `left`, what's left of its clip, if that's less, so that it never stops or starts again while
  // it can be seen. While the page holds still, it's a cut.
  const fadeTo = (i: number, left = FADE) => {
    endFade();
    const from = shown;
    shown = i;
    still = 0;
    if (chosen !== i) {
      chosen = i;
      selectTab(i);
    }
    clips[i].slide.classList.add('is-active');
    const slide = clips[from].slide;
    slide.classList.remove('is-active');
    const fade = Math.min(FADE, left);
    if (reducedMotion() || fade <= 0) {
      stop(from);
      return;
    }
    if (fade < FADE) slide.style.setProperty('--fade', `${fade}s`);
    slide.classList.add('is-leaving');
    leaving = from;
    fadeEnds = performance.now() + fade * 1000;
    schedule();
  };

  // A clip on its way in is playing: show it. On the stage on show, that's over its own first
  // frame, its still; otherwise it's the change of stage. `t` and `length` are the clock of the
  // stage on show, whose clip has `length - t` left (less a frame, as the fade starts on the next).
  const reveal = (i: number, t: number, length: number) => {
    const clip = clips[i];
    clip.phase = 'idle';
    next = -1;
    clip.slide.classList.add('is-playing');
    if (i === shown) return;
    // Settle its clip's picture out of sight before the slide shows, or it would fade in over its
    // still along with the slide.
    void getComputedStyle(clip.video).opacity;
    // On the tour, start the next clip earlier or later by however far this one was from its cue.
    if (i !== chosen && !late) lead = Math.min(0.3, Math.max(0, lead + t - clip.video.currentTime - (length - FADE)));
    fadeTo(i, Number.isFinite(length) ? length - t - 1 / 60 : FADE);
  };

  // A frame of the tour: its progress bar, and the next clip on its way in.
  const update = (dt: number) => {
    const on = clips[shown];
    const playing = on.slide.classList.contains('is-playing');
    // The tour runs on the clock of the clip on show, so a clip slow to load can't put it out of
    // step; a still standing in for a clip runs on the frames'.
    let t = 0;
    let length = Infinity;
    if (playing) {
      t = on.video.currentTime;
      length = on.video.duration || Infinity;
    } else if (on.broken) {
      still += dt;
      t = still;
      length = STILL;
    }
    // The cue for the next clip.
    const cue = length - FADE;
    if (chosen === shown) on.tab.style.setProperty('--progress', String(Math.min(1, Math.max(0, t / cue)) || 0));
    if (leaving >= 0) return;

    // What comes in next: a chosen stage; or the clip of the stage on show, over its still; or
    // the tour's next stage, unless the pointer or the keyboard is on the tabs.
    const goal = chosen !== shown ? chosen : !playing && !on.broken ? shown : hovered || focused ? -1 : (shown + 1) % clips.length;
    if (next !== goal) {
      if (next >= 0) stop(next);
      next = goal;
      late = false;
    }
    if (goal < 0) return;
    const clip = clips[goal];
    load(goal);
    fetchStill(goal);
    // A chosen stage comes in as soon as it can; the tour's next on its cue.
    const now = goal === chosen;
    if (!now && t > cue && clip.phase !== 'starting') late = true;
    if (clip.broken) {
      if (now || t >= cue) {
        next = -1;
        fadeTo(goal, playing ? length - t - 1 / 60 : FADE);
      }
      return;
    }
    const { video } = clip;
    switch (clip.phase) {
      case 'idle':
        if (loaded(clip) && (now || late || t >= cue - WARM)) {
          roll(clip);
          clip.phase = 'warming';
        }
        break;
      case 'warming':
        if (!rolling(clip)) break;
        if (now && ready(clip)) {
          reveal(goal, t, length);
          break;
        }
        // It plays. Back to its start, to wait for its cue (or the rest of it to load).
        video.pause();
        video.currentTime = 0;
        clip.phase = 'held';
        break;
      case 'held':
        if (ready(clip) && !video.seeking && (now || late || t >= cue - lead)) {
          roll(clip);
          clip.phase = 'starting';
        }
        break;
      case 'starting':
        if (rolling(clip)) reveal(goal, t, length);
    }
  };

  const tick = (time: number) => {
    raf = 0;
    const dt = last ? Math.min(0.1, (time - last) / 1000) : 0;
    last = time;
    if (leaving >= 0 && time >= fadeEnds) endFade();
    if (visible && !paused) update(dt);
    if ((visible && !paused) || leaving >= 0) schedule();
  };
  function schedule() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  // Plays the stage on show: its clip from where it stopped, or, once it's here, from its start,
  // out of sight over its still. Now rather than on the next frame, so that a press of play
  // starts it: a browser may only let a clip start in answer to one.
  const resume = () => {
    const on = clips[shown];
    if (on.slide.classList.contains('is-playing')) roll(on);
    else if (loaded(on) && !on.broken) {
      next = shown;
      roll(on);
      on.phase = 'warming';
    }
    schedule();
  };

  // Stops in a state it can start again from: a fade cut short to the stage coming in, the clip
  // on its way in put away, and the one on show paused where it is.
  const halt = () => {
    endFade();
    if (next >= 0) stop(next);
    next = -1;
    clips[shown].video.pause();
  };

  const choose = (i: number, focus = false) => {
    if (chosen !== i) {
      chosen = i;
      selectTab(i);
    }
    if (focus) tabs[i].focus();
    fetchStill(i);
    const clip = clips[i];
    // A press tries a clip that wouldn't play again.
    clip.broken = false;
    if (i === shown) {
      if (next >= 0 && next !== shown) stop(next);
      if (next !== shown) next = -1;
      return;
    }
    endFade();
    if (next >= 0 && next !== i) stop(next);
    if (!visible || paused) {
      next = -1;
      fadeTo(i);
      return;
    }
    // The stage on show stays, playing, until this one plays. It starts now, in answer to the
    // press, if it's here; otherwise once it is.
    next = i;
    if (loaded(clip) && clip.phase === 'idle') {
      roll(clip);
      clip.phase = 'warming';
    } else if (clip.phase === 'held') {
      roll(clip);
      clip.phase = 'starting';
    }
    schedule();
  };

  clips.forEach((clip, i) => {
    // The clip on show goes round again while the tour waits (on the pointer, or a late clip).
    clip.video.loop = true;
    clip.video.addEventListener('playing', () => { clip.started = true; });
    clip.video.addEventListener('error', () => fail(clip));
    clip.tab.addEventListener('click', () => choose(i));
    // A pointer on a tab, or the keyboard, starts its clip loading, so a press finds it ready.
    for (const type of ['pointerenter', 'pointerdown', 'focus']) clip.tab.addEventListener(type, () => load(i));
  });

  pauseButton(toggle, { pause: 'Pause the stage tour and all animation', play: 'Play the stage tour and all animation' });
  // The tour follows the page's state, which this button and the others set.
  onMotionChange(() => {
    if (paused === holdsVideo()) return;
    paused = holdsVideo();
    if (paused) halt();
    else if (visible) resume();
    if (near) load(shown);
  });

  tablist.addEventListener('keydown', (event) => {
    // Left and right step along the tabs from the one the keyboard is on. With a modifier they
    // are the browser's own (Alt+Left is Back).
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const from = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const step = STEPS[event.key];
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : step ? ((from < 0 ? chosen : from) + step + tabs.length) % tabs.length : undefined;
    if (target === undefined) return;
    event.preventDefault();
    choose(target, true);
  });
  tablist.addEventListener('pointerenter', () => { hovered = true; });
  tablist.addEventListener('pointerleave', () => { hovered = false; });
  tablist.addEventListener('focusin', () => { focused = true; });
  tablist.addEventListener('focusout', (event) => {
    focused = tablist.contains(event.relatedTarget as Node | null);
  });

  watchVisible(section, (now) => {
    visible = now;
    if (visible && !paused) resume();
    else halt();
  });
  // The first clip loads as the viewer nears the screen, to be playing when it's there.
  watchVisible(section, (now) => {
    near = now;
    if (near) load(shown);
  }, '100%');

  // Once every clip has its source, the first can load if the viewer is near.
  Promise.all(clips.map((clip) => chooseSource(clip.video))).then(() => {
    sourced = true;
    if (near) load(shown);
  });
}
