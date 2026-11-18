// The page's furniture: the nav bar.

// A phone, held either way: narrow (where the nav is already its compact size, components.css), or
// short and without a pointer that hovers, so a short laptop window keeps its nav. An iPad is wider
// and taller than both. index.css gives the same query its own, shorter scroll padding.
const PHONE = '(max-width: 480px), (max-height: 480px) and (hover: none)';
// How far the page must go one way before the nav goes or comes back, so a finger's wobble doesn't
// flicker it. Coming back takes a little more, as the nav covers what's being read.
const HIDE_AFTER = 12;
const SHOW_AFTER = 24;

/**
 * The nav is clear glass over the hero's sky, and white glass once the page has scrolled. On a
 * phone it also slides up out of the way while the page scrolls down (`data-hidden`), and comes
 * back as soon as it scrolls up. It stays while the page is at its top, and while the keyboard is
 * in it. Slid away it's still on the page, for a screen reader or a Tab.
 */
export function initNav() {
  const nav = document.querySelector<HTMLElement>('[data-nav]');
  const bar = nav?.querySelector<HTMLElement>('.nav__bar');
  if (!nav || !bar) return;
  const phone = window.matchMedia(PHONE);
  const root = document.documentElement;

  let hidden = false;
  // Whether the keyboard's focus is in the nav.
  let held = false;
  // Where the page last turned against the nav: its lowest point since the nav came back, or its
  // highest since it went. The distance from there is what counts.
  let turn = Math.max(0, window.scrollY);
  // The window's height and whether the page was at its foot, at the last frame.
  let height = window.innerHeight;
  let atFoot = false;
  let queued = false;

  const update = () => {
    queued = false;
    // Everything is measured before anything changes, so a frame lays out once. iOS pulls a page
    // past either end and springs it back; clamped to the page, the bounce isn't a scroll.
    const foot = Math.max(0, root.scrollHeight - window.innerHeight);
    const y = Math.min(Math.max(window.scrollY, 0), foot);
    // Where the bar's foot rests (offsets leave out its slide): above it, the page is at its top.
    const top = nav.offsetTop + bar.offsetTop + bar.offsetHeight;
    nav.toggleAttribute('data-scrolled', y > 24);

    // Safari's toolbars grow and shrink as the page scrolls, changing the window's height a pixel or
    // two a frame. Mid-page that leaves the scroll position alone (and the reader is scrolling then,
    // so it all counts), but at the page's foot the position moves with the foot. That isn't the
    // reader scrolling, so there the count starts again.
    const wasAtFoot = atFoot;
    atFoot = y >= foot - 1;
    if (atFoot && (wasAtFoot || window.innerHeight !== height)) turn = y;
    height = window.innerHeight;

    let hide = false;
    if (phone.matches && !held && y > top) {
      turn = hidden ? Math.max(turn, y) : Math.min(turn, y);
      hide = hidden ? turn - y < SHOW_AFTER : y - turn >= HIDE_AFTER;
    } else {
      turn = y;
    }
    if (hide === hidden) return;
    hidden = hide;
    turn = y;
    nav.toggleAttribute('data-hidden', hide);
  };

  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  // A keyboard reaching into the nav brings it back, and it stays while the focus is there. A tap's
  // focus (no focus ring) doesn't hold it, so the jump down from its button still slides it away.
  nav.addEventListener('focusin', (event) => {
    held = event.target instanceof Element && event.target.matches(':focus-visible');
    queue();
  });
  nav.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && nav.contains(event.relatedTarget)) return;
    held = false;
    queue();
  });
  // Turned or resized out of a phone's size, it comes back.
  phone.addEventListener('change', queue);
  window.addEventListener('scroll', queue, { passive: true });
  update();
}
