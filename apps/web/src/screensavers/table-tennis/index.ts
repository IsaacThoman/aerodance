import { paddleIcon } from '../icons.ts';
import type { ScreensaverDefinition } from '../types.ts';

/*
 * Table Tennis: a glass dancer playing the Torven robot arm at ping-pong in the Biodome, on the
 * Table Tennis minigame's own ball, bot and rally (match.ts); or two dancers, or two arms.
 */

const tableTennis: ScreensaverDefinition = {
  id: 'table-tennis',
  title: 'Table Tennis',
  subtitle: 'A glass dancer rallying with the robot arm in the Biodome',
  icon: paddleIcon,
  views: [
    { value: 'broadcast', label: 'Broadcast' },
    { value: 'courtside', label: 'Courtside' },
    { value: 'shoulder', label: 'Over the shoulder' },
    { value: 'far-end', label: 'Far end' },
    { value: 'overhead', label: 'Overhead' },
  ],
  cutEvery: 20,
  scenarioLabel: 'Match',
  scenarios: [
    { value: 'robot', label: 'Dancer vs Robot' },
    { value: 'dancers', label: 'Dancer vs Dancer' },
    { value: 'robots', label: 'Robot vs Robot' },
  ],
  scene: 'custom',
  sceneClock: true,
  order: 10,
  load: () => import('./Saver.tsx'),
};
export default tableTennis;
