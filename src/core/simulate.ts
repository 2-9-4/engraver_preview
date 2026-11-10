import type { CompiledOperation, Operation, Project, Toolpath } from '../types';

export interface Surface {
  width: number;
  height: number;
  values: Float32Array; // negative mm from original stock top
  minDepth: number;
}

export function toolHeightAtRadius(radius: number, op: Operation): number {
  if (op.tool === 'vbit') {
    const angle = Math.max(1, Math.min(179, op.angle));
    // V-tip to surface: z(r) = r / tan(angle / 2)
    return radius / Math.tan(angle * Math.PI / 360);
  }
  const cutterR = Math.max(0.05, op.diameter / 2);
  if (radius > cutterR) return Infinity;
  if (op.tool === 'flat') return 0;
  return cutterR - Math.sqrt(Math.max(0, cutterR * cutterR - radius * radius));
}

export function simulateSurface(project: Project, compiled: CompiledOperation[]): Surface {
  const width = Math.max(16, Math.floor(project.resolution * project.width / Math.max(project.width, project.height)));
  const height = Math.max(16, Math.floor(project.resolution * project.height / Math.max(project.width, project.height)));
  const values = new Float32Array((width + 1) * (height + 1));
  const dx = project.width / width;
  const dy = project.height / height;
  let minDepth = 0;

  for (const item of compiled) {
    const op = item.operation;
    const cutterR = Math.max(0.05, op.diameter / 2);
    const radius = op.tool === 'vbit'
      ? Math.min(cutterR, Math.max(0, op.depth) * Math.tan(Math.max(1, Math.min(179, op.angle)) * Math.PI / 360))
      : cutterR;
    const reachX = Math.ceil(radius / dx) + 1;
    const reachY = Math.ceil(radius / dy) + 1;

    const stamp = (x: number, y: number, depth: number) => {
      const cx = Math.round(x / dx);
      const cy = Math.round(y / dy);
      for (let iy = Math.max(0, cy - reachY); iy <= Math.min(height, cy + reachY); iy++) {
        for (let ix = Math.max(0, cx - reachX); ix <= Math.min(width, cx + reachX); ix++) {
          const r = Math.hypot(ix * dx - x, iy * dy - y);
          if (r > radius) continue;
          const cutterZ = -depth + toolHeightAtRadius(r, op);
          if (cutterZ < 0) {
            const i = iy * (width + 1) + ix;
            if (cutterZ < values[i]!) {
              values[i] = Math.max(-project.thickness, cutterZ);
              minDepth = Math.min(minDepth, values[i]!);
            }
          }
        }
      }
    };
    for (const path of item.paths) sweepPath(path, Math.min(dx, dy) * 0.55, stamp);
  }
  return { width, height, values, minDepth };
}

export function sweepPath(path: Toolpath, maxStep: number, stamp: (x: number, y: number, depth: number) => void): void {
  if (!path.length) return;
  stamp(path[0]!.x, path[0]!.y, path[0]!.depth);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / maxStep));
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      stamp(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), a.depth + t * (b.depth - a.depth));
    }
  }
}
