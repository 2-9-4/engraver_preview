import type { Artwork, VectorStroke } from '../types';
import { svgPathFromStrokes } from '../svgMasks';

const MAX_SIDE = 1536;
const SIMPLIFY_PX = 0.65;
const SHORT_SPUR_PX = 4;
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

type XY = { x: number; y: number };

/** Standard Zhang-Suen topology-preserving thinning of an opaque rasterized
 * filled region. This rasterization is an explicit *reconstruction* option:
 * SVG fill outlines have no unique original centerline to recover.
 */
export function thinBinaryMask(mask: Uint8Array, width: number, height: number): void {
  if (mask.length !== width * height) throw new Error('Invalid centerline mask');
  const deleted: number[] = [];
  const lastRow = height - 1, lastCol = width - 1;
  for (let pass = 0; pass < 128; pass++) {
    let changed = false;
    for (let phase = 0; phase < 2; phase++) {
      deleted.length = 0;
      for (let y = 1; y < lastRow; y++) {
        let i = y * width + 1;
        for (let x = 1; x < lastCol; x++, i++) {
          if (!mask[i]) continue;
          const p2 = mask[i - width]!, p3 = mask[i - width + 1]!;
          const p4 = mask[i + 1]!, p5 = mask[i + width + 1]!;
          const p6 = mask[i + width]!, p7 = mask[i + width - 1]!;
          const p8 = mask[i - 1]!, p9 = mask[i - width - 1]!;
          const count = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (count < 2 || count > 6) continue;
          const transitions = (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) +
            (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) +
            (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
          if (transitions !== 1) continue;
          if (phase === 0) {
            if (p2 && p4 && p6) continue;
            if (p4 && p6 && p8) continue;
          } else {
            if (p2 && p4 && p8) continue;
            if (p2 && p6 && p8) continue;
          }
          deleted.push(i);
        }
      }
      if (deleted.length) changed = true;
      for (const i of deleted) mask[i] = 0;
    }
    if (!changed) break;
  }
}

function neighboring(mask: Uint8Array, width: number, height: number, i: number): Array<[number, number]> {
  const x = i % width, y = (i / width) | 0;
  const found: Array<[number, number]> = [];
  for (let direction = 0; direction < 8; direction++) {
    const [dx, dy] = DIRECTIONS[direction]!;
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    const next = ny * width + nx;
    if (!mask[next]) continue;
    // Do not create diagonal shortcuts across a 90-degree skeleton corner:
    // they would produce three-sided loops and spur junctions.
    if (dx !== 0 && dy !== 0 && (mask[y * width + nx] || mask[ny * width + x])) continue;
    found.push([next, direction]);
  }
  return found;
}

function pruneShortSpurs(mask: Uint8Array, width: number, height: number): void {
  for (let round = 0; round < 3; round++) {
    const remove: number[] = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const firstNeighbors = neighboring(mask, width, height, i);
      if (firstNeighbors.length !== 1) continue;
      const branch = [i];
      let previous = i, current = firstNeighbors[0]![0];
      while (branch.length <= SHORT_SPUR_PX) {
        const around = neighboring(mask, width, height, current);
        if (around.length !== 2) {
          if (around.length >= 3 && branch.length <= SHORT_SPUR_PX)
            remove.push(...branch);
          break;
        }
        branch.push(current);
        const forward = around.find(([next]) => next !== previous);
        if (!forward) break;
        previous = current;
        current = forward[0];
      }
    }
    if (!remove.length) break;
    for (const i of remove) mask[i] = 0;
  }
}

function simplifyOpen(points: XY[], epsilon: number): XY[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const a = points[start]!, b = points[end]!;
    const dx = b.x - a.x, dy = b.y - a.y, sq = dx * dx + dy * dy;
    let most = -1, distance = epsilon * epsilon;
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!;
      const t = sq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / sq)) : 0;
      const ex = p.x - a.x - dx * t, ey = p.y - a.y - dy * t;
      const d2 = ex * ex + ey * ey;
      if (d2 > distance) { distance = d2; most = i; }
    }
    if (most !== -1) {
      keep[most] = 1;
      stack.push([start, most], [most, end]);
    }
  }
  return points.filter((_, i) => keep[i] !== 0);
}

function smoothAndSimplify(indices: number[], width: number): XY[] {
  if (indices.length < 3) return [];
  const closed = indices[0] === indices[indices.length - 1];
  const unique = closed ? indices.slice(0, -1) : indices;
  const coords: XY[] = unique.map(i => ({ x: i % width + 0.5, y: Math.floor(i / width) + 0.5 }));
  // Small weighted smoothing removes one-pixel thinning jaggies while keeping
  // true endpoints/junctions in their original positions.
  const smoothed = coords.map((p, i) => {
    if (!closed && (i === 0 || i === coords.length - 1)) return p;
    const a = coords[(i + coords.length - 1) % coords.length]!;
    const b = coords[(i + 1) % coords.length]!;
    return { x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
  });
  if (!closed) return simplifyOpen(smoothed, SIMPLIFY_PX);
  if (smoothed.length < 5) return [];
  let pivot = 1, furthest = -1;
  for (let i = 1; i < smoothed.length; i++) {
    const dx = smoothed[i]!.x - smoothed[0]!.x;
    const dy = smoothed[i]!.y - smoothed[0]!.y;
    if (dx * dx + dy * dy > furthest) { furthest = dx * dx + dy * dy; pivot = i; }
  }
  const a = simplifyOpen(smoothed.slice(0, pivot + 1), SIMPLIFY_PX);
  const b = simplifyOpen([...smoothed.slice(pivot), smoothed[0]!], SIMPLIFY_PX);
  return [...a, ...b.slice(1)];
}

/** Walk each thinned skeleton edge exactly once. Junctions split strokes, but
 * no boundary is followed twice. Closed loops remain closed cutter paths.
 */
export function traceSkeleton(mask: Uint8Array, width: number, height: number): XY[][] {
  pruneShortSpurs(mask, width, height);
  const degree = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) degree[i] = neighboring(mask, width, height, i).length;
  }
  const visited = new Uint8Array(mask.length);
  const walk = (start: number, next: number, direction: number): XY[] => {
    const indices = [start];
    let from = start, to = next, dir = direction;
    while (true) {
      visited[from] = visited[from]! | (1 << dir);
      visited[to] = visited[to]! | (1 << ((dir + 4) % 8));
      indices.push(to);
      if (to === start || degree[to] !== 2) break;
      const onward = neighboring(mask, width, height, to)
        .find(([q, d]) => q !== from && !(visited[to]! & (1 << d)));
      if (!onward) break;
      from = to;
      to = onward[0];
      dir = onward[1];
    }
    return smoothAndSimplify(indices, width);
  };
  const traced: XY[][] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || (pass === 0 ? degree[i] === 2 : degree[i] !== 2)) continue;
      for (const [next, direction] of neighboring(mask, width, height, i)) {
        if (visited[i]! & (1 << direction)) continue;
        const points = walk(i, next, direction);
        if (points.length > 1) traced.push(points);
      }
    }
  }
  return traced;
}

/**
 * Opt-in fallback for "outline-of-a-line" SVGs generated by bitmap tracing.
 * Fill contours describe two sides of each ink band, NOT a tool centerline.
 * Rasterize filled geometry only for this recovery mode, thin to medial lines,
 * then reuse the resulting centerline polylines for both CAM and preview.
 */
export function recoverFilledSvgCenterlines(artwork: Artwork): Artwork {
  if (!artwork.isSVG) throw new Error('Filled centerline recovery requires SVG artwork.');
  const shapes = artwork.strokes.filter(s => s.fillColor);
  if (!shapes.length) throw new Error('No filled SVG geometry found. Use native stroke paths instead.');
  const naturalW = artwork.image.naturalWidth, naturalH = artwork.image.naturalHeight;
  const density = Math.min(MAX_SIDE / Math.max(naturalW, naturalH), 8);
  const width = Math.max(16, Math.round(naturalW * density));
  const height = Math.max(16, Math.round(naturalH * density));
  const project = { width: naturalW, height: naturalH, thickness: 1, resolution: 64 };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Cannot rasterize filled SVG paths for centerline recovery.');
  const output: VectorStroke[] = [];
  const colors = [...new Set(shapes.map(s => s.fillColor!.toLowerCase()))];
  for (const color of colors) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    for (const shape of shapes) {
      if (shape.fillColor?.toLowerCase() !== color) continue;
      // Fill each compound SVG shape independently to preserve its holes and
      // CSS winding rule. Do not follow its outer and inner boundaries.
      const path = svgPathFromStrokes(artwork, project, [shape], density);
      ctx.fill(path, shape.fillRule || 'nonzero');
    }
    const rgba = ctx.getImageData(0, 0, width, height).data;
    // An empty halo is essential for paths crossing the artwork boundary.
    // Without it thinning refuses to remove outermost pixels and leaves
    // artificial duplicate/border-following skeletons at the frame edges.
    const pad = 2, paddedWidth = width + 2 * pad, paddedHeight = height + 2 * pad;
    const pixels = new Uint8Array(paddedWidth * paddedHeight);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels[(y + pad) * paddedWidth + x + pad] =
          rgba[4 * (y * width + x) + 3]! >= 128 ? 1 : 0;
      }
    }
    thinBinaryMask(pixels, paddedWidth, paddedHeight);
    const lines = traceSkeleton(pixels, paddedWidth, paddedHeight);
    for (const line of lines) {
      // svgPathFromStrokes renders machine Y-up on Canvas; convert its points
      // back into the normalized SVG top-left system shared by other strokes.
      const points = line.map(p => ({
        x: Math.max(0, Math.min(1, (p.x - pad) / width)),
        y: Math.max(0, Math.min(1, 1 - (p.y - pad) / height)),
      }));
      if (points.length > 1) output.push({ color, points });
    }
  }
  if (!output.length) throw new Error('No centerlines could be recovered from the filled SVG artwork.');
  return { ...artwork, strokes: output };
}
