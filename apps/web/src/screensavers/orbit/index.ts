import { orbitIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('orbit', orbitIcon, {
  views: [
    { value: 'earth', label: 'Earth' },
    { value: 'sunrise', label: 'Sunrise' },
    { value: 'station', label: 'Station' },
  ],
  load: () => import('./Saver.tsx'),
});
