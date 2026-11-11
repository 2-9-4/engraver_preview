import type { Curve, Vector2 } from 'three';
export type ToolKind = 'vbit' | 'ball' | 'flat';
export type Channel = 'luma' | 'red' | 'green' | 'blue' | 'alpha' | 'color';
export type Controller = 'marlin' | 'klipper' | 'linuxcnc';
export type OperationMode = 'raster' | 'vector';

export interface VectorStroke {
  color: string;
  // Computed SVG fill, used only when explicitly converting filled bands to centerlines.
  fillColor?: string | null;
  fillRule?: 'nonzero' | 'evenodd';
  // Original SVG parametric curves. Never resample these during import.
  curves?: Array<Array<{ curve: Curve<Vector2>; ctm: [number, number, number, number, number, number] }>>;
  points: Array<{ x: number; y: number }>; // legacy fallback, empty for native SVG curves
}

export interface Artwork {
  name: string;
  image: HTMLImageElement;
  isSVG: boolean;
  strokes: VectorStroke[];
}

export interface Preprocess {
  blur: number;
  contrast: number;
  brightness: number;
  posterize: number;
  invert: boolean;
}

export interface Project {
  width: number;
  height: number;
  thickness: number;
  resolution: number;
}

export interface Operation {
  id: string;
  name: string;
  enabled: boolean;
  mode: OperationMode;
  centerlineFilled: boolean;
  channel: Channel;
  color: string;
  tolerance: number;
  tool: ToolKind;
  diameter: number;
  angle: number;
  depth: number;
  stepover: number;
  scanAxis: 'horizontal' | 'vertical';
  threshold: number;
  gamma: number;
  feed: number;
  plunge: number;
  passDepth: number;
}

export interface Machine {
  controller: Controller;
  safeZ: number;
  travelFeed: number;
  spindleEnabled: boolean;
  spindleRPM: number;
  origin: 'lower-left' | 'center';
}

export interface Point {
  x: number;
  y: number;
  depth: number; // positive, measured down from surface Z = 0
}

export type Toolpath = Point[];
export interface CompiledOperation {
  operation: Operation;
  paths: Toolpath[];
  length: number;
}

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export const defaultProject: Project = { width: 120, height: 90, thickness: 12, resolution: 170 };
export const defaultPreprocess: Preprocess = { blur: 0, contrast: 0, brightness: 0, posterize: 0, invert: false };
export const defaultMachine: Machine = { controller: 'marlin', safeZ: 5, travelFeed: 2400, spindleEnabled: false, spindleRPM: 12000, origin: 'lower-left' };
let nextId = 1;
export function newOperation(partial: Partial<Operation> = {}): Operation {
  return {
    id: 'op-' + nextId++,
    name: 'Engraving ' + nextId,
    enabled: true,
    mode: 'raster',
    centerlineFilled: false,
    channel: 'luma',
    color: '#282828',
    tolerance: 70,
    tool: 'vbit',
    diameter: 3.175,
    angle: 60,
    depth: 1.5,
    stepover: 0.65,
    scanAxis: 'horizontal',
    threshold: 0.10,
    gamma: 1,
    feed: 650,
    plunge: 200,
    passDepth: 0.8,
    ...partial,
  };
}
