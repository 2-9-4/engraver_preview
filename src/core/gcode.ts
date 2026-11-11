import type { CompiledOperation, Machine, Point, Project } from '../types';

function fmt(v: number): string {
  if (!Number.isFinite(v)) throw new Error('Non-finite G-code coordinate');
  return v.toFixed(3);
}
function coords(p: Point, project: Project, machine: Machine): string {
  const x = p.x - (machine.origin === 'center' ? project.width / 2 : 0);
  const y = p.y - (machine.origin === 'center' ? project.height / 2 : 0);
  return 'X' + fmt(x) + ' Y' + fmt(y);
}

export function generateGcode(project: Project, machine: Machine, compiled: CompiledOperation): string {
  const op = compiled.operation;
  if (!Number.isFinite(project.width) || !Number.isFinite(project.height) ||
      !Number.isFinite(project.thickness) || project.width <= 0 ||
      project.height <= 0 || project.thickness <= 0) {
    throw new Error('Stock dimensions must be finite and positive.');
  }
  if (!Number.isFinite(op.depth) || op.depth <= 0 ||
      !Number.isFinite(op.diameter) || op.diameter <= 0 ||
      (op.tool === 'vbit' && (!Number.isFinite(op.angle) || op.angle <= 0 || op.angle >= 180))) {
    throw new Error('Cutter diameter, depth, and V angle must be valid.');
  }
  if (!Number.isFinite(machine.safeZ) || !Number.isFinite(machine.travelFeed) ||
      !Number.isFinite(op.feed) || !Number.isFinite(op.plunge) ||
      !Number.isFinite(op.passDepth) ||
      (machine.spindleEnabled && (!Number.isFinite(machine.spindleRPM) || machine.spindleRPM < 0))) {
    throw new Error('Feeds, clearance, and spindle settings must be finite.');
  }
  // Reject corrupted/out-of-bounds jobs instead of silently writing dangerous coordinates.
  for (const path of compiled.paths) {
    for (const p of path) {
      if (![p.x, p.y, p.depth].every(Number.isFinite) ||
          p.x < -0.0001 || p.x > project.width + 0.0001 ||
          p.y < -0.0001 || p.y > project.height + 0.0001 ||
          p.depth < 0 || p.depth > op.depth + 0.0001) {
        throw new Error('Toolpath has invalid or out-of-stock coordinates or depth.');
      }
    }
  }
  if (!(machine.safeZ > 0 && machine.travelFeed > 0 && op.feed > 0 && op.plunge > 0 && op.passDepth > 0)) {
    throw new Error('Safe Z, feeds, and pass depth must be positive.');
  }
  if (op.depth > project.thickness) throw new Error('Operation depth exceeds stock thickness.');
  if (!compiled.paths.length) throw new Error('Operation contains no toolpaths.');
  const lines = [
    '; Engraver Preview - VERIFY IN SIMULATOR BEFORE RUNNING',
    '; ' + op.name.replace(/[\r\n;]/g, ' ') + ' | ' + op.tool + ' | diameter ' + fmt(op.diameter) + ' mm',
    '; Stock Z0 is top surface; negative Z cuts; origin: ' + machine.origin,
    '; Tool and work zero MUST be manually set. No automatic homing or tool changes.',
    '; Controller: ' + machine.controller,
    'G90',
  ];
  if (op.mode === 'vector' && op.centerlineFilled) {
    lines.push('; WARNING: SVG filled contours were approximately reduced to centerlines.');
    lines.push('; Inspect branches, small gaps and reconstructed strokes before machining.');
  }
  if (machine.controller !== 'klipper') lines.push('G21');
  if (machine.controller === 'linuxcnc') lines.push('G17', 'G94', 'G40');
  lines.push('G0 Z' + fmt(machine.safeZ) + ' F' + fmt(machine.travelFeed));
  if (machine.spindleEnabled) {
    lines.push('; Requires configured spindle / M3 support on your controller');
    lines.push('M3 S' + Math.round(machine.spindleRPM));
  } else {
    lines.push('; Spindle control omitted: start spindle using your machine procedure');
  }
  const passes = Math.ceil(op.depth / op.passDepth);
  if (passes > 250) throw new Error('Too many depth passes; increase pass depth.');
  for (let pass = 1; pass <= passes; pass++) {
    const limit = Math.min(op.depth, pass * op.passDepth);
    lines.push('; Pass ' + pass + '/' + passes + ' depth limit ' + fmt(limit));
    for (const path of compiled.paths) {
      if (!path.length || path.every(p => p.depth <= 0)) continue;
      const first = path[0]!;
      lines.push('G0 Z' + fmt(machine.safeZ) + ' F' + fmt(machine.travelFeed));
      lines.push('G0 ' + coords(first, project, machine) + ' F' + fmt(machine.travelFeed));
      lines.push('G1 Z-' + fmt(Math.min(first.depth, limit)) + ' F' + fmt(op.plunge));
      let last = first;
      let lastDepth = Math.min(first.depth, limit);
      for (let i = 1; i < path.length; i++) {
        const p = path[i]!;
        const depth = Math.min(p.depth, limit);
        if (Math.hypot(p.x - last.x, p.y - last.y) < 0.01 && Math.abs(depth - lastDepth) < 0.01) continue;
        // F applies to 3D path length. Reduce feed on steep variable-Z segments
        // so the Z component never exceeds the requested plunge feed.
        const xyDistance = Math.hypot(p.x - last.x, p.y - last.y);
        const zDistance = Math.abs(depth - lastDepth);
        const linearDistance = Math.hypot(xyDistance, zDistance);
        const segmentFeed = zDistance > 0
          ? Math.min(op.feed, op.plunge * linearDistance / zDistance)
          : op.feed;
        lines.push('G1 ' + coords(p, project, machine) + ' Z-' + fmt(depth) + ' F' + fmt(segmentFeed));
        last = p;
        lastDepth = depth;
      }
    }
  }
  lines.push('G0 Z' + fmt(machine.safeZ) + ' F' + fmt(machine.travelFeed));
  if (machine.spindleEnabled) lines.push('M5');
  if (machine.controller === 'linuxcnc') lines.push('M2');
  lines.push('; End of operation');
  return lines.join('\n') + '\n';
}
