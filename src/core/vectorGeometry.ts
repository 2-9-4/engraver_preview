import * as THREE from 'three';
import * as polygonClipping from 'polygon-clipping';
import ClipperLib from 'clipper-lib';
import type { CompiledOperation, Project, Toolpath } from '../types';

// Polygon clipping coordinates are in machine XY millimetres. All outlines are
// cutter-centerline sweeps, NOT SVG-stroke-width approximations.
type Ring = Array<[number, number]>;
type Poly = Ring[];
type Multi = Poly[];
const rectangle = (w: number, h: number): Multi => [[[[0, 0], [w, 0], [w, h], [0, h], [0, 0]]]];
const winding = (ring: Ring) => ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length]!;
  return sum + p[0]! * q[1]! - q[0]! * p[1]!;
}, 0);


const INTEGER_SCALE = 10000; // 0.0001mm integer coordinates (no pixel/voxel grid)
const ARC_ERROR_MM = 0.005;
type IntPoint = { X: number; Y: number };
function pathPolygon(points: IntPoint[]): Multi {
  const ring: Ring = points.map(p => [p.X / INTEGER_SCALE, p.Y / INTEGER_SCALE]);
  if (ring.length < 3) return [];
  ring.push([ring[0]![0], ring[0]![1]]);
  return [[ring]];
}

function offsetPath(path: Toolpath, radius: number): Multi {
  const raw: IntPoint[] = [];
  for (const point of path) {
    const p = { X: Math.round(point.x * INTEGER_SCALE), Y: Math.round(point.y * INTEGER_SCALE) };
    if (!raw.length || raw[raw.length - 1]!.X !== p.X || raw[raw.length - 1]!.Y !== p.Y) raw.push(p);
  }
  if (!raw.length) return [];
  // Closed input polylines are still swept as centerline curves (NOT filled SVG contours).
  // Native ClipperOffset handles join geometry once for the entire curve, instead
  // of boolean-unioning hundreds of overlapping polygonal capsules per segment.
  if (raw.length === 1) raw.push({ X: raw[0]!.X + 1, Y: raw[0]!.Y });
  const closed = raw.length >= 4 &&
    raw[0]!.X === raw[raw.length - 1]!.X &&
    raw[0]!.Y === raw[raw.length - 1]!.Y;
  if (closed) raw.pop();
  const offsetter = new ClipperLib.ClipperOffset(2, ARC_ERROR_MM * INTEGER_SCALE);
  offsetter.AddPath(raw, ClipperLib.JoinType.jtRound,
    closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
  const solution: IntPoint[][] = [];
  offsetter.Execute(solution, radius * INTEGER_SCALE);
  // A closed centerline creates a ring with a hole. Reconstruct it explicitly
  // instead of filling the hole or dropping the interior of a closed stroke.
  const outer: Multi[] = [], holes: Multi[] = [];
  for (const contour of solution) {
    const geometry = pathPolygon(contour);
    if (!geometry.length) continue;
    (ClipperLib.Clipper.Area(contour) >= 0 ? outer : holes).push(geometry);
  }
  if (!outer.length) return [];
  const unionOuter = polygonClipping.union(...outer as [Multi, ...Multi[]]) as Multi;
  if (!holes.length) return unionOuter;
  const unionHoles = polygonClipping.union(...holes as [Multi, ...Multi[]]) as Multi;
  return polygonClipping.difference(unionOuter, unionHoles) as Multi;
}

function footprint(paths: Toolpath[], radius: number): Multi {
  // One offset operation per complete SVG stroke; only union the finished
  // footprints. This avoids tiny overlapping capsule seams and staircase artefacts.
  const shapes = paths.map(path => offsetPath(path, radius)).filter(shape => shape.length);
  if (!shapes.length) return [];
  let merged: Multi = [];
  for (let i = 0; i < shapes.length; i += 24) {
    const batch = polygonClipping.union(...shapes.slice(i, i + 24) as [Multi, ...Multi[]]) as Multi;
    merged = merged.length ? polygonClipping.union(merged, batch) as Multi : batch;
  }
  return merged;
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
  const normals: number[] = [];
  const smoothCornerDot = Math.cos(Math.PI / 5); // preserve genuinely sharp corners
  for (const polygon of regions) for (const ring of polygon) {
    if (Math.abs(winding(ring)) < 1e-8) continue;
    const n = ring.length - 1;
    const edgeNormal = (i: number): [number, number, number] => {
      const p = ring[(i + n) % n]!, q = ring[(i + n + 1) % n]!;
      const dx = q[0]! - p[0]!, dy = q[1]! - p[1]!;
      const len = Math.hypot(dx, dy) || 1;
      // Original ring winding is preserved, including reversed hole walls.
      return [dy / len, 0, dx / len];
    };
    const blend = (a: [number, number, number], b: [number, number, number]) => {
      if (a[0] * b[0] + a[2] * b[2] < smoothCornerDot) return b;
      const x = a[0] + b[0], z = a[2] + b[2];
      const len = Math.hypot(x, z) || 1;
      return [x / len, 0, z / len] as [number, number, number];
    };
    for (let i = 0; i < n; i++) {
      const a = ring[i]!, b = ring[i + 1]!;
      const x1 = a[0]! - project.width / 2, x2 = b[0]! - project.width / 2;
      const z1 = project.height / 2 - a[1]!, z2 = project.height / 2 - b[1]!;
      const current = edgeNormal(i);
      const start = blend(edgeNormal(i - 1), current);
      const finish = blend(edgeNormal(i + 1), current);
      vertices.push(x1, upper, z1, x1, lower, z1, x2, upper, z2,
                    x2, upper, z2, x1, lower, z1, x2, lower, z2);
      for (const normal of [start, start, finish, finish, start, finish])
        normals.push(...normal);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
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
 * tessellated to <=0.005mm radial error; no heightfield interpolation.
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
