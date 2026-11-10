import { CubicBezierCurve, EllipseCurve, LineCurve, QuadraticBezierCurve, Vector2 } from 'three';
import type { Artwork, Point, Project, Toolpath, VectorStroke } from '../types';

/** Geometry stays parametric in Artwork. Conversion into machine-supported G1
 * segments occurs here, in physical millimeters, with a bounded chord error.
 * No image rasterization, SVG-pixel spacing or fixed-distance sampling.
 */
export const SVG_CHORD_ERROR_MM = 0.01;
const MAX_SEGMENTS = 250000;
type XY = { x: number; y: number };
const midpoint = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distanceToChord = (p: XY, a: XY, b: XY): number => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return length < 1e-12 ? Math.hypot(p.x - a.x, p.y - a.y)
    : Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / length;
};
export function nativeStrokeToolpaths(
  project: Project, artwork: Artwork, stroke: VectorStroke,
  depth: number, tolerance = SVG_CHORD_ERROR_MM,
): Toolpath[] {
  if (!(tolerance > 0 && Number.isFinite(tolerance))) throw new Error('Invalid SVG machining tolerance');
  if (!stroke.curves) return [];
  const width = artwork.image.naturalWidth, height = artwork.image.naturalHeight;
  const fit = Math.min(project.width / width, project.height / height);
  const offsetX = (project.width - width * fit) / 2;
  const offsetY = (project.height - height * fit) / 2;
  const output: Toolpath[] = [];
  let count = 0;
  for (const subpath of stroke.curves) {
    const out: Toolpath = [];
    const emit = (p: XY) => {
      if (++count > MAX_SEGMENTS) throw new Error('SVG is too complex for G1 export at this tolerance');
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('SVG contains non-finite geometry');
      const point: Point = { x: p.x, y: p.y, depth };
      const last = out[out.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1e-8) out.push(point);
    };
    for (const segment of subpath) {
      const [a, b, c, d, e, f] = segment.ctm;
      const transform = (p: XY): XY => ({
        x: offsetX + (a * p.x + c * p.y + e) * fit,
        y: project.height - offsetY - (b * p.x + d * p.y + f) * fit,
      });
      const curve = segment.curve;
      if (curve instanceof LineCurve) {
        if (!out.length) emit(transform(curve.v1));
        emit(transform(curve.v2));
        continue;
      }
      // De Casteljau subdivision preserves the original polynomial, with the
      // control polygon's distance to the chord bounding Bézier deviation.
      if (curve instanceof CubicBezierCurve || curve instanceof QuadraticBezierCurve) {
        const controls = curve instanceof CubicBezierCurve
          ? [curve.v0, curve.v1, curve.v2, curve.v3].map(transform)
          : [curve.v0, curve.v1, curve.v2].map(transform);
        if (!out.length) emit(controls[0]!);
        const subdivide = (points: XY[], recursion: number) => {
          if (recursion > 25) throw new Error('SVG Bézier subdivision exceeded geometric limits');
          const first = points[0]!, last = points[points.length - 1]!;
          if (points.slice(1, -1).every(p => distanceToChord(p, first, last) <= tolerance)) {
            emit(last);
            return;
          }
          const levels: XY[][] = [points];
          while (levels[levels.length - 1]!.length > 1) {
            const previous = levels[levels.length - 1]!;
            levels.push(previous.slice(1).map((p, i) => midpoint(previous[i]!, p)));
          }
          const left = levels.map(level => level[0]!);
          const right = levels.map(level => level[level.length - 1]!).reverse();
          subdivide(left, recursion + 1);
          subdivide(right, recursion + 1);
        };
        subdivide(controls, 0);
        continue;
      }
      if (curve instanceof EllipseCurve) {
        // SVG elliptical arcs are retained as parametric ellipse primitives.
        // A second-derivative bound controls polygonalization *for G1 only*.
        const totalAngle = Math.abs(curve.aEndAngle - curve.aStartAngle) || 2 * Math.PI;
        const s = Math.max(Math.hypot(a, b), Math.hypot(c, d)) * fit;
        const second = Math.max(Math.abs(curve.xRadius), Math.abs(curve.yRadius)) * s * totalAngle * totalAngle;
        if (!out.length) emit(transform(curve.getPoint(0)));
        const subdivide = (t0: number, t1: number, recursion: number) => {
          if (recursion > 25) throw new Error('SVG arc subdivision exceeded geometric limits');
          if (second * (t1 - t0) ** 2 / 8 <= tolerance) {
            emit(transform(curve.getPoint(t1)));
            return;
          }
          const mid = (t0 + t1) / 2;
          subdivide(t0, mid, recursion + 1);
          subdivide(mid, t1, recursion + 1);
        };
        subdivide(0, 1, 0);
        continue;
      }
      throw new Error('Unsupported SVG primitive in CAM: ' + curve.type);
    }
    if (out.length > 1) output.push(out);
  }
  return output;
}
