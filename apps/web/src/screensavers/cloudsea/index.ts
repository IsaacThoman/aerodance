import { cloudIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('cloudsea', cloudIcon, {
  views: [
    { value: 'sunrise', label: 'Sunrise' },
    { value: 'airship', label: 'Airship' },
    { value: 'pods', label: 'Pods' },
  ],
  suits: ['dawn', 'day'],
  sceneClock: true,
  load: () => import('./Saver.tsx'),
});
