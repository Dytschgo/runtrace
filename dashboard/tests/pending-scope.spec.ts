import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { expect, LIVE, test } from './fixture';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(LIVE, 'Neutral fixture only');
  // A private build directory lets the frontend be checked while another worker
  // owns release compilation. Normal suite runs use the embedded application.
  const preview = process.env.RUNTRACE_UI_PREVIEW;
  if (preview) await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const origin = new URL(testInfo.project.use.baseURL as string).origin;
    if (url.origin !== origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/')) return route.continue();
    const directory = resolve(preview);
    const file = resolve(directory, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(directory + sep)) throw new Error('Preview asset escaped its directory');
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] ?? 'application/octet-stream' });
  });
});

for (const width of [1280, 390]) test(`pending global scope keeps totals readable at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?page=Overview&range=all');
  const totals = page.getByRole('region', { name: 'Key totals' });
  await expect(totals).toContainText('Prompts');
  await page.waitForLoadState('networkidle');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('run_status') === 'failed') await pending;
    await route.continue();
  });
  try {
    await page.getByRole('combobox', { name: 'Run status', exact: true }).selectOption('failed');
    await expect(page).toHaveURL(/run_status=failed/);
    await expect(totals).toHaveAttribute('data-stale', 'true');
    await page.screenshot({ path: testInfo.outputPath(`pending-totals-${width}.png`), fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('status').filter({ hasText: 'Totals for the previous selection' })).toBeVisible();
  } finally {
    release();
  }
  await expect(totals).not.toHaveAttribute('data-stale', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Totals for the previous selection' })).toHaveCount(0);
});

for (const width of [1280, 390]) test(`picked totals describe their own loading state at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?page=Overview&range=all');
  await page.locator('.model-line').first().click();
  await expect(page).toHaveURL(/pick=/);
  const totals = page.getByRole('region', { name: 'Key totals' });
  const loading = totals.getByRole('status', { name: 'Loading Prompts', exact: true });
  const previous = page.getByRole('status').filter({ hasText: 'Totals for the previous selection' });
  await expect(loading).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.model-line[aria-pressed="true"]')).toHaveCount(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  let releasePicked!: () => void;
  let releaseGlobal!: () => void;
  let sawGlobal!: () => void;
  const pickedPending = new Promise<void>((resolve) => { releasePicked = resolve; });
  const globalPending = new Promise<void>((resolve) => { releaseGlobal = resolve; });
  const globalStarted = new Promise<void>((resolve) => { sawGlobal = resolve; });
  await page.route('**/api/v1/overview?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('run_status') === 'failed') {
      if (params.has('model')) await pickedPending;
      else { sawGlobal(); await globalPending; }
    }
    await route.continue();
  });
  try {
    await page.getByRole('combobox', { name: 'Run status', exact: true }).selectOption('failed');
    await globalStarted;
    await expect(loading).toBeVisible();
    await expect(previous).toHaveCount(0);
    const pickedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/overview' && url.searchParams.get('run_status') === 'failed' && url.searchParams.has('model');
    });
    releasePicked();
    const response = await pickedResponse;
    expect(response.ok()).toBe(true);
    const body = await response.json() as { data: { kind: string; count: number }[] };
    const prompts = body.data.find((row) => row.kind === 'prompt')?.count ?? 0;
    await expect(loading).toHaveCount(0);
    const promptTile = totals.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Prompts', exact: true }) });
    await expect(promptTile.locator('strong')).toHaveText(prompts.toLocaleString('en-US'));
    // The unpicked overview is still waiting. Ready picked counts must not be
    // described as values from the previous selection.
    await expect(previous).toHaveCount(0);
    await expect(totals).not.toHaveAttribute('data-stale', 'true');
    await page.screenshot({ path: testInfo.outputPath(`picked-totals-${width}.png`), fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    releasePicked();
    releaseGlobal();
  }
});
