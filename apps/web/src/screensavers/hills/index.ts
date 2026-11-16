import { hillsIcon } from '../icons.ts';
import { backdropSaver } from '../places.ts';

export default backdropSaver('hills', hillsIcon, {
  views: [
    { value: 'valley', label: 'Valley' },
    { value: 'turbines', label: 'Turbines' },
    { value: 'domes', label: 'Domes' },
  ],
  suits: ['day'],
  load: () => import('./Saver.tsx'),
});
