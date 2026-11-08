import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, LIVE, pinClock, test } from './fixture';

// The slider against the fixture history, or a live service. Totals are compared with the API, never hard-coded.
const api = async (request: APIRequestContext, route: string) => {
  const res = await request.get(`/api/v1/${route}`);
  expect(res.ok(), `${route} responded`).toBeTruthy();
  return res.json();
};
const display = (n: number) => n.toLocaleString('en-US');
const modelTotal = async (request: APIRequestContext, query: string) => {
  const rows = (await api(request, `models${query}`)).data as { total_tokens?: number | null }[];
  return rows.reduce((s, m) => s + (m.total_tokens ?? 0), 0);
};
const dragTo = async (page: Page, handle: string, ratio: number) => {
  const box = (await page.locator(handle).boundingBox())!;
  const rail = (await page.locator('.ts-rail').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(rail.x + rail.width * ratio, y, { steps: 8 });
};

test('dragging follows the data without a request, and agrees with the service on release', async ({ page, request }) => {
  test.slow();
  await page.goto('/?range=all');
  await page.waitForLoadState('networkidle');
  const hero = page.locator('.tokens-hero strong');
  const all = await modelTotal(request, '');
  await expect(hero).toHaveAttribute('title', new RegExp(`${display(all)} tokens$`));

  let calls = 0;
  page.on('request', (r) => { if (r.url().includes('/api/v1/')) calls++; });
  await dragTo(page, '.ts-start', 0.5);
  await expect(page.locator('.ts')).toHaveAttribute('data-holding', 'start');
  const held = await hero.getAttribute('title');
  expect(held).not.toBe(`${display(all)} tokens`);
  expect(calls, 'no request while the handle is held').toBe(0);
  await expect(page).not.toHaveURL(/since=/);

  await page.mouse.up();
  await expect(page).toHaveURL(/since=/);
  const since = new URL(page.url()).searchParams.get('since')!;
  await page.waitForLoadState('networkidle');
  // A live service keeps capturing during the test, so there the two reads are compared closely. The fixture never changes.
  const shown = async () => Number((await hero.getAttribute('title'))!.replace(/[^0-9]/g, ''));
  const windowed = await modelTotal(request, `?since=${encodeURIComponent(since)}`);
  const agrees = async () => (LIVE ? Math.abs((await shown()) - windowed) / windowed < 0.002 : (await shown()) === windowed);
  await expect.poll(agrees).toBe(true);

  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect.poll(agrees).toBe(true);
  await expect(page.locator('.ts-start')).not.toHaveAttribute('aria-valuenow', '0');
});

test('handles work from the keyboard, and the whole span means no filter', async ({ page }) => {
  await page.goto('/?range=all');
  const start = page.getByRole('slider', { name: 'Window start' });
  const end = page.getByRole('slider', { name: 'Window end' });
  await expect(start).toHaveAttribute('aria-valuenow', '0');
  const last = await end.getAttribute('aria-valuemax');
  await expect(end).toHaveAttribute('aria-valuenow', last!);

  await end.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('PageDown');
  await expect(end).toHaveAttribute('aria-valuenow', String(Number(last) - 8));
  await expect(page).toHaveURL(/until=/);

  await start.focus();
  await page.keyboard.press('End');
  await expect(start).toHaveAttribute('aria-valuenow', String(Number(last) - 8));

  await page.getByRole('radio', { name: 'All' }).check({ force: true });
  await expect(page).not.toHaveURL(/since=|until=/);
  await expect(start).toHaveAttribute('aria-valuenow', '0');
  await expect(end).toHaveAttribute('aria-valuenow', last!);
});

test('a preset moves the handles, and any window reaches other pages', async ({ page }) => {
  await page.goto('/?range=all');
  const start = page.getByRole('slider', { name: 'Window start' });
  await expect(start).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('radio', { name: '7d' }).check({ force: true });
  await expect(page).toHaveURL(/range=7d/);
  await expect(start).not.toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page).toHaveURL(/page=Activity.*range=7d/);
  await expect(page.getByRole('radio', { name: '7d' })).toBeChecked();
});

test('reduced motion shows the final state with nothing looping', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', timezoneId: 'Europe/Zurich' });
  await pinClock(context);
  const page = await context.newPage();
  await page.goto('/?range=all');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', /tokens$/);
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
  await context.close();
});

test('the week opens framed on the track, and the whole history is one press away', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const band = () => page.locator('.ts').evaluate((el) => parseFloat(el.style.getPropertyValue('--b')) - parseFloat(el.style.getPropertyValue('--a')));
  // A week of five weeks is a band you can grab, not a sliver.
  const framed = await band();
  expect(framed).toBeGreaterThan(15);
  await page.getByRole('button', { name: 'Show the whole history on the track' }).click();
  await expect(page).toHaveURL(/track=day/);
  await expect.poll(band).toBeLessThan(framed);
  await expect(page.locator('.ts-read')).toContainText('Last 7d');
});

test('a stray click on the bare track changes nothing, and a drag from there still moves a handle', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const rail = (await page.locator('.ts-rail').boundingBox())!;
  const url = page.url();
  await page.mouse.click(rail.x + rail.width * 0.1, rail.y + rail.height / 2);
  await page.waitForTimeout(400);
  expect(page.url()).toBe(url);
  await page.mouse.move(rail.x + rail.width * 0.1, rail.y + rail.height / 2);
  await page.mouse.down();
  await page.mouse.move(rail.x + rail.width * 0.2, rail.y + rail.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page).toHaveURL(/since=/);
  // The framed track stays as it was, so the window is still a band on it.
  await expect(page).toHaveURL(/zs=/);
});

test('Home on a handle moves to the first bar and never turns the window into all history', async ({ page }) => {
  await page.goto('/?range=30d&track=day');
  const start = page.getByRole('slider', { name: 'Window start' });
  await start.focus();
  await page.keyboard.press('Home');
  await expect(start).toHaveAttribute('aria-valuenow', '0');
  await expect(page).toHaveURL(/since=/);
  await expect(page).not.toHaveURL(/range=/);
  await expect(page.locator('.ts-read')).not.toContainText('Last');
});
