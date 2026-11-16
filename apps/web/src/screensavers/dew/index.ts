import { dewIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('dew', dewIcon, {
  views: [
    { value: 'leaf', label: 'Leaf' },
    { value: 'drops', label: 'Drops' },
    { value: 'drip', label: 'Drip' },
    { value: 'ladybug', label: 'Ladybug' },
  ],
  suits: ['dawn', 'day'],
  load: () => import('./Saver.tsx'),
});
