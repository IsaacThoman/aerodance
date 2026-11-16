import { skylineIcon } from '../icons.ts';
import type { ScreensaverDefinition } from '../types.ts';

const skyline: ScreensaverDefinition = {
  id: 'skyline',
  title: 'Skyline',
  subtitle: 'A drone flight over the Aero city, its lake and meadows',
  icon: skylineIcon,
  views: [
    { value: 'flight', label: 'Flight' },
    { value: 'downtown', label: 'Downtown' },
    { value: 'lake', label: 'Lake' },
    { value: 'meadow', label: 'Meadow' },
  ],
  scene: { background: 'skyline' },
  suits: ['dawn', 'day', 'dusk'],
  order: 40,
  load: () => import('./Saver.tsx'),
};
export default skyline;
