import type { MinigameDefinition } from '../types.ts';
import { paddleIcon, raiseIcon, swingIcon } from './art.ts';
import { OPTIONS } from './options.ts';

/*
 * Table Tennis: ping-pong in first person. The player's tracked hands are the dancers' glass
 * hands, a paddle in the right. The opponent is a robot arm at the far end (the robot hall's
 * Torven arm): it serves when the left hand is raised, and plays back what they return. So far
 * it's open play: there's no
 * match or score to finish, and the round lasts until the player leaves it (pause, Minigames).
 */

const tableTennis: MinigameDefinition = {
  id: 'table-tennis',
  title: 'Table Tennis',
  players: [1],
  howTo: [
    { icon: raiseIcon, text: 'Raise your left hand for the robot to serve' },
    { icon: swingIcon, text: 'Swing your right hand through the ball to hit it back' },
    { icon: 'replay', text: 'Keep the rally going with the robot. Pause to leave' },
  ],
  icon: paddleIcon,
  best: false,
  scene: 'custom',
  hud: { scores: false, timer: false },
  tracking: 'hands',
  options: OPTIONS,
  order: 10,
  load: () => import('./Game.tsx'),
};
export default tableTennis;
