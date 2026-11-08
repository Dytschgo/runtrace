import { type Page } from '@playwright/test';
import { expect, NOW, test } from './fixture';

// These journeys replace API responses in the browser, so they cover states that real history cannot produce on demand.
const envelope = (data: unknown[]) => ({ data, capture_quality: 'partial', limit: 100, offset: 0, timezone: 'UTC', null_semantics: 'null means unavailable, never zero' });

test('overview ranks all stored tools without downloading sampled content', async ({ page }) => {
  let sampledCalls = 0;
  let aggregateProject: string | null = null;
  await mockApi(page, (name, url) => {
    if (name === 'overview') return envelope([{ kind: 'prompt', count: 10 }, { kind: 'tool', count: 9000 }]);
    if (name === 'usage/tools') {
      aggregateProject = url.searchParams.get('project');
      return envelope([{ name: 'all-history-tool', category: 'shell', calls: 9000, failed: 0, statusKnown: 9000, p50: null, p95: null, max: null, timed: 0, chars: 0 }]);
    }
    if (name === 'tool-calls') { sampledCalls++; return envelope([]); }
  });
  await page.goto('/?project=p1');
  const panel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Most used tools' }) });
  await expect(panel).toContainText('all-history-tool');
  await expect(panel).toContainText('All matching stored calls');
  expect(aggregateProject).toBe('p1');
  expect(sampledCalls).toBe(0);
});

test('data quality shows incomplete backfill and scoped import errors', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'data-quality') return { ...envelope([{ kind: 'thread', capture_quality: 'partial', count: 1 }]), checkpoints: [], project_checkpoints: [], missing_thread_relationships: 3, import_reports: [{ project_errors: [{ project_id: 'synthetic-project', error_category: 'source_schema_mismatch' }] }] };
  });
  await page.route('**/health/ready', (route) => route.fulfill({ json: { ready: true, collector: { state: 'partial' } } }));
  await page.goto('/?page=Data+Quality');
  const panel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Collection coverage' }) });
  await expect(panel).toContainText('No complete instance sync has finished');
  await expect(panel).toContainText('synthetic-project');
  await expect(panel).toContainText('source_schema_mismatch');
  await expect(panel).toContainText('partial');
});

async function mockApi(page: Page, handler: (route: string, url: URL) => unknown | undefined) {
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const name = url.pathname.replace('/api/v1/', '');
    const body = handler(name, url);
    if (body === undefined) return r.fulfill({ status: 200, json: envelope([]) });
    if (body === 'abort') return r.abort('connectionrefused');
    if (typeof body === 'number') return r.fulfill({ status: body, json: { error: { code: 'x' } } });
    return r.fulfill({ status: 200, json: body });
  });
}

test('service down shows recovery, and Retry brings data back', async ({ page }) => {
  let down = true;
  await mockApi(page, (name) => {
    if (down) return 'abort';
    if (name === 'overview') return envelope([{ kind: 'prompt', count: 1234 }]);
    return undefined;
  });
  await page.goto('/?range=all');
  const alert = page.getByRole('alert').filter({ hasText: 'Analytics service unreachable' }).first();
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('t3ui serve');
  // Navigation stays usable while the service is away.
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  down = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.stats strong').first()).toHaveText('1,234');
});

test('one failed panel leaves the rest of the page working', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'overview') return envelope([{ kind: 'prompt', count: 7 }]);
    if (name === 'models') return 500;
    return undefined;
  });
  await page.goto('/?range=all');
  await expect(page.locator('.stats strong').first()).toHaveText('7');
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load this view' }).first()).toBeVisible();
});

test('rejected filters are explained, not shown as an empty result', async ({ page }) => {
  await mockApi(page, () => 400);
  await page.goto('/?since=not-a-date');
  await expect(page.getByRole('alert').filter({ hasText: 'Query rejected' }).first()).toBeVisible();
});

test('an empty database invites an import and invents no numbers', async ({ page }) => {
  await mockApi(page, (name) => (name === 'storage' ? { rows: [], events: 0 } : undefined));
  await page.goto('/?range=all');
  await expect(page.getByRole('heading', { name: 'No imported history in this view' })).toBeVisible();
  await expect(page.getByText('t3ui import --all')).toBeVisible();
  await expect(page.locator('.stats strong').first()).toHaveText('0');
  for (const [name, text] of [['Threads', 'No records match'], ['Agent Trees', 'No delegation recorded in this view'], ['Tool Calls', 'No records match'], ['Activity', 'No records match'], ['Models', 'No records match']]) {
    await page.goto(`/?page=${encodeURIComponent(name)}`);
    await expect(page.getByRole('heading', { name: text }).first()).toBeVisible();
  }
});

test('a slow response shows a labelled skeleton first', async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/v1/overview**', async (r) => { await gate; await r.fulfill({ status: 200, json: envelope([{ kind: 'prompt', count: 3 }]) }); });
  await page.goto('/?range=all');
  await expect(page.getByRole('status', { name: 'Loading Prompts' })).toBeVisible();
  release();
  await expect(page.locator('.stats strong').first()).toHaveText('3');
});

test('richer optional data appears without a frontend change', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'models') return envelope([{ model: 'm-1', observed_runs: 2, calls: 5, input_tokens: 1000, output_tokens: 200, total_tokens: 1200, capture_quality: 'partial' }]);
    if (name === 'overview') return envelope([{ kind: 'run', count: 2 }]);
    if (name === 'quota/current') return envelope([{ provider: 'codex', remaining_percentage: 42, sampled_at: new Date(NOW - 600_000).toISOString(), reset_at: new Date(NOW + 86_400_000).toISOString(), capture_quality: 'complete' }]);
    if (name === 'quota/windows') return envelope([{ provider: 'codex', unused_percentage_before_reset: 20, reset_at: '2026-11-05T12:00:00Z', capture_quality: 'partial' }]);
    return undefined;
  });
  await page.goto('/?page=Models');
  await expect(page.getByRole('columnheader', { name: 'Input', exact: true })).toBeVisible();
  await expect(page.locator('tbody')).toContainText('1,000');
  await page.goto('/?range=all');
  await expect(page.locator('.tokens-hero')).toContainText('1,200');
  await expect(page.locator('.gaps')).not.toContainText('Tokens');
  await expect(page.locator('.gaps')).not.toContainText('Model calls');
  await page.goto('/?page=Quota+and+Resets');
  await expect(page.getByText('42.0%')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No quota snapshots collected' })).toBeHidden();
  await expect(page.getByRole('cell', { name: '20.0%' })).toBeVisible();
  await expect(page.locator('[aria-label="Codex quota"]')).toBeVisible();
});

const MODEL_ROWS = [
  { model: 'gpt-x', observed_runs: 10, observed_provider_turns: 12, calls: null, input_tokens: 9000, cached_input_tokens: 8100, output_tokens: 500, reasoning_tokens: 100, total_tokens: 9500, turns_with_usage: 12, complete_usage_turns: 10, median_latency_ms: 2000, p95_latency_ms: 9000 },
  { model: 'grok-4.7', observed_runs: 3, observed_provider_turns: 3, calls: null, input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null, total_tokens: null, turns_with_usage: 0, complete_usage_turns: 0, median_latency_ms: 4000, p95_latency_ms: 5000 },
];

test('models show verified tokens, name those without usage, and never count turns as calls', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'models') return envelope(MODEL_ROWS);
    if (name === 'overview') return envelope([{ kind: 'run', count: 13 }, { kind: 'model_turn', count: 15 }]);
    return undefined;
  });
  await page.goto('/?page=Models');
  await expect(page.getByRole('columnheader', { name: 'Input', exact: true })).toBeVisible();
  const grok = page.locator('tbody tr', { hasText: 'grok-4.7' });
  await expect(grok.locator('.unknown').first()).toBeVisible();
  await expect(grok).toContainText('None reported usage');
  await expect(grok).toContainText('4.0 s');
  const gpt = page.locator('tbody tr', { hasText: 'gpt-x' });
  await expect(gpt).toContainText('9,500');
  await expect(gpt).toContainText('90%');
  await expect(gpt).toContainText('12 reported, 10 in full');
  // Calls are null for every model: stated once, and turns never appear under that heading.
  await expect(page.getByRole('columnheader', { name: 'Model calls' })).toBeHidden();
  await expect(page.locator('.table-gap')).toContainText('Model calls');
  await expect(page.locator('.tokens-none')).toContainText('grok-4.7');
});

test('the backend without provider turns still renders every model', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'models') return envelope([{ model: 'old', observed_runs: 4, calls: null, input_tokens: null, output_tokens: null, capture_quality: 'partial' }]);
    if (name === 'overview') return envelope([{ kind: 'run', count: 4 }]);
    return undefined;
  });
  await page.goto('/?page=Models');
  await expect(page.locator('tbody')).toContainText('old');
  await expect(page.locator('.table-gap')).toContainText('Input');
  await page.goto('/?range=all');
  await expect(page.locator('.stats')).not.toContainText('Provider turns');
  await expect(page.locator('.gaps')).toContainText('Complete token total');
});

test('storage degrades to record counts when its heavier query fails', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'storage') return 400;
    if (name === 'overview') return envelope([{ kind: 'tool', count: 34610 }, { kind: 'prompt', count: 1870 }]);
    return undefined;
  });
  await page.goto('/?page=Storage');
  await expect(page.getByRole('alert').filter({ hasText: 'Query rejected' })).toBeVisible();
  await expect(page.locator('.ranked')).toContainText('34,610');
  await expect(page.locator('.stat', { hasText: 'Database size' }).locator('.unknown')).toBeVisible();
});

test('storage shows the sizes the service reports', async ({ page }) => {
  await mockApi(page, (name) => (name === 'storage'
    ? { rows: [{ table: 'tool', rows: 10 }], events: 20, duckdb_bytes: 5_242_880, redacted_content_characters: 2_500_000, normalized_json_characters: 9_000_000, oldest_at: '2026-10-03T10:00:00Z', newest_at: '2026-11-06T10:00:00Z', capture_source: 't3_sqlite_v2' }
    : undefined));
  await page.goto('/?page=Storage');
  await expect(page.locator('.stat', { hasText: 'Database size' })).toContainText('5.0 MB');
  await expect(page.locator('.stat', { hasText: 'Redacted text' })).toContainText('2.5M chars');
  await expect(page.getByText('3 Oct 2026')).toBeVisible();
});

test('projects use the usage aggregate and fall back when it fails', async ({ page }) => {
  const project = { id: 'x', source_id: 'p1', kind: 'project', instance_id: 'local', project_id: 'p1', thread_id: '', run_id: '', occurred_at: '2026-11-05T10:00:00Z', data: { name: 'alpha', git_remote_alias: 'github.com/acme/alpha' } };
  const other = { ...project, id: 'y', source_id: 'p2', project_id: 'p2', data: { name: 'beta' } };
  let usageWorks = true;
  await mockApi(page, (name, url) => {
    if (name === 'projects') return envelope([project, other]);
    if (name === 'usage/projects') return usageWorks ? envelope([{ identity: 'p1', dimension: 'project_id', observed_prompts: 7, observed_answers: 1, observed_runs: 2, observed_provider_turns: 3, observed_tool_calls: 4, observed_agents: 5, input_tokens: 100, output_tokens: 10, total_tokens: 110, capture_quality: 'partial' }]) : 400;
    if (name === 'overview') return envelope(url.searchParams.get('project') === 'p1' ? [{ kind: 'prompt', count: 7 }, { kind: 'thread', count: 9 }] : [{ kind: 'prompt', count: 1 }]);
    return undefined;
  });
  await page.goto('/?page=Projects');
  const alpha = page.locator('tbody tr', { hasText: 'alpha' });
  await expect(alpha).toContainText('110');
  await expect(alpha).toContainText('github.com/acme/alpha');
  usageWorks = false;
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: 'alpha' })).toContainText('7');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('agent tree reports a missing parent without inventing a node', async ({ page }) => {
  const thread = (id: string, data: object) => ({ id, source_id: id, kind: 'thread', instance_id: 'local', project_id: 'p', thread_id: id, run_id: '', occurred_at: '2026-11-05T10:00:00Z', capture_quality: 'partial', data: { title: id, ...data } });
  const agent = { id: 'a', source_id: 'a', kind: 'agent', instance_id: 'local', project_id: 'p', thread_id: 'root', run_id: 'r', occurred_at: '2026-11-05T10:00:00Z', capture_quality: 'partial', data: { child_thread_id: 'kid', status: 'running', started_at: '2026-11-05T10:00:00Z', completed_at: null, result_returned_to_parent: null } };
  await mockApi(page, (name) => {
    if (name === 'threads') return envelope([thread('root', {}), thread('kid', { relationship_to_parent: 'subagent', parent_thread_id: 'root' }), thread('orphan', { relationship_to_parent: 'subagent', parent_thread_id: 'gone' }), thread('fork', { relationship_to_parent: 'fork', parent_thread_id: 'root' })]);
    if (name === 'agents') return envelope([agent]);
    return undefined;
  });
  await page.goto('/?page=Agent+Trees');
  await expect(page.getByRole('status').filter({ hasText: 'recorded parents are not imported' })).toBeVisible();
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  await expect(page.getByRole('treeitem', { level: 2 })).toContainText('kid');
  await expect(page.getByRole('treeitem', { level: 2 })).toContainText('No end');
  await expect(page.getByRole('tree')).not.toContainText('gone');
  await expect(page.getByRole('tree')).not.toContainText('fork');
});

test('reduced motion stops skeleton and spinner animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/v1/overview**', async (r) => { await gate; await r.fulfill({ status: 200, json: envelope([]) }); });
  await page.goto('/?range=all');
  const skeleton = page.getByRole('status', { name: 'Loading Prompts' });
  await expect(skeleton).toBeVisible();
  expect(await skeleton.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  release();
});

test('the display timezone setting persists and changes the buckets', async ({ page }) => {
  await mockApi(page, (name) => {
    if (name === 'activity/hourly') return envelope([{ hour: '2026-11-02T23:00:00Z', prompts: 5 }]);
    if (name === 'overview') return envelope([{ kind: 'prompt', count: 5 }]);
    return undefined;
  });
  await page.goto('/?page=Activity');
  await expect(page.locator('.stat', { hasText: 'Busiest hour of day' }).locator('.stat-value')).toHaveText('00:00');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Display timezone' }).selectOption('UTC');
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.locator('.stat', { hasText: 'Busiest hour of day' }).locator('.stat-value')).toHaveText('23:00');
  await page.reload();
  await expect(page.locator('.stat', { hasText: 'Busiest hour of day' }).locator('.stat-value')).toHaveText('23:00');
});


test('partial-only models explain totals and retain recorded cache fields', async ({page}) => {
  await mockApi(page,(name) => {
    if(name==='models') return envelope([
      {model:'partial-model',observed_runs:2,observed_provider_turns:3,calls:null,input_tokens:100,output_tokens:10,total_tokens:null,cache_write_tokens:0,cache_write_observed_turns:2,turns_with_usage:2,complete_usage_turns:0},
      {model:'never-ran',observed_runs:0,observed_provider_turns:0,calls:null,input_tokens:null,output_tokens:null,total_tokens:null,cache_write_tokens:null,cache_write_observed_turns:0,turns_with_usage:0,complete_usage_turns:0}
    ]);
    return undefined;
  });
  await page.goto('/?page=Models');
  const row=page.locator('tbody tr',{hasText:'partial-model'}).first();
  await expect(row.locator('.token-cell .unknown')).toHaveAttribute('title','Total is only computed for turns with complete usage.');
  await expect(row).not.toContainText('None reported usage');
  await expect(row).toContainText('2 of 3 recorded');
  await expect(page.locator('tbody tr',{hasText:'never-ran'}).first()).not.toContainText('0 of 0');
  await expect(page.locator('.tokens-hero .unknown')).toBeVisible();
  await expect(page.getByText('Total covers only turns with complete usage, so input can exceed it.',{exact:true})).toBeVisible();
  await expect(page.getByText('No complete token totals. Partial token fields are shown in the ledger.',{exact:true})).toBeVisible();
  await expect(page.getByText('Most requested',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Model summary')).toContainText('of runs');
});


test('cache-only usage keeps turn controls and explains the missing complete total', async ({page}) => {
  await mockApi(page,(name) => {
    if(name==='models') return envelope([{model:'cache-only',observed_runs:1,observed_provider_turns:1,calls:null,input_tokens:null,output_tokens:null,total_tokens:null,cache_write_tokens:0,cache_write_observed_turns:1,turns_with_usage:1,complete_usage_turns:0}]);
    if(name==='overview') return envelope([{kind:'model_turn',count:1}]);
    return undefined;
  });
  await page.goto('/?page=Models');
  await expect(page.getByRole('radio',{name:'Turns',exact:true})).toBeVisible();
  await expect(page.getByText('No complete token totals. Partial token fields are shown in the ledger.',{exact:true})).toBeVisible();
  await page.goto('/?range=all');
  await expect(page.locator('.gaps')).toContainText('Complete token total');
  await expect(page.locator('.gaps .unknown[title="No complete provider-turn total is recorded in this view."]')).toBeVisible();
  await expect(page.locator('.gaps')).not.toContainText('No provider turn in this view reported usage');
});
