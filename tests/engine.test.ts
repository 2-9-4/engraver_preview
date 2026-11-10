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
