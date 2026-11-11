import './style.css';
import { zipSync, strToU8 } from 'fflate';
import type { Artwork, CompiledOperation, Machine, Operation, Pixels, Preprocess, Project } from './types';
import { defaultMachine, defaultPreprocess, defaultProject, newOperation } from './types';
import { discoverPalette, intensityAt, preprocess } from './core/image';
import { compileOperation } from './core/toolpaths';
import { simulateSurface } from './core/simulate';
import { generateGcode } from './core/gcode';
import { loadArtwork } from './core/svg';
import { Preview3D } from './preview';
import type { StockMaterial } from './materials';
import { defaultPlywoodSettings, parsePlyThicknesses, validatePlywoodSettings, type PlywoodSettings } from './plywood';

const el = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing element #' + id);
  return element as T;
};
const escaped = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
const project: Project = { ...defaultProject };
const prep: Preprocess = { ...defaultPreprocess };
const machine: Machine = { ...defaultMachine };
let artwork: Artwork | null = null;
let pixels: Pixels | null = null;
let operations: Operation[] = [newOperation({ name: 'Main engraving' })];
let compiled: CompiledOperation[] = [];
let selectedId = operations[0]!.id;
let renderTimer: number | undefined;
let running = false;
let stockMaterial: StockMaterial = 'mdf';
const plywoodSettings: PlywoodSettings = { ...defaultPlywoodSettings,
  layerThicknesses: [...defaultPlywoodSettings.layerThicknesses] };
const preview = new Preview3D(el('viewport'));

function status(message: string, error = false): void {
  const target = el('status');
  target.textContent = message;
  target.classList.toggle('error', error);
}

function number(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function optionHTML(current: string, choices: Array<[string, string]>): string {
  return choices.map(([value, label]) => '<option value="' + value + '"' + (current === value ? ' selected' : '') + '>' + label + '</option>').join('');
}

function field(id: string, key: keyof Operation, title: string, value: string | number, type = 'number', opts = ''): string {
  return '<label class="field"><span>' + title + '</span><input data-op="' + id + '" data-key="' + key + '" type="' + type + '" value="' + escaped(String(value)) + '" ' + opts + '></label>';
}

function selectField(id: string, key: keyof Operation, title: string, value: string, choices: Array<[string, string]>): string {
  return '<label class="field"><span>' + title + '</span><select data-op="' + id + '" data-key="' + key + '">' + optionHTML(value, choices) + '</select></label>';
}

const channels: Array<[string, string]> = [
  ['luma', 'Luminance (dark cuts)'], ['red', 'Red channel'], ['green', 'Green channel'],
  ['blue', 'Blue channel'], ['alpha', 'Alpha channel'], ['color', 'Specific color'],
];
const bits: Array<[string, string]> = [
  ['vbit', 'V-bit / engraving cone'], ['ball', 'Ball-nose'], ['flat', 'Flat end mill'],
];

function renderOperations(): void {
  const target = el('operation-list');
  target.innerHTML = '';
  for (const op of operations) {
    const id = escaped(op.id);
    const card = document.createElement('article');
    card.className = 'operation-card' + (selectedId === op.id ? ' selected' : '') + (!op.enabled ? ' disabled' : '');
    card.innerHTML = [
      '<div class="op-top"><label class="op-switch"><input type="checkbox" data-op="' + id + '" data-key="enabled"' + (op.enabled ? ' checked' : '') + '><span class="op-number">', String(operations.indexOf(op) + 1).padStart(2, '0'), '</span></label>',
      '<button class="op-title" data-select-op="' + id + '">', escaped(op.name), '</button>',
      '<button class="op-remove" data-remove-op="' + id + '" aria-label="Remove operation">×</button></div>',
      '<div class="op-fields">',
      field(id, 'name', 'Label', op.name, 'text', 'maxlength="80"'),
      selectField(id, 'mode', 'Path strategy', op.mode, [['raster', 'Raster scanlines'], ['vector', 'SVG stroke paths']]),
      selectField(id, 'channel', op.mode === 'vector' ? 'Stroke color filter' : 'Depth source', op.channel, op.mode === 'vector'
        ? [['luma', 'All SVG strokes'], ['color', 'Matching stroke color']]
        : channels),
      op.channel === 'color' ? '<div class="field-grid">' + field(id, 'color', 'Target color', op.color, 'color') + field(id, 'tolerance', 'Color tolerance', op.tolerance, 'number', 'min="1" max="442" step="5"') + '</div>' : '',
      selectField(id, 'tool', 'Cutter shape', op.tool, bits),
      '<div class="field-grid">',
      field(id, 'diameter', 'Diameter · mm', op.diameter, 'number', 'min="0.1" max="30" step="0.05"'),
      op.tool === 'vbit' ? field(id, 'angle', 'Included angle · °', op.angle, 'number', 'min="1" max="179" step="1"') : '',
      field(id, 'depth', 'Max cut · mm', op.depth, 'number', 'min="0.01" max="100" step="0.1"'),
      op.mode === 'raster' ? field(id, 'stepover', 'Stepover · mm', op.stepover, 'number', 'min="0.05" max="30" step="0.05"') : '',
      op.mode === 'raster' ? selectField(id, 'scanAxis', 'Raster scan direction', op.scanAxis, [['horizontal', 'Horizontal / X'], ['vertical', 'Vertical / Y']]) : '',
      op.mode === 'raster' ? field(id, 'threshold', 'Cut threshold · 0–1', op.threshold, 'number', 'min="0" max="0.99" step="0.02"') : '',
      op.mode === 'raster' ? field(id, 'gamma', 'Depth gamma', op.gamma, 'number', 'min="0.1" max="5" step="0.1"') : '',
      field(id, 'passDepth', 'Step-down · mm', op.passDepth, 'number', 'min="0.01" max="30" step="0.1"'),
      field(id, 'feed', 'XY feed · mm/min', op.feed, 'number', 'min="1" max="30000" step="50"'),
      field(id, 'plunge', 'Z feed · mm/min', op.plunge, 'number', 'min="1" max="10000" step="25"'),
      '</div></div>',
    ].join('');
    target.append(card);
    const fields = card.querySelector('.op-fields') as HTMLElement;
    fields.hidden = selectedId !== op.id;
  }
}

function schedule(): void {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(build, 160);
}

function build(): void {
  if (!artwork) return;
  if (running) { schedule(); return; }
  running = true;
  try {
    const maxDimension = 410;
    const scale = maxDimension / Math.max(project.width, project.height);
    pixels = preprocess(artwork, Math.max(1, Math.round(project.width * scale)), Math.max(1, Math.round(project.height * scale)), prep);
    compiled = operations.filter(o => o.enabled).map(o => compileOperation(project, pixels!, artwork!, prep, o));
    const surface = simulateSurface(project, compiled);
    preview.setSurface(project, surface, compiled, stockMaterial, artwork, plywoodSettings);
    renderImagePreview();
    el('header-size').textContent = project.width + ' × ' + project.height + ' mm';
    el('stat-operations').textContent = String(compiled.length);
    const length = compiled.reduce((sum, item) => sum + item.length, 0);
    el('stat-length').textContent = length >= 1000 ? (length / 1000).toFixed(1) + ' m' : length.toFixed(0) + ' mm';
    el('stat-depth').textContent = (-surface.minDepth).toFixed(2) + ' mm';
    const minutes = compiled.reduce((sum, item) => sum + item.length / item.operation.feed * Math.ceil(item.operation.depth / item.operation.passDepth), 0);
    el('stat-time').textContent = minutes < 60 ? minutes.toFixed(0) + ' min' : (minutes / 60).toFixed(1) + ' h';
    const segments = compiled.reduce((sum, item) => sum + item.paths.length, 0);
    status(segments.toLocaleString() + ' toolpath segments · preview based on swept cutter geometry');
    renderGcodePreview();
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true);
    compiled = [];
  } finally {
    running = false;
  }
}

function renderImagePreview(): void {
  if (!pixels) return;
  const canvas = el<HTMLCanvasElement>('source-canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const data = context.createImageData(pixels.width, pixels.height);
  const selected = operations.find(o => o.id === selectedId);
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
    const i = (y * pixels.width + x) * 4;
    if (selected && selected.mode === 'raster') {
      const v = intensityAt(pixels, (x + 0.5) / pixels.width, (y + 0.5) / pixels.height, selected.channel, selected.color, selected.tolerance, prep.invert);
      const intensity = Math.round((1 - v) * 255);
      data.data[i] = intensity;
      data.data[i + 1] = intensity;
      data.data[i + 2] = intensity;
    } else {
      data.data[i] = pixels.data[i]!;
      data.data[i + 1] = pixels.data[i + 1]!;
      data.data[i + 2] = pixels.data[i + 2]!;
    }
    data.data[i + 3] = 255;
  }
  context.putImageData(data, 0, 0);
}

function renderGcodePreview(): void {
  const target = el<HTMLTextAreaElement>('gcode-preview');
  const op = compiled.find(item => item.operation.id === selectedId);
  if (!op || !op.paths.length) { target.value = '; No toolpaths for selected operation'; return; }
  try { target.value = generateGcode(project, machine, op).split('\n').slice(0, 110).join('\n') + '\n; ... (preview truncated)'; }
  catch (error) { target.value = '; ' + String(error); }
}

async function importFile(file: File): Promise<void> {
  status('Decoding ' + file.name + '…');
  try {
    const loaded = await loadArtwork(file);
    artwork = loaded;
    el('source-name').textContent = file.name;
    el('source-type').textContent = (loaded.isSVG ? 'SVG · ' + loaded.strokes.length + ' vector stroke paths' : 'Raster image') + ' · ' + loaded.image.naturalWidth + ' × ' + loaded.image.naturalHeight;
    el('file-label').textContent = file.name;
    // Stroked SVGs are vector toolpaths; avoid defaulting to the raster heightfield.
    operations = [newOperation({
      name: 'Main engraving',
      mode: loaded.isSVG && loaded.strokes.length > 0 ? 'vector' : 'raster',
    })];
    selectedId = operations[0]!.id;
    renderOperations();
    preview.resetCamera(project);
    schedule();
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true);
  }
}

function splitColors(): void {
  if (!pixels || !artwork) return;
  const palette = discoverPalette(pixels, 6);
  const distinct: string[] = [];
  for (const color of [...artwork.strokes.map(s => s.color), ...palette]) {
    const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
    const a = rgb(color);
    if (distinct.some(existing => {
      const b = rgb(existing);
      return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 70;
    })) continue;
    distinct.push(color);
    if (distinct.length === 6) break;
  }
  if (!distinct.length) { status('No strong non-white colors detected'); return; }
  operations = distinct.map((color, i) => newOperation({
    name: 'Color ' + (i + 1) + ' · ' + color,
    channel: 'color', color, tolerance: 80,
    mode: artwork!.isSVG && artwork!.strokes.some(s => s.color === color) ? 'vector' : 'raster',
  }));
  selectedId = operations[0]!.id;
  renderOperations();
  schedule();
}

function download(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'operation';
}

function exportOne(): void {
  const item = compiled.find(c => c.operation.id === selectedId);
  if (!item) { status('Select an enabled operation with toolpaths', true); return; }
  try {
    const gcode = generateGcode(project, machine, item);
    download(new Blob([gcode], { type: 'text/plain' }), safeName(item.operation.name) + '-' + machine.controller + '.gcode');
    status('Downloaded ' + item.operation.name + '. Dry-run and verify coordinates before machining.');
  } catch (error) { status(String(error), true); }
}

function exportAll(): void {
  try {
    const contents: Record<string, Uint8Array> = {};
    let n = 0;
    for (const item of compiled) {
      if (!item.paths.length) continue;
      const code = generateGcode(project, machine, item);
      contents[String(++n).padStart(2, '0') + '-' + safeName(item.operation.name) + '.gcode'] = strToU8(code);
    }
    if (!n) throw new Error('There are no toolpaths to export');
    contents['READ-ME-FIRST.txt'] = strToU8(
      'Engraver Preview - separate files per operation/tool\n\n' +
      'Controller: ' + machine.controller + '\n' +
      'Workpiece: ' + project.width + ' x ' + project.height + ' x ' + project.thickness + ' mm\n' +
      'XY zero: ' + machine.origin + ' | top surface Z = 0 | cut Z is negative\n' +
      'Run these files individually in numbered order. Set work origin and install the correct cutter before each file.\n' +
      'NO automatic tool changes or homing. Confirm spindle setup, safe Z and clamping. Air-cut/test first.\n' +
      (machine.controller === 'klipper' ? 'Klipper M3/M5 requires configured macros if spindle commands are enabled.\n' : '') +
      (machine.controller === 'marlin' ? 'Marlin spindle commands require configured spindle support.\n' : '') +
      '\nThis CAM is experimental; there is no collision detection or feed/speed optimization.\n'
    );
    const bytes = zipSync(contents, { level: 6 });
    download(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), 'engraver-' + machine.controller + '.zip');
    status('Downloaded ' + n + ' separate operations. Set up and verify each tool individually.');
  } catch (error) { status(String(error), true); }
}

function updatePlywoodControls(): void {
  const isPlywood = stockMaterial === 'plywood' || stockMaterial === 'painted-plywood';
  el('plywood-options').hidden = !isPlywood;
  el('painted-plywood-options').hidden = stockMaterial !== 'painted-plywood';
}

function editPlywoodSetting(input: HTMLInputElement): void {
  const key = input.dataset.plywood as keyof PlywoodSettings | undefined;
  if (!key) return;
  try {
    const value: number | string | number[] = key === 'layerThicknesses'
      ? parsePlyThicknesses(input.value)
      : key === 'paintColor' ? input.value : Number(input.value);
    const next: PlywoodSettings = { ...plywoodSettings, layerThicknesses: [...plywoodSettings.layerThicknesses] };
    if (key === 'layerThicknesses') next.layerThicknesses = value as number[];
    else if (key === 'paintColor') next.paintColor = value as string;
    else if (key === 'topVeneerThickness') next.topVeneerThickness = value as number;
    else if (key === 'paintThickness') next.paintThickness = value as number;
    validatePlywoodSettings(next);
    Object.assign(plywoodSettings, next);
    input.setCustomValidity('');
    schedule();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.setCustomValidity(message);
    status(message, true);
  }
}

function initEvents(): void {
  el<HTMLInputElement>('file-input').addEventListener('change', e => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) void importFile(file);
    (e.currentTarget as HTMLInputElement).value = '';
  });
  el('demo-btn').addEventListener('click', loadDemo);
  el<HTMLSelectElement>('stock-material').addEventListener('change', e => {
    stockMaterial = (e.currentTarget as HTMLSelectElement).value as StockMaterial;
    updatePlywoodControls();
    schedule();
  });
  document.querySelectorAll<HTMLInputElement>('[data-plywood]').forEach(input => {
    input.addEventListener('change', () => editPlywoodSetting(input));
    if (input.type === 'color') input.addEventListener('input', () => editPlywoodSetting(input));
  });
  updatePlywoodControls();
  el('add-op').addEventListener('click', () => {
    const next = newOperation({ name: 'Additional engraving', mode: artwork?.isSVG && artwork.strokes.length > 0 ? 'vector' : 'raster' });
    operations.push(next); selectedId = next.id; renderOperations(); schedule();
  });
  el('split-colors').addEventListener('click', splitColors);
  el('reset-camera').addEventListener('click', () => preview.resetCamera(project));
  el('export-all').addEventListener('click', exportAll);
  el('export-selected').addEventListener('click', exportOne);

  el('operation-list').addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const select = target.closest<HTMLElement>('[data-select-op]');
    const remove = target.closest<HTMLElement>('[data-remove-op]');
    if (select) { selectedId = select.dataset.selectOp!; renderOperations(); renderImagePreview(); renderGcodePreview(); }
    if (remove) {
      operations = operations.filter(o => o.id !== remove.dataset.removeOp);
      if (!operations.length) operations = [newOperation()];
      if (!operations.some(o => o.id === selectedId)) selectedId = operations[0]!.id;
      renderOperations(); schedule();
    }
  });
  el('operation-list').addEventListener('change', e => {
    const input = e.target as HTMLInputElement | HTMLSelectElement;
    const op = operations.find(o => o.id === input.dataset.op);
    const key = input.dataset.key as keyof Operation | undefined;
    if (!op || !key) return;
    if (key === 'enabled') op.enabled = (input as HTMLInputElement).checked;
    else if (key === 'name' || key === 'mode' || key === 'channel' || key === 'tool' || key === 'color') {
      (op as unknown as Record<string, string>)[key] = input.value;
    } else {
      (op as unknown as Record<string, number>)[key] = number(input.value, op[key] as number, 0, 50000);
    }
    selectedId = op.id;
    renderOperations();
    schedule();
  });
  document.querySelectorAll<HTMLInputElement>('[data-pre]').forEach(input => input.addEventListener('change', () => {
    const key = input.dataset.pre as keyof Preprocess;
    if (key === 'invert') prep.invert = input.checked;
    else (prep as unknown as Record<string, number>)[key] = number(input.value, Number(prep[key]), 0 - (key === 'contrast' || key === 'brightness' ? 100 : 0), 200);
    schedule();
  }));
  document.querySelectorAll<HTMLInputElement>('[data-project]').forEach(input => input.addEventListener('change', () => {
    const key = input.dataset.project as keyof Project;
    project[key] = number(input.value, project[key], key === 'resolution' ? 40 : 1, key === 'resolution' ? 320 : 1000);
    if (key === 'width' || key === 'height') preview.resetCamera(project);
    schedule();
  }));
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-machine]').forEach(input => input.addEventListener('change', () => {
    const key = input.dataset.machine as keyof Machine;
    if (key === 'spindleEnabled') machine.spindleEnabled = (input as HTMLInputElement).checked;
    else if (key === 'controller' || key === 'origin') (machine as unknown as Record<string, string>)[key] = input.value;
    else (machine as unknown as Record<string, number>)[key] = number(input.value, Number(machine[key]), 0, 50000);
    el('controller-help').textContent = machine.controller === 'klipper'
      ? 'Klipper G0/G1 assume millimeters. M3/M5 require user-defined macros; spindle output is opt-in.'
      : machine.controller === 'marlin'
        ? 'Marlin spindle control requires firmware support. M3/M5 emission is opt-in.'
        : 'LinuxCNC uses G21/G90/G94 and M2. Spindle M3/M5 is opt-in.';
    renderGcodePreview();
  }));
}

function loadDemo(): void {
  const demo = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">',
    '<rect width="640" height="480" fill="white"/>',
    '<g fill="none" stroke="#285d67" stroke-width="6">',
    '<circle cx="320" cy="240" r="130"/><circle cx="320" cy="240" r="98"/>',
    '<path d="M130 240 Q320 -25 510 240 Q320 505 130 240 Z"/>',
    '</g>',
    '<g fill="none" stroke="#a05d38" stroke-width="8">',
    '<path d="M195 240 L320 100 L445 240 L320 380 Z"/>',
    '<circle cx="320" cy="240" r="48"/>',
    '</g>',
    '<g fill="#d6b785" opacity=".8"><circle cx="320" cy="240" r="24"/>',
    '<circle cx="70" cy="75" r="28"/><circle cx="570" cy="405" r="28"/></g>',
    '</svg>',
  ].join('');
  void importFile(new File([demo], 'sample-geometric-engraving.svg', { type: 'image/svg+xml' }));
}

initEvents();
renderOperations();
loadDemo();
