import { koiIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('koi', koiIcon, {
  views: [
    { value: 'pond', label: 'Pond' },
    { value: 'koi', label: 'Koi' },
    { value: 'lotus', label: 'Lotus' },
    { value: 'overhead', label: 'Overhead' },
  ],
  suits: ['dawn', 'day', 'dusk'],
  load: () => import('./Saver.tsx'),
});
