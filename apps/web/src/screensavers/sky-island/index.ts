import { weatherIcon } from '../icons.ts';
import type { ScreensaverDefinition } from '../types.ts';

/*
 * Sky Island: a grassy island floating over a sea of clouds, a glass greenhouse, a pond spilling
 * off its edge in a waterfall, turbines and a clock tower, under the real sky: the light follows
 * the time of day where the device is (the sun and the moon as high as they really are, the moon
 * in its real phase), the weather the real weather there; and the tower's clock can tell the time.
 */

const skyIsland: ScreensaverDefinition = {
  id: 'sky-island',
  title: 'Sky Island',
  subtitle: 'A floating garden lit by your own sky and weather',
  icon: weatherIcon,
  views: [
    { value: 'island', label: 'Island' },
    { value: 'orbit', label: 'Orbit' },
    { value: 'garden', label: 'Garden' },
    { value: 'falls', label: 'Waterfall' },
  ],
  cutEvery: 40,
  scene: 'custom',
  follows: { time: true, weather: true },
  sceneClock: true,
  order: 5,
  load: () => import('./Saver.tsx'),
};
export default skyIsland;
