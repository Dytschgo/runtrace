import type { Page } from '@playwright/test';
import { expect, fixtureOnly, test } from './fixture';

// The implicit state machines made explicit on 8 Nov, each kept by a test of the state that used to read as a number.

const failWhen = (page: Page, match: (url: URL) => boolean) =>
  page.route('**/api/v1/**', (r) => (match(new URL(r.request().url()))
    ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'test failure' } }) })
    : r.fallback()));

test('a picked row whose counts fail reads Not loaded on every tile, never 0', async ({ page }) => {
  fixtureOnly();
  await failWhen(page, (u) => u.pathname.endsWith('/overview') && u.searchParams.get('model') === 'gpt-6.1-sol');
  await page.goto('/?range=30d&pick=gpt-6.1-sol');
  const prompts = page.locator('.tile').filter({ hasText: 'Prompts' });
  await expect(prompts).toContainText('Not loaded', { timeout: 30_000 });
  await expect(prompts.locator('strong')).not.toHaveText('0');
});

test('with the whole history failing, another measure over 30 days is not loaded rather than the last 15 days', async ({ page }) => {
  fixtureOnly();
  // The recent read (with a start date) still answers; only the whole history fails.
  await failWhen(page, (u) => u.pathname.endsWith('/model-turns') && !u.searchParams.get('since') && u.searchParams.get('limit') !== '200');
  await page.goto('/?range=30d&metric=output');
  const hero = page.locator('.tokens-hero');
  await expect(hero).toContainText('Not loaded', { timeout: 30_000 });
});

test('Agent Trees says its tokens are not loaded when the turns covering the window fail', async ({ page }) => {
  fixtureOnly();
  await failWhen(page, (u) => u.pathname.endsWith('/model-turns') && !u.searchParams.get('since') && u.searchParams.get('limit') !== '200');
  await page.goto('/?page=Agent+Trees&range=30d');
  await expect(page.locator('tbody').getByText('Not loaded').first()).toBeVisible({ timeout: 30_000 });
});

test('an update already running is followed, and an updater that gives up is said at once', async ({ page }) => {
  let applied = false;
  await page.route('**/api/v1/update', (r) => r.fulfill({ json: applied
    ? { state: 'apply_failed', current: '0.2.0', latest: '0.3.0', available: true, log: 'logs/update-1.log' }
    : { state: 'available', current: '0.2.0', latest: '0.3.0', available: true } }));
  await page.route('**/api/v1/update/apply', (r) => { applied = true; return r.fulfill({ status: 409, json: { error: { code: 'update_running', message: 'An update is already running' } } }); });
  // The old version keeps answering while its updater runs; the page reloads only for a new version.
  await page.route('**/health/ready', (r) => r.fulfill({ json: { ready: true, version: '0.2.0', pid: 1, collector: { state: 'synced' } } }));
  await page.goto('/?page=Settings');
  await page.getByRole('button', { name: 'Update' }).click();
  const dialog = page.getByRole('dialog', { name: 'Runtrace 0.3.0 is available' });
  await dialog.getByRole('button', { name: 'Update now' }).click();
  await expect(dialog.getByRole('status')).toContainText('stopped before installing', { timeout: 15_000 });
  await expect(dialog.getByRole('status')).toContainText('logs/update-1.log');
});
