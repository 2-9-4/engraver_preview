import * as THREE from 'three';
import type { Artwork, CompiledOperation, Operation, Project } from './types';
import { svgPathForOperation } from './svgMasks';
import { createStockMaterial, type StockMaterial } from './materials';

export const DISTANCE_MAX_PX = 2560;
export const CURVE_MESH_MAX = 1050;
export const DISTANCE_MIN_PX_PER_MM = 8;

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

export function makeCurvedSurfaceMesh(
  project: Project, field: NativeDistanceField, op: Operation, material: THREE.MeshStandardMaterial,
  density = 6,
): THREE.Mesh {
  // Geometry tessellation is a display requirement, not an input SVG sample.
  const nx = Math.max(32, Math.min(CURVE_MESH_MAX, Math.ceil(project.width * density)));
  const ny = Math.max(32, Math.min(CURVE_MESH_MAX, Math.ceil(project.height * density)));
  const geometry = new THREE.PlaneGeometry(project.width, project.height, nx, ny);
  geometry.rotateX(-Math.PI / 2);
  const attr = geometry.getAttribute('position');
  for (let i = 0; i < attr.count; i++) {
    const x = attr.getX(i) + project.width / 2;
    const y = project.height / 2 - attr.getZ(i);
    const distance = distanceAt(field, x, y);
    attr.setY(i, Math.max(-project.thickness, cutterProfileAtDistance(distance, op)));
  }
  attr.needsUpdate = true;
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export function makeCurvedPreview(
  project: Project, artwork: Artwork, compiled: CompiledOperation,
  stock: StockMaterial, pxPerMm: number,
): { group: THREE.Group; density: number; dispose: () => void } {
  const op = compiled.operation;
  if (op.mode !== 'vector' || (op.tool !== 'ball' && op.tool !== 'vbit'))
    throw new Error('Native curved preview requires SVG V-bit or ball-nose engraving.');
  const field = makeNativeSvgDistanceField(artwork, project, compiled, pxPerMm);
  // Visibility is clipped using the exact source Path2D at the physical cutter
  // top radius; unlike the mesh silhouette it is never extracted from a grid.
  const scale = Math.min(6144 / Math.max(project.width, project.height),
    Math.max(1024 / Math.max(project.width, project.height), pxPerMm));
  const canvasW = Math.max(1, Math.round(project.width * scale));
  const canvasH = Math.max(1, Math.round(project.height * scale));
  const path = svgPathForOperation(artwork, project, compiled, scale);
  const makeMask = (outside: boolean) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot create cutter outline masks');
    ctx.fillStyle = outside ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.strokeStyle = outside ? '#000000' : '#ffffff';
    ctx.lineWidth = cutterSurfaceRadius(op) * 2 * scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 8;
    return tex;
  };
  const outside = makeMask(true), inside = makeMask(false);
  const topMat = createStockMaterial(stock);
  topMat.alphaMap = outside;
  topMat.alphaTest = 0.01;
  topMat.alphaToCoverage = true;
  topMat.needsUpdate = true;
  const channelMat = createStockMaterial(stock, true);
  channelMat.alphaMap = inside;
  channelMat.alphaTest = 0.01;
  channelMat.alphaToCoverage = true;
  channelMat.needsUpdate = true;
  const group = new THREE.Group();
  const top = new THREE.Mesh(new THREE.PlaneGeometry(project.width, project.height), topMat);
  top.rotation.x = -Math.PI / 2;
  group.add(top);
  const mesh = makeCurvedSurfaceMesh(project, field, op, channelMat, field.width / project.width / 2);
  mesh.position.y = -0.00005; // prevent coplanar z fighting at curve boundary
  group.add(mesh);
  return { group, density: field.width / project.width,
    dispose: () => {
      top.geometry.dispose();
      mesh.geometry.dispose();
      topMat.dispose(); channelMat.dispose();
      outside.dispose(); inside.dispose();
    } };
}
