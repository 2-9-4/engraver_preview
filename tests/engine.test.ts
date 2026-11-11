import { defaultPlywoodSettings, parsePlyThicknesses, plywoodLayerAtDepth, plywoodShaderLogic, validatePlywoodSettings } from '../src/plywood';
import { createStockMaterial } from '../src/materials';
import { buildCurvedStockGeometry, cutterProfileAtDistance, cutterSurfaceRadius, distanceAt } from '../src/curvedPreview';
import { CubicBezierCurve, EllipseCurve, LineCurve, Vector2 } from 'three';
import { nativeStrokeToolpaths } from '../src/core/nativeCurves';
import { describe, expect, it } from 'vitest';
import { defaultMachine, defaultProject, newOperation } from '../src/types';
import { depthFromIntensity } from '../src/core/toolpaths';
import { simulateSurface, sweepPath, toolHeightAtRadius } from '../src/core/simulate';
import { generateGcode } from '../src/core/gcode';
import { flatVectorGeometry } from '../src/core/vectorGeometry';
import type { CompiledOperation } from '../src/types';

describe('cutter geometry', () => {
  it('V-bit slope matches included angle', () => {
    const op = newOperation({ tool: 'vbit', angle: 60 });
    expect(toolHeightAtRadius(Math.tan(Math.PI / 6), op)).toBeCloseTo(1);
  });
  it('ball nose rises with radius and flat cutter stays flat', () => {
    const ball = newOperation({ tool: 'ball', diameter: 4 });
    expect(toolHeightAtRadius(0, ball)).toBe(0);
    expect(toolHeightAtRadius(2, ball)).toBeCloseTo(2);
    expect(toolHeightAtRadius(2.1, ball)).toBe(Infinity);
    expect(toolHeightAtRadius(1.5, { ...ball, tool: 'flat' })).toBe(0);
  });
  it('interpolates cuts between path points', () => {
    const stamps: number[] = [];
    sweepPath([{ x: 0, y: 0, depth: 1 }, { x: 8, y: 0, depth: 3 }], 1,
      (x, _y, d) => { stamps.push(x); expect(d).toBeCloseTo(1 + x / 4); });
    expect(stamps).toHaveLength(9);
  });
  it('simulates milled channel while retaining uncut stock', () => {
    const project = { ...defaultProject, width: 10, height: 10, thickness: 3, resolution: 40 };
    const op = newOperation({ tool: 'ball', diameter: 2, depth: 2 });
    const surface = simulateSurface(project, [{ operation: op, length: 5,
      paths: [[{ x: 2.5, y: 5, depth: 2 }, { x: 7.5, y: 5, depth: 2 }]] }]);
    expect(surface.minDepth).toBeCloseTo(-2);
    expect(surface.values.some(v => v < -1)).toBe(true);
    expect(surface.values.some(v => v === 0)).toBe(true);
  });
});
describe('intensity to depth mapping', () => {
  it('thresholds and applies gamma', () => {
    const op = newOperation({ threshold: 0.2, depth: 2, gamma: 2 });
    expect(depthFromIntensity(0.1, op)).toBe(0);
    expect(depthFromIntensity(1, op)).toBe(2);
    expect(depthFromIntensity(0.6, op)).toBeCloseTo(0.5);
  });
});
describe('G-code export', () => {
  const op = newOperation({ name: 'Sample', depth: 2, passDepth: 1, plunge: 100, feed: 600 });
  const compiled: CompiledOperation = { operation: op, length: 10, paths: [[{ x: 1, y: 2, depth: 2 }, { x: 11, y: 2, depth: 1.3 }]] };
  it('uses safe Z, two depth passes, no homing or coordinate override', () => {
    const code = generateGcode(defaultProject, defaultMachine, compiled);
    expect(code).toContain('G90');
    expect(code).toContain('G21');
    expect(code).toContain('G0 Z5.000');
    expect(code).toContain('G1 Z-1.000 F100.000');
    expect(code).toContain('G1 Z-2.000 F100.000');
    expect(code).not.toMatch(/(?:^|\n)G28\b/);
    expect(code).not.toMatch(/(?:^|\n)G92\b/);
    expect(code).not.toMatch(/(?:^|\n)M3\b/);
  });
  it('avoids unsupported G21/G94/M2 on Klipper', () => {
    const code = generateGcode(defaultProject, { ...defaultMachine, controller: 'klipper' }, compiled);
    expect(code).not.toMatch(/(?:^|\n)G21\b/);
    expect(code).not.toMatch(/(?:^|\n)G94\b/);
    expect(code).not.toMatch(/(?:^|\n)M2\b/);
    expect(code).toContain('G1 X11.000 Y2.000');
  });
  it('uses LinuxCNC G94, M2 and optional spindle', () => {
    const code = generateGcode(defaultProject, { ...defaultMachine, controller: 'linuxcnc', spindleEnabled: true }, compiled);
    expect(code).toContain('G94');
    expect(code).toContain('M3 S12000');
    expect(code).toContain('M5');
    expect(code).toContain('\nM2\n');
  });
  it('supports centered XY zero and rejects cut through stock', () => {
    const code = generateGcode({ ...defaultProject, width: 20, height: 20 },
      { ...defaultMachine, origin: 'center' }, compiled);
    expect(code).toContain('X-9.000 Y-8.000');
    expect(() => generateGcode(defaultProject, defaultMachine,
      { ...compiled, operation: { ...op, depth: 100 } })).toThrow('stock thickness');
  });
});

describe('simultaneous XYZ motion', () => {
  it('limits feed on steep variable-Z segments to requested Z plunge speed', () => {
    const op = newOperation({ depth: 2, passDepth: 2, feed: 1200, plunge: 90 });
    const paths = [[{ x: 1, y: 2, depth: 2 }, { x: 1.01, y: 2, depth: 0.5 }]];
    const program = generateGcode(defaultProject, defaultMachine, { operation: op, paths, length: 0.01 });
    const line = program.split('\n').find(l => l.includes('X1.010 Y2.000'));
    expect(line).toBeDefined();
    const feed = Number(line!.match(/F([\d.]+)/)?.[1]);
    expect(feed).toBeGreaterThan(0);
    expect(feed).toBeLessThan(91);
  });
});

describe('export boundary validation', () => {
  const op = newOperation({ depth: 1, passDepth: 1 });
  const example = (x: number, y: number, depth: number): CompiledOperation => ({
    operation: op, length: 1, paths: [[{ x, y, depth }, { x: 2, y: 2, depth: 1 }]],
  });
  it('rejects coordinates outside the programmed stock', () => {
    expect(() => generateGcode(defaultProject, defaultMachine, example(-1, 1, 1))).toThrow('out-of-stock');
    expect(() => generateGcode(defaultProject, defaultMachine, example(1, 200, 1))).toThrow('out-of-stock');
  });
  it('rejects NaN coordinates and exceeding requested cut depth', () => {
    expect(() => generateGcode(defaultProject, defaultMachine, example(NaN, 1, 1))).toThrow('invalid');
    expect(() => generateGcode(defaultProject, defaultMachine, example(1, 1, 1.5))).toThrow('invalid');
  });
  it('rejects non-finite or nonsensical cutter and machine settings', () => {
    expect(() => generateGcode(defaultProject, defaultMachine,
      { ...example(1, 1, 1), operation: { ...op, diameter: NaN } })).toThrow('Cutter');
    expect(() => generateGcode(defaultProject, { ...defaultMachine, safeZ: Infinity },
      example(1, 1, 1))).toThrow('finite');
  });
});

describe('SVG flat endmill swept geometry', () => {
  it('puts the channel floor at the commanded depth with vertical side triangles', () => {
    const op = newOperation({ mode: 'vector', tool: 'flat', diameter: 2, depth: 1.8 });
    const project = { ...defaultProject, width: 20, height: 20 };
    const geometry = flatVectorGeometry(project, {
      operation: op, length: 8,
      paths: [[{ x: 6, y: 10, depth: 1.8 }, { x: 14, y: 10, depth: 1.8 }]],
    });
    const floor = geometry.floor.getAttribute('position');
    expect(floor.count).toBeGreaterThan(3);
    for (let i = 0; i < floor.count; i++) expect(floor.getY(i)).toBeCloseTo(-1.8);
    const walls = geometry.walls.getAttribute('position');
    expect(walls.count).toBeGreaterThan(30);
    for (let i = 0; i < walls.count; i += 6) {
      // For each wall quad, the upper and lower vertices share EXACT x/z.
      expect(walls.getX(i)).toBeCloseTo(walls.getX(i + 1));
      expect(walls.getZ(i)).toBeCloseTo(walls.getZ(i + 1));
      expect(walls.getY(i)).toBeCloseTo(0);
      expect(walls.getY(i + 1)).toBeCloseTo(-1.8);
    }
    geometry.top.dispose(); geometry.floor.dispose(); geometry.walls.dispose();
  });
});

describe('whole-curve cutter offset', () => {
  it('preserves the uncut island inside a closed SVG centerline', () => {
    const project = { ...defaultProject, width: 30, height: 30 };
    const op = newOperation({ mode: 'vector', tool: 'flat', diameter: 2, depth: 1 });
    const circle = Array.from({ length: 361 }, (_, i) => {
      const t = i * Math.PI / 180;
      return { x: 15 + 8 * Math.cos(t), y: 15 + 8 * Math.sin(t), depth: 1 };
    });
    const geometry = flatVectorGeometry(project, {
      operation: op, paths: [circle], length: 2 * Math.PI * 8,
    });
    expect(geometry.footprint.length).toBe(1);
    expect(geometry.footprint[0]?.length).toBe(2);
    geometry.top.dispose(); geometry.floor.dispose(); geometry.walls.dispose();
  });
});

describe('native SVG curve preservation', () => {
  const artwork = {
    name: 'native svg', image: { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement,
    isSVG: true, strokes: [],
  };
  const project = { ...defaultProject, width: 100, height: 100 };
  const identity: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  it('preserves exact straight lines without introducing intermediate points', () => {
    const stroke = { color: '#000000', points: [], curves: [[{
      curve: new LineCurve(new Vector2(4, 7), new Vector2(90, 7)), ctm: identity,
    }]] };
    const paths = nativeStrokeToolpaths(project, artwork, stroke, 1);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveLength(2);
    expect(paths[0]![0]!.x).toBe(4);
    expect(paths[0]![1]!.x).toBe(90);
  });
  it('subdivides a cubic by geometric error, not SVG pixel spacing', () => {
    const stroke = { color: '#000000', points: [], curves: [[{
      curve: new CubicBezierCurve(new Vector2(0, 0), new Vector2(0, 70),
        new Vector2(100, 70), new Vector2(100, 0)), ctm: identity,
    }]] };
    const coarse = nativeStrokeToolpaths(project, artwork, stroke, 1, 0.5)[0]!;
    const precise = nativeStrokeToolpaths(project, artwork, stroke, 1, 0.01)[0]!;
    expect(coarse.length).toBeGreaterThan(2);
    expect(precise.length).toBeGreaterThan(coarse.length);
    expect(precise[0]!.x).toBe(0);
    expect(precise.at(-1)!.x).toBe(100);
  });
  it('keeps elliptical arcs parametric until machine motion generation', () => {
    const stroke = { color: '#000000', points: [], curves: [[{
      curve: new EllipseCurve(50, 50, 25, 10, 0, Math.PI, false, 0), ctm: identity,
    }]] };
    const paths = nativeStrokeToolpaths(project, artwork, stroke, 1);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.length).toBeGreaterThan(5);
    expect(paths[0]![0]!.x).toBeCloseTo(75);
    expect(paths[0]!.at(-1)!.x).toBeCloseTo(25);
  });
});

describe('native SVG curved cutter preview', () => {
  it('V-bit is a true conical groove with programmed included angle', () => {
    const op = newOperation({ tool: 'vbit', angle: 60, diameter: 6, depth: 1.5 });
    const edge = 1.5 * Math.tan(Math.PI / 6);
    expect(cutterSurfaceRadius(op)).toBeCloseTo(edge);
    expect(cutterProfileAtDistance(0, op)).toBeCloseTo(-1.5);
    expect(cutterProfileAtDistance(edge / 2, op)).toBeCloseTo(-0.75);
    expect(cutterProfileAtDistance(edge, op)).toBeCloseTo(0);
  });
  it('ball-nose makes a spherical cove rather than V walls', () => {
    const op = newOperation({ tool: 'ball', diameter: 4, depth: 1 });
    expect(cutterSurfaceRadius(op)).toBeCloseTo(Math.sqrt(3));
    expect(cutterProfileAtDistance(0, op)).toBe(-1);
    expect(cutterProfileAtDistance(1, op)).toBeCloseTo(1 - Math.sqrt(3));
    expect(cutterProfileAtDistance(Math.sqrt(3), op)).toBeCloseTo(0);
  });
  it('samples the physical display distance field bilinearly', () => {
    const map = { width: 2, height: 2, mmPerPixel: 1, distances: new Float32Array([0, 2, 2, 4]) };
    expect(distanceAt(map, 1, 1)).toBeCloseTo(2);
  });
});


describe('watertight V-bit and ball-nose stock geometry', () => {
  const project = { ...defaultProject, width: 60, height: 60, thickness: 12 };

  // Precisely modeled closed square centerline. This distance data is just
  // display input; the manifold checks apply to the actual constructed mesh.
  const segmentDistance = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
  const size = 481;
  const sampleStep = project.width / (size - 1);
  const distances = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x * sampleStep, py = y * sampleStep;
    distances[y * size + x] = Math.min(
      segmentDistance(px, py, 20, 20, 40, 20),
      segmentDistance(px, py, 40, 20, 40, 40),
      segmentDistance(px, py, 40, 40, 20, 40),
      segmentDistance(px, py, 20, 40, 20, 20),
    );
  }
  const field = { width: size, height: size, mmPerPixel: sampleStep, distances };

  const validateClosedSolid = (kind: 'vbit' | 'ball') => {
    const op = newOperation({ mode: 'vector', tool: kind, angle: 60, diameter: 4, depth: 1 });
    const geometry = buildCurvedStockGeometry(project, field, op, 1);
    const positions = geometry.getAttribute('position');
    const indices = geometry.getIndex()!;
    const edgeIncidence = new Map<string, { count: number; balance: number }>();
    const edge = (i: number, j: number) => {
      const low = Math.min(i, j), high = Math.max(i, j);
      const key = low + ':' + high;
      const incidence = edgeIncidence.get(key) || { count: 0, balance: 0 };
      incidence.count++;
      incidence.balance += i === low ? 1 : -1;
      edgeIncidence.set(key, incidence);
    };
    for (let t = 0; t < indices.count; t += 3) {
      const a = indices.getX(t), b = indices.getX(t + 1), c = indices.getX(t + 2);
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(c).not.toBe(a);
      const ab = [positions.getX(b) - positions.getX(a),
        positions.getY(b) - positions.getY(a),
        positions.getZ(b) - positions.getZ(a)];
      const ac = [positions.getX(c) - positions.getX(a),
        positions.getY(c) - positions.getY(a),
        positions.getZ(c) - positions.getZ(a)];
      const cross = [
        ab[1]! * ac[2]! - ab[2]! * ac[1]!,
        ab[2]! * ac[0]! - ab[0]! * ac[2]!,
        ab[0]! * ac[1]! - ab[1]! * ac[0]!,
      ];
      expect(Math.hypot(...cross)).toBeGreaterThan(1e-7);
      edge(a, b); edge(b, c); edge(c, a);
    }
    // Every geometric edge is shared by two oppositely oriented triangles.
    // No boundary edges, nonmanifold branches, duplicate coplanar faces, or
    // disconnected stock surfaces.
    for (const item of edgeIncidence.values()) {
      expect(item.count).toBe(2);
      expect(item.balance).toBe(0);
    }
    expect(geometry.groups).toHaveLength(2);
    const top = geometry.groups[0]!;
    const sides = geometry.groups[1]!;
    expect(top.count).toBeGreaterThan(0);
    expect(sides.start).toBe(top.count);
    expect(sides.count).toBeGreaterThan(0);
    // The square groove must be physically lower than its untouched island.
    const stride = 61;
    const at = (i: number, j: number) => positions.getY(j * stride + i);
    expect(at(20, 30)).toBeLessThan(-0.8);
    expect(at(30, 30)).toBeCloseTo(0, 5);
    expect(at(5, 5)).toBeCloseTo(0, 5);
    geometry.dispose();
  };

  it('builds a single closed, consistently wound V-bit block around a square', () => {
    validateClosedSolid('vbit');
  });
  it('builds a single closed, consistently wound ball-nose block around a square', () => {
    validateClosedSolid('ball');
  });
});


describe('editable plywood material layup', () => {
  const options = {
    ...defaultPlywoodSettings, topVeneerThickness: 0.5,
    layerThicknesses: [1, 2], paintThickness: 0.1, paintColor: '#e13244',
  };
  it('accepts exact comma-separated ply thicknesses and rejects malformed values', () => {
    expect(parsePlyThicknesses('0.6, 1.25, 2')).toEqual([0.6, 1.25, 2]);
    expect(() => parsePlyThicknesses('1.2,')).toThrow();
    expect(() => parsePlyThicknesses('0,1')).toThrow();
    expect(() => parsePlyThicknesses('1, Infinity')).toThrow();
    expect(() => validatePlywoodSettings({...options, topVeneerThickness: -1})).toThrow();
  });
  it('distinguishes paint, top veneer and repeating core layers', () => {
    expect(plywoodLayerAtDepth(0.05, options, true).paint).toBe(true);
    expect(plywoodLayerAtDepth(0.11, options, true).layerIndex).toBe(0);
    expect(plywoodLayerAtDepth(0.59, options, true).layerIndex).toBe(0);
    expect(plywoodLayerAtDepth(0.61, options, true).layerIndex).toBe(1);
    expect(plywoodLayerAtDepth(1.61, options, true).layerIndex).toBe(2);
    expect(plywoodLayerAtDepth(3.61, options, true).layerIndex).toBe(3);
    expect(plywoodLayerAtDepth(0.05, options, false).paint).toBe(false);
    expect(plywoodLayerAtDepth(0.5, options, false).layerIndex).toBe(1);
    expect(plywoodLayerAtDepth(1.5, options, false).layerIndex).toBe(2);
  });
  it('generates real plywood layers and a separately colored thin coating in the shader', () => {
    const paint = plywoodShaderLogic('painted-plywood', options);
    const plain = plywoodShaderLogic('plywood', options);
    expect(paint).toContain('materialDepth < 0.100000');
    expect(paint).toContain('woodDepth - 0.500000');
    expect(paint).toContain('withinCycle >= 1.000000');
    expect(plain).not.toContain('pigment = vec3(');
    expect(plain).toContain('materialDepth - 0.000000');
    const a = createStockMaterial('painted-plywood', true, options);
    const b = createStockMaterial('painted-plywood', true, {...options, topVeneerThickness: 0.7});
    const c = createStockMaterial('plywood', true, options);
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
    expect(a.customProgramCacheKey()).not.toBe(c.customProgramCacheKey());
    a.dispose(); b.dispose(); c.dispose();
  });
});
