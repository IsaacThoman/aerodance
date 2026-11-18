// Where the landing page's buttons go. index.html names these as {{key}}; vite.config.ts fills
// them in, and the build fails on a key that isn't here.

const REPO = 'https://github.com/IsaacThoman/aerodance';

export const LINKS = {
  // The page's own address, for its canonical link and social card (`site`/og.jpg), and the game
  // in a browser. They're the same address until it's decided where the page goes: give them
  // different ones before deploying, or "Play in your browser" will lead back to the page.
  site: 'https://aerodance.party',
  play: 'https://aerodance.party',
  repo: REPO,
  // Placeholders until the store listings exist: each goes to the repository for now.
  appStore: REPO,
  appleTv: REPO,
  steam: REPO,
  releases: `${REPO}/releases`,
  issues: `${REPO}/issues`,
  docs: `${REPO}/blob/dev/docs/README.md`,
  minigames: `${REPO}/blob/dev/docs/minigames.md`,
  studio: `${REPO}/blob/dev/tools/choreography/README.md`,
  appleTvDocs: `${REPO}/blob/dev/apps/tvos/README.md`,
} as const;

export type LinkKey = keyof typeof LINKS;
