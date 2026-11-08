import type { MinigameDefinition } from '../types.ts';
import { drawTableTile, raiseIcon, swingIcon } from './art.ts';
import { OPTIONS } from './options.ts';

/*
 * Table Tennis: ping-pong in first person. The player's tracked hands are the dancers' glass
 * hands, a paddle in the right; a launcher at the far end serves when the left hand is raised,
 * and a floating paddle, the bot, plays back what they return. So far it's open play: there's no
 * match or score to finish, and the round lasts until the player leaves it (pause, Minigames).
 */

const tableTennis: MinigameDefinition = {
  id: 'table-tennis',
  title: 'Table Tennis',
  blurb: 'Ping-pong in first person',
  description: 'Stand at the end of the table with a paddle in your right hand. Raise your left hand and the launcher serves; swing through the ball to send it back, and the bot at the far end will keep the rally going. The aim assist helps your swings find the ball.',
  players: [1],
  howTo: [
    { icon: raiseIcon, text: 'Raise your left hand for a serve' },
    { icon: swingIcon, text: 'Swing your right hand through the ball to hit it back' },
    { icon: 'replay', text: 'Keep the rally going with the bot. Pause to leave' },
  ],
  art: drawTableTile,
  tint: ['rgba(80, 160, 255, 0.6)', 'rgba(16, 70, 180, 0.74)'],
  score: { unit: 'returns' },
  scene: 'custom',
  hud: { scores: false, timer: false },
  tracking: 'hands',
  options: OPTIONS,
  order: 10,
  load: () => import('./Game.tsx'),
};
export default tableTennis;
