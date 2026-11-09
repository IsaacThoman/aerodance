import type { MinigameDefinition } from '../types.ts';
import { paddleIcon, raiseIcon, swingIcon } from './art.ts';
import { OPTIONS, optionsOf } from './options.ts';

/*
 * Table Tennis: ping-pong in first person. The players' tracked hands are the dancers' glass
 * hands, a paddle in the right. Alone, the opponent is a robot arm at the far end (the robot
 * hall's Torven arm): it serves when the left hand is raised, and plays back what they return.
 * Two players split the screen, one at each end, and see each other as glass dancers; the
 * server raises their left hand to toss the ball up. Either way it's open play: there's no
 * match or score to finish, and the round lasts until the players leave it (pause, Minigames).
 */

const tableTennis: MinigameDefinition = {
  id: 'table-tennis',
  title: 'Table Tennis',
  players: [1, 2],
  howTo: [
    { icon: raiseIcon, text: 'Raise your left hand for the robot to serve', players: [1] },
    { icon: swingIcon, text: 'Swing your right hand through the ball to hit it back', players: [1] },
    { icon: 'replay', text: 'Keep the rally going with the robot. Pause to leave', players: [1] },
    { icon: raiseIcon, text: 'To serve, raise your left hand: the ball goes up for you to hit', players: [2] },
    { icon: swingIcon, text: 'Swing your right hand through the ball to hit it over to the other player', players: [2] },
    { icon: 'replay', text: 'Keep the rally going between you. Pause to leave', players: [2] },
  ],
  icon: paddleIcon,
  best: false,
  scene: 'custom',
  hud: { scores: false, timer: false },
  // The 3D world landmarks always (for the arms' depth: arms.ts); the hands too for one player
  // unless the Hand tracking setting is off (with two, the camera has no hands to give).
  tracking: ({ playerCount, options }) => (playerCount === 1 && optionsOf(options).handTracking ? 'hands' : 'world'),
  options: OPTIONS,
  order: 10,
  load: () => import('./Game.tsx'),
};
export default tableTennis;
