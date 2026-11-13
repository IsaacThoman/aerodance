// The shape every station shares: the coach view beside a panel of the station's own controls,
// over the transport and the timeline.
import type { ReactNode } from 'react';

export function StationLayout({ stage, side, bar, timeline, wide = false }: {
  /** The main picture (usually a Viewport). */
  stage: ReactNode;
  /** The station's controls, in a scrolling column on the right. */
  side: ReactNode;
  /** The transport row above the timeline. */
  bar?: ReactNode;
  timeline?: ReactNode;
  /** Give the side column more room (for stations that are mostly lists). */
  wide?: boolean;
}) {
  return (
    <div className={`station-layout${wide ? ' wide' : ''}`}>
      <div className="station-stage">{stage}</div>
      <aside className="station-side">{side}</aside>
      {(bar || timeline) && <div className="station-bottom">{bar}{timeline}</div>}
    </div>
  );
}
