import type { Artwork, CompiledOperation, Operation, Pixels, Point, Preprocess, Project, Toolpath } from '../types';
import { intensityAt } from './image';
import { nativeStrokeToolpaths } from './nativeCurves';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function depthFromIntensity(value: number, operation: Operation): number {
  const t = clamp(operation.threshold, 0, 0.99);
  return value <= t ? 0 : operation.depth * Math.pow(clamp((value - t) / (1 - t), 0, 1), clamp(operation.gamma, 0.1, 5));
}

export function compileOperation(project: Project, pixels: Pixels, artwork: Artwork, preprocess: Preprocess, operation: Operation): CompiledOperation {
  const paths = operation.mode === 'vector'
    ? compileVectors(project, artwork, operation)
    : compileRaster(project, pixels, preprocess, operation);
  let length = 0;
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    length += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  }
  return { operation, paths, length };
}

function compileRaster(project: Project, pixels: Pixels, prep: Preprocess, op: Operation): Toolpath[] {
  const out: Toolpath[] = [];
  const stepover = clamp(op.stepover, 0.05, 100);
  const sample = Math.max(0.12, Math.min(stepover * 0.5, project.width / pixels.width));
  const vertical = op.scanAxis === 'vertical';
  const travel = vertical ? project.height : project.width;
  const cross = vertical ? project.width : project.height;
  const rows = Math.ceil(cross / stepover);
  const columns = Math.ceil(travel / sample);
  if (rows * columns > 750000) throw new Error('Toolpath exceeds 750,000 samples. Increase stepover or reduce workpiece size.');
  for (let row = 0; row <= rows; row++) {
    const crossPos = Math.min(cross, row * stepover);
    const path: Toolpath = [];
    const segments: Toolpath[] = [];
    const backwards = row % 2 === 1;
    for (let col = 0; col <= columns; col++) {
      const along = travel * (backwards ? 1 - col / columns : col / columns);
      const x = vertical ? crossPos : along;
      const y = vertical ? along : crossPos;
      // Canvas Y grows downward; machine Y grows up from the bottom edge.
      const value = intensityAt(pixels, x / project.width, 1 - y / project.height, op.channel, op.color, op.tolerance, prep.invert);
      const depth = depthFromIntensity(value, op);
      if (depth > 0.008) {
        path.push({ x, y, depth });
      } else if (path.length) {
        segments.push(path.splice(0));
      }
    }
    if (path.length) segments.push(path);
    out.push(...segments);
  }
  return out;
}

function compileVectors(project: Project, artwork: Artwork, op: Operation): Toolpath[] {
  const selected = op.channel === 'color' ? op.color.toLowerCase() : null;
  // Match image fitting: SVG strokes must not stretch when the stock and artwork have different aspect ratios.
  const scale = Math.min(project.width / artwork.image.naturalWidth, project.height / artwork.image.naturalHeight);
  const displayWidth = artwork.image.naturalWidth * scale;
  const displayHeight = artwork.image.naturalHeight * scale;
  const left = (project.width - displayWidth) / 2;
  const top = (project.height - displayHeight) / 2;
  return artwork.strokes
    .filter(stroke => !selected || stroke.color.toLowerCase() === selected)
    .flatMap(stroke => stroke.curves ? nativeStrokeToolpaths(project, artwork, stroke, op.depth) : [stroke.points.map(({ x, y }): Point => ({
      x: left + clamp(x, 0, 1) * displayWidth,
      y: project.height - (top + clamp(y, 0, 1) * displayHeight),
      depth: op.depth,
    }))])
    .filter(path => path.length > 1);
}
