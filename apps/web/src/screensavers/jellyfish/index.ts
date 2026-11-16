import { jellyfishIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('jellyfish', jellyfishIcon, {
  views: [
    { value: 'water', label: 'Open water' },
    { value: 'nettle', label: 'Sea nettle' },
    { value: 'moon', label: 'Moon jelly' },
  ],
  load: () => import('./Saver.tsx'),
});
