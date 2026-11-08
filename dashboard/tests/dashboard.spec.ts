import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext } from '@playwright/test';
import { expect, FIXTURE, fixtureOnly, test } from './fixture';

// These journeys run against the fixture history (tests/fixture.ts), or a live service. Numbers are compared with the API.
const api = async (request: APIRequestContext, route: string) => {
  const res = await request.get(`/api/v1/${route}`);
  expect(res.ok(), `${route} responded`).toBeTruthy();
  return res.json();
};
interface Row { source_id: string; thread_id: string; data: Record<string, string | null> }
const scanAll = async (request: APIRequestContext, route: string) => {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = (await api(request, `${route}?limit=500&offset=${offset}`)).data as Row[];
    rows.push(...page);
    if (page.length < 500) return rows;
  }
};
const countOf = (rows: { kind: string; count: number }[], kind: string) => rows.find((r) => r.kind === kind)?.count ?? 0;
const display = (n: number) => n.toLocaleString('en-US');

test('real history project and thread drilldown', async ({ page, request }) => {
  await page.goto('/?range=all');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.locator('.stats')).toContainText('Prompts');

  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page).toHaveURL(/page=Projects/);
  await expect(page.locator('tbody')).toContainText(FIXTURE.project);

  await page.locator('.row-link').first().click();
  await expect(page.getByRole('heading', { name: 'Threads', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/project=/);
  // Select a primary thread with captured conversation evidence. New primary
  // threads can still be running, so type alone does not prove a conversation.
  const project = new URL(page.url()).searchParams.get('project')!;
  const primary = ((await api(request, `threads?project=${encodeURIComponent(project)}&limit=500`)).data as Row[]).filter((t) => t.data.thread_type === 'primary');
  let chosen: Row | undefined;
  for (const candidate of primary) {
    const events = (await api(request, `timeline?id=${encodeURIComponent(candidate.source_id)}&limit=500`)).data as Row[];
    if (events.some((e) => ['prompt','answer'].includes((e as Row & {kind:string}).kind))) { chosen = candidate; break; }
  }
  expect(chosen, 'a primary conversation is captured in the selected project').toBeDefined();
  await page.getByRole('radio', { name: 'Primary' }).check({ force: true });
  await expect(page).toHaveURL(/type=primary/);
  const title = String(chosen!.data.title);
  await page.getByRole('searchbox', {name:'Filter threads by title or branch'}).fill(title);
  const thread = page.locator(`.row-link[href*="id=${encodeURIComponent(chosen!.source_id)}"]`).first();
  await thread.click();
  await expect(page.getByRole('heading', { name: 'Thread timeline' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  await expect(page.locator('.timeline .tl').first()).toBeVisible();

  await page.getByRole('link', { name: 'Agent Trees', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent Trees', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Data Quality', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Data Quality', level: 1 })).toBeVisible();

  // Filters survive the journey, and history returns to the previous page.
  await expect(page).toHaveURL(/project=/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Agent Trees', level: 1 })).toBeVisible();
});

test('verified tokens match the API and cover the models that report them', async ({ page, request }) => {
  const models = (await api(request, 'models')).data as { model: string | null; total_tokens?: number | null; turns_with_usage?: number; observed_provider_turns?: number }[];
  const total = models.reduce((s, m) => s + (m.total_tokens ?? 0), 0);
  test.skip(total === 0, 'This service reports no tokens.');
  await page.goto('/?range=all');
  await expect(page.locator('.tokens-hero strong')).toHaveAttribute('title', new RegExp(`${display(total)} tokens$`));
  await expect(page.locator('.gaps')).not.toContainText('Tokens');
  for (const m of models.filter((r) => r.model && (r.observed_provider_turns ?? 0) > 0 && !r.turns_with_usage)) {
    await expect(page.locator('.model-lines li', { hasText: m.model! }).locator('.unknown').first()).toBeVisible();
  }
  await page.goto('/?page=Models&range=all');
  await expect(page.locator('.table-gap')).toContainText('Model calls');
  const named = models.find((m) => m.model && m.total_tokens);
  await expect(page.locator('tbody tr', { hasText: named!.model! }).first().locator('[title$="tokens"]').first()).toHaveAttribute('title', `${display(named!.total_tokens!)} tokens`);
});

test('dashboard screenshot and narrow layout', async ({ page, request }) => {
  const overview = await api(request, 'overview');
  await page.goto('/?range=all');
  const prompts = countOf(overview.data, 'prompt');
  expect(prompts, 'imported history is present').toBeGreaterThan(0);
  await expect(page.locator('.stats strong').first()).toHaveAttribute('title', display(prompts));
  await expect(page.locator('.stats strong').last()).toHaveAttribute('title', display(countOf(overview.data, 'tool')));
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'test-results/overview.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('unsupported quota is explicit', async ({ page }) => {
  // No quota is ever collected here, which the history cannot show once readings exist, so the quota reads are empty.
  await page.route('**/api/v1/quota/**', (route) => route.fulfill({ json: { data: [], capture_quality: 'partial', limit: 100, offset: 0, timezone: 'UTC', null_semantics: 'null means unavailable, never zero' } }));
  await page.goto('/?page=Quota+and+Resets');
  await expect(page.getByRole('heading', { name: 'No quota snapshots collected' })).toBeVisible();
  await expect(page.getByText('No agent has reported its limits yet', { exact: false })).toBeVisible();
});

test('filters live in the URL, reach the API and survive reload', async ({ page, request }) => {
  const projects = await api(request, 'projects?limit=1');
  const project = projects.data[0].source_id;
  const scoped = await api(request, `overview?project=${encodeURIComponent(project)}`);

  await page.goto(`/?range=all&project=${encodeURIComponent(project)}`);
  await expect(page.locator('.scope-chip').first()).toBeVisible();
  await expect(page.locator('.stats strong').first()).toHaveAttribute('title', display(countOf(scoped.data, 'prompt')));

  await page.getByRole('radio', { name: '7d' }).check({ force: true });
  await expect(page).toHaveURL(/range=7d/);
  await page.reload();
  await expect(page.getByRole('radio', { name: '7d' })).toBeChecked();
  await expect(page.locator('.scope-chip').first()).toBeVisible();

  // Clear takes away the scope and keeps the time chosen. A second Clear puts the time back to the default.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page).not.toHaveURL(/project=/);
  await expect(page).toHaveURL(/range=7d/);
  await page.getByRole('radio', { name: 'All' }).check({ force: true });
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page).not.toHaveURL(/range=/);
});

test('threads paginate, sort and filter through the URL', async ({ page, request }) => {
  const overview = await api(request, 'overview');
  const total = countOf(overview.data, 'thread');
  test.skip(total <= 25, 'Needs more than one page of threads.');

  await page.goto('/?page=Threads');
  await expect(page.locator('.pager-range')).toHaveText(/^1–25 of [0-9,]+$/);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/offset=25/);
  await expect(page.locator('.pager-range')).toHaveText(new RegExp(`^26–.* of [0-9,]+$`));
  await page.reload();
  await expect(page.locator('.pager-range')).toHaveText(new RegExp(`^26–.* of [0-9,]+$`));

  await page.getByRole('button', { name: 'Thread', exact: true }).click();
  await expect(page).toHaveURL(/sort=title/);
  await expect(page.getByRole('columnheader', { name: 'Thread' })).toHaveAttribute('aria-sort', /ending/);

  const firstTitle = (await page.locator('.cell-title .row-link').first().innerText()).trim();
  await page.getByRole('searchbox', { name: 'Filter threads by title or branch' }).fill(firstTitle);
  await expect(page).toHaveURL(/tq=/);
  await expect(page.locator('tbody tr').first()).toContainText(firstTitle);
});

test('agent graph draws only edges present in the API', async ({ page, request }) => {
  const agents = await scanAll(request, 'agents');
  const threads = await scanAll(request, 'threads');
  const ids = new Set(threads.map((t) => t.source_id));
  // Mirrors the rule under test: an agent's child link, then explicit subagent lineage. Nothing else is an edge.
  const parents = new Map<string, string>();
  for (const a of agents) if (a.thread_id) parents.set(a.data.child_thread_id ?? `agent:${a.source_id}`, a.thread_id);
  for (const t of threads) if (t.data.relationship_to_parent === 'subagent' && t.data.parent_thread_id && !parents.has(t.source_id)) parents.set(t.source_id, t.data.parent_thread_id);
  const edges = [...parents].filter(([, parent]) => ids.has(parent));
  test.skip(edges.length === 0, 'No delegation in this database.');

  await page.goto('/?page=Agent+Trees&range=all');
  await expect(page.getByRole('tree')).toBeVisible();
  // Every sub-agent in view is one recorded edge; trees with no known start time are the only ones left out.
  const summary = page.locator('.stat', { hasText: 'Sub-agents' });
  const shown = Number((await summary.locator('.stat-value').innerText()).replace(/\D/g, ''));
  expect(shown).toBeGreaterThan(0);
  // Each delegation record counts, a repeat delegation to the same child included, plus children known only from thread lineage.
  const childOfAgent = new Set(agents.map((a) => a.data.child_thread_id).filter(Boolean));
  const lineageOnly = threads.filter((t) => t.data.relationship_to_parent === 'subagent' && t.data.parent_thread_id && !childOfAgent.has(t.source_id)).length;
  expect(shown).toBeLessThanOrEqual(agents.length + lineageOnly);

  // Every direct child in the rendered tree must be a recorded child of the selected root.
  const rootLink = page.locator('.row-link[aria-current="true"]');
  const rootTitle = (await rootLink.innerText()).trim();
  const root = threads.find((t) => t.data.title === rootTitle);
  expect(root, `selected root "${rootTitle}" exists in the API`).toBeTruthy();
  const children = page.getByRole('treeitem', { level: 2 });
  expect(await children.count()).toBe(edges.filter(([, parent]) => parent === root!.source_id).length);

  // Keyboard: one tab stop, arrows move, Enter selects.
  await page.getByRole('treeitem', { level: 1 }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(children.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(children.first()).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/node=/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('treeitem', { level: 1 })).toBeFocused();
});

test('tool calls open in a dialog that can be linked and dismissed', async ({ page }) => {
  await page.goto('/?page=Tool+Calls');
  const call = page.locator('.data-table').last().locator('tbody .row-link').first();
  await call.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/call=/);
  await expect(dialog.getByRole('term').filter({ hasText: 'Started' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/call=/);
  await expect(call).toBeFocused();
});

test('search finds redacted content and highlights the match', async ({ page, request }) => {
  const timeline = await api(request, 'search?q=the&limit=1');
  test.skip(!timeline.data.length, 'No searchable content.');
  await page.goto('/?range=all');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search captured content' })).toBeFocused();
  await page.keyboard.type('the');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/q=the/);
  await expect(page.locator('mark').first()).toBeVisible();
});

test('keyboard shortcuts navigate and move focus to the page heading', async ({ page }) => {
  await page.goto('/?range=all');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  const heading = page.getByRole('heading', { name: 'Models', level: 1 });
  await expect(heading).toBeFocused();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
});

for (const name of ['Overview', 'Activity', 'Models', 'Projects', 'Threads', 'Agent Trees', 'Tool Calls', 'Quota and Resets', 'Storage', 'Data Quality', 'Settings']) {
  test(`${name}: accessible, and no overflow at 390px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // A rejected aggregate or large scan page has a tested fallback, so only those responses are tolerated here.
    page.on('console', (m) => { if (m.type() === 'error' && !(m.text().includes('400') && /\/api\/v1\/(usage\/|storage|tool-calls|agents|timeline)/.test(m.location().url))) errors.push(`${m.text()} ${m.location().url}`); });
    const external: string[] = [];
    page.on('request', (r) => { if (!r.url().startsWith(new URL(page.url() === 'about:blank' ? 'http://127.0.0.1' : page.url()).origin) && !r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?page=${encodeURIComponent(name)}`);
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => {
      if (document.documentElement.scrollWidth <= innerWidth) return null;
      const wide = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('.table-scroll, .nav'));
      return `${document.documentElement.scrollWidth}px: ${wide.slice(0, 4).map((el) => `${el.tagName}.${el.className}`).join(', ')}`;
    });
    expect(overflow, 'no page-level sideways scroll').toBeNull();
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');

    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
    const wide = await new AxeBuilder({ page }).analyze();
    expect(wide.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);

    expect(errors).toEqual([]);
    expect(external, 'no remote requests').toEqual([]);
  });
}
