import { bubblesIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('bubbles', bubblesIcon, {
  views: [
    { value: 'depths', label: 'Depths' },
    { value: 'bubbles', label: 'Bubbles' },
  ],
  load: () => import('./Saver.tsx'),
});
