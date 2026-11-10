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

- SVG, PNG, JPEG, WebP, GIF, BMP import; aspect-preserving fit to stock and demo SVG on load. Stroked SVGs default to vector engraving rather than raster.
- Image preprocessing: blur, brightness, contrast, posterize, inversion.
- Source channels: luminance (darkness), R, G, B, alpha, and specific color with adjustable similarity tolerance.
- Multiple independent engraving operations and automatic separation into dominant color masks.
- Raster scanlines with per-position variable negative Z; threshold, gamma, stepover, max depth, step-down, feeds.
- SVG stroke centerline geometry extraction for path, circle, ellipse, line, polyline, polygon and rectangle (including nested transforms and per-stroke color).
- V-bits with included angle, ball endmills, flat endmills; actual cutter profiles swept along tool-center paths into a 3D heightfield.
- Interactive Three.js wood stock with orbit/pan/zoom, flat (non-smoothed) lighting, procedural MDF fiber, plywood wood grain and 1.5 mm exposed plies, or a dark face layer over pale color-core material.
- **High-fidelity SVG V-bit and ball-nose visual preview:** native parametric SVG curves are stroked by the browser vector renderer solely to construct a high-resolution display distance cache. The displayed 3D depth comes from the cutter's physical profile: a cone with the selected included angle for V-bits, and a spherical cross-section for ball noses. Overlapping strokes use the nearest centerline so the deepest material removal wins. The whole carved stock is rendered as one indexed, closed mesh: the cutter-envelope top, continuous perimeter walls, and stock bottom share their boundary vertices. No interior alpha-mask planes, overlaid bottoms, or old coarse stock walls are drawn for V/ball mode. Zoom increases the physical-distance-cache quality. This is still an approximate displayed mesh, not an exact CAD Boolean, and is currently supported for a single SVG vector operation.
- **High-fidelity SVG flat-endmill visual preview:** native parametric lines, cubic/quadratic Béziers and elliptical arcs feed the browser's vector renderer directly. Antialiased cutter-width masks clip the stock top and channel floor, bypassing *both* G1 chord subdivision and polygon-clipped silhouettes for these two most visible faces. Zooming increases mask resolution to preserve edge detail (capped at 6144 pixels along the longest stock dimension).
- The 3D side walls remain a polygon-clipped cutter sweep with true vertical walls; their faceted edge normals are blended along gradual curves while actual sharp corners stay sharp. This is not a mathematically exact boundary-representation CAD solid. Material surface shaders use world-space coordinates so plywood plies and painted/color-core depths remain consistent.
- G-code for Marlin, Klipper, LinuxCNC; manual spindle by default, optional configured M3/M5, safe Z, lower-left or centered XY zero, Z0 at stock top.
- Export individual G-code operations or ZIP with separately numbered programs to avoid automatic tool-change ambiguity.
- Geometric and exporter regression tests, plus a Playwright browser smoke test in GitHub Actions.

## Core architecture

SVG artwork -> sanitized native path commands (lines, Béziers, elliptical arcs, separate subpaths and DOM transforms). The **visual preview** uses native SVG curves to derive its own cutter-distance surface (independent of G-code); V/ball previews stitch this into one continuous stock solid. The **machine program** separately approximates curves in physical coordinates with a 0.01 mm chord-error bound for conservative G1 G-code. Raster images take a separate preprocessing + scanline route.

File layout:
- src/core/svg.ts: secure-ish SVG sanitization and **parametric** native curve extraction (no pixel-based source sampling)
- src/core/nativeCurves.ts: bounded-error Bézier/ellipse conversion to machine-compatible G1 strokes in millimeters
- src/core/image.ts: preprocessing, color masks, palette
- src/core/toolpaths.ts: unified raster and SVG tool-center paths
- src/core/simulate.ts: V/ball/flat cutter sweep simulation
- src/core/gcode.ts: controller-specific conservative G-code
- src/svgMasks.ts: original SVG curves to zoom-refined antialiased visual masks for cutter edges
- src/curvedPreview.ts: native SVG vector curve distance transform and physically shaped V-bit / ball-nose 3D surface
- src/preview.ts: Three.js renderer
- src/main.ts: editable UI and operation ZIP export
- tests/engine.test.ts: unit tests

## G-code behavior

Negative Z cuts beneath the selected stock-top Z0; units are mm, feed rates are mm/min. Marlin uses G90/G21; Klipper uses G90 and G0/G1 (G21 is omitted because default Klipper does not support it); LinuxCNC uses G90/G21/G17/G94/G40, G0/G1 and M2. No automatic homing, G92 coordinate rewriting, or automatic tool changes. Klipper M3/M5 require user macros if enabled, and Marlin requires spindle support in firmware.

## Important limitations

This is **experimental CAM**, not safety-validated CNC software. Independently inspect G-code and air-cut before machining. Confirm cutter geometry, feeds/speeds, spindle macros, XY/Z origin, clamps, travel limits and workpiece thickness. No stock-fixture collision checking, spindle ramp handling, pocket clearing, adaptive roughing, automatic tool change, or tool deflection model.

SVG centerline tracing follows explicit **strokes**, not outline pockets for fills or text; filled artwork can be engraved by raster. Stroke widths are not automatically converted into variable V-carve depth. Complex SVG filters and external references may be sanitized away. Raster operations and combined/mixed-depth vector operations still use an approximate sampled heightfield. Single-operation SVG V-bit and ball-nose previews use a single continuous indexed, physically profiled carved stock mesh (top, outer walls and bottom), with no overlapping interior planes. The square regression checks every mesh edge is incident to exactly two oppositely oriented triangles. Deep cuts wider than the tip's modeled radial reach can introduce near-vertical slopes that remain approximated by the top mesh. The finite display-distance cache and 3D mesh can still exhibit artifacts at extreme magnification; source SVG paths remain parametric and unmodified. SVG flat-endmill preview is currently the enhanced native-curve visual mode; it is not a general-purpose exact solid-model Boolean engine. Flat-endmill cutter curves are polygonal approximations with 0.005 mm arc deviation tolerance; this is not voxelization. SVG sources are kept as native parametric segments without pixel-based sampling. The improved flat-bit visual top and floor are generated separately from original SVG curves via the browser vector renderer, not from controller G1 motion or a world-space heightfield. Screens still rasterize pixels as all GPUs must; the display masks are regenerated with zoom rather than being used as low-resolution CNC geometry. Because Marlin/Klipper/LinuxCNC G1 motion and Three.js polygon meshes cannot encode arbitrary cubic Béziers exactly, output geometry is *tessellated* at 0.01 mm physical chord tolerance, not a fixed number of pixels or source points. This is bounded-error geometric approximation, not mathematically exact swept-solid CAD. Arc tessellation has a 0.01 mm second-derivative error bound. Bézier deviation is conservatively bounded by transformed control-point distance to its chord. Material finishes are procedural visualizations, not physically measured plywood, fiberboard or coating properties. Raster toolpaths may be large and are limited to 750k samples per operation.
