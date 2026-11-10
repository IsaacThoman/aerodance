import type { StationDriver } from './station.ts';

/**
 * What every arm component takes. It's drawn in its station's frame (layout.ts StationSpec),
 * and each frame (useRobotFrame, priority 0) it poses its joints so that its <Paddle driver>
 * lands on `driver.target`.
 */
export interface ArmProps {
  driver: StationDriver;
}
