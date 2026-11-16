import { FONT, TAU, drawDarkGlassPanel } from '../ui/draw.ts';
import type { Weather, WeatherKind } from './sky/weather.ts';
import { formatTemperature } from './sky/weather.ts';

/*
 * The screensavers' clock and captions, drawn on their overlay in design units: the time and
 * date as the device writes them, and the live weather beside them with a small icon. The Clock
 * setting picks a glass chip in the bottom right corner or a large clock bottom left; captions
 * name the screensaver and its view as it comes on.
 */

/** The time ("9:41", and "PM" where the device uses a 12-hour clock), and the date ("Monday, November 16"). */
export function clockText(date: Date): { time: string; period: string; day: string } {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).formatToParts(date);
    const time = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
    const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
    const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
    return { time, period, day };
  } catch {
    const pad = (n: number) => String(n).padStart(2, '0');
    return { time: `${date.getHours()}:${pad(date.getMinutes())}`, period: '', day: date.toDateString() };
  }
}

/** A white line icon for the weather (and whether it's night, for clear skies), centred at cx, cy, about r across. */
export function drawWeatherIcon(g: CanvasRenderingContext2D, kind: WeatherKind, night: boolean, cx: number, cy: number, r: number) {
  g.save();
  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineWidth = Math.max(2, r * 0.13);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const sunOrMoon = (x: number, y: number, s: number) => {
    if (night) {
      g.beginPath();
      g.arc(x, y, s, -0.5 * Math.PI, 0.9 * Math.PI, false);
      g.arc(x + s * 0.45, y - s * 0.3, s * 0.82, 0.78 * Math.PI, -0.62 * Math.PI, true);
      g.closePath();
      g.stroke();
      return;
    }
    g.beginPath();
    g.arc(x, y, s * 0.55, 0, TAU);
    g.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * s * 0.85, y + Math.sin(a) * s * 0.85);
      g.lineTo(x + Math.cos(a) * s * 1.15, y + Math.sin(a) * s * 1.15);
      g.stroke();
    }
  };
  const cloud = (x: number, y: number, s: number) => {
    g.beginPath();
    g.moveTo(x - s * 0.95, y + s * 0.45);
    g.arc(x - s * 0.55, y + s * 0.05, s * 0.42, 0.6 * Math.PI, 1.5 * Math.PI);
    g.arc(x + s * 0.02, y - s * 0.2, s * 0.58, 1.1 * Math.PI, 1.95 * Math.PI);
    g.arc(x + s * 0.6, y + s * 0.12, s * 0.36, 1.45 * Math.PI, 0.45 * Math.PI);
    g.closePath();
    g.stroke();
  };
  if (kind === 'clear') sunOrMoon(cx, cy, r * 0.62);
  else if (kind === 'partly') { sunOrMoon(cx - r * 0.25, cy - r * 0.25, r * 0.42); cloud(cx + r * 0.12, cy + r * 0.18, r * 0.6); }
  else if (kind === 'fog') {
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.moveTo(cx - r * (0.7 - i * 0.12), cy - r * 0.35 + i * r * 0.35);
      g.lineTo(cx + r * (0.7 - (2 - i) * 0.12), cy - r * 0.35 + i * r * 0.35);
      g.stroke();
    }
  } else {
    const wet = kind === 'rain' || kind === 'drizzle' || kind === 'storm' || kind === 'snow';
    cloud(cx, cy - (wet ? r * 0.2 : 0), r * 0.68);
    if (kind === 'rain' || kind === 'drizzle') {
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(cx + i * r * 0.36, cy + r * 0.38);
        g.lineTo(cx + i * r * 0.36 - r * 0.12, cy + r * (kind === 'rain' ? 0.72 : 0.58));
        g.stroke();
      }
    } else if (kind === 'snow') {
      for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(cx + i * r * 0.36, cy + r * 0.55 + (i === 0 ? r * 0.1 : 0), r * 0.07, 0, TAU); g.fill(); }
    } else if (kind === 'storm') {
      g.beginPath();
      g.moveTo(cx + r * 0.08, cy + r * 0.3);
      g.lineTo(cx - r * 0.14, cy + r * 0.6);
      g.lineTo(cx + r * 0.08, cy + r * 0.6);
      g.lineTo(cx - r * 0.1, cy + r * 0.9);
      g.stroke();
    }
  }
  g.restore();
}

const shadowed = (g: CanvasRenderingContext2D, size: number) => {
  g.shadowColor = 'rgba(0, 34, 84, 0.7)';
  g.shadowBlur = size * 0.18;
  g.shadowOffsetY = Math.max(2, size * 0.06);
};

/** The live weather's words, with the temperature first: "12° · Light rain". */
const weatherLine = (w: Weather) => `${w.temperature === null ? '' : `${formatTemperature(w.temperature)} · `}${w.label}`;

/**
 * The corner clock: a dark glass chip in the bottom right, its right edge at `right` and its
 * bottom at `bottom`: the time large, the date under it, and the live weather (if there is any)
 * beside the time with its icon.
 */
export function drawCornerClock(g: CanvasRenderingContext2D, date: Date, weather: Weather | null, night: boolean, right: number, bottom: number) {
  const { time, period, day } = clockText(date);
  g.save();
  const pad = 26, timeSize = 58, small = 22;
  g.font = `300 ${timeSize}px ${FONT}`;
  const timeW = g.measureText(time).width;
  g.font = `600 ${small}px ${FONT}`;
  const periodW = period ? g.measureText(period).width + 8 : 0;
  const dayW = g.measureText(day).width;
  const line = weather ? weatherLine(weather) : '';
  g.font = `700 ${small}px ${FONT}`;
  const weatherW = weather ? g.measureText(line).width + 50 : 0;
  const w = Math.max(timeW + periodW + (weather ? 76 : 0), dayW, weatherW) + pad * 2;
  const h = weather ? 152 : 118;
  const x = right - w, y = bottom - h;
  drawDarkGlassPanel(g, { x, y, w, h }, 28);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  shadowed(g, timeSize);
  g.font = `300 ${timeSize}px ${FONT}`;
  g.fillText(time, x + pad, y + pad + timeSize * 0.78);
  if (period) {
    g.font = `600 ${small}px ${FONT}`;
    g.fillText(period, x + pad + timeW + 8, y + pad + timeSize * 0.78);
  }
  shadowed(g, small);
  g.font = `600 ${small}px ${FONT}`;
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillText(day, x + pad, y + pad + timeSize + 26);
  if (weather) {
    drawWeatherIcon(g, weather.kind, night, x + w - pad - 26, y + pad + 28, 40);
    g.font = `700 ${small}px ${FONT}`;
    g.fillStyle = '#dff6ff';
    g.fillText(line, x + pad, y + pad + timeSize + 60);
  }
  g.restore();
}

/** The large clock: the time big and light, bottom left, the date and the weather under it, on no panel. */
export function drawLargeClock(g: CanvasRenderingContext2D, date: Date, weather: Weather | null, night: boolean, x: number, y: number) {
  const { time, period, day } = clockText(date);
  const size = 210;
  g.save();
  if ('letterSpacing' in g) g.letterSpacing = `${-size * 0.03}px`;
  g.textBaseline = 'alphabetic';
  g.font = `200 ${size}px ${FONT}`;
  const timeW = g.measureText(time).width;
  // The wordmark's treatment: a wide dark halo, a hard drop shadow, a glossy face.
  g.shadowColor = 'rgba(0, 28, 70, 0.5)';
  g.shadowBlur = 46;
  g.shadowOffsetY = 10;
  g.fillStyle = 'rgba(0, 40, 90, 0.3)';
  g.fillText(time, x, y);
  g.shadowColor = 'rgba(0, 34, 84, 0.7)';
  g.shadowBlur = 4;
  g.shadowOffsetY = 6;
  g.fillStyle = '#ffffff';
  g.fillText(time, x, y);
  g.shadowColor = 'transparent';
  const face = g.createLinearGradient(0, y - size * 0.75, 0, y);
  face.addColorStop(0, '#ffffff');
  face.addColorStop(0.55, '#ffffff');
  face.addColorStop(1, '#d5f3ff');
  g.fillStyle = face;
  g.fillText(time, x, y);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  shadowed(g, 40);
  if (period) {
    g.font = `500 44px ${FONT}`;
    g.fillStyle = '#ffffff';
    g.fillText(period, x + timeW + 14, y);
  }
  g.font = `600 38px ${FONT}`;
  g.fillStyle = '#ffffff';
  g.fillText(day, x + 8, y + 60);
  if (weather) {
    drawWeatherIcon(g, weather.kind, night, x + 30, y + 108, 40);
    g.font = `600 32px ${FONT}`;
    g.fillText(weatherLine(weather), x + 66, y + 120);
  }
  g.restore();
}

/** A caption bottom left: the screensaver's name and, under it, its view and scene; `alpha` fades it. */
export function drawCaption(g: CanvasRenderingContext2D, title: string, line: string, x: number, bottom: number, alpha: number) {
  if (alpha <= 0.005) return;
  g.save();
  g.globalAlpha *= alpha;
  g.textBaseline = 'alphabetic';
  shadowed(g, 40);
  g.font = `800 40px ${FONT}`;
  g.fillStyle = '#ffffff';
  g.fillText(title, x, bottom - 34);
  if (line) {
    shadowed(g, 24);
    g.font = `600 24px ${FONT}`;
    g.fillStyle = 'rgba(255,255,255,0.88)';
    g.fillText(line, x + 2, bottom);
  }
  g.restore();
}
