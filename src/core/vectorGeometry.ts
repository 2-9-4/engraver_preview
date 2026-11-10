import * as THREE from 'three';
import * as polygonClipping from 'polygon-clipping';
import type { CompiledOperation, Project, Toolpath } from '../types';

// Polygon clipping coordinates are in machine XY millimetres. All outlines are
// cutter-centerline sweeps, NOT SVG-stroke-width approximations.
type Ring = number[][];
type Poly = Ring[];
type Multi = Poly[];
const rectangle = (w: number, h: number): Multi => [[[[0, 0], [w, 0], [w, h], [0, h], [0, 0]]]];
const winding = (ring: Ring) => ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length]!;
  return sum + p[0]! * q[1]! - q[0]! * p[1]!;
}, 0);

function capsule(ax: number, ay: number, bx: number, by: number, r: number): Multi {
  const a = Math.atan2(by - ay, bx - ax);
  const count = Math.max(12, Math.min(96, Math.ceil(Math.PI * r / 0.06)));
  const ring: Ring = [];
  for (let i = 0; i <= count; i++) {
    const t = a - Math.PI / 2 + Math.PI * i / count;
    ring.push([bx + r * Math.cos(t), by + r * Math.sin(t)]);
  }
  for (let i = 0; i <= count; i++) {
    const t = a + Math.PI / 2 + Math.PI * i / count;
    ring.push([ax + r * Math.cos(t), ay + r * Math.sin(t)]);
  }
  ring.push([...ring[0]!]);
  return [[ring]];
}

function merge(shapes: Multi[]): Multi {
  if (!shapes.length) return [];
  // Keep each boolean manageable for long SVG curves.
  let acc: Multi = [];
  for (let i = 0; i < shapes.length; i += 32) {
    const batch = polygonClipping.union(...shapes.slice(i, i + 32) as [Multi, ...Multi[]]) as Multi;
    acc = acc.length ? polygonClipping.union(acc, batch) as Multi : batch;
  }
  return acc;
}

function footprint(paths: Toolpath[], radius: number): Multi {
  const swept: Multi[] = [];
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-7) continue;
      swept.push(capsule(a.x, a.y, b.x, b.y, radius));
    }
    if (path.length === 1) {
      const p = path[0]!;
      swept.push(capsule(p.x, p.y, p.x + 1e-5, p.y, radius));
    }
  }
  return merge(swept);
}

function makePlanar(regions: Multi, project: Project, elevation: number): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const polygon of regions) {
    if (!polygon.length) continue;
    const outline = polygon[0]!;
    if (outline.length < 4) continue;
    const shape = new THREE.Shape();
    shape.moveTo(outline[0]![0]!, outline[0]![1]!);
    for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i]![0]!, outline[i]![1]!);
    for (const hole of polygon.slice(1)) {
      if (hole.length < 4) continue;
      const p = new THREE.Path();
      p.moveTo(hole[0]![0]!, hole[0]![1]!);
      for (let i = 1; i < hole.length; i++) p.lineTo(hole[i]![0]!, hole[i]![1]!);
      shape.holes.push(p);
    }
    const triangulated = new THREE.ShapeGeometry(shape, 12).toNonIndexed();
    const attr = triangulated.getAttribute('position');
    for (let i = 0; i < attr.count; i++) {
      positions.push(attr.getX(i) - project.width / 2, elevation, project.height / 2 - attr.getY(i));
    }
    triangulated.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function makeWalls(regions: Multi, project: Project, upper: number, lower: number): THREE.BufferGeometry {
  const vertices: number[] = [];
  for (const polygon of regions) for (const ring of polygon) {
    const area = winding(ring);
    if (Math.abs(area) < 1e-8) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!, b = ring[i + 1]!;
      const x1 = a[0]! - project.width / 2, x2 = b[0]! - project.width / 2;
      const z1 = project.height / 2 - a[1]!, z2 = project.height / 2 - b[1]!;
      // Double-sided material handles boundary orientation and hole winding.
      vertices.push(x1, upper, z1, x1, lower, z1, x2, upper, z2,
                    x2, upper, z2, x1, lower, z1, x2, lower, z2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

export interface ExactVectorGeometry {
  top: THREE.BufferGeometry;
  floor: THREE.BufferGeometry;
  walls: THREE.BufferGeometry;
  footprint: Multi;
  depth: number;
}

/** True topological cutter sweep for ONE constant-depth flat endmill operation.
 * Exact for the polyline tool-center trajectory, with circular cutter edges
 * tessellated at <=0.06mm nominal arc length; no heightfield interpolation.
 */
export function flatVectorGeometry(project: Project, operation: CompiledOperation): ExactVectorGeometry {
  const op = operation.operation;
  if (op.mode !== 'vector' || op.tool !== 'flat') throw new Error('Requires SVG flat-endmill operation.');
  if (operation.paths.some(path => path.some(p => Math.abs(p.depth - op.depth) > 1e-5)))
    throw new Error('Variable depth flat engraving requires a different solver.');
  const radius = op.diameter / 2;
  const swept = footprint(operation.paths, radius);
  // Keep geometry strictly within the displayed stock. Cutter overhang still
  // deserves a fixture warning, but only intersecting stock is removed.
  const bounded = swept.length ? polygonClipping.intersection(swept, rectangle(project.width, project.height)) as Multi : [];
  const untouched = bounded.length
    ? polygonClipping.difference(rectangle(project.width, project.height), bounded) as Multi
    : rectangle(project.width, project.height);
  return {
    top: makePlanar(untouched, project, 0),
    floor: makePlanar(bounded, project, -op.depth),
    walls: makeWalls(bounded, project, 0, -op.depth),
    footprint: bounded,
    depth: op.depth,
  };
}
