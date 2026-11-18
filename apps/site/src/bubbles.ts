import { onMotionChange, reducedMotion } from './motion.ts';

// Soap bubbles rising through the hero's sky. Touching one pops it, and another sets off from
// the bottom, as the game's menu dancers arrive in bubbles that pop.
const COUNT = 14;

export function initBubbles() {
  const sky = document.querySelector<HTMLElement>('[data-bubbles]');
  if (!sky) return;
  // Refilled only when the page starts or stops holding still, so they don't jump otherwise.
  let still: boolean | undefined;
  const fill = () => {
    if (reducedMotion() === still) return;
    still = reducedMotion();
    sky.replaceChildren();
    if (still) return;
    // Fewer on a phone, where the sky is narrow.
    const count = window.innerWidth < 700 ? 7 : COUNT;
    for (let i = 0; i < count; i++) sky.append(bubble(i / count));
  };

  sky.addEventListener('pointerover', (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('bubble') || target.classList.contains('is-popped')) return;
    target.classList.add('is-popped');
    target.addEventListener('animationend', () => target.replaceWith(bubble(0)), { once: true });
  });
  onMotionChange(fill);
  fill();
}

/** One bubble, `progress` (0 to 1) of the way through its climb when it first appears. */
function bubble(progress: number) {
  const element = document.createElement('span');
  const size = 18 + Math.random() ** 2 * 74;
  // Big bubbles climb slowly.
  const seconds = 26 + size / 3 + Math.random() * 14;
  element.className = 'bubble';
  element.style.setProperty('--s', `${size.toFixed(0)}px`);
  element.style.setProperty('--x', `${(Math.random() * 100).toFixed(1)}%`);
  element.style.setProperty('--t', `${seconds.toFixed(1)}s`);
  element.style.setProperty('--delay', `${(-progress * seconds - Math.random() * 4).toFixed(1)}s`);
  return element;
}
