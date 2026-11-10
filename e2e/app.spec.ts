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
