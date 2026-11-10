import * as THREE from 'three';
import type { Artwork, CompiledOperation, Operation, Project } from './types';
import { svgPathForOperation } from './svgMasks';
import { createStockMaterial, type StockMaterial } from './materials';

export const DISTANCE_MAX_PX = 2560;
export const CURVE_MESH_MAX = 1050;
export const DISTANCE_MIN_PX_PER_MM = 12;

/** Physical cross section measured from the cutter centerline; all units mm.
 * The center of a ball endmill is a hemispherical tip, not a V/triangular cone.
 */
export function cutterProfileAtDistance(distance: number, op: Operation): number {
  const radius = op.diameter / 2;
  if (distance < 0 || !Number.isFinite(distance)) return 0;
  if (op.tool === 'vbit') {
    const rise = distance / Math.tan(op.angle * Math.PI / 360);
    return Math.min(0, -op.depth + rise);
  }
  if (op.tool === 'ball') {
    if (distance >= radius) return 0;
    const rise = radius - Math.sqrt(Math.max(0, radius * radius - distance * distance));
    return Math.min(0, -op.depth + rise);
  }
  throw new Error('Curved profile preview requires V-bit or ball nose.');
}

export function cutterSurfaceRadius(op: Operation): number {
  const r = op.diameter / 2;
  if (op.tool === 'vbit') return Math.min(r, op.depth * Math.tan(op.angle * Math.PI / 360));
  if (op.tool === 'ball') return op.depth >= r ? r : Math.sqrt(Math.max(0, op.depth * (2 * r - op.depth)));
  throw new Error('Unsupported cutter type');
}

/** Felzenszwalb-Huttenlocher squared Euclidean distance transform (linear).
 * The source shape is rendered from ORIGINAL SVG Path2D curves, never G-code
 * polyline segments or source image pixels. Pixels are only the display cache.
 */
function squaredDistance1d(f: Float64Array, n: number, out: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * (q - v[k]!));
    while (k > 0 && s <= z[k]!) {
      k--;
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * (q - v[k]!));
    }
    if (k === 0 && s <= z[0]!) s = -Infinity;
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const d = q - v[k]!;
    out[q] = d * d + f[v[k]!]!;
  }
}

export interface NativeDistanceField {
  width: number;
  height: number;
  mmPerPixel: number;
  distances: Float32Array;
}

export function makeNativeSvgDistanceField(
  artwork: Artwork, project: Project, compiled: CompiledOperation, requestedPixelsPerMm: number
): NativeDistanceField {
  const maxSide = Math.max(project.width, project.height);
  const pixelsPerMm = Math.min(DISTANCE_MAX_PX / maxSide,
    Math.max(DISTANCE_MIN_PX_PER_MM, requestedPixelsPerMm));
  const width = Math.max(4, Math.round(project.width * pixelsPerMm));
  const height = Math.max(4, Math.round(project.height * pixelsPerMm));
  const path = svgPathForOperation(artwork, project, compiled, pixelsPerMm);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas2D is required for native SVG cutter preview.');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  const image = ctx.getImageData(0, 0, width, height).data;
  const count = width * height;
  const maxLength = Math.max(width, height);
  const input = new Float64Array(maxLength), output = new Float64Array(maxLength);
  const intermediate = new Float32Array(count);
  const distances = new Float32Array(count);
  const infinity = (width * width + height * height) * 4;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++)
      input[y] = image[4 * (y * width + x) + 3]! > 48 ? 0 : infinity;
    squaredDistance1d(input, height, output);
    for (let y = 0; y < height; y++) intermediate[y * width + x] = output[y]!;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) input[x] = intermediate[y * width + x]!;
    squaredDistance1d(input, width, output);
    for (let x = 0; x < width; x++) distances[y * width + x] =
      Math.sqrt(Math.max(0, output[x]!)) / pixelsPerMm;
  }
  return { width, height, mmPerPixel: 1 / pixelsPerMm, distances };
}

/** Bilinear interpolation of the display-only distance cache. Source SVG
 * curves are not altered. Geometry gets recomputed from the native curves
 * whenever the user zooms sufficiently far into the preview.
 */
export function distanceAt(field: NativeDistanceField, x: number, y: number): number {
  const px = Math.max(0, Math.min(field.width - 1, x / field.mmPerPixel - 0.5));
  const py = Math.max(0, Math.min(field.height - 1, y / field.mmPerPixel - 0.5));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(field.width - 1, x0 + 1), y1 = Math.min(field.height - 1, y0 + 1);
  const tx = px - x0, ty = py - y0;
  const a = field.distances[y0 * field.width + x0]!;
  const b = field.distances[y0 * field.width + x1]!;
  const c = field.distances[y1 * field.width + x0]!;
  const d = field.distances[y1 * field.width + x1]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * Build a SINGLE indexed, closed stock surface: carved top + 4 perimeter walls
 * + bottom. All faces share top boundary indices. No alpha masks, coplanar
 * overlays, separate interior wall patches, or offset Z meshes.
 *
 * The top is a single-valued cutter-envelope approximation. The source curve
 * is preserved separately; this grid is solely display tessellation.
 */
export function buildCurvedStockGeometry(
  project: Project, field: NativeDistanceField, op: Operation, density = 6,
): THREE.BufferGeometry {
  if (!(project.width > 0 && project.height > 0 && project.thickness > 0)) {
    throw new Error('Stock dimensions must be positive');
  }
  const nx = Math.max(32, Math.min(CURVE_MESH_MAX, Math.ceil(project.width * density)));
  const ny = Math.max(32, Math.min(CURVE_MESH_MAX, Math.ceil(project.height * density)));
  const stride = nx + 1;
  const topVertexCount = stride * (ny + 1);
  const vertices: number[] = new Array(topVertexCount * 3);
  for (let j = 0; j <= ny; j++) {
    const z = project.height * (j / ny - 0.5);
    for (let i = 0; i <= nx; i++) {
      const x = project.width * (i / nx - 0.5);
      const physicalX = x + project.width / 2;
      const physicalY = project.height / 2 - z;
      const elevation = Math.max(-project.thickness,
        cutterProfileAtDistance(distanceAt(field, physicalX, physicalY), op));
      const index = 3 * (j * stride + i);
      vertices[index] = x;
      vertices[index + 1] = elevation;
      vertices[index + 2] = z;
    }
  }

  const topTriangles: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
      // x cross z is -Y, so wind top triangles for +Y.
      topTriangles.push(a, c, b, b, c, d);
    }
  }

  // Traverse top outer perimeter in the direction induced by top triangles.
  // LEFT down -> BOTTOM right -> RIGHT up -> TOP left.
  const perimeter: number[] = [];
  for (let j = 0; j <= ny; j++) perimeter.push(j * stride);
  for (let i = 1; i <= nx; i++) perimeter.push(ny * stride + i);
  for (let j = ny - 1; j >= 0; j--) perimeter.push(j * stride + nx);
  for (let i = nx - 1; i >= 1; i--) perimeter.push(i);
  const bottomStart = topVertexCount;
  for (const topIndex of perimeter) {
    const ix = 3 * topIndex;
    vertices.push(vertices[ix]!, -project.thickness, vertices[ix + 2]!);
  }
  const bottomCenter = vertices.length / 3;
  vertices.push(0, -project.thickness, 0);

  const wallTriangles: number[] = [], bottomTriangles: number[] = [];
  for (let i = 0; i < perimeter.length; i++) {
    const next = (i + 1) % perimeter.length;
    const a = perimeter[i]!, b = perimeter[next]!;
    const lowerA = bottomStart + i, lowerB = bottomStart + next;
    // Side shares the top and lower rings: no cracks or intersecting planes.
    wallTriangles.push(a, lowerA, b, b, lowerA, lowerB);
    // Reversed winding from top => bottom faces -Y.
    bottomTriangles.push(lowerA, bottomCenter, lowerB);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  // Top surface normals must not be averaged with the sharp vertical side
  // normals. Compute normals from the top triangles alone before adding
  // side/bottom groups; those use a separate flat-shaded material.
  geometry.setIndex(topTriangles);
  geometry.computeVertexNormals();
  geometry.setIndex([...topTriangles, ...wallTriangles, ...bottomTriangles]);
  geometry.clearGroups();
  geometry.addGroup(0, topTriangles.length, 0);
  geometry.addGroup(topTriangles.length, wallTriangles.length + bottomTriangles.length, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The visible curved preview is ONE mesh with one contiguous indexed solid.
 * V/ball cuts should not have a top overlay or separate channel bottom.
 */
export function makeCurvedPreview(
  project: Project, artwork: Artwork, compiled: CompiledOperation,
  stock: StockMaterial, pxPerMm: number,
): { group: THREE.Group; density: number; dispose: () => void } {
  const op = compiled.operation;
  if (op.mode !== 'vector' || (op.tool !== 'ball' && op.tool !== 'vbit'))
    throw new Error('Native curved preview requires SVG V-bit or ball-nose engraving.');
  const field = makeNativeSvgDistanceField(artwork, project, compiled, pxPerMm);
  const density = Math.max(6, field.width / project.width / 2);
  const geometry = buildCurvedStockGeometry(project, field, op, density);
  const topMaterial = createStockMaterial(stock, true); // smooth cut profiles
  const sideMaterial = createStockMaterial(stock, false); // crisp stock edges
  const mesh = new THREE.Mesh(geometry, [topMaterial, sideMaterial]);
  const group = new THREE.Group();
  group.add(mesh);
  return { group, density: field.width / project.width,
    dispose: () => {
      geometry.dispose();
      topMaterial.dispose();
      sideMaterial.dispose();
    } };
}
