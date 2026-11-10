# Engraver Preview

Browser-based CNC wood engraving simulation. Upload an image or SVG, map luminance, colors, or RGB channels to cutter depth, assign independent cutters, preview the resulting swept surface in 3D, and export one G-code job per tool/operation.

## Quick start

Requires Node 20.19+ or Node 22.12+.

1. Run **npm install**
2. Run **npm run dev**
3. Open the Vite URL shown in the console.
4. Run **npm test** and **npm run build** for validation.
5. Run **npx playwright install chromium** then **npm run test:e2e** for the browser smoke test.

No server processing: uploaded artwork stays in your browser.

## Implemented

- SVG, PNG, JPEG, WebP, GIF, BMP import; aspect-preserving fit to stock and demo SVG on load.
- Image preprocessing: blur, brightness, contrast, posterize, inversion.
- Source channels: luminance (darkness), R, G, B, alpha, and specific color with adjustable similarity tolerance.
- Multiple independent engraving operations and automatic separation into dominant color masks.
- Raster scanlines with per-position variable negative Z; threshold, gamma, stepover, max depth, step-down, feeds.
- SVG stroke centerline geometry extraction for path, circle, ellipse, line, polyline, polygon and rectangle (including nested transforms and per-stroke color).
- V-bits with included angle, ball endmills, flat endmills; actual cutter profiles swept along tool-center paths into a 3D heightfield.
- Interactive Three.js wood stock with orbit/pan/zoom, flat (non-smoothed) lighting, procedural MDF fiber, plywood wood grain and 1.5 mm exposed plies, or a dark face layer over pale color-core material.
- Single-operation, constant-depth SVG flat-endmill paths rendered as polygon-unioned cutter sweeps with true vertical walls and flat floors. Circular cutter edges are finely tessellated (~0.06 mm arc intervals); this bypasses the heightfield for that case.
- G-code for Marlin, Klipper, LinuxCNC; manual spindle by default, optional configured M3/M5, safe Z, lower-left or centered XY zero, Z0 at stock top.
- Export individual G-code operations or ZIP with separately numbered programs to avoid automatic tool-change ambiguity.
- Ten geometric and exporter regression tests, plus a Playwright browser smoke test in GitHub Actions.

## Core architecture

Artwork -> sanitized SVG and optional vector centerlines -> preprocessed raster -> independently masked operations -> sampled tool-center XY/Z paths -> swept cutter simulation -> stock surface mesh; the **same** paths feed the G-code exporter.

File layout:
- src/core/svg.ts: secure-ish SVG sanitization and native stroke extraction
- src/core/image.ts: preprocessing, color masks, palette
- src/core/toolpaths.ts: unified raster and SVG tool-center paths
- src/core/simulate.ts: V/ball/flat cutter sweep simulation
- src/core/gcode.ts: controller-specific conservative G-code
- src/preview.ts: Three.js renderer
- src/main.ts: editable UI and operation ZIP export
- tests/engine.test.ts: unit tests

## G-code behavior

Negative Z cuts beneath the selected stock-top Z0; units are mm, feed rates are mm/min. Marlin uses G90/G21; Klipper uses G90 and G0/G1 (G21 is omitted because default Klipper does not support it); LinuxCNC uses G90/G21/G17/G94/G40, G0/G1 and M2. No automatic homing, G92 coordinate rewriting, or automatic tool changes. Klipper M3/M5 require user macros if enabled, and Marlin requires spindle support in firmware.

## Important limitations

This is **experimental CAM**, not safety-validated CNC software. Independently inspect G-code and air-cut before machining. Confirm cutter geometry, feeds/speeds, spindle macros, XY/Z origin, clamps, travel limits and workpiece thickness. No stock-fixture collision checking, spindle ramp handling, pocket clearing, adaptive roughing, automatic tool change, or tool deflection model.

SVG centerline tracing follows explicit **strokes**, not outline pockets for fills or text; filled artwork can be engraved by raster. Stroke widths are not automatically converted into variable V-carve depth. Complex SVG filters and external references may be sanitized away. Raster operations, V-bits, ball-nose cutters, and combined/mixed-depth vector operations still use an approximate sampled heightfield. SVG flat-endmill geometry is currently the precise path-sweep mode; it is not a general-purpose exact solid-model Boolean engine. Flat-endmill cutter circles are polygonal approximations at approximately 0.06 mm arc intervals. Material finishes are procedural visualizations, not physically measured plywood, fiberboard or coating properties. Raster toolpaths may be large and are limited to 750k samples per operation.
