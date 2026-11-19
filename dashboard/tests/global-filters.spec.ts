import AxeBuilder from '@axe-core/playwright';
import { expect, LIVE, test } from './fixture';
import { PAGES } from '../src/lib/url';
import { fmtBytes } from '../src/lib/format';

for (const width of [1280, 390]) test(`global machine and status scope across every page at ${width}px`, async ({ page, request }, testInfo) => {
  test.skip(LIVE, 'Neutral fixture only');
  test.setTimeout(180_000);
  await page.setViewportSize({ width, height: 900 });
  const scope = 'instance=local&run_status=failed';
  const efficiency = (await (await request.get(`/api/v1/usage/efficiency?${scope}`)).json()).data[0];
  const globalStorage = await (await request.get('/api/v1/storage')).json();
  for (const name of [...PAGES, 'Search']) {
    await page.goto(`/?page=${encodeURIComponent(name)}&range=all&${scope}`);
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    if (width === 390 && name !== 'Overview') await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(page.getByRole('combobox', { name: 'Machine', exact: true })).toHaveValue('local');
    await expect(page.getByRole('combobox', { name: 'Run status', exact: true })).toHaveValue('failed');
    if (name === 'Models') await expect(page.getByRole('heading', { name: /Threads started per (day|week), by configured model/ })).toBeVisible();
    if (name === 'Harnesses') await expect(page.getByText('Installation-wide limits.', { exact: true })).toBeVisible();
    if (name === 'Quota and Resets') {
      await expect(page.getByText('Installation-wide quota.', { exact: true })).toBeVisible();
      await expect(page.locator('.quota-card').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Left over time' })).toBeVisible();
    }
    if (name === 'Storage') {
      await expect(page.getByText(/File sizes, archive segments, maintenance and event-history totals remain installation-wide/)).toBeVisible();
      const databaseSize=page.locator('.stat').filter({ hasText: 'Database size' });
      await expect(databaseSize).toContainText('Installation-wide');
      await expect(databaseSize).toContainText(fmtBytes(globalStorage.duckdb_bytes));
    }
    if (name === 'Storage') await expect(page.locator('main')).not.toContainText('1970');
    if (name === 'Data Quality') await expect(page.getByText('Installation-wide · all machines and run statuses', { exact: true })).toBeVisible();
    if (name === 'Settings') await expect(page.getByText(/Browser preferences and local service controls apply to this installation/)).toBeVisible();
    if (name === 'Threads') {
      const measures = page.locator('[aria-label="Efficiency measures"]');
      await expect(measures).toContainText('Retries per thread');
      await expect(measures).toContainText(`${efficiency.covered_threads} of ${efficiency.threads} threads covered`);
      if (efficiency.retries_per_thread !== null) await expect(measures).toContainText(efficiency.retries_per_thread.toFixed(2));
    }
    await page.waitForLoadState('networkidle');
    await expect.poll(() => page.locator('.page').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const overlaps = await page.locator('.topbar').evaluate((bar) => {
      const items = [...bar.children].map((el) => ({ name: el.className, box: el.getBoundingClientRect() })).filter(({ box }) => box.width && box.height);
      return items.flatMap((a, i) => items.slice(i + 1).filter((b) => Math.min(a.box.right,b.box.right)-Math.max(a.box.left,b.box.left)>2 && Math.min(a.box.bottom,b.box.bottom)-Math.max(a.box.top,b.box.top)>2).map((b) => `${a.name} overlaps ${b.name}`));
    });
    expect(overlaps, `${name} header controls`).toEqual([]);
    const coveredLinks = await page.locator('.nav').evaluate((nav) => [...nav.querySelectorAll('a')].flatMap((a) => {
      const r = a.getBoundingClientRect();
      const clip = nav.getBoundingClientRect();
      const x = r.left+r.width/2, y = r.top+r.height/2;
      if (x < Math.max(0,clip.left) || x > Math.min(innerWidth,clip.right) || y < 0 || y > innerHeight) return [];
      return document.elementFromPoint(x,y)?.closest('a') === a ? [] : [a.getAttribute('aria-label')];
    }));
    expect(coveredLinks, `${name} clickable navigation`).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations, name).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${name.replaceAll(' ', '-')}-${width}.png`), fullPage: true });
    const link = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Activity', exact: true });
    expect(await link.getAttribute('href')).toContain('instance=local');
    expect(await link.getAttribute('href')).toContain('run_status=failed');
  }
  await page.goto('/?page=Threads');
  if (width === 390) await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('local');
  await page.getByRole('combobox', { name: 'Run status', exact: true }).selectOption('completed');
  await expect(page).toHaveURL(/run_status=completed/);
  await page.reload();
  if (width === 390) await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('combobox', { name: 'Run status', exact: true })).toHaveValue('completed');
});


for (const width of [1280, 390]) test(`same source IDs stay on their own machine in trees and token totals at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const at = '2026-11-05T10:00:00Z';
  const rows = ['east', 'west'].flatMap((machine, i) => {
    const base = { instance_id: machine, project_id: 'p', run_id: 'run', occurred_at: at, capture_quality: 'partial' };
    const thread = (source: string, title: string) => ({ ...base, id: `${machine}-${source}`, source_id: source, thread_id: source, kind: 'thread', data: { title, thread_type: source === 'root' ? 'primary' : 'child' } });
    return [thread('root', `${machine} root`), thread('kid', `${machine} child`),
      { ...base, id: `${machine}-agent`, source_id: 'same-agent', thread_id: 'root', kind: 'agent', data: { child_thread_id: 'kid', status: 'completed', started_at: at, completed_at: '2026-11-05T10:01:00Z' } },
      { ...base, id: `${machine}-turn`, source_id: 'same-turn', thread_id: 'root', kind: 'model_turn', data: { total_tokens: i ? 909 : 121, usage_status: 'complete' } },
      ...(i ? [{ ...base, id: `${machine}-open`, source_id: 'open-agent', thread_id: 'root', kind: 'agent', data: { child_thread_id: null, status: 'running', started_at: at, completed_at: null, content_redacted: JSON.stringify({ task: 'Timing unavailable' }) } }] : []),
    ];
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const kind = ({ threads: 'thread', agents: 'agent', 'model-turns': 'model_turn' } as Record<string,string>)[url.pathname.split('/').at(-1)!];
    if (!kind) return route.continue();
    const instance = url.searchParams.get('instance');
    await route.fulfill({ json: { data: rows.filter((r) => r.kind === kind && (!instance || r.instance_id === instance)), limit: 500, offset: 0 } });
  });
  await page.goto('/?page=Agent%20Trees&range=all');
  const table = page.getByRole('table', { name: 'Threads that delegated' });
  await expect(table.getByRole('link', { name: 'east root' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'west root' })).toBeVisible();
  for (const [machine, total, other] of [['east','121','909'], ['west','909','121']]) {
    await table.getByRole('link', { name: `${machine} root` }).click();
    const tree = page.getByRole('tree', { name: `Delegation tree for ${machine} root` });
    await expect(tree.getByText(`${machine} child`, { exact: true })).toBeVisible();
    await expect(tree).not.toContainText(machine === 'east' ? 'west child' : 'east child');
    await expect(page.locator('.tree-stats')).toContainText(`${total} root tokens`);
    await expect(page.locator('.tree-stats')).not.toContainText(`${other} root tokens`);
    const path = page.getByRole('status', { name: 'Observed critical path coverage' });
    await expect(path).toContainText('1m 00s');
    await expect(path).toContainText(machine === 'east' ? '1 of 1 agents fully timed' : '1 of 2 agents fully timed');
    if (machine === 'west') { await expect(path).toContainText('partial timing'); await expect(path).toContainText('at least'); }
    await expect(tree.locator('[data-critical-path]')).toHaveCount(2);
    const href = await page.getByRole('link', { name: 'Open thread', exact: true }).getAttribute('href');
    expect(href).toContain(`instance=${machine}`);
  }
  await expect.poll(() => page.locator('.page > *').evaluateAll((items) => items.every((el) => getComputedStyle(el).opacity === '1'))).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`machine-collisions-${width}.png`), fullPage: true });
  await page.getByRole('link', { name: 'Open thread', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('instance')).toBe('west');
  await expect(page.getByRole('heading', { name: 'west root', level: 1 })).toBeVisible();
});


for (const width of [1280, 390]) test(`overview text remains readable during row entrance motion at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/?page=Overview');
  await expect(page.locator('.trace-rows li').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const pausedRows = await page.locator('.trace-rows li').evaluateAll((rows) => {
    rows.forEach((row) => { (row as HTMLElement).style.animation = 'none'; });
    void document.documentElement.offsetWidth;
    rows.forEach((row) => {
      const el = row as HTMLElement;
      el.style.animation = 'rise 1000ms linear 0ms paused';
      el.getAnimations().forEach((animation) => { animation.currentTime = 50; });
    });
    return rows.length;
  });
  expect(pausedRows).toBeGreaterThan(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
