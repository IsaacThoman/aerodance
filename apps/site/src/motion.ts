// Whether the page should hold still. It's one state for the whole page, html's data-motion="off":
// index.css freezes CSS animation and transition under it, and everything that moves by itself
// (the videos, the bubbles, the stage tour, the parallax) stops for it. The page's pause buttons
// (the hero TV's and the stage viewer's) all show it and all set it, so pausing any one of them
// pauses everything, and playing any one plays it all again.
//
// The page starts paused for the system's "reduce motion" setting, though a press of play starts it
// for that visit; and after a pause pressed on an earlier visit, as presses are kept for the next.
// index.html's inline script works out the same before the first paint.
const query = window.matchMedia('(prefers-reduced-motion: reduce)');
const root = document.documentElement;
// index.html's inline script reads the same key.
const KEY = 'aerodance:motion';
const listeners = new Set<() => void>();

const saved = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
// The last press, 'off' for a pause and 'on' for a play, this visit's or an earlier one's. Kept here
// as well as in storage, which private browsing may not offer.
let pressed = saved();
// Whether play has been pressed this visit, which asks for video when the browser is saving data.
let asked = false;
const savesData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

export const reducedMotion = () => root.dataset.motion === 'off';

/** No video until it's asked for: the page held still, or a browser saving data until play is pressed. */
export const holdsVideo = () => reducedMotion() || (savesData() && !asked);

/** Calls back whenever reducedMotion() or holdsVideo() changes. */
export const onMotionChange = (listener: () => void) => { listeners.add(listener); };

let last = '';
const hold = (still: boolean) => {
  if (still) root.dataset.motion = 'off';
  else delete root.dataset.motion;
  const now = `${reducedMotion()} ${holdsVideo()}`;
  if (now === last) return;
  last = now;
  for (const listener of listeners) listener();
};
const startsPaused = () => query.matches || pressed === 'off';
hold(startsPaused());
// The system's setting changed: start again from it and the last press.
query.addEventListener('change', () => hold(startsPaused()));

function press() {
  const play = holdsVideo();
  if (play) asked = true;
  pressed = play ? 'on' : 'off';
  try {
    localStorage.setItem(KEY, pressed);
  } catch {
    // No storage (private browsing): the press lasts for this visit.
  }
  hold(!play);
}

/**
 * Makes `button` one of the page's pause buttons: it shows the shared state (`data-state` is
 * "playing" or "paused", and its label `labels.pause` or `labels.play`), and pressing it pauses or
 * plays the whole page.
 */
export function pauseButton(button: HTMLButtonElement, labels: { pause: string; play: string }) {
  const show = () => {
    const held = holdsVideo();
    button.dataset.state = held ? 'paused' : 'playing';
    button.setAttribute('aria-label', held ? labels.play : labels.pause);
  };
  button.addEventListener('click', press);
  onMotionChange(show);
  show();
}

/**
 * For a video the browser wouldn't start by itself (autoplay refused, on a phone in Low Power Mode
 * say): the page holds still and shows its play buttons, as a press of one always may play. For
 * this visit only.
 */
export const waitForPress = () => hold(true);

/**
 * Calls back as an element comes into view and leaves it (or comes within `margin` of the
 * viewport). A hidden tab counts as out of view, so nothing keeps running behind one.
 */
export function watchVisible(element: Element, onChange: (visible: boolean) => void, margin = '0px') {
  let inView = false;
  let last: boolean | undefined;
  const report = () => {
    const visible = inView && !document.hidden;
    if (visible === last) return;
    last = visible;
    onChange(visible);
  };
  new IntersectionObserver((entries) => {
    for (const entry of entries) inView = entry.isIntersecting;
    report();
  }, { rootMargin: margin }).observe(element);
  document.addEventListener('visibilitychange', report);
}
