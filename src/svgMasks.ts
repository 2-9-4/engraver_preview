import * as THREE from 'three';
import type { Artwork, CompiledOperation, Project, VectorStroke } from './types';

/**
 * Draw the ORIGINAL SVG's analytic curves using the browser's native vector
 * renderer, instead of tracing raster pixels or using polygon-clipped boundaries.
 * This supplies the sharp visible top and floor contours. Cutter geometry is
 * still approximated for walls, whose finite polygons are hidden behind these
 * antialiased silhouette boundaries in the usual viewing directions.
 */
export interface VectorMasks {
  top: THREE.CanvasTexture;
  floor: THREE.CanvasTexture;
  resolution: number;
}

const MAX_DIMENSION = 6144;
const MIN_DIMENSION = 1024;

export function svgPathForOperation(artwork: Artwork, project: Project, compiled: CompiledOperation, pxPerMm: number): Path2D {
  const op = compiled.operation;
  if (op.mode !== 'vector') throw new Error('SVG path preview expects a vector operation');
  const native = artwork.strokes.filter(stroke =>
    op.channel !== 'color' || stroke.color.toLowerCase() === op.color.toLowerCase()
  );
  return svgPathFromStrokes(artwork, project, native, pxPerMm);
}

/** Shared SVG-to-stock transform. Native curves remain parametric; opt-in
 * recovered centerlines are already polylines in normalized artwork coordinates.
 */
export function svgPathFromStrokes(
  artwork: Artwork, project: Project, native: VectorStroke[], pxPerMm: number
): Path2D {
  const scale = Math.min(project.width / artwork.image.naturalWidth, project.height / artwork.image.naturalHeight);
  const offsetX = (project.width - artwork.image.naturalWidth * scale) / 2;
  const offsetY = (project.height - artwork.image.naturalHeight * scale) / 2;
  const result = new Path2D();
  for (const stroke of native) {
    if (!stroke.curves?.length && stroke.points.length > 1) {
      const toMachine = (point: {x: number; y: number}) => ({
        x: pxPerMm * (offsetX + point.x * artwork.image.naturalWidth * scale),
        y: pxPerMm * (project.height - offsetY - point.y * artwork.image.naturalHeight * scale),
      });
      const first = toMachine(stroke.points[0]!);
      result.moveTo(first.x, first.y);
      for (const point of stroke.points.slice(1)) {
        const p = toMachine(point);
        result.lineTo(p.x, p.y);
      }
      continue;
    }
    if (!stroke.curves) continue;
    for (const subpath of stroke.curves) {
      if (!subpath.length) continue;
      // Keep EACH native SVG subpath as ONE continuous Path2D. Previously
      // every constituent segment was a separate stroked Path2D with round
      // caps. That destroyed SVG joins and could never represent Z closure.
      const one = new Path2D();
      const first = subpath[0]!.curve.getPoint(0);
      one.moveTo(first.x, first.y);
      for (const segment of subpath) {
        const curve = segment.curve;
        if (curve instanceof THREE.LineCurve) {
          one.lineTo(curve.v2.x, curve.v2.y);
        } else if (curve instanceof THREE.QuadraticBezierCurve) {
          one.quadraticCurveTo(curve.v1.x, curve.v1.y, curve.v2.x, curve.v2.y);
        } else if (curve instanceof THREE.CubicBezierCurve) {
          one.bezierCurveTo(
            curve.v1.x, curve.v1.y, curve.v2.x, curve.v2.y, curve.v3.x, curve.v3.y
          );
        } else if (curve instanceof THREE.EllipseCurve) {
          one.ellipse(curve.aX, curve.aY, Math.abs(curve.xRadius), Math.abs(curve.yRadius),
            curve.aRotation, curve.aStartAngle, curve.aEndAngle, curve.aClockwise);
        } else {
          throw new Error('Unsupported parametric curve: ' + curve.type);
        }
      }
      const last = subpath[subpath.length - 1]!.curve.getPoint(1);
      if (first.distanceToSquared(last) <= 1e-16) one.closePath();
      const ctm = subpath[0]!.ctm;
      // Transform the entire continuous vector curve into stock coordinates.
      const matrix = new DOMMatrix([
        pxPerMm * scale * ctm[0], -pxPerMm * scale * ctm[1],
        pxPerMm * scale * ctm[2], -pxPerMm * scale * ctm[3],
        pxPerMm * (offsetX + scale * ctm[4]),
        pxPerMm * (project.height - offsetY - scale * ctm[5]),
      ]);
      result.addPath(one, matrix);
    }
  }
  return result;
}

export function makeVectorMasks(
  artwork: Artwork, project: Project, compiled: CompiledOperation, requestedPxPerMm: number
): VectorMasks {
  const maxMm = Math.max(project.width, project.height);
  const pxPerMm = Math.min(MAX_DIMENSION / maxMm,
    Math.max(MIN_DIMENSION / maxMm, requestedPxPerMm));
  const width = Math.max(1, Math.round(project.width * pxPerMm));
  const height = Math.max(1, Math.round(project.height * pxPerMm));
  const path = svgPathForOperation(artwork, project, compiled, pxPerMm);
  const produce = (invert: boolean): THREE.CanvasTexture => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D unavailable for SVG vector masks');
    ctx.fillStyle = invert ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = invert ? '#000000' : '#ffffff';
    ctx.lineWidth = compiled.operation.diameter * pxPerMm;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    return texture;
  };
  return { top: produce(true), floor: produce(false), resolution: pxPerMm };
}
