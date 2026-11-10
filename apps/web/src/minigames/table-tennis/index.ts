import type { MinigameDefinition } from '../types.ts';
import { paddleIcon, raiseIcon, swingIcon } from './art.ts';
import { handsDetail } from '../../../../../packages/pose/webcamRecord.ts';
import { OPTIONS, optionsOf } from './options.ts';

/*
 * Table Tennis: ping-pong in first person. The players' tracked hands are the dancers' glass
 * hands, a paddle in the hand each player chose (Paddle hand). Alone, the opponent is a robot arm at the far end (the robot
 * hall's Torven arm): it serves when the left hand is raised, and plays back what they return.
 * Two players split the screen, one at each end, and see each other as glass dancers; the
 * ball waits in the air by the server, whose swing through it serves. Either way it's open play: there's no
 * match or score to finish, and the round lasts until the players leave it (pause, Minigames).
 */

const tableTennis: MinigameDefinition = {
  id: 'table-tennis',
  title: 'Table Tennis',
  players: [1, 2],
  howTo: [
    { icon: raiseIcon, text: 'Raise your free hand (not the paddle\'s) for the robot to serve', players: [1] },
    { icon: swingIcon, text: 'Swing your paddle hand through the ball to hit it back', players: [1] },
    { icon: 'replay', text: 'Keep the rally going with the robot. Pause to leave', players: [1] },
    { icon: paddleIcon, text: 'The ball waits in the air by whoever serves: swing through it to serve', players: [2] },
    { icon: swingIcon, text: 'Swing your paddle hand through the ball to hit it over to the other player', players: [2] },
    { icon: 'replay', text: 'Keep the rally going between you. Pause to leave', players: [2] },
  ],
  icon: paddleIcon,
  best: false,
  scene: 'custom',
  hud: { scores: false, timer: false },
  // The 3D world landmarks always (for the arms' depth: arms.ts), and the hands too unless the
  // Hand tracking setting is off: both of one player's, and two players' paddle hands, each
  // player's own (alone, the free hand only asks for the serve, which the pose's own wrist sees
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
