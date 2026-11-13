import './styles/index.css';
import { initBubbles } from './bubbles.ts';
import { initHero } from './hero.ts';
import { initStages } from './stages.ts';
import { initNav } from './chrome.ts';

// The page reads and works without any of this: every section is plain HTML and CSS, and these
// only add motion and the few interactive pieces. index.html offers the controls these drive on
// the understanding that this script will run, and takes them away again if it never says so.
document.documentElement.dataset.ready = '';
initNav();
initBubbles();
initHero();
initStages();
