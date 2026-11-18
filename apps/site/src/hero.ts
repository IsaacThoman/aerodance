import { chooseSource } from './codec.ts';
import { holdsVideo, onMotionChange, pauseButton, reducedMotion, waitForPress, watchVisible } from './motion.ts';

// The TV in the hero plays real gameplay. It only plays while it's on screen, and while the page
// holds still (or the browser saves data) it waits to be asked. The button on it is one of the
// page's pause buttons (src/motion.ts): it pauses and plays everything that moves, the video too.
// Nothing of the video loads until it has its source in the page's encoding (src/codec.ts); then
// it loads its metadata, as it did with the page.
export function initHero() {
  initVideo();
  initParallax();
}

function initVideo() {
  const frame = document.querySelector<HTMLElement>('[data-video]');
  const video = frame?.querySelector('video');
  const toggle = frame?.querySelector<HTMLButtonElement>('[data-video-toggle]');
  if (!frame || !video || !toggle) return;

  let sourced = false;
  let visible = false;
  const sync = () => {
    if (!sourced) return;
    if (holdsVideo() || !visible) {
      video.pause();
      return;
    }
    video.play().catch((error: unknown) => {
      // A pause that cut the play short is fine. Refused (autoplay, on a phone in Low Power Mode
      // say), the page waits for a press of play, which a tap satisfies.
      if (error instanceof DOMException && error.name === 'NotAllowedError') waitForPress();
    });
  };
  pauseButton(toggle, { pause: 'Pause the video and all animation', play: 'Play the video and all animation' });
  onMotionChange(sync);
  watchVisible(frame, (now) => { visible = now; sync(); }, '120px');
  chooseSource(video).then(() => {
    sourced = true;
    video.preload = 'metadata';
    sync();
  });
}

// As the page scrolls, the dancers round the TV drift up a little (the near ones more than the
// far) and the sky falls a little behind, so the hero has some depth.
function initParallax() {
  const stage = document.querySelector<HTMLElement>('.hero__stage');
  const sky = document.querySelector<HTMLElement>('[data-sky]');
  const dancers = [...document.querySelectorAll<HTMLElement>('.hero__stage .dancer')];
  if (!stage || !dancers.length) return;

  let visible = true;
  let queued = false;
  const update = () => {
    queued = false;
    // Never negative: a page pulled down past its top would bare the foot of the sky.
    const y = reducedMotion() ? 0 : Math.max(0, window.scrollY);
    for (const dancer of dancers) dancer.style.setProperty('--py', `${(-y * 0.07 * Number(dancer.dataset.depth ?? 1)).toFixed(1)}px`);
    sky?.style.setProperty('--sky-y', `${(y * 0.12).toFixed(1)}px`);
  };
  watchVisible(stage, (now) => { visible = now; });
  onMotionChange(update);
  window.addEventListener('scroll', () => {
    if (!visible || queued) return;
    queued = true;
    requestAnimationFrame(update);
  }, { passive: true });
}
