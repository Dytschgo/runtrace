import { expect, test, type Page } from '@playwright/test';

// Page totals must come from the whole window, not from whatever sample happened to load. These replace API responses.
const envelope = (data: unknown[]) => ({ data, capture_quality: 'partial', limit: 100, offset: 0, timezone: 'UTC', null_semantics: 'null means unavailable, never zero' });
const entity = (kind: string, id: string, occurred_at: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, source_id: id, kind, instance_id: 'local', project_id: 'p1', thread_id: '', run_id: '', occurred_at, capture_quality: 'partial', data, ...extra,
});

async function mockApi(page: Page, handler: (route: string, url: URL) => unknown | undefined) {
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const body = handler(url.pathname.replace('/api/v1/', ''), url);
    if (body === undefined) return r.fulfill({ status: 200, json: envelope([]) });
    if (typeof body === 'number') return r.fulfill({ status: body, json: { error: { code: 'x' } } });
    return r.fulfill({ status: 200, json: body });
  });
}

/** Serves a list the way the service pages it, with since and until applied. */
const paged = (rows: { occurred_at: string }[], url: URL) => {
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  const inside = rows.filter((r) => (!since || r.occurred_at >= since) && (!until || r.occurred_at <= until));
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  return envelope(inside.slice(offset, offset + limit));
};

test('the tool headline counts every call in the window, not the loaded sample', async ({ page }) => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await mockApi(page, (name, url) => {
    if (name === 'overview') return envelope([{ kind: 'tool', count: 250_000 }]);
    if (name === 'usage/tool-summary') return envelope([{ calls: 250_000, failed: 2_500, statusKnown: 250_000, p50: 120, p95: 900, timed: 250_000, shell: 100_000, exitKnown: 90_000, nonZero: 900 }]);
    if (name === 'usage/tool-hours') return envelope([{ hour: at.slice(0, 13) + ':00:00Z', completed: 247_500, cancelled: 0, failed: 2_500, running: 0, unknown: 0 }]);
    if (name === 'usage/tools') return envelope([{ name: 'shell', category: 'shell', calls: 250_000, failed: 2_500, statusKnown: 250_000, p50: 120, p95: 900, max: 5000, timed: 250_000, chars: 0 }]);
    if (name === 'tool-calls') {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return envelope(Array.from({ length: limit }, (_, i) => entity('tool', `t${offset + i}`, at, { tool_name: 'shell', tool_category: 'shell', status: 'completed', duration_ms: 5 })));
    }
  });
  await page.goto('/?page=Tool+Calls&range=7d');
  const stats = page.getByRole('region', { name: 'Tool call summary' }).or(page.locator('[aria-label="Tool call summary"]'));
  await expect(stats).toContainText('250,000');
  await expect(stats).toContainText('1.0%');
  await expect(stats).not.toContainText('loaded');
  // The chart and categories cover the whole window too.
  await page.getByRole('button', { name: 'Show as table' }).first().click();
  await expect(page.locator('table').first()).toContainText('247,500');
  await expect(page.getByRole('list', { name: 'Calls by category' }).or(page.locator('[aria-label="Calls by category"]'))).toContainText('250,000');
});

test('agent trees say nothing about threads outside an empty window', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'threads') return envelope([
      entity('thread', 'root', '2026-01-02T10:00:00Z', { title: 'Old root', thread_type: 'primary' }),
      entity('thread', 'kid', '2026-01-02T10:05:00Z', { title: 'Old kid', thread_type: 'child', parent_thread_id: 'root', relationship_to_parent: 'subagent' }),
      entity('thread', 'lone', '2026-01-03T10:00:00Z', { title: 'Old lone', thread_type: 'primary' }),
    ]);
    if (name === 'agents') return envelope([entity('agent', 'a1', '2026-01-02T10:05:00Z', { child_thread_id: 'kid', status: 'completed' }, { thread_id: 'root' })]);
  });
  await page.goto('/?page=Agent+Trees&range=7d');
  await expect(page.getByText('No threads ran in this view.')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('threads have no recorded sub-agents');
});

test('the event feed filters by kind on the service, so a page is full', async ({ page }) => {
  const kinds: (string | null)[] = [];
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await mockApi(page, (name, url) => {
    if (name === 'overview') return envelope([{ kind: 'tool', count: 25 }, { kind: 'prompt', count: 500 }]);
    if (name === 'timeline') {
      kinds.push(url.searchParams.get('kind'));
      const kind = url.searchParams.get('kind') ?? 'prompt';
      return envelope(Array.from({ length: 25 }, (_, i) => entity(kind, `${kind}${i}`, at, { tool_name: 'Read', content_redacted: 'hello' })));
    }
  });
  await page.goto('/?page=Activity&range=7d&kind=tool');
  await expect(page.locator('.feed li')).toHaveCount(25);
  await expect(page.locator('.feed li[data-kind="tool"]')).toHaveCount(25);
  expect(kinds).toContain('tool');
});

test('activity never counts more active days than the window holds', async ({ page }) => {
  const now = Date.now();
  await mockApi(page, (name) => {
    if (name === 'activity/hourly') return envelope(Array.from({ length: 8 }, (_, i) => ({ hour: new Date(Math.floor((now - i * 86_400_000) / 3_600_000) * 3_600_000).toISOString(), prompts: 2 })));
  });
  await page.goto('/?page=Activity&range=7d');
  const stat = page.locator('.stat').filter({ hasText: 'Active days' });
  await expect(stat).toBeVisible();
  const [active, span] = (await stat.locator('.stat-value').innerText()).split(' of ').map((s) => Number(s.replace(/\D/g, '')));
  expect(active).toBeLessThanOrEqual(span);
  await expect(page.getByText('Busiest hour of day')).toBeVisible();
  await expect(page.getByText('Busiest date')).toBeVisible();
});

test('threads add up the tokens used in the window, like the overview', async ({ page }) => {
  const day = (d: number, h = 10) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
  const turns = [
    entity('model_turn', 'u1', day(3), { total_tokens: 1_000_000, usage_status: 'complete' }, { thread_id: 'long' }),
    entity('model_turn', 'u2', day(4), { total_tokens: 500_000, usage_status: 'complete' }, { thread_id: 'new' }),
    entity('model_turn', 'u3', '2026-10-01T10:00:00.000Z', { total_tokens: 9_000_000, usage_status: 'complete' }, { thread_id: 'long' }),
    entity('model_turn', 'u4', day(5), { total_tokens: 250_000, usage_status: 'complete', usage_source: 'session_log' }),
  ];
  await mockApi(page, (name, url) => {
    if (name === 'threads') return envelope([
      entity('thread', 'long', '2026-09-30T10:00:00Z', { title: 'Started earlier', thread_type: 'primary' }),
      entity('thread', 'new', day(4), { title: 'Started here', thread_type: 'primary' }),
    ]);
    if (name === 'model-turns') return paged(turns, url);
  });
  await page.goto(`/?page=Threads&since=${day(1, 0)}&until=${day(6, 0)}`);
  const stat = page.locator('.stat').filter({ hasText: 'Tokens' });
  await expect(stat.locator('[title$="tokens"]').first()).toHaveAttribute('title', '1,750,000 tokens');
  await expect(stat).toContainText('from session logs');
  await expect(page.getByRole('cell', { name: 'Started earlier', exact: true })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Started earlier' });
  await expect(row.locator('[title$="tokens"]')).toHaveAttribute('title', '1,000,000 tokens');
});

test('projects show true zeros and lower bounds, never "Not loaded"', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'projects') return envelope([
      entity('project', 'p1', '2026-01-01T00:00:00Z', { name: 'Busy' }),
      entity('project', 'p2', '2026-01-01T00:00:00Z', { name: 'Quiet' }, { project_id: 'p2' }),
    ]);
    if (name === 'usage/projects') return envelope([{ dimension: 'project_id', identity: 'p1', observed_threads: 3, observed_prompts: 9, observed_answers: 9, observed_runs: 9, observed_provider_turns: 10, reported_turns: 8, observed_tool_calls: 4, observed_agents: 1, input_tokens: 900, output_tokens: 100, total_tokens: 1000 }]);
  });
  await page.goto('/?page=Projects&range=7d');
  await expect(page.getByRole('row').filter({ hasText: 'Busy' })).toContainText('≥');
  await expect(page.getByRole('row').filter({ hasText: 'Quiet' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Not loaded');
});

test('on a phone every navigation icon shows its name', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, () => undefined);
  await page.goto('/?page=Settings');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'Threads', exact: true })).toContainText('Threads');
  await expect(nav.getByRole('link', { name: 'Threads', exact: true }).locator('.nav-tip')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a quota window at 80% or more is marked on every page, and its pace is a labelled projection', async ({ page }) => {
  const now = Date.now();
  const reset = new Date(now + 3 * 3_600_000).toISOString();
  const quota = { provider: 'claude', window: 'five_hour', used_percentage: 85, remaining_percentage: 15, reset_at: reset, reset_passed: false, window_minutes: 300, sampled_at: new Date(now - 60_000).toISOString(), source: 'claude_usage_cache', plan: null };
  // Readings rising 20 points an hour, so a 5-hour window at 85% fills before its reset.
  const samples = [60, 45, 30, 15, 1].map((minutesAgo, i) => ({ provider: 'claude', window: 'five_hour', sampled_at: new Date(now - minutesAgo * 60_000).toISOString(), used_percentage: 65 + i * 5, reset_at: reset }));
  await mockApi(page, (name) => {
    if (name === 'quota/current') return envelope([quota]);
    if (name === 'quota/samples') return envelope(samples);
  });
  await page.goto('/?page=Activity');
  const link = page.getByRole('link', { name: 'Quota and Resets, a limit is nearly reached' });
  await expect(link).toBeVisible();
  await expect(link.locator('.nav-alert')).toHaveCount(1);
  await link.click();
  const card = page.locator('[aria-label="Claude Code quota"]');
  await expect(card.locator('.quota-window[data-high]')).toHaveCount(1);
  await expect(card.locator('.quota-pace')).toContainText('At this pace, full around');
  await expect(card.locator('.quota-pace')).toContainText('projection from 59m');
});

test('no warning when every window is below 80% or has reset', async ({ page }) => {
  const now = Date.now();
  await mockApi(page, (name) => {
    if (name === 'quota/current') return envelope([
      { provider: 'codex', window: 'weekly', used_percentage: 40, reset_at: new Date(now + 86_400_000).toISOString(), reset_passed: false, window_minutes: 10080, sampled_at: new Date(now).toISOString() },
      { provider: 'claude', window: 'five_hour', used_percentage: 95, reset_at: new Date(now - 60_000).toISOString(), reset_passed: true, window_minutes: 300, sampled_at: new Date(now - 7_200_000).toISOString() },
    ]);
  });
  await page.goto('/?page=Activity');
  await expect(page.getByRole('link', { name: 'Quota and Resets', exact: true })).toBeVisible();
  await expect(page.locator('.nav-alert')).toHaveCount(0);
});

test('a thread whose turns did not all report a total reads as a lower bound', async ({ page }) => {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const thread = entity('thread', 'th1', at(5), { title: 'Partly reported', thread_type: 'primary' }, { thread_id: 'th1' });
  const turns = [
    entity('model_turn', 'm1', at(4), { total_tokens: 1000, usage_status: 'complete', model: 'gpt-6.1-sol' }, { thread_id: 'th1' }),
    entity('model_turn', 'm2', at(3), { total_tokens: null, usage_status: 'unavailable', model: 'gpt-6.1-sol' }, { thread_id: 'th1' }),
  ];
  await mockApi(page, (name, url) => {
    if (name === 'threads') return paged([thread], url);
    if (name === 'model-turns') return paged(turns, url);
  });
  await page.goto('/?page=Threads&range=7d');
  const cell = page.locator('tbody tr', { hasText: 'Partly reported' }).locator('.cell-tokens');
  await expect(cell.locator('.lower-bound')).toHaveCount(1);
  await expect(cell).toContainText('1,000');
});

test('on a phone the quota warning shows in the top bar and the current page is scrolled into the nav', async ({ page }) => {
  const now = Date.now();
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, (name) => {
    if (name === 'quota/current') return envelope([{ provider: 'claude', window: 'five_hour', used_percentage: 90, reset_at: new Date(now + 3_600_000).toISOString(), reset_passed: false, window_minutes: 300, sampled_at: new Date(now).toISOString() }]);
  });
  await page.goto('/?page=Activity');
  const mini = page.getByRole('link', { name: 'A quota limit is nearly reached' });
  await expect(mini).toBeVisible();
  await mini.click();
  await expect(page.getByRole('heading', { name: 'Quota and Resets', level: 1 })).toBeVisible();
  const current = page.locator('.nav [aria-current="page"]');
  await expect.poll(() => current.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
});

test('a quota track whose window reset after its last reading says reset, not an old percentage', async ({ page }) => {
  const now = Date.now();
  const reset = new Date(now - 30 * 60_000).toISOString();
  const samples = [3, 2, 1].map((h, i) => ({ provider: 'claude', window: 'five_hour', sampled_at: new Date(now - h * 3_600_000).toISOString(), used_percentage: 40 + i * 10, reset_at: reset }));
  await mockApi(page, (name) => {
    if (name === 'quota/current') return envelope([{ provider: 'claude', window: 'five_hour', used_percentage: 60, reset_at: reset, reset_passed: true, window_minutes: 300, sampled_at: samples[2].sampled_at }]);
    if (name === 'quota/samples') return envelope(samples);
  });
  await page.goto('/?page=Quota+and+Resets');
  const last = page.locator('.quota-track-last').first();
  await expect(last).toHaveText('reset');
  await expect(page.locator('.quota-window[data-passed]')).toHaveCount(1);
});

test('a thread whose totals sum to 0 while other turns reported none is not an exact zero', async ({ page }) => {
  const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const thread = entity('thread', 'th0', at(5), { title: 'Zero with gaps', thread_type: 'primary' }, { thread_id: 'th0' });
  const turns = [
    entity('model_turn', 'z1', at(4), { total_tokens: 0, usage_status: 'complete', model: 'gpt-6.1-sol' }, { thread_id: 'th0' }),
    entity('model_turn', 'z2', at(3), { total_tokens: null, input_tokens: 18_000_000, usage_status: 'partial', model: 'gpt-6.1-sol' }, { thread_id: 'th0' }),
  ];
  await mockApi(page, (name, url) => {
    if (name === 'threads') return paged([thread], url);
    if (name === 'model-turns') return paged(turns, url);
  });
  await page.goto('/?page=Threads&range=7d');
  const cell = page.locator('tbody tr', { hasText: 'Zero with gaps' }).locator('.cell-tokens');
  await expect(cell).toContainText('No complete total');
  await expect(cell).not.toHaveText(/^0$/);
});
