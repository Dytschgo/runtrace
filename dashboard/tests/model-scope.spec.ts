import AxeBuilder from '@axe-core/playwright';
import { expect, LIVE, test } from './fixture';

for (const width of [1280, 390]) test(`requested models and configured threads stay distinct at ${width}px`, async ({ page, request }, testInfo) => {
  test.skip(LIVE, 'Neutral fixture only');
  await page.setViewportSize({ width, height: 900 });
  const scope = 'instance=local&run_status=failed';
  const response = await request.get(`/api/v1/models?${scope}`);
  expect(response.ok()).toBe(true);
  const rows = (await response.json()).data;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ model: 'grok-4.7', observed_runs: 16, observed_threads: 1 });
  await page.goto(`/?page=Models&range=all&${scope}`);
  await expect(page.getByText('100% of matching runs requested grok-4.7.', { exact: true })).toBeVisible();
  await expect(page.getByText('Runs and turns use requested models. Configured threads are thread starts in this range grouped by their configured model.', { exact: true })).toBeVisible();
  if (width === 1280) await expect(page.getByRole('columnheader', { name: /Configured threads/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Threads started per week, by configured model' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`requested-model-scope-${width}.png`), fullPage: true });
});
