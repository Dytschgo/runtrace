import type { Page } from '@playwright/test';
import { expect, pinClock, test } from './fixture';

// Findings from the keyboard, error-state and phone reviews of 8 Nov, each kept fixed by a test.

const failApi = (page: Page) => page.route('**/api/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'test failure' } }) }));

test('a failed load is never shown as zero on Storage, Threads or Data Quality', async ({ page }) => {
  await failApi(page);
  for (const [name, stats] of [['Storage', ['Current records']], ['Threads', ['In view', 'Primary', 'Child']], ['Data Quality', ['Records', 'Marked complete']]] as const) {
    await page.goto(`/?page=${encodeURIComponent(name)}`);
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    for (const label of stats) {
      const stat = page.locator('.stat').filter({ hasText: label }).first();
      await expect(stat, `${name}: ${label}`).toContainText('Not loaded', { timeout: 30_000 });
      await expect(stat.locator('strong, .stat-value').first()).not.toHaveText(/^0%?$/);
    }
  }
});

test('the Overview headline says it could not load, not that nothing reported', async ({ page }) => {
  await failApi(page);
  await page.goto('/');
  const hero = page.locator('.tokens-hero');
  await expect(hero).toContainText('Not loaded', { timeout: 30_000 });
  await expect(hero).not.toContainText('No complete total');
});

test('opening a thread and changing page by chord move focus to the new heading', async ({ page }) => {
  await page.goto('/?page=Activity');
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('g');
  await page.keyboard.press('o');
  await expect(page).toHaveURL(/page=Overview|^[^?]*\/(\?(?!.*page=).*)?$/);
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeFocused();

  await page.goto('/?page=Threads&range=all');
  const first = page.locator('table .row-link, table .list-title').first();
  await expect(first).toBeVisible({ timeout: 60_000 });
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]id=/);
  await expect(page.locator('h1[data-page-title]')).toBeFocused();
});

test('a heading focused from the keyboard shows a ring, and the hidden Overview heading shows itself', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: 'Overview', level: 1 });
  await expect(heading).toBeFocused();
  const box = await heading.boundingBox();
  expect(box!.width).toBeGreaterThan(20);
  const outline = await heading.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('values the dashboard ignores are taken out of the address', async ({ page }) => {
  await page.goto('/?page=Nope&range=banana&since=yesterday&project=keep-me');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeAttached();
  await expect.poll(() => new URL(page.url()).searchParams.toString()).toBe('project=keep-me');
});

test('an unknown project id says so on Projects', async ({ page }) => {
  await page.goto('/?page=Projects&project=does-not-exist-xyz');
  await expect(page.getByRole('heading', { name: 'No such project' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('code').filter({ hasText: 'does-not-exist-xyz' })).toBeVisible();
});

test('the footer is the page footer landmark', async ({ page }) => {
  await page.goto('/?page=Settings');
  await expect(page.getByRole('contentinfo')).toContainText('Local only');
  await expect(page.getByRole('main').getByText('Local only')).toHaveCount(0);
});

test('short controls take taps from a 44px band on a touch screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await pinClock(ctx);
  const page = await ctx.newPage();
  await page.goto('/?range=1h');
  const pill = page.locator('.segmented-track label').first();
  await expect(pill).toBeVisible();
  const band = await pill.evaluate((el) => parseFloat(getComputedStyle(el, '::after').height));
  expect(band).toBeGreaterThanOrEqual(43);
  await ctx.close();
});
