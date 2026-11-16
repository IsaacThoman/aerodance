/*
 * Menu screens that are overlays of their own (the title menu, Experiments, Screensavers, Song
 * Select's way back) hand over to each other the way a screen change inside one of them goes: the
 * one leaving fades out sliding left (SWAP_OUT a second), then the one arriving fades in sliding
 * from the left (SWAP_IN), each SWAP_SLIDE design units, rather than the two cross-fading.
 */

/** How fast a screen swaps out, and in (its swap, 1 to 0 and back, per second). */
export const SWAP_OUT = 7;
export const SWAP_IN = 6;
/** How far left a screen slides as it swaps out (design units). */
export const SWAP_SLIDE = 24;
/** How long the screen arriving waits before it swaps in: the one leaving's swap out. */
export const HANDOFF_WAIT = 1 / SWAP_OUT;

/**
 * Whether a menu has been on screen yet: until then (the page's first fade in) a menu screen
 * fades in as it always has; after, one showing arrives by a handoff.
 */
export const handoff = { live: false };
