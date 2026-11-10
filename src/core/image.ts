import type { Artwork, Channel, Pixels, Preprocess } from '../types';

const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));

export function preprocess(artwork: Artwork, width: number, height: number, options: Preprocess): Pixels {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const factor = Math.min(width / artwork.image.naturalWidth, height / artwork.image.naturalHeight);
  const w = artwork.image.naturalWidth * factor;
  const h = artwork.image.naturalHeight * factor;
  ctx.filter = options.blur > 0 ? 'blur(' + options.blur + 'px)' : 'none';
  ctx.drawImage(artwork.image, (width - w) / 2, (height - h) / 2, w, h);
  ctx.filter = 'none';
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = data[i + c]! / 255;
      v = clamp((v - 0.5) * (1 + options.contrast / 100) + 0.5 + options.brightness / 100);
      if (options.posterize > 1) v = Math.round(v * (options.posterize - 1)) / (options.posterize - 1);
      data[i + c] = Math.round(v * 255);
    }
  }
  return { width, height, data };
}

export function intensityAt(p: Pixels, x: number, y: number, channel: Channel, color: string, tolerance: number, invert: boolean): number {
  const ix = Math.max(0, Math.min(p.width - 1, Math.floor(x * p.width)));
  const iy = Math.max(0, Math.min(p.height - 1, Math.floor(y * p.height)));
  const i = 4 * (iy * p.width + ix);
  const r = p.data[i]! / 255;
  const g = p.data[i + 1]! / 255;
  const b = p.data[i + 2]! / 255;
  const a = p.data[i + 3]! / 255;
  let v: number;
  switch (channel) {
    case 'red': v = r; break;
    case 'green': v = g; break;
    case 'blue': v = b; break;
    case 'alpha': v = a; break;
    case 'color': {
      const target = hexRGB(color);
      const dist = Math.hypot(r * 255 - target[0], g * 255 - target[1], b * 255 - target[2]);
      v = clamp(1 - dist / Math.max(1, tolerance));
      break;
    }
    default: v = 1 - (0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  v *= a;
  return clamp(invert ? 1 - v : v);
}

function hexRGB(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const n = Number.parseInt(normalized.length === 3 ? normalized.split('').map(c => c + c).join('') : normalized, 16);
  return Number.isFinite(n) ? [(n >>> 16) & 255, (n >>> 8) & 255, n & 255] : [0, 0, 0];
}

export function discoverPalette(p: Pixels, count = 6): string[] {
  const buckets = new Map<number, number>();
  for (let i = 0; i < p.data.length; i += Math.max(4, Math.floor(p.data.length / 22000 / 4) * 4 || 4)) {
    if (p.data[i + 3]! < 50) continue;
    const r = p.data[i]!, g = p.data[i + 1]!, b = p.data[i + 2]!;
    if (r > 235 && g > 235 && b > 235) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([key]) => {
    const rgb = [((key >> 8) & 15) * 16 + 8, ((key >> 4) & 15) * 16 + 8, (key & 15) * 16 + 8];
    return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  });
}
