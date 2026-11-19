import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) test(`quota explains recorded observer sleep at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install({ time: new Date('2026-11-08T13:37:00Z') });
  await page.goto('/?page=Quota%20and%20Resets');
  await expect(page.getByRole('heading', { name: 'Quota and Resets', exact: true })).toBeVisible();
  await expect(page.locator('.quota-track svg[role="img"]').first()).toHaveAttribute('aria-label', /gaps in readings/);
  expect(await page.locator('.quota-track rect[fill="url(#quota-hatch)"]').count()).toBeGreaterThan(0);
  const sleep = page.getByRole('region', { name: 'Past quota windows' }).locator('details').filter({ hasText: 'Observer asleep' }).first();
  await expect(sleep).toBeVisible();
  await sleep.locator('summary').click();
  await expect(sleep.locator('li').filter({ hasText: 'recorded by Windows' }).first()).toBeVisible();
  await expect(sleep).toContainText('No readings');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
