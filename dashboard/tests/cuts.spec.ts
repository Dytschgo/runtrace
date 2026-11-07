import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The new cuts on real history. Every total is compared with the API, never hard-coded.
const api = async (request: APIRequestContext, route: string) => {
  const res = await request.get(`/api/v1/${route}`);
  expect(res.ok(), `${route} responded`).toBeTruthy();
  return (await res.json()).data as Record<string, number | null>[];
};
const display = (n: number) => n.toLocaleString('en-US');
const open = async (page: Page, query = '') => {
  // Tests that name no window read the whole history, which is a choice rather than where the page opens.
  const whole = /range=|since=|until=/.test(query) ? query : `${query ? `${query}&` : '?'}range=all`;
  await page.goto(`/${whole}`);
  await page.waitForLoadState('networkidle');
};

test('providers split the same total as models, with nothing left unattributed', async ({ page, request }) => {
  test.slow();
  const models = await api(request, 'models');
  const total = models.reduce((s, m) => s + (m.total_tokens ?? 0), 0);
  await open(page);
  await page.getByRole('group', { name: 'Group by' }).getByRole('radio', { name: 'Providers', exact: true }).check({ force: true });
  await expect(page).toHaveURL(/by=provider/);
  // Live capture can add a little between the two reads.
  await expect.poll(async () => Number(((await page.locator('.tokens-hero strong').getAttribute('title')) ?? '').replace(/[^0-9]/g, ''))).toBeGreaterThan(total * 0.999);
  const rows = page.locator('.model-lines .model-line-name');
  await expect(rows.first()).toHaveText('OpenAI');
  await expect(page.locator('.model-lines')).not.toContainText('Not recorded');
  const shown = Number((await page.locator('.tokens-hero strong').getAttribute('title'))!.replace(/[^0-9]/g, ''));
  const sum = await page.locator('.model-lines b').evaluateAll((b) => b.map((x) => (x as HTMLElement).title).map((t) => Number(t.replace(/[^0-9]/g, ''))).reduce((a, c) => a + c, 0));
  expect(sum).toBe(shown);
  // xAI's own turns reported nothing, but its session logs did, so it shows those tokens as a lower bound.
  const xai = page.locator('.model-lines li', { hasText: 'xAI' });
  await expect(xai.locator('.lower-bound')).toHaveCount(1);
  await expect(xai.locator('.unknown')).toHaveCount(0);
});

test('a measure reads the same as the service, and a missing one never shows as zero', async ({ page, request }) => {
  test.slow();
  const models = await api(request, 'models');
  const output = models.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
  await open(page);
  await page.getByRole('combobox', { name: 'Measure' }).selectOption('output');
  await expect(page).toHaveURL(/metric=output/);
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', new RegExp(`${display(output)} output tokens$`));
  await expect(page.locator('.hero-chart h2')).toContainText('Output per');
  await expect(page.locator('.model-lines li', { hasText: 'grok-4.7' }).locator('.unknown').first()).toBeVisible();
});

test('resolution changes the buckets, and the last hour goes down to minutes', async ({ page }) => {
  await open(page, '?range=1h');
  await expect(page.locator('.ts-read')).toContainText('Last 1h');
  await expect(page.locator('.hero-chart h2')).toContainText('per 5 minutes');
  await page.getByRole('group', { name: 'Resolution' }).getByRole('radio', { name: '15m', exact: true }).check({ force: true });
  await expect(page.locator('.hero-chart h2')).toContainText('per 15 minutes');
  await page.getByRole('group', { name: 'Resolution' }).getByRole('radio', { name: 'Auto', exact: true }).check({ force: true });
  await expect(page).not.toHaveURL(/res=/);
});

test('dragging across the chart zooms in, the track follows in hours, and z goes back one step', async ({ page }) => {
  test.slow();
  await open(page, '?range=30d');
  const box = (await page.locator('.trace').boundingBox())!;
  const y = box.y + 200;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.58, y, { steps: 8 });
  await expect(page.locator('.trace-band')).toBeVisible();
  await page.mouse.up();
  await expect(page).toHaveURL(/since=.*until=.*zs=.*ze=/);
  await expect(page.locator('.ts-read')).toContainText(':00');
  await page.getByRole('button', { name: 'Show the whole history on the track' }).waitFor();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('z');
  await expect(page).toHaveURL(/range=30d/);
  await expect(page).not.toHaveURL(/since=|until=|zs=|up=/);
});

test('a click on the chart pins the reading and changes nothing until a period is opened', async ({ page }) => {
  await open(page, '?range=7d&res=1d');
  const box = (await page.locator('.trace').boundingBox())!;
  const before = page.url();
  await page.mouse.click(box.x + box.width * 0.5, box.y + 200);
  await expect(page.locator('.trace-tip-pinned')).toBeVisible();
  expect(page.url()).toBe(before);
  // The reading stays where it was pinned while the pointer moves on.
  const label = await page.locator('.trace-tip-head span').textContent();
  await page.mouse.move(box.x + box.width * 0.9, box.y + 200);
  await expect(page.locator('.trace-tip-head span')).toHaveText(label!);
  await page.locator('.trace-tip-open').click();
  await expect(page).toHaveURL(/since=.*until=.*up=r%3A7d|since=.*until=.*up=r:7d/);
  await page.getByRole('button', { name: 'Zoom out one step' }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(page).not.toHaveURL(/since=|up=/);
  await page.mouse.click(box.x + box.width * 0.5, box.y + 200);
  await expect(page.locator('.trace-tip-pinned')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.trace-tip-pinned')).toHaveCount(0);
});

test('a resolution too fine for the window stays chosen and says what is drawn', async ({ page }) => {
  await open(page, '?range=30d&res=5m');
  const group = page.getByRole('group', { name: 'Resolution' });
  await expect(group.getByRole('radio', { name: '5m', exact: true })).toBeChecked();
  await expect(group.getByRole('radio', { name: '1h', exact: true })).not.toBeChecked();
  await expect(page.locator('.res-note')).toBeVisible();
  await expect(group.getByRole('radio', { name: '15m', exact: true })).toBeDisabled();
});

test('the whole history folds the smaller models into Other', async ({ page }) => {
  await open(page);
  await expect(page.locator('.trace-line')).toHaveCount(9);
  await expect(page.locator('.trace-line[stroke-dasharray="1 4"]')).toHaveCount(1);
});

test('the overview list is one tab stop, and the arrow keys move along it', async ({ page }) => {
  await open(page, '?range=7d');
  const buttons = page.locator('.model-lines .model-line');
  await expect(buttons.first()).toBeVisible();
  await expect(page.locator('.model-lines .model-line[tabindex="0"]')).toHaveCount(1);
  await buttons.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(buttons.last()).toBeFocused();
});

test('compare draws the period before, and only when there is one', async ({ page }) => {
  await open(page);
  const compare = page.getByRole('button', { name: 'Compare with the period before' });
  await expect(compare).toBeDisabled();
  await open(page, '?range=7d');
  await compare.click();
  await expect(page).toHaveURL(/compare=1/);
  await expect(page.locator('.trace-ghost')).toHaveCount(1);
  await expect(page.locator('.hero-delta')).toBeVisible();
});

test('every chart style and grouping draws without an error, and a quiet window reads as zero', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  for (const by of ['Providers', 'Projects', 'Models']) {
    await page.getByRole('group', { name: 'Group by' }).getByRole('radio', { name: by, exact: true }).check({ force: true });
    for (const view of ['Stacked', 'Running', 'Lines']) {
      await page.getByRole('group', { name: 'Chart style' }).getByRole('radio', { name: view, exact: true }).check({ force: true });
      // The busiest line, because a very small one lies flat on the axis and has no height to be seen by.
      await expect(page.locator('.trace-line').last()).toBeVisible();
    }
  }
  // Long before any capture nothing is known, which must not read as a zero.
  await open(page, '?since=2020-01-01T00:00:00.000Z&until=2020-01-02T00:00:00.000Z');
  await expect(page.locator('.tokens-hero strong')).toContainText('Before history');
  await expect(page.locator('.before-history')).toBeVisible();
  await expect(page.locator('.trace-empty')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the biggest threads come first', async ({ page }) => {
  test.slow();
  await open(page, '?by=provider');
  await page.getByRole('group', { name: 'Sort threads' }).getByRole('radio', { name: 'Biggest', exact: true }).check({ force: true });
  await expect(page).toHaveURL(/threads=tokens/);
  await expect(page.getByRole('heading', { name: 'Biggest threads' })).toBeVisible();
  const values = await page.locator('.trace-row-tokens span[title$="tokens"]').evaluateAll((s) => s.map((x) => Number((x as HTMLElement).title.replace(/[^0-9]/g, ''))));
  expect(values.length).toBeGreaterThan(1);
  expect([...values].sort((a, b) => b - a)).toEqual(values);
});

test('the hour before is one press away, and zoom leaves the numbers alone', async ({ page }) => {
  test.slow();
  await open(page, '?range=6h');
  const hero = page.locator('.tokens-hero strong');
  const start = await hero.getAttribute('title');
  await page.getByRole('button', { name: 'Zoom the track to this window' }).click();
  await expect(page).toHaveURL(/zs=/);
  await expect(page).toHaveURL(/range=6h/);
  await expect(hero).toHaveAttribute('title', start!);
  await page.getByRole('button', { name: 'Step back one window' }).click();
  await expect(page).toHaveURL(/since=.*until=/);
  await expect(page).not.toHaveURL(/range=/);
  await page.getByRole('button', { name: 'Step forward one window' }).click();
  await expect(page).not.toHaveURL(/until=/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('[');
  await expect(page).toHaveURL(/until=/);
  await page.keyboard.press(']');
  await expect(page).not.toHaveURL(/until=/);
});

test('every resolution draws all the data across the October clock change', async ({ page, request }) => {
  test.slow();
  const models = await api(request, 'models');
  const total = models.reduce((s, m) => s + (m.total_tokens ?? 0), 0);
  for (const res of ['6h', '1d', '1w']) {
    await open(page, `?res=${res}&nr=1`);
    await page.getByRole('button', { name: 'Show as table' }).click();
    const sum = await page.locator('.hero-chart tbody tr').evaluateAll((rows) => rows.reduce((s, r) => s + [...r.querySelectorAll('td.num')].reduce((n, c) => n + (Number(c.textContent!.replace(/[^0-9]/g, '')) || 0), 0), 0));
    // Live capture can add a little between the two reads, but nothing close to a dropped day.
    expect(Math.abs(sum - total) / total, res).toBeLessThan(0.01);
  }
});

test('the headline, list and chart agree, and a partial reporter is not called empty', async ({ page }) => {
  test.slow();
  await open(page, '?nr=1');
  await page.getByRole('button', { name: 'Show as table' }).click();
  const headline = Number((await page.locator('.tokens-hero strong').getAttribute('title'))!.replace(/[^0-9]/g, ''));
  const chart = await page.locator('.hero-chart tbody tr').evaluateAll((rows) => rows.reduce((s, r) => s + [...r.querySelectorAll('td.num')].reduce((n, c) => n + (Number(c.textContent!.replace(/[^0-9]/g, '')) || 0), 0), 0));
  expect(chart).toBe(headline);
  const muse = page.locator('.model-lines li', { hasText: 'muse-wonder-1.0' }).locator('.unknown');
  await expect(muse).toHaveAttribute('title', /Reported token fields/);
  await page.getByRole('combobox', { name: 'Measure' }).selectOption('turns');
  await expect(page.locator('.model-lines .unknown')).toHaveCount(0);
});

test('the last hour slides forward on its own while the page sits idle', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await page.goto('/?range=1h');
  await page.clock.runFor(1_000);
  const seen: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/v1/overview') && r.url().includes('since=')) seen.push(new URL(r.url()).searchParams.get('since')!); });
  await page.clock.runFor(3 * 60_000);
  await expect.poll(() => new Set(seen).size).toBeGreaterThan(1);
});

test('the slider is the widest thing in the header, and a tap keeps the tooltip open', async ({ page, browser }) => {
  await open(page);
  const rail = (await page.locator('.ts-rail').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(rail.width).toBeGreaterThan(viewport.width * 0.4);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage();
  await phone.goto('/');
  await phone.waitForLoadState('networkidle');
  await phone.locator('.trace').scrollIntoViewIfNeeded();
  await phone.waitForTimeout(400);
  const box = (await phone.locator('.trace').boundingBox())!;
  await phone.touchscreen.tap(box.x + box.width * 0.6, box.y + 60);
  await expect(phone.locator('.trace-tip')).toBeVisible();
  await phone.waitForTimeout(300);
  await expect(phone.locator('.trace-tip')).toBeVisible();
  await context.close();
});

test('the projects view stays responsive with many projects, including its comparison', async ({ page }) => {
  test.slow();
  await open(page, '?by=project&range=30d&compare=1');
  await expect(page.locator('.model-lines li').first()).toBeVisible();
  await expect(page.locator('.trace-line').first()).toBeVisible();
  expect(await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(true))))).toBe(true);
  const looks = await page.locator('.trace-line').evaluateAll((l) => l.map((x) => `${x.getAttribute('stroke')}|${x.getAttribute('stroke-dasharray') ?? ''}`));
  expect(new Set(looks).size).toBe(looks.length);
});

test('stepping back from a preset and forward again returns to that live preset', async ({ page }) => {
  await open(page, '?range=1h');
  await page.getByRole('button', { name: 'Step back one window' }).click();
  await expect(page).toHaveURL(/rp=1h/);
  await page.getByRole('button', { name: 'Step forward one window' }).click();
  await expect(page).toHaveURL(/range=1h/);
  await expect(page).not.toHaveURL(/since=|until=|rp=/);
  await expect(page.locator('.ts-read')).toContainText('Last 1h');
});

// A closed evening where Opus ran at 18:00 UTC and reported nothing, which old windows keep true.
const EVENING = 'since=2026-10-31T17:00:00.000Z&until=2026-10-31T20:59:59.999Z&res=1h';
const hoverAt = async (page: Page, fraction: number) => {
  const box = (await page.locator('.trace').boundingBox())!;
  await page.mouse.move(box.x + box.width * fraction, box.y + 150);
};

test('a stacked band hatches what it cannot know and its sum says it is a lower bound', async ({ page }) => {
  await open(page, `?${EVENING}&view=stacked`);
  await expect(page.locator('.trace-line').first()).toBeVisible();
  const holes = await page.locator('.trace-hole').evaluateAll((l) => l.filter((x) => x.getAttribute('d')).length);
  expect(holes).toBeGreaterThan(0);
  await hoverAt(page, 0.36);
  const tip = page.locator('.trace-tip');
  await expect(tip).toContainText('not reported');
  await expect(tip.locator('.trace-tip-head b')).toHaveText(/^≥ /);
});

test('lines have no hatched bands', async ({ page }) => {
  await open(page, `?${EVENING}`);
  await expect(page.locator('.trace-line').first()).toBeVisible();
  expect(await page.locator('.trace-hole').evaluateAll((l) => l.filter((x) => x.getAttribute('d')).length)).toBe(0);
});

test('a focused or filtered model compares against its own silence, not a zero', async ({ page }) => {
  const when = 'since=2026-10-31T19:00:00.000Z&until=2026-10-31T19:59:59.999Z&res=15m&compare=1';
  await open(page, `?${when}`);
  await page.locator('.model-line', { hasText: 'claude-opus-5-5' }).hover();
  await expect(page.locator('.trace')).toHaveAttribute('data-focus', 'true');
  // Four buckets, the last one silent: three points and no dive to the floor. It must still be so once the entrance has finished.
  await page.waitForTimeout(1600);
  await expect(page.locator('.trace')).toHaveAttribute('data-focus', 'true');
  expect(((await page.locator('.trace-ghost').getAttribute('d')) ?? '').match(/C/g)?.length).toBe(2);

  await open(page, `?model=claude-opus-5-5&${when}`);
  await hoverAt(page, 0.9);
  await expect(page.locator('.trace-tip-ghost')).toContainText('not reported');
  await hoverAt(page, 0.36);
  await expect(page.locator('.trace-tip-ghost b')).toHaveText('0');
});

test('a live preset moves with the clock while nobody touches it', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  // Capture keeps up during the wait, as it does in real use.
  await page.route('**/health/ready', (route) => route.fulfill({ json: { ready: true, collector: { state: 'idle', last_successful_sync_at: new Date(Date.now() + 3_600_000).toISOString() } } }));
  await open(page, '?range=1h');
  const last = page.locator('.trace-tick[text-anchor="end"]').last();
  await expect(last).toBeVisible();
  const before = await last.textContent();
  await page.clock.fastForward(20 * 60_000);
  await expect(last).not.toHaveText(before!);
  await expect(page.locator('.ts-read')).toContainText('Last 1h');
});

test('a change made during the entrance animation is still there when it ends', async ({ page }) => {
  await open(page, '?since=2026-10-31T17:00:00.000Z&until=2026-10-31T20:59:59.999Z&res=1h');
  await expect(page.locator('.trace-line').first()).toBeVisible();
  const paths = () => page.locator('.trace-line').evaluateAll((l) => l.map((x) => x.getAttribute('d')));
  // Change the look straight after the data lands, then let any frames still queued run out.
  await page.getByRole('group', { name: 'Chart style' }).getByRole('radio', { name: 'Stacked', exact: true }).check({ force: true });
  await page.waitForTimeout(100);
  await page.waitForTimeout(1600);
  const settled = await paths();
  await page.waitForTimeout(600);
  expect(await paths()).toEqual(settled);
  expect(await page.locator('.trace-hole').evaluateAll((l) => l.filter((x) => x.getAttribute('d')).length)).toBeGreaterThan(0);
});

test('the chart download says which values are missing and which are lower bounds', async ({ page }) => {
  await open(page, `?${EVENING}`);
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download this chart as CSV' }).click();
  const file = await (await waiting).createReadStream();
  const text = await new Promise<string>((done) => { let s = ''; file.on('data', (d) => { s += d; }); file.on('end', () => done(s)); });
  const [head, ...rows] = text.trim().split(/\r?\n/);
  expect(head).toContain('Ran but reported nothing');
  expect(head).toContain('Lower bound, some turns missing');
  expect(rows.length).toBeGreaterThanOrEqual(4);
  expect(rows.join('\n')).toContain('muse-wonder-1.0');
});

test('opening today stops at now and compares equal time', async ({ page }) => {
  const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday.getTime() + 86_400_000 - 1);
  await open(page, `?since=${startOfToday.toISOString()}&until=${endOfToday.toISOString()}&res=1h`);
  await expect(page.locator('.trace-line').first()).toBeVisible();
  // Every row in the table lies before now.
  await page.getByRole('button', { name: 'Show as table' }).click();
  const rows = await page.locator('.hero-chart tbody tr').count();
  expect(rows).toBeLessThanOrEqual(Math.ceil((Date.now() - startOfToday.getTime()) / 3_600_000) + 2);
  await expect(page.locator('.ts-read')).toContainText('now');
});

test('shortcuts still work after clicking a preset', async ({ page }) => {
  await open(page);
  await page.locator('.filterbar .segmented').getByRole('radio', { name: '6h', exact: true }).check({ force: true });
  await expect(page).toHaveURL(/range=6h/);
  await page.keyboard.press('[');
  await expect(page).toHaveURL(/since=.*until=/);
  await page.keyboard.press('z');
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox').or(page.locator('.search input')).first()).toBeFocused();
});

test('a window before history is unknown, and a window part way in starts at history', async ({ page }) => {
  await open(page, '?since=2026-05-01T00:00:00.000Z&until=2026-05-02T00:00:00.000Z');
  await expect(page.locator('.before-history')).toContainText('unknown');
  await expect(page.locator('.stats')).toContainText('Unknown');
  await open(page, '?since=2026-06-01T00:00:00.000Z&until=2026-06-20T00:00:00.000Z&res=1d');
  await expect(page.locator('.trace-note')).toContainText('History here starts');
  await expect(page.locator('.trace-tick[text-anchor="start"]').first()).toHaveText('13 JUN');
});

test('a window that starts later than now is unknown, not zero', async ({ page }) => {
  const from = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await open(page, `?since=${from}&until=${to}`);
  await expect(page.locator('.before-history')).toContainText('Not yet');
  await expect(page.locator('.tokens-hero strong')).toContainText('Not yet');
  await expect(page.locator('.stats')).toContainText('Unknown');
  await expect(page.locator('.trace-empty')).toHaveCount(0);
});

test('a long stretch with no records is not captured, not a quiet time', async ({ page }) => {
  await open(page, '?since=2026-07-05T00:00:00.000Z&until=2026-07-10T00:00:00.000Z');
  await expect(page.locator('.before-history')).toContainText('Not captured');
  await expect(page.locator('.tokens-hero strong')).toContainText('Not captured');
  await open(page, '?since=2026-06-10T00:00:00.000Z&until=2026-08-25T00:00:00.000Z&res=1d');
  await expect(page.locator('.trace-blackout').first()).toBeAttached();
  const d = (await page.locator('.trace-line').first().getAttribute('d'))!;
  expect((d.match(/M/g) ?? []).length).toBeGreaterThan(1);
});

test('a link with a bad date still opens the app', async ({ page }) => {
  for (const q of ['?since=garbage', '?until=garbage', '?since=2026-99-99&until=x', '?zs=garbage&ze=nope', '?since=2026-11-01T00:00:00.000Z&until=2026-10-10T00:00:00.000Z']) {
    await open(page, q);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.tokens-hero strong')).toBeVisible();
    await expect(page.getByText('Query rejected')).toHaveCount(0);
  }
});

test('exact dates cannot make a window that ends before it starts', async ({ page }) => {
  await open(page, '?page=Threads&since=2026-10-10T00:00:00.000Z&until=2026-10-20T23:59:59.999Z');
  await page.getByRole('button', { name: 'Exact dates' }).click();
  await page.getByLabel('From date').fill('2026-11-01');
  await expect(page).toHaveURL(/since=/);
  const url = new URL(page.url());
  expect(Date.parse(url.searchParams.get('since')!)).toBeLessThan(Date.parse(url.searchParams.get('until')!));
});

test('the compare total breaks where nothing reported', async ({ page }) => {
  await open(page, '?since=2026-10-18T00:00:00.000Z&until=2026-10-18T06:59:59.999Z&res=1h&compare=1');
  await expect(page.locator('.trace-total')).toBeVisible();
  const d = (await page.locator('.trace-total').getAttribute('d'))!;
  expect((d.match(/M/g) ?? []).length).toBeGreaterThan(1);
});

test('focusing a line does not rescale the chart', async ({ page }) => {
  await open(page, '?range=24h&compare=1');
  await expect(page.locator('.trace-line').first()).toBeVisible();
  const top = () => page.locator('.trace-tick[text-anchor="end"]').evaluateAll((l) => l.map((x) => x.textContent).join('|'));
  const before = await top();
  await page.locator('.model-lines li:not([data-unnamed]) .model-line').nth(1).hover();
  await expect(page.locator('.trace')).toHaveAttribute('data-focus', 'true');
  expect(await top()).toBe(before);
});

test('a tab left open keeps every new turn, even past one page', async ({ page }) => {
  test.slow();
  await page.clock.install({ time: new Date() });
  let batch = 0;
  await page.route(/model-turns\?.*limit=200/, async (route) => {
    batch += 1;
    const res = await route.fetch();
    const body = await res.json();
    const sample = body.data[0];
    const at = new Date().toISOString();
    body.data = Array.from({ length: 200 }, (_, i) => ({ ...sample, id: `new-${batch}-${i}`, source_id: `new-${batch}-${i}`, occurred_at: at }));
    await route.fulfill({ response: res, json: body });
  });
  await open(page, '?metric=turns');
  const hero = page.locator('.tokens-hero strong');
  await expect(hero).toHaveAttribute('title', /provider turns$/);
  const count = async () => Number((await hero.getAttribute('title'))!.replace(/[^0-9]/g, ''));
  const startAt = await count();
  const startBatch = batch;
  for (let i = 0; i < 3; i++) await page.clock.fastForward(61_000);
  await expect.poll(() => batch).toBeGreaterThan(startBatch);
  await expect.poll(count, { timeout: 15_000 }).toBeGreaterThanOrEqual(startAt + (batch - startBatch) * 200);
});

test('a hovered row that disappears does not leave the chart dimmed', async ({ page }) => {
  await open(page, '?range=24h');
  await page.locator('.model-line').first().hover();
  await expect(page.locator('.trace')).toHaveAttribute('data-focus', 'true');
  // The rows under the pointer change while it stays put.
  await page.getByRole('group', { name: 'Group by' }).getByRole('radio', { name: 'Projects', exact: true }).check({ force: true });
  await expect(page.locator('.trace-line').first()).toBeVisible();
  await page.mouse.move(2, 2);
  await expect(page.locator('.trace')).not.toHaveAttribute('data-focus', 'true');
});

test('compare can be turned off when there is nothing before', async ({ page }) => {
  await open(page, '?range=7d&compare=1');
  await page.keyboard.press('z');
  await expect(page).toHaveURL(/range=30d/);
  await page.keyboard.press('z');
  await expect(page).toHaveURL(/range=all/);
  const button = page.getByRole('button', { name: 'Compare with the period before' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page).not.toHaveURL(/compare=/);
  await expect(button).toBeDisabled();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('a tooltip stays on screen and a tap elsewhere puts it away', async ({ page }) => {
    await open(page, '?range=30d');
    const box = (await page.locator('.trace').boundingBox())!;
    await page.locator('.trace').scrollIntoViewIfNeeded();
    const now = (await page.locator('.trace').boundingBox())!;
    await page.touchscreen.tap(now.x + box.width / 2, now.y + 80);
    const tip = page.locator('.trace-tip');
    await expect(tip).toBeVisible();
    const rect = (await tip.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(390);
    await page.locator('.tokens-hero span').first().tap();
    await expect(tip).toHaveCount(0);
  });
});

test('the overview opens on the last week without waiting for the whole history', async ({ page }) => {
  // The whole-history scan never answers here, and the page must not need it.
  await page.route(/model-turns\?(?!.*since=)(?!.*limit=200)/, () => {});
  await page.goto('/');
  await expect(page.locator('.ts-read')).toContainText('Last 7d');
  await expect(page.locator('.filterbar .segmented').getByRole('radio', { name: '7d', exact: true })).toBeChecked();
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', /tokens$/, { timeout: 20_000 });
  await expect(page.locator('.trace-line').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  await page.locator('.filterbar .segmented').getByRole('radio', { name: 'All', exact: true }).check({ force: true });
  await expect(page).toHaveURL(/range=all/);
});

test('the whole history arrives in the background and a chosen window waits only for what it needs', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', /tokens$/);
  await page.locator('.filterbar .segmented').getByRole('radio', { name: 'All', exact: true }).check({ force: true });
  await expect(page.locator('.ts-read')).not.toContainText('Last 7d');
  await expect(page.locator('.trace-tick[text-anchor="start"]').first()).toHaveText(/JUN/, { timeout: 120_000 });
});

test('every provider and model stays listed, ranked by use', async ({ page }) => {
  await open(page, '?by=provider&range=24h');
  for (const name of ['OpenAI', 'Anthropic', 'xAI', 'Meta', 'Google']) await expect(page.locator('.model-lines li', { hasText: name })).toHaveCount(1);
  await open(page, '?range=24h');
  await expect(page.locator('.more-models')).toHaveCount(0);
  const values = await page.locator('.model-lines li b[title]').evaluateAll((b) => b.map((x) => Number((x as HTMLElement).title.replace(/[^0-9]/g, ''))));
  expect([...values].sort((a, c) => c - a)).toEqual(values);
  await expect(page.locator('.model-lines li', { hasText: 'gemini' }).first()).toBeVisible();
});

test('turns that name no model keep their rank in the list, stay off the chart until asked for, and the rows add up', async ({ page }) => {
  // A week, because on the whole history the smaller lines fold into Other and the count stays the same.
  await open(page, '?range=7d');
  await expect(page.locator('.model-lines li[data-unnamed] .model-line-name', { hasText: /^Not recorded$/ })).toHaveCount(1);
  const headline = await page.locator('.tokens-hero strong').getAttribute('title');
  const sum = await page.locator('.model-lines b[title]').evaluateAll((b) => b.reduce((s, x) => s + Number((x as HTMLElement).title.replace(/[^0-9]/g, '')), 0));
  expect(sum).toBe(Number(headline!.replace(/[^0-9]/g, '')));
  const toggle = page.locator('.unnamed-toggle');
  await expect(toggle).toContainText('Not recorded on chart');
  // The chart settles once the whole history is in, so the lines are counted when two readings agree.
  let before = -1;
  for (let last = -2; before !== last; await page.waitForTimeout(1500)) { last = before; before = await page.locator('.trace-line').count(); }
  await toggle.click();
  await expect(page).toHaveURL(/nr=1/);
  await expect(page.locator('.trace-line')).toHaveCount(before + 1);
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', headline!);
});

test('choosing rows filters the page, for any number of them', async ({ page }) => {
  test.slow();
  await open(page, '?by=provider&range=7d');
  const tile = page.locator('.stats strong').first();
  await expect(tile).toHaveAttribute('title', /\d/);
  const allPrompts = Number((await tile.getAttribute('title'))!.replace(/[^0-9]/g, ''));
  const rows = page.locator('.model-lines li');
  const value = async (name: string) => Number((await rows.filter({ hasText: name }).locator('b').getAttribute('title'))!.replace(/[^0-9]/g, ''));
  const anthropic = await value('Anthropic');
  await rows.filter({ hasText: 'Anthropic' }).locator('button').click();
  await expect(page).toHaveURL(/pick=anthropic/);
  await page.mouse.move(2, 2);
  await expect(page.locator('.trace-line')).toHaveCount(1);
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', new RegExp(`${display(anthropic)} tokens$`));
  await expect.poll(async () => Number((await tile.getAttribute('title'))?.replace(/[^0-9]/g, '') ?? allPrompts)).toBeLessThan(allPrompts);
  // Rows keep their own totals, so a second can be added.
  expect(await value('Anthropic')).toBe(anthropic);
  const openai = await value('OpenAI');
  await rows.filter({ hasText: 'OpenAI' }).locator('button').click();
  await expect(page).toHaveURL(/pick=anthropic%2Copenai|pick=anthropic,openai/);
  await page.mouse.move(2, 2);
  await expect(page.locator('.trace-line')).toHaveCount(2);
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', new RegExp(`${display(anthropic + openai)} tokens$`));
  await page.reload();
  await expect(rows.filter({ hasText: 'OpenAI' }).locator('button')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page).not.toHaveURL(/pick=/);
});

test('the overview has no dropdowns for what a row can do, and other pages keep theirs', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exact dates' })).toHaveCount(0);
  await open(page, '?page=Threads');
  await expect(page.getByRole('combobox', { name: 'Project' })).toBeVisible();
  await open(page, '?page=Activity');
  await expect(page.locator('main')).not.toContainText('When work happened');
});

test('an unsupported preset is ignored and a window with only an end before history says so', async ({ page }) => {
  await open(page, '?range=constructor');
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', /tokens$/, { timeout: 30_000 });
  await open(page, '?until=2026-05-30T23:59:59.000Z');
  await expect(page.locator('.before-history')).toContainText('Before history', { timeout: 120_000 });
});

test('a backwards link edits correctly in the calendar', async ({ page }) => {
  await page.goto('/?page=Threads&since=2026-10-12T00:00:00.000Z&until=2026-10-10T00:00:00.000Z');
  await page.getByRole('button', { name: 'Exact dates' }).click();
  await page.getByLabel('To date').fill('2026-10-11');
  await expect.poll(() => new URL(page.url()).searchParams.get('until')).toMatch(/^2026-10-11/);
  const url = new URL(page.url());
  expect(url.searchParams.get('since')).toBe('2026-10-10T00:00:00.000Z');
});

test('tokens by type are parts of the total, and turns with parts but no total are named', async ({ page }) => {
  await open(page, '?range=30d');
  await expect(page.locator('.type-coverage')).toBeVisible();
  const total = Number((await page.locator('.tokens-hero strong').getAttribute('title'))!.replace(/[^0-9]/g, ''));
  const cached = Number((await page.locator('.type-legend li', { hasText: 'Cache read' }).locator('[title$="tokens"]').getAttribute('title'))!.replace(/[^0-9]/g, ''));
  expect(cached).toBeLessThanOrEqual(total);
  await expect(page.locator('.type-coverage')).toContainText('with parts but no total left out');
});

test('a filter does not turn a real zero into unknown', async ({ page }) => {
  await open(page, '?model=claude-sonnet-5-5&since=2026-10-04T00:00:00.000Z&until=2026-10-05T00:00:00.000Z');
  await expect(page.locator('.before-history')).toHaveCount(0);
  await expect(page.locator('.tokens-hero strong')).toHaveText('0');
  await expect(page.locator('.trace-empty')).toBeVisible();
});

test('time after the last capture is unknown, not a quiet hour', async ({ page }) => {
  await page.route('**/health/ready', (route) => route.fulfill({ json: { ready: true, collector: { state: 'idle', last_successful_sync_at: new Date(Date.now() - 11 * 3_600_000).toISOString() } } }));
  await open(page, '?range=1h');
  await expect(page.locator('.before-history')).toContainText('Not captured yet');
  await expect(page.locator('.tokens-hero strong')).toContainText('Not captured yet');
  await expect(page.getByRole('button', { name: 'Download this chart as CSV' })).toBeDisabled();
  await open(page, '?range=24h');
  await expect(page.locator('.trace-note')).toContainText('Captured up to');
});

test('past windows never read as not yet, and unknown windows do not count threads as zero', async ({ page }) => {
  await open(page, '?until=2026-05-01T00:00:00Z');
  await expect(page.locator('.before-history')).toContainText('Before history');
  await open(page, '?since=2000-01-01T00:00:00Z&until=2000-02-01T00:00:00Z');
  await expect(page.locator('.tokens-hero')).not.toContainText('0 main threads');
  await expect(page.locator('.ts-read')).toContainText('2000');
  await expect(page.locator('.ts')).toHaveAttribute('data-off-track', 'true');
});

test('date-only links work and nonsense is ignored', async ({ page }) => {
  await open(page, '?since=2026-10-10&until=2026-10-20');
  await expect(page.getByText('Query rejected')).toHaveCount(0);
  await expect(page.locator('.stats strong').first()).toHaveAttribute('title', /\d/);
  for (const q of ['?since=1', '?since=-271821-04-20T00:00:00.000Z', '?res=constructor', '?range=toString']) {
    await open(page, q);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.hero-chart h2')).not.toContainText('native code');
    await expect(page.getByText('could not render')).toHaveCount(0);
  }
});

test('pressing the slider without moving it changes nothing', async ({ page }) => {
  await open(page, '?range=24h');
  const hero = page.locator('.tokens-hero strong');
  await expect(hero).toHaveAttribute('title', /tokens$/);
  const before = await hero.getAttribute('title');
  const box = (await page.locator('.ts-rail').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  await expect(hero).toHaveAttribute('title', before!);
  await expect(page.locator('.ts-read')).toContainText('Last 24h');
  await page.mouse.up();
  await expect(page).toHaveURL(/range=24h/);
});

test('delegation follows a model filter', async ({ page }) => {
  await open(page, '?model=claude-sonnet-5-5&since=2026-10-10T00:00:00.000Z&until=2026-10-11T00:00:00.000Z');
  await expect(page.getByText('No delegation recorded here')).toBeVisible();
});

test('the calendar keeps the start of a preset when the end is set', async ({ page }) => {
  await open(page, '?page=Threads&range=7d');
  await page.getByRole('button', { name: 'Exact dates' }).click();
  const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('To date').fill(end);
  await expect.poll(() => new URL(page.url()).searchParams.get('since')).toBeTruthy();
});

test('a percentage is withheld when too few turns reported', async ({ page }) => {
  await open(page, '?since=2026-10-11T22:00:00.000Z&until=2026-10-12T21:59:59.999Z&by=provider');
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', /tokens$/);
  await expect(page.locator('.hero-delta')).toHaveCount(0);
  await expect(page.locator('.hero-nocompare')).toHaveText('not compared');
});

test('a bucket still in progress is shaded', async ({ page }) => {
  await open(page, '?range=7d&res=1d');
  await expect(page.locator('.trace-line').first()).toBeVisible();
  await expect(page.locator('.trace-part').first()).toBeAttached();
});

test.describe('chart controls on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('are all reachable without sideways scrolling', async ({ page }) => {
    await open(page, '?range=24h');
    const controls = page.locator('.chart-controls');
    await expect(controls).toBeVisible();
    const fits = await controls.evaluate((c) => c.scrollWidth <= c.clientWidth + 1);
    expect(fits).toBe(true);
  });
});

test('a window with only session-log tokens shows them, not an unknown total', async ({ page }) => {
  await open(page, '?since=2026-07-01T00:00:00.000Z&until=2026-08-01T00:00:00.000Z');
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', /tokens$/, { timeout: 60_000 });
  await expect(page.locator('.tokens-hero')).not.toContainText('No complete total');
  const shown = Number((await page.locator('.tokens-hero strong').getAttribute('title'))!.replace(/[^0-9]/g, ''));
  expect(shown).toBeGreaterThan(100_000_000);
});

test.describe('with touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('a second tap on the same point lets go of the reading', async ({ page }) => {
    await open(page, '?range=7d&res=1d');
    const trace = page.locator('.trace');
    await trace.scrollIntoViewIfNeeded();
    const box = (await trace.boundingBox())!;
    const at = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.locator('.trace-tip-pinned')).toHaveCount(1);
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.locator('.trace-tip')).toHaveCount(0);
  });
});

test('Overview and Agent Trees give the same delegation numbers for the same window', async ({ page }) => {
  test.slow();
  await open(page, '?range=7d');
  const panel = page.locator('dl', { hasText: 'Delegating threads' }).first();
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const read = async (dt: string) => (await panel.locator('div', { hasText: dt }).locator('dd').first().innerText()).trim();
  const trees = await read('Delegating threads');
  await page.goto('/?page=Agent+Trees&range=7d');
  await page.waitForLoadState('networkidle');
  const stat = page.locator('.stat', { hasText: 'Delegating threads' }).first();
  await expect(stat).toContainText(trees);
});

test('a row with tokens only from session logs says so', async ({ page }) => {
  await open(page, '?since=2026-06-13T00:00:00.000Z&until=2026-06-27T00:00:00.000Z');
  await expect(page.locator('.model-lines small', { hasText: 'session logs only' }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.model-lines li:not([data-idle]) small', { hasText: /· 0 turns/ })).toHaveCount(0);
});

test('the model ledger counts threads for every model, with no unloaded cells', async ({ page }) => {
  test.slow();
  await page.goto('/?page=Models&range=all');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main')).not.toContainText('Not loaded');
  await expect(page.locator('tbody [aria-label="Loading"]')).toHaveCount(0, { timeout: 30_000 });
});

test('z does nothing on pages with no time window', async ({ page }) => {
  for (const url of ['/?page=Search&q=the', '/?page=Quota+and+Resets', '/?page=Settings']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('z');
    await page.waitForTimeout(200);
    expect(new URL(page.url()).searchParams.get('range')).toBeNull();
  }
});

test('a resolution longer than the window is switched off', async ({ page }) => {
  await open(page, '?range=24h&res=1w');
  const group = page.getByRole('group', { name: 'Resolution' });
  await expect(group.getByRole('radio', { name: '1w', exact: true })).toBeChecked();
  await expect(page.locator('.res-note')).toBeVisible();
  await expect(page.locator('.hero-chart h2')).not.toContainText('per week');
  await open(page, '?range=24h');
  await expect(group.getByRole('radio', { name: '1w', exact: true })).toBeDisabled();
});

test('a pinned reading names turns with no model and adds up to the period it opens', async ({ page }) => {
  test.slow();
  await open(page, '?range=7d&res=1d');
  const box = (await page.locator('.trace').boundingBox())!;
  // Walk the days until one holds turns with no model, then open it.
  let found = false;
  for (let i = 0; i < 8 && !found; i++) {
    await page.mouse.click(box.x + 60 + ((box.width - 80) * i) / 7, box.y + 200);
    if (!(await page.locator('.trace-tip-pinned').count())) continue;
    // A day only partly in the window, or still running, opens wider than what the reading covers.
    const partial = /part|so far/.test(await page.locator('.trace-tip-head span').innerText());
    if (!partial && (await page.locator('.trace-tip-aside').count())) {
      found = true;
      const pinned = (await page.locator('.trace-tip-head b').innerText()).replace(/[≥\s]/g, '');
      await page.locator('.trace-tip-open').click();
      await expect(page).toHaveURL(/up=/);
      // The headline counts up to its new value, so it is read once it settles.
      await expect.poll(async () => (await page.locator('.tokens-hero strong').innerText()).replace(/[≥\s]|at least/g, ''), { timeout: 20_000 }).toBe(pinned);
    } else {
      await page.keyboard.press('Escape');
    }
  }
  test.skip(!found, 'No day in this week had turns with no model.');
});

test('Agent Trees says a future window is not yet known', async ({ page }) => {
  const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await page.goto(`/?page=Agent+Trees&since=${day}T00:00:00.000Z&until=${day}T23:59:59.999Z`);
  await expect(page.getByRole('heading', { name: 'Not yet' })).toBeVisible({ timeout: 30_000 });
});

test('Shift and an arrow carry the week along its framed track', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const bars = () => page.locator('.ts').evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue('--b')) - parseFloat((el as HTMLElement).style.getPropertyValue('--a')));
  const framed = await bars();
  await page.getByRole('slider', { name: 'Window end' }).focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page).toHaveURL(/zs=/);
  await expect(page.getByRole('button', { name: 'Show the whole history on the track' })).toBeVisible();
  expect(Math.abs((await bars()) - framed)).toBeLessThan(5);
});
