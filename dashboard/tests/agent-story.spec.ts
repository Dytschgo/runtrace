import { expect, test, type Page } from '@playwright/test';

// The story of a thread, played back. Mocked journeys cover states real history cannot produce on demand;
// the live journey at the end runs against whatever the service holds and skips when nothing delegated.
const envelope = (data: unknown[]) => ({ data, capture_quality: 'partial', limit: 500, offset: 0, timezone: 'UTC', null_semantics: 'null means unavailable, never zero' });
const T0 = Date.parse('2026-11-05T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const row = (kind: string, id: string, thread: string, s: number, data: object) => ({ id, source_id: id, kind, instance_id: 'local', project_id: 'p', thread_id: thread, run_id: 'run-1', occurred_at: at(s), capture_quality: 'partial', data });

const THREADS = [
  row('thread', 'root', 'root', 0, { title: 'Ship the thing', thread_type: 'primary', model: 'gpt-x', root_thread_id: 'root', depth: 0 }),
  row('thread', 'kid', 'kid', 10, { title: 'Check the tests', thread_type: 'child', model: 'claude-y', relationship_to_parent: 'subagent', parent_thread_id: 'root', root_thread_id: 'root', depth: 1 }),
];
const AGENTS = [
  row('agent', 'a1', 'root', 10, { child_thread_id: 'kid', model: 'claude-y', status: 'failed', started_at: at(10), completed_at: at(40), result_returned_to_parent: null, content_redacted: '{"result":"Claude API rate limit reached.","task":"Check the tests\\nCarefully"}' }),
  row('agent', 'a2', 'root', 50, { child_thread_id: null, agent_type: 'provider_native_subagent', model: 'gpt-x', status: 'running', started_at: at(50), completed_at: null, result_returned_to_parent: null, content_redacted: '{"result":null,"task":"Inspect logs"}' }),
];
const ROOT_EVENTS = [
  row('answer', 'ans', 'root', 90, { content_redacted: 'All done.', model: 'gpt-x' }),
  row('tool', 't2', 'root', 60, { tool_name: 'command_execution', status: 'failed', exit_code: 1, content_redacted: '{"arguments":"npm test"}' }),
  row('tool', 't1', 'root', 30, { tool_name: 'read', status: 'completed' }),
  row('model_turn', 'mt', 'root', 5, { model: 'gpt-x', total_tokens: 1200, usage_status: 'complete' }),
  row('run', 'run-1', 'root', 5, { started_at: at(5), completed_at: at(95), requested_model: 'gpt-x', status: 'completed' }),
  ...AGENTS,
  row('prompt', 'p1', 'root', 0, { content_redacted: 'Please ship it' }),
  THREADS[0],
];
const KID_EVENTS = [row('answer', 'kans', 'kid', 38, { content_redacted: 'Tests are red.' }), row('tool', 'kt', 'kid', 20, { tool_name: 'read', status: 'completed' }), THREADS[1]];

async function mockApi(page: Page) {
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const name = url.pathname.replace('/api/v1/', '');
    const id = url.searchParams.get('id');
    let body: unknown[] = [];
    if (name === 'threads') body = id ? THREADS.filter((t) => t.source_id === id) : THREADS;
    else if (name === 'agents') body = id ? AGENTS.filter((a) => a.source_id === id) : AGENTS;
    else if (name === 'timeline') body = id === 'root' ? ROOT_EVENTS : id === 'kid' ? KID_EVENTS : [];
    else if (name === 'model-turns') body = [ROOT_EVENTS[3]];
    else if (name === 'overview') body = [{ kind: 'thread', count: 2 }];
    await r.fulfill({ status: 200, json: envelope(body) });
  });
}

test('a thread opens as a story with a real URL, plays, pauses into the URL and narrates what went wrong', async ({ page }) => {
  await mockApi(page);
  await page.goto('/?page=Threads');
  await page.getByRole('link', { name: 'Play the story of Ship the thing' }).click();
  await expect(page).toHaveURL(/page=Threads&id=root&story=1/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ship the thing');
  await expect(page.locator('.page-head p')).toContainText('1 prompt, 2 tool calls (1 failed), 2 sub-agents (1 did not finish cleanly)');
  // It plays by itself, then can be paused, and the pause lands in the URL so the moment can be linked.
  const pause = page.getByRole('button', { name: 'Pause' });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(page).toHaveURL(/&at=2026-11-05T10%3A/);
  // Jump to the end: everything has happened, with running totals that count only what was recorded.
  await page.locator('.story-scrub input').focus();
  await page.keyboard.press('End');
  const now = page.locator('.story-now');
  await expect(now.locator('.story-counts')).toContainText('1 failed');
  await expect(now).toContainText('Please ship it');
  await expect(now).toContainText('All done.');
  await expect(now.locator('[title="1,200 tokens from 1 provider turns with a complete total"]')).toHaveText('1,200');
  const log = page.locator('.story-log');
  await expect(log).toContainText('You asked “Please ship it”');
  await expect(log).toContainText('Delegated to claude-y: Check the tests');
  await expect(log).toContainText('claude-y failed after 30 s “Claude API rate limit reached.”');
  await expect(log).toContainText('command_execution failed with exit code 1 “npm test”');
  await expect(log).toContainText('gpt-x answered “All done.”');
  await expect(log).not.toContainText('read');
  // The open-ended native agent is a hatched stub, not an implied duration, and the gaps are named.
  await expect(page.locator('.story-lane-open')).toHaveCount(1);
  await expect(page.locator('.story-gaps')).toContainText('1 sub-agent has no recorded end');
  await expect(page.locator('.story-gaps')).toContainText('delivery of 2 results was not recorded');
  // A step back through the story moves the playhead to the previous narrated moment.
  await page.locator('.story-now h2').click();
  await expect(page.locator('.story-log .story-line').last()).toContainText('gpt-x answered');
  await page.keyboard.press('j');
  await expect(page.locator('.story-log .story-line').last()).toContainText('command_execution failed');
  await page.keyboard.press('j');
  await expect(page.locator('.story-log .story-line').last()).toContainText('Delegated to gpt-x: Inspect logs');
  await page.keyboard.press('j');
  await expect(page.locator('.story-log .story-line').last()).toContainText('claude-y failed after 30 s');
  await page.keyboard.press('k');
  await page.keyboard.press('k');
  await expect(page.locator('.story-log .story-line').last()).toContainText('command_execution failed');
});

test('lanes are keyboard reachable, a selected sub-agent reads its own thread, and its story can be played', async ({ page }) => {
  await mockApi(page);
  await page.goto('/?page=Threads&id=root&story=1&at=2026-11-05T10:01:35Z');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.locator('.story-hit').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(/&node=kid/);
  const detail = page.locator('.story-detail');
  await expect(detail).toContainText('Check the tests');
  await expect(detail.locator('.status')).toContainText('Failed');
  await expect(detail).toContainText('30 s');
  await expect(detail.locator('.unknown', { hasText: 'Not recorded' })).toBeVisible();
  await expect(detail).toContainText('1 tool call, 1 answer');
  await expect(detail).toContainText('Carefully');
  await expect(page.locator('.story-tools-child')).toHaveAttribute('d', /^M[\d.]+ [\d.]+v\d+$/);
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(/&node=agent%3Aa2/);
  await expect(detail.locator('.unknown', { hasText: 'No end recorded' })).toBeVisible();
  await expect(detail.locator('.unknown', { hasText: 'No thread' })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await detail.getByRole('link', { name: 'Play its story' }).click();
  await expect(page).toHaveURL(/id=kid&story=1/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check the tests');
});

test('reduced motion shows the finished story at once, and 390px fits without sideways scroll', async ({ page }) => {
  await mockApi(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=Threads&id=root&story=1');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect(page.locator('.story-scrub input')).toHaveValue('1000');
  await expect(page.locator('.story-log')).toContainText('gpt-x answered “All done.”');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  expect(await page.locator('.story-end-fail').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test('live: the busiest delegating thread plays smoothly', async ({ page, request }) => {
  test.setTimeout(180_000);
  const counts = new Map<string, number>();
  for (let offset = 0; ; offset += 500) {
    const res = await request.get(`/api/v1/agents?limit=500&offset=${offset}`);
    if (!res.ok()) test.skip(true, 'The service is not answering.');
    const rows = (await res.json()).data as { thread_id: string }[];
    for (const r of rows) counts.set(r.thread_id, (counts.get(r.thread_id) ?? 0) + 1);
    if (rows.length < 500) break;
  }
  const [busiest] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  test.skip(!busiest, 'No delegation is recorded here.');
  await page.goto(`/?page=Threads&id=${encodeURIComponent(busiest)}&story=1`);
  await expect(page.getByRole('button', { name: /Pause|Play/ })).toBeVisible({ timeout: 120_000 });
  const fps = await page.evaluate(() => new Promise<number>((res) => { let n = 0; const s = performance.now(); const f = () => { n++; if (performance.now() - s < 1500) requestAnimationFrame(f); else res(n / 1.5); }; requestAnimationFrame(f); }));
  expect(fps).toBeGreaterThan(30);
  expect(await page.locator('.story-hit').count()).toBeGreaterThan(1);
});
