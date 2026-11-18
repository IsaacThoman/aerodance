import { auroraIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('aurora', auroraIcon, {
  views: [
    { value: 'lake', label: 'Lake' },
    { value: 'cabin', label: 'Cabin' },
    { value: 'sky', label: 'Sky' },
  ],
  suits: ['night'],
  load: () => import('./Saver.tsx'),
});
