import type { Artwork, VectorStroke } from '../types';

const svgNS = 'http://www.w3.org/2000/svg';
const forbidden = 'script,foreignObject,iframe,object,embed,image,video,audio,animate,animateMotion,animateTransform,set,feImage,link';
const geometryTags = 'path,line,polyline,polygon,rect,circle,ellipse';

function sanitize(source: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid SVG XML');
  const root = doc.documentElement;
  if (root.namespaceURI !== svgNS || root.localName !== 'svg') throw new Error('File is not an SVG');
  root.querySelectorAll(forbidden).forEach(e => e.remove());
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(node.attributes)) {
      const key = a.name.toLowerCase();
      const value = a.value.trim();
      if (key.startsWith('on') || key === 'href' && !value.startsWith('#')
        || key === 'xlink:href' && !value.startsWith('#')
        || /url\(\s*['"]?(?!#)/i.test(value)
        || /javascript:|data:text\/html|@import/i.test(value)) node.removeAttribute(a.name);
    }
  }
  root.querySelectorAll('style').forEach(node => {
    if (/@import|url\(\s*['"]?(?!#)/i.test(node.textContent || '')) node.remove();
  });
  return root as SVGSVGElement;
}

function svgDimension(root: SVGSVGElement): { width: number; height: number } {
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let width = vb.length === 4 && vb[2]! > 0 ? vb[2]! : Number.parseFloat(root.getAttribute('width') || '') || 512;
  let height = vb.length === 4 && vb[3]! > 0 ? vb[3]! : Number.parseFloat(root.getAttribute('height') || '') || 512;
  const scale = 512 / Math.max(width, height);
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  return { width, height };
}

function paintHex(value: string): string | null {
  if (!value || value === 'none' || value === 'transparent') return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + value.slice(1).split('').map(c => c + c).join('').toLowerCase();
  const numbers = value.match(/[\d.]+/g);
  if (!numbers || numbers.length < 3) return null;
  return '#' + numbers.slice(0, 3).map(n => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')).join('');
}

function extractStrokes(root: SVGSVGElement, width: number, height: number): VectorStroke[] {
  root.style.position = 'absolute';
  root.style.left = '-10000px';
  root.style.top = '0';
  root.style.pointerEvents = 'none';
  root.style.opacity = '0';
  document.body.append(root);
  const result: VectorStroke[] = [];
  try {
    for (const shape of root.querySelectorAll<SVGGeometryElement>(geometryTags)) {
      if (shape.closest('defs,symbol,clipPath,mask,pattern')) continue;
      const style = getComputedStyle(shape);
      const color = paintHex(style.stroke);
      if (!color || style.display === 'none' || Number(style.strokeOpacity) === 0 || Number(style.opacity) === 0) continue;
      const ctm = shape.getCTM();
      if (!ctm) continue;
      let length = 0;
      try { length = shape.getTotalLength(); } catch { continue; }
      if (!(length > 0)) continue;
      const scale = Math.max(Math.hypot(ctm.a, ctm.b), Math.hypot(ctm.c, ctm.d));
      const count = Math.min(10000, Math.max(2, Math.ceil(length * scale / 1.2)));
      const points: VectorStroke['points'] = [];
      for (let i = 0; i <= count; i++) {
        const pt = shape.getPointAtLength(length * i / count).matrixTransform(ctm);
        points.push({ x: pt.x / width, y: pt.y / height });
      }
      result.push({ color, points });
    }
  } finally {
    root.remove();
  }
  return result;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Cannot decode image'));
    image.src = src;
  });
}

export async function loadArtwork(file: File): Promise<Artwork> {
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (!svg && !/^image\/(png|jpeg|webp|gif|bmp)$/i.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
    throw new Error('Upload an SVG, PNG, JPEG, WebP, GIF, or BMP image');
  }
  let blob: Blob = file;
  let strokes: VectorStroke[] = [];
  if (svg) {
    const root = sanitize(await file.text());
    const { width, height } = svgDimension(root);
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    if (!root.hasAttribute('viewBox')) root.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    // Collect native SVG centerline paths before serializing to an image-only URL.
    strokes = extractStrokes(root, width, height);
    root.removeAttribute('style');
    blob = new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' });
  }
  const url = URL.createObjectURL(blob);
  try {
    return { name: file.name, image: await loadImage(url), isSVG: svg, strokes };
  } finally {
    URL.revokeObjectURL(url);
  }
}
