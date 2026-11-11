import * as THREE from 'three';

/** Physical-looking plywood stack measured in millimetres downward from Z=0.
 * The top veneer is independent; the underlying thickness sequence repeats.
 * Painted plywood also includes a thin coating above the face veneer.
 */
export interface PlywoodSettings {
  topVeneerThickness: number;
  layerThicknesses: number[];
  paintThickness: number;
  paintColor: string;
}

export const defaultPlywoodSettings: PlywoodSettings = {
  topVeneerThickness: 0.6,
  layerThicknesses: [1.5],
  paintThickness: 0.15,
  paintColor: '#182934',
};

export function parsePlyThicknesses(value: string): number[] {
  const entries = value.split(',').map(part => part.trim());
  if (!entries.length || entries.length > 16 ||
      entries.some(part => !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(part)))
    throw new Error('Enter 1–16 positive ply thicknesses separated by commas (mm).');
  const result = entries.map(Number);
  if (result.some(n => !Number.isFinite(n) || n < 0.01 || n > 100))
    throw new Error('Each plywood layer must be between 0.01 and 100 mm.');
  return result;
}

export function validatePlywoodSettings(settings: PlywoodSettings): PlywoodSettings {
  const { topVeneerThickness, layerThicknesses, paintThickness, paintColor } = settings;
  if (!Number.isFinite(topVeneerThickness) || topVeneerThickness < 0.01 || topVeneerThickness > 150)
    throw new Error('Top veneer thickness must be 0.01–150 mm.');
  if (!Number.isFinite(paintThickness) || paintThickness < 0 || paintThickness > 20)
    throw new Error('Paint thickness must be 0–20 mm.');
  if (!layerThicknesses.length || layerThicknesses.length > 16 ||
      layerThicknesses.some(n => !Number.isFinite(n) || n < 0.01 || n > 100))
    throw new Error('Plywood requires 1–16 positive layer thicknesses.');
  if (!/^#[0-9a-f]{6}$/i.test(paintColor))
    throw new Error('Paint color must be a six-digit hex color.');
  return settings;
}

/** The paint occupies a layer at the top; wood follows at the selected depths.
 * This helper also describes the shader's boundary logic for regression tests.
 */
export function plywoodLayerAtDepth(
  depthMm: number, settings: PlywoodSettings, painted = false,
): { layerIndex: number; depthIntoLayer: number; layerThickness: number; paint: boolean } {
  validatePlywoodSettings(settings);
  if (painted && depthMm < settings.paintThickness)
    return { layerIndex: -1, depthIntoLayer: Math.max(0, depthMm),
      layerThickness: settings.paintThickness, paint: true };
  const depth = Math.max(0, depthMm - (painted ? settings.paintThickness : 0));
  if (depth < settings.topVeneerThickness)
    return { layerIndex: 0, depthIntoLayer: depth,
      layerThickness: settings.topVeneerThickness, paint: false };
  const period = settings.layerThicknesses.reduce((sum, thickness) => sum + thickness, 0);
  let remaining = depth - settings.topVeneerThickness;
  const cycles = Math.floor(remaining / period);
  remaining -= cycles * period;
  for (let i = 0; i < settings.layerThicknesses.length; i++) {
    const thickness = settings.layerThicknesses[i]!;
    if (remaining < thickness || i === settings.layerThicknesses.length - 1)
      return { layerIndex: 1 + cycles * settings.layerThicknesses.length + i,
        depthIntoLayer: remaining, layerThickness: thickness, paint: false };
    remaining -= thickness;
  }
  throw new Error('Unreachable plywood layer');
}

const glFloat = (n: number): string => n.toFixed(6);

/** Emit the same repeating layer-boundary sequence in GLSL. No 1.5 mm
 * hardcoded periodicity: every layer in the user-supplied cycle is respected.
 */
export function plywoodShaderLogic(kind: 'plywood' | 'painted-plywood', settings: PlywoodSettings): string {
  validatePlywoodSettings(settings);
  const painted = kind === 'painted-plywood';
  const coat = painted ? settings.paintThickness : 0;
  const sequence = settings.layerThicknesses;
  const period = sequence.reduce((sum, n) => sum + n, 0);
  const color = new THREE.Color(settings.paintColor);
  const rgb = [color.r, color.g, color.b].map(glFloat).join(', ');
  const boundaries: string[] = [];
  let cumulative = 0;
  for (const thickness of sequence.slice(0, -1)) {
    cumulative += thickness;
    boundaries.push('if (withinCycle >= ' + glFloat(cumulative) + ') ply += 1.0;');
  }
  return [
    'float materialDepth = max(0.0, -vStockPosition.y);',
    'float woodDepth = max(0.0, materialDepth - ' + glFloat(coat) + ');',
    'float ply = 0.0;',
    'if (woodDepth >= ' + glFloat(settings.topVeneerThickness) + ') {',
    '  float underFace = woodDepth - ' + glFloat(settings.topVeneerThickness) + ';',
    '  ply = 1.0 + floor(underFace / ' + glFloat(period) + ') * ' + glFloat(sequence.length) + ';',
    '  float withinCycle = mod(underFace, ' + glFloat(period) + ');',
    ...boundaries,
    '}',
    'float alternate = mod(ply, 2.0);',
    'vec2 grainPosition = alternate < 0.5 ? vStockPosition.xz : vStockPosition.zx;',
    'float woodgrain = grainWood(grainPosition * vec2(1.0, 1.2));',
    'vec3 pigment = mix(vec3(0.76, 0.53, 0.31), vec3(0.54, 0.34, 0.20), alternate);',
    'pigment *= 0.91 + 0.16 * woodgrain;',
    painted ? 'if (materialDepth < ' + glFloat(coat) + ') pigment = vec3(' + rgb + ');' : '',
  ].join('\n');
}
