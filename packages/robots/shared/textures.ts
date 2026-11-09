import * as THREE from 'three';
import { mulberry32 } from '../../stages/shared/random.ts';

// Canvas textures drawn once at load and shared: surface noise for bump and roughness maps,
// brushed streaks, carbon weave, hazard stripes and printed labels. Cached by their arguments,
// never disposed (the hall is one scene that lives as long as the page).

const cache = new Map<string, THREE.Texture>();

function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let texture = cache.get(key) as T | undefined;
  if (!texture) cache.set(key, (texture = make()));
  return texture;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw Error('No 2D canvas');
  return [c, g];
}

function finish(c: HTMLCanvasElement, { color = false, repeat = 1 }: { color?: boolean; repeat?: number } = {}): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Tiling grey noise, for bump maps (orange-peel paint, cast metal, rubber) and roughness
 * variation. `grain` is the size of the finest blobs in pixels; `seed` varies it.
 */
export function noiseTexture(grain = 2, seed = 1, size = 256): THREE.Texture {
  return cached(`noise:${grain}:${seed}:${size}`, () => {
    const [c, g] = canvas(size, size);
    const rand = mulberry32(seed);
    const image = g.createImageData(size, size);
    // A few octaves of value noise that wrap at the edges.
    const octaves = [grain, grain * 2, grain * 4, grain * 8];
    const grids = octaves.map((cell) => {
      const n = Math.max(1, Math.round(size / cell));
      return { n, v: Float32Array.from({ length: n * n }, () => rand()) };
    });
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        let weight = 0;
        grids.forEach(({ n, v }, o) => {
          const fx = (x / size) * n;
          const fy = (y / size) * n;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = fx - x0;
          const ty = fy - y0;
          const sx = tx * tx * (3 - 2 * tx);
          const sy = ty * ty * (3 - 2 * ty);
          const at = (i: number, j: number) => v[((j % n) * n) + (i % n)];
          const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
          const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
          const w = 1 / (o + 1);
          sum += (a + (b - a) * sy) * w;
          weight += w;
        });
        const value = Math.round((sum / weight) * 255);
        const i = (y * size + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
        image.data[i + 3] = 255;
      }
    }
    g.putImageData(image, 0, 0);
    return finish(c);
  });
}

/** Fine streaks along U, for brushed and ground metal (roughness or bump). */
export function brushedTexture(seed = 3): THREE.Texture {
  return cached(`brushed:${seed}`, () => {
    const size = 512;
    const [c, g] = canvas(size, size);
    const rand = mulberry32(seed);
    g.fillStyle = '#808080';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {
      const y = rand() * size;
      const x = rand() * size;
      const len = 40 + rand() * 260;
      const shade = Math.round(100 + rand() * 60);
      g.strokeStyle = `rgba(${shade},${shade},${shade},${0.25 + rand() * 0.35})`;
      g.lineWidth = 0.6 + rand() * 1.2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + len, y + (rand() - 0.5) * 1.5);
      g.stroke();
      // Wrap the streak round the edge.
      if (x + len > size) {
        g.beginPath();
        g.moveTo(x - size, y);
        g.lineTo(x + len - size, y);
        g.stroke();
      }
    }
    return finish(c);
  });
}

/** A 2×2 twill carbon-fibre weave (colour), `tows` tows across the tile. */
export function carbonTexture(tows = 8): THREE.Texture {
  return cached(`carbon:${tows}`, () => {
    const size = 256;
    const [c, g] = canvas(size, size);
    const cell = size / tows;
    for (let j = 0; j < tows; j++) {
      for (let i = 0; i < tows; i++) {
        // Twill: the over/under shifts by one each row.
        const warp = ((i + j) >> 1) % 2 === 0;
        const grad = warp ? g.createLinearGradient(i * cell, 0, (i + 1) * cell, 0) : g.createLinearGradient(0, j * cell, 0, (j + 1) * cell);
        grad.addColorStop(0, '#0b0c0e');
        grad.addColorStop(0.5, warp ? '#3a3e44' : '#2a2d32');
        grad.addColorStop(1, '#0b0c0e');
        g.fillStyle = grad;
        g.fillRect(i * cell, j * cell, cell, cell);
      }
    }
    return finish(c, { color: true });
  });
}

/** Diagonal stripes of two colours (yellow and black by default), `stripes` across the tile. */
export function stripeTexture(a = '#f2c200', b = '#16171a', stripes = 4): THREE.Texture {
  return cached(`stripes:${a}:${b}:${stripes}`, () => {
    const size = 256;
    const [c, g] = canvas(size, size);
    g.fillStyle = a;
    g.fillRect(0, 0, size, size);
    g.fillStyle = b;
    const w = size / stripes;
    for (let i = -stripes; i < stripes * 2; i++) {
      g.beginPath();
      g.moveTo(i * w, 0);
      g.lineTo(i * w + w / 2, 0);
      g.lineTo(i * w + w / 2 + size, size);
      g.lineTo(i * w + size, size);
      g.closePath();
      g.fill();
    }
    return finish(c, { color: true });
  });
}

export interface LabelOptions {
  /** Canvas pixels: keep the aspect of the face it goes on. */
  width?: number;
  height?: number;
  background?: string;
  color?: string;
  /** CSS font weight and family. */
  font?: string;
  /** Each line's size as a share of the height. */
  sizes?: readonly number[];
  align?: CanvasTextAlign;
  /** A border inset this far, in pixels (0: none). */
  border?: number;
}

/**
 * Printed text (nameplates, axis numbers, warning labels), centred line by line. Colour texture.
 *
 *   labelTexture(['J2', 'AXIS'], { width: 256, height: 128, background: '#111', color: '#fff' })
 */
export function labelTexture(lines: readonly string[], options: LabelOptions = {}): THREE.Texture {
  const { width = 512, height = 256, background = '#f4f4f0', color = '#15171a', font = '700 {size}px "Exo 2", "Nunito", sans-serif', sizes = [], align = 'center', border = 0 } = options;
  return cached(`label:${JSON.stringify([lines, options])}`, () => {
    const [c, g] = canvas(width, height);
    g.fillStyle = background;
    g.fillRect(0, 0, width, height);
    if (border) {
      g.strokeStyle = color;
      g.lineWidth = Math.max(2, border / 3);
      g.strokeRect(border, border, width - 2 * border, height - 2 * border);
    }
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    const shares = lines.map((_, i) => sizes[i] ?? 0.7 / lines.length);
    const total = shares.reduce((a, b) => a + b, 0);
    let y = (height - total * height * 1.15) / 2;
    lines.forEach((line, i) => {
      const px = shares[i] * height;
      g.font = font.replace('{size}', String(Math.round(px)));
      const x = align === 'left' ? width * 0.06 : align === 'right' ? width * 0.94 : width / 2;
      g.fillText(line, x, y + px * 0.575, width * 0.9);
      y += px * 1.15;
    });
    const texture = finish(c, { color: true });
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  });
}
