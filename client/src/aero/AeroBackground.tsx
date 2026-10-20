import { useEffect, useRef } from 'react';
import { createAeroBackground, type AeroBackgroundHandle, type AeroTelemetry } from './aeroBackground.ts';

export interface AeroBackgroundProps {
  speed?: number;
  paused?: boolean;
  onTelemetry?: (telemetry: AeroTelemetry) => void;
  className?: string;
}

/**
 * Full-screen Frutiger Aero drone flight that sits behind the rest of the app.
 *
 * <AeroBackground speed={1} paused={false} onTelemetry={(t) => ...} />
 *
 * A fresh <canvas> is created on every mount so React StrictMode's
 * mount → unmount → mount cycle never reuses a lost WebGL context.
 */
export default function AeroBackground({ speed = 1, paused = false, onTelemetry, className = '' }: AeroBackgroundProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const aeroRef = useRef<AeroBackgroundHandle | null>(null);
  const teleRef = useRef(onTelemetry);
  teleRef.current = onTelemetry;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    let aero: AeroBackgroundHandle | null = null;
    try {
      aero = createAeroBackground(canvas, {
        speed,
        onTelemetry: (t) => teleRef.current?.(t),
      });
      aero.setPaused(paused);
      aeroRef.current = aero;
    } catch (err) {
      console.warn('Aero background could not start (WebGL unavailable?)', err);
    }
    return () => {
      aero?.destroy();
      aeroRef.current = null;
      canvas.remove();
    };
    // Rebuilding the scene is expensive; speed and paused changes go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { aeroRef.current?.setSpeed(speed); }, [speed]);
  useEffect(() => { aeroRef.current?.setPaused(paused); }, [paused]);

  return <div ref={hostRef} className={`aero-background ${className}`.trim()} aria-hidden="true" />;
}
