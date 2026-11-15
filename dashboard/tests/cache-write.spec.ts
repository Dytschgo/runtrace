import { expect, test } from './fixture';

test('cache writes expose real API values and coverage across token panels', async ({ page, request }, testInfo) => {
  const response = await request.get('/api/v1/models');
  expect(response.ok()).toBeTruthy();
  const models = (await response.json()).data as {model: string | null; cache_write_tokens: number | null; cache_write_observed_turns: number; observed_provider_turns: number}[];
  const values = models.filter((m) => m.cache_write_tokens !== null);
  expect(values.length).toBeGreaterThan(0);
  const total = values.reduce((s,m) => s + m.cache_write_tokens!,0);
  const covered = models.reduce((s,m) => s + m.cache_write_observed_turns,0);
  const turns = models.reduce((s,m) => s + m.observed_provider_turns,0);
  const display = (n: number) => n.toLocaleString('en-US');
  await page.goto('/?page=Models&range=all');
  const panel = page.locator('dl.facts').getByText('Cache writes', {exact:true}).locator('..');
  await expect(panel.locator('dd span[title$="tokens"]')).toHaveAttribute('title', `${display(total)} tokens`);
  await expect(panel).toContainText(`recorded for ${display(covered)} of ${display(turns)} turns`);
  // Each model's cache writes, with how many turns recorded them, are exact on the mix bar's hover.
  const named = values.find((m) => m.model)!;
  const table = page.getByRole('table', {name:'Usage by requested model'});
  const cell = table.locator('tbody tr', {hasText:named.model!}).first().locator('.mix-cell');
  await expect(cell).toHaveAttribute('title', new RegExp(`Cache writes: ${display(named.cache_write_tokens!)} tokens \\(${display(named.cache_write_observed_turns)} of ${display(named.observed_provider_turns)} turns recorded\\)`));

  // The rule is one hover away, beside the headline.
  await expect(page.locator('.tokens-hero .hint')).toContainText('Cached input and cache writes are included in input. Reasoning is included in output.');
  await expect(page.getByLabel('Loading chart')).toHaveCount(0, {timeout:15000});
  await page.screenshot({path:testInfo.outputPath('models-cache-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(panel).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('models-cache-mobile.png'),fullPage:true});
  await page.goto('/?range=all');
  await expect(page.locator('.type-legend li', {hasText:'Cache write'}).locator('[title$="tokens"]')).toHaveAttribute('title', `${display(total)} tokens`);
});
