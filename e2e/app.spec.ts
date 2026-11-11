import { test, expect } from '@playwright/test';

test('imports example SVG, displays carved stock, splits colors and exports G-code', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#source-name')).toHaveText('sample-geometric-engraving.svg', { timeout: 30000 });
  await expect(page.locator('#status')).toContainText('toolpath segments', { timeout: 30000 });
  await expect(page.locator('#viewport canvas')).toBeVisible();
  await expect(page.locator('#stat-operations')).toHaveText('1');
  await expect(page.locator('#stat-depth')).not.toHaveText('—');

  await page.locator('#split-colors').click();
  await expect.poll(() => page.locator('.operation-card').count()).toBeGreaterThan(1);
  await expect(page.locator('#status')).toContainText('toolpath segments');
  await page.locator('[data-select-op]').first().click();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-all').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/engraver.*\.zip$/);
  expect(errors).toEqual([]);
});

test('switches stock materials and renders SVG flat-endmill geometry', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('toolpath segments', { timeout: 30000 });
  await page.locator('[data-key="mode"]').selectOption('vector');
  await page.locator('[data-key="tool"]').selectOption('flat');
  await page.waitForTimeout(2000);
  const mode = await page.locator('#viewport').getAttribute('data-preview-mode');
  if (mode !== 'native-svg-mask') {
    throw new Error('Unexpected SVG preview ' + mode + ': ' + await page.locator('#status').innerText() +
      '; operation count=' + await page.locator('#stat-operations').innerText());
  }
  await expect(page.locator('#status')).toContainText(/^[1-9][0-9,]* toolpath segments/, { timeout: 30000 });
  await expect(page.locator('#gcode-preview')).toHaveValue(/G1 X/);
  for (const material of ['mdf', 'plywood', 'colorcore']) {
    await page.locator('#stock-material').selectOption(material);
    await expect(page.locator('#viewport canvas')).toBeVisible();
    await expect(page.locator('#status')).toContainText('toolpath segments', { timeout: 30000 });
  }
  expect(errors).toEqual([]);
});

test('renders actual native SVG V-bit and ball-nose cutter profiles', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#source-name')).toHaveText('sample-geometric-engraving.svg', { timeout: 30000 });
  await page.locator('[data-key="mode"]').selectOption('vector');
  for (const bit of ['vbit', 'ball']) {
    await page.locator('[data-key="tool"]').selectOption(bit);
    await expect(page.locator('#viewport')).toHaveAttribute('data-preview-mode', 'native-svg-curved', { timeout: 30000 });
    await expect(page.locator('#status')).toContainText('toolpath segments', { timeout: 30000 });
    await expect(page.locator('#viewport canvas')).toBeVisible();
  }
  expect(errors).toEqual([]);
});


test('closed square SVG renders one closed solid for both curved bits', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#source-name')).toHaveText('sample-geometric-engraving.svg', { timeout: 30000 });
  const squareSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">' +
    '<rect x="20" y="20" width="60" height="60" stroke="#252525" fill="none" stroke-width="1"/></svg>';
  await page.locator('#file-input').setInputFiles({
    name: 'closed-square.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(squareSVG),
  });
  await expect(page.locator('#source-name')).toHaveText('closed-square.svg', { timeout: 30000 });
  await expect(page.locator('[data-key="mode"]')).toHaveValue('vector');
  for (const bit of ['vbit', 'ball']) {
    await page.locator('[data-key="tool"]').selectOption(bit);
    await expect(page.locator('#viewport')).toHaveAttribute('data-preview-mode', 'native-svg-curved', { timeout: 30000 });
    await expect(page.locator('#viewport')).toHaveAttribute('data-preview-topology', 'single-indexed-stock');
    await expect(page.locator('#viewport')).toHaveAttribute('data-preview-meshes', '1');
    await expect(page.locator('#status')).toContainText('toolpath segments');
    await expect(page.locator('#status')).not.toHaveClass(/error/);
  }
  expect(pageErrors).toEqual([]);
});


test('SVG Z, polygon and rect have all four edges in native preview AND CAM; open paths stay open', async ({ page }) => {
  await page.goto('/');
  const forms = [
    ['close uppercase', '<path d="M 20 20 H 80 V 80 H 20 Z" stroke="black" fill="none"/>', true],
    ['close lowercase', '<path d="M 20 20 h 60 v 60 h -60 z" stroke="black" fill="none"/>', true],
    ['polygon', '<polygon points="20,20 80,20 80,80 20,80" stroke="black" fill="none"/>', true],
    ['rectangle', '<rect x="20" y="20" width="60" height="60" stroke="black" fill="none"/>', true],
    ['open path', '<path d="M 20 20 H 80 V 80 H 20" stroke="black" fill="none"/>', false],
    ['polyline', '<polyline points="20,20 80,20 80,80 20,80" stroke="black" fill="none"/>', false],
  ] as const;
  for (const [name, content, closed] of forms) {
    const result = await page.evaluate(async ({ content, closed }) => {
      const { loadArtwork } = await import('/src/core/svg.ts');
      const { nativeStrokeToolpaths } = await import('/src/core/nativeCurves.ts');
      const { svgPathForOperation } = await import('/src/svgMasks.ts');
      const { newOperation } = await import('/src/types.ts');
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">' + content + '</svg>';
      const artwork = await loadArtwork(new File([svg], 'closure.svg', { type: 'image/svg+xml' }));
      const project = { width: 100, height: 100, thickness: 10, resolution: 170 };
      const stroke = artwork.strokes[0]!;
      const paths = nativeStrokeToolpaths(project, artwork, stroke, 1);
      const path = paths[0]!;
      const first = path[0]!, last = path.at(-1)!;
      const closedInCam = Math.hypot(first.x - last.x, first.y - last.y) < 0.000001;
      const op = newOperation({mode:'vector',tool:'vbit'});
      const p2d = svgPathForOperation(artwork, project,
        { operation: op, paths, length: 0 }, 10);
      const canvas = document.createElement('canvas');
      canvas.width = 1000; canvas.height = 1000;
      const ctx = canvas.getContext('2d')!;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.stroke(p2d);
      const alpha = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3]!;
      return {
        strokes: artwork.strokes.length, camLength: path.length,
        closedInCam, top: alpha(500, 200), right: alpha(800, 500),
        bottom: alpha(500, 800), left: alpha(200, 500),
      };
    }, { content, closed });
    expect(result.strokes, name).toBe(1);
    expect(result.closedInCam, name + ' machine closure').toBe(closed);
    expect(result.top, name + ' top edge').toBeGreaterThan(220);
    expect(result.right, name + ' right edge').toBeGreaterThan(220);
    expect(result.bottom, name + ' bottom edge').toBeGreaterThan(220);
    if (closed) expect(result.left, name + ' closing edge').toBeGreaterThan(220);
    else expect(result.left, name + ' intentionally open edge').toBeLessThan(20);
  }
});

test('independently closes multiple Z subpaths without joining separate shapes', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { loadArtwork } = await import('/src/core/svg.ts');
    const { nativeStrokeToolpaths } = await import('/src/core/nativeCurves.ts');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">' +
      '<path d="M 10 10 H 25 V 25 H 10 Z M 70 70 H 85 V 85 H 70 z" stroke="black" fill="none"/></svg>';
    const artwork = await loadArtwork(new File([svg], 'two-rects.svg', {type:'image/svg+xml'}));
    const paths = nativeStrokeToolpaths({width:100,height:100,thickness:10,resolution:100}, artwork, artwork.strokes[0]!, 1);
    return paths.map(path => ({
      count: path.length,
      start: [path[0]!.x, path[0]!.y],
      end: [path.at(-1)!.x, path.at(-1)!.y],
    }));
  });
  expect(result).toHaveLength(2);
  for(const subpath of result) {
    expect(subpath.count).toBe(5);
    expect(subpath.start[0]).toBeCloseTo(subpath.end[0]!);
    expect(subpath.start[1]).toBeCloseTo(subpath.end[1]!);
  }
  expect(Math.hypot(result[0]!.start[0]! - result[1]!.start[0]!,
    result[0]!.start[1]! - result[1]!.start[1]!)).toBeGreaterThan(40);
});


test('example SVG diamond retains its final diagonal Z edge', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const {loadArtwork} = await import('/src/core/svg.ts');
    const {nativeStrokeToolpaths} = await import('/src/core/nativeCurves.ts');
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">' +
      '<path d="M195 240 L320 100 L445 240 L320 380 Z" fill="none" stroke="#a05d38"/></svg>';
    const artwork = await loadArtwork(new File([source], 'demo-diamond.svg', {type:'image/svg+xml'}));
    const toolpaths = nativeStrokeToolpaths({width:640,height:480,thickness:12,resolution:170},
      artwork, artwork.strokes[0]!, 1);
    return toolpaths.map(path => path.map(p => ({ x:p.x, y:p.y })));
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toHaveLength(5);
  expect(result[0]![0]!.x).toBeCloseTo(195);
  expect(result[0]![4]!.x).toBeCloseTo(195);
  expect(result[0]![0]!.y).toBeCloseTo(result[0]![4]!.y);
});


test('painted plywood exposes editable veneer, ply sequence and paint over all SVG cutter types', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const shaders: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' && /WebGLProgram|shader error|GL_INVALID/i.test(message.text()))
      shaders.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('#source-name')).toHaveText('sample-geometric-engraving.svg', { timeout: 30000 });

  const select = page.locator('#stock-material');
  const panel = page.locator('#plywood-options');
  const paintPanel = page.locator('#painted-plywood-options');
  await expect(panel).toBeHidden();
  await select.selectOption('plywood');
  await expect(panel).toBeVisible();
  await expect(paintPanel).toBeHidden();
  await expect(page.locator('#viewport')).toHaveAttribute('data-stock-material', 'plywood', { timeout: 30000 });
  const plainPlywoodImage = await page.locator('#viewport canvas').screenshot();
  await select.selectOption('painted-plywood');
  await expect(paintPanel).toBeVisible();
  await expect(page.locator('#viewport')).toHaveAttribute('data-stock-material', 'painted-plywood', { timeout: 30000 });
  const paintedPlywoodImage = await page.locator('#viewport canvas').screenshot();
  expect(paintedPlywoodImage.equals(plainPlywoodImage)).toBe(false);

  await page.locator('#plywood-top-veneer').fill('0.45');
  await page.locator('#plywood-top-veneer').blur();
  await page.locator('#plywood-layers').fill('0.9, 1.5, 2.1');
  await page.locator('#plywood-layers').blur();
  await page.locator('#plywood-paint-thickness').fill('0.12');
  await page.locator('#plywood-paint-thickness').blur();
  await page.locator('#plywood-paint-color').evaluate((input: HTMLInputElement) => {
    input.value = '#b72d37';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.locator('#viewport')).toHaveAttribute('data-stock-material', 'painted-plywood', { timeout: 30000 });
  await expect(page.locator('#status')).toContainText('toolpath segments', { timeout: 30000 });
  for (const cutter of ['vbit', 'ball', 'flat']) {
    await page.locator('[data-key="tool"]').selectOption(cutter);
    await expect(page.locator('#viewport')).toHaveAttribute('data-preview-mode',
      cutter === 'flat' ? 'native-svg-mask' : 'native-svg-curved', { timeout: 30000 });
    await expect(page.locator('#status')).not.toHaveClass(/error/);
  }

  // Invalid ply patterns must not be silently converted into valid but wrong layers.
  await page.locator('#plywood-layers').fill('1.5, nope');
  await page.locator('#plywood-layers').blur();
  expect(await page.locator('#plywood-layers').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await expect(page.locator('#plywood-layers')).toHaveCSS('border-color', 'rgb(219, 139, 117)');
  await page.locator('#plywood-layers').fill('1.5');
  await page.locator('#plywood-layers').blur();
  await expect(page.locator('#status')).toContainText('toolpath segments', { timeout: 30000 });
  await expect(page.locator('#plywood-layers')).toHaveJSProperty('validationMessage', '');

  await select.selectOption('mdf');
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
  expect(shaders).toEqual([]);
});
