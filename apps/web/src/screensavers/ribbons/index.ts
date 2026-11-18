import { ribbonsIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('ribbons', ribbonsIcon, {
  views: [
    { value: 'sweep', label: 'Sweep' },
    { value: 'light', label: 'Light' },
    { value: 'aqua', label: 'Aqua' },
  ],
  load: () => import('./Saver.tsx'),
});
