import type { MinigameDefinition } from '../types.ts';
import { paddleIcon, raiseIcon, swingIcon } from './art.ts';
import { handsDetail } from '../../../../../packages/pose/webcamRecord.ts';
import { OPTIONS, optionsOf } from './options.ts';

/*
 * Table Tennis: ping-pong in first person, played as Wii Sports Resort's is. The players' tracked
 * hands are the dancers' glass hands, a paddle in the hand each player chose (Paddle hand). Alone,
 * the opponent is a robot arm at the far end (the robot hall's Torven arm), in a match (first to
 * 6) or Return Challenge (return its serves, quicker and quicker, until one gets by); two players
 * split the screen, one at each end, and play a match, seeing each other as glass dancers. A
 * player's serve waits in the air by their paddle hand: their free hand raised tosses it, and a
 * swing through it as it comes down serves it.
 */

const tableTennis: MinigameDefinition = {
  id: 'table-tennis',
  title: 'Table Tennis',
  players: [1, 2],
  howTo: [
    { icon: raiseIcon, text: 'To serve, raise your free hand (not the paddle\'s) to toss the ball, then swing through it' },
    { icon: swingIcon, text: 'Swing your paddle hand through the ball to hit it back over the net' },
    { icon: 'replay', text: 'Match: first to 6 points wins. Return Challenge: return the robot\'s serves for as long as you can', players: [1] },
    { icon: 'replay', text: 'First to 6 points wins (by 2 clear)', players: [2] },
  ],
  icon: paddleIcon,
  // A match's points aren't a score to beat (its round says so: outcome.best false); Return
  // Challenge's returns are, and the best is theirs.
  scene: 'custom',
  hud: { scores: false, timer: false },
  // The 3D world landmarks always (for the arms' depth: arms.ts), and the hands too unless the
  // Hand tracking setting is off: both of one player's, and two players' paddle hands, each
  // player's own (alone, the free hand only tosses the serve, which the pose's own wrist sees
  // well enough; both of two players' would cost twice as much, as the camera can't follow them:
  // packages/pose/browser/hands.ts).
  tracking: ({ playerCount, options }) => {
    const chosen = optionsOf(options);
    if (!chosen.handTracking) return 'world';
    return playerCount === 1 ? 'hands' : handsDetail(chosen.paddleHands.slice(0, playerCount));
  },
  options: OPTIONS,
  order: 10,
  load: () => import('./Game.tsx'),
};
export default tableTennis;
