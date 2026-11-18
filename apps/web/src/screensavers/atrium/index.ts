import { atriumIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('atrium', atriumIcon, {
  views: [
    { value: 'atrium', label: 'Atrium' },
    { value: 'column', label: 'Column' },
    { value: 'dome', label: 'Dome' },
  ],
  suits: ['dawn', 'day', 'dusk'],
  load: () => import('./Saver.tsx'),
});
