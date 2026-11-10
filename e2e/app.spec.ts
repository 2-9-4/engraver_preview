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
  await expect(page.locator('#viewport')).toHaveAttribute('data-preview-mode', 'native-svg-mask', { timeout: 30000 });
  await expect(page.locator('#status')).toContainText(/^[1-9][0-9,]* toolpath segments/, { timeout: 30000 });
  await expect(page.locator('#gcode-preview')).toHaveValue(/G1 X/);
  for (const material of ['mdf', 'plywood', 'colorcore']) {
    await page.locator('#stock-material').selectOption(material);
    await expect(page.locator('#viewport canvas')).toBeVisible();
    await expect(page.locator('#status')).toContainText('toolpath segments', { timeout: 30000 });
  }
  expect(errors).toEqual([]);
});
