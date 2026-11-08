import { expect, test } from '@playwright/test';

// Frame rates measure the machine as much as the page, so this file runs in its own project, alone and after the
// journeys (playwright.config.ts). It uses the real browser clock: a faked clock also fakes requestAnimationFrame.
// Against the fixture the busiest delegating thread is always the same one.

/** Frames per second over three one-second samples after a short warm-up, keeping the middle one so one hiccup does not decide. */
const frameRate = () => new Promise<number>((done) => {
  const samples: number[] = [];
  let frames = 0;
  let start = 0;
  const warm = performance.now() + 300;
  const tick = (t: number) => {
    if (t < warm) return requestAnimationFrame(tick);
    if (!start) start = t;
    frames++;
    if (t - start >= 1000) {
      samples.push((frames * 1000) / (t - start));
      frames = 0;
      start = t;
      if (samples.length === 3) return done(samples.sort((a, b) => a - b)[1]);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

test('the busiest delegating thread plays smoothly', async ({ page, request }) => {
  test.setTimeout(180_000);
  const counts = new Map<string, number>();
  for (let offset = 0; ; offset += 500) {
    const res = await request.get(`/api/v1/agents?limit=500&offset=${offset}`);
    expect(res.ok(), 'agents responded').toBeTruthy();
    const rows = (await res.json()).data as { thread_id: string }[];
    for (const r of rows) counts.set(r.thread_id, (counts.get(r.thread_id) ?? 0) + 1);
    if (rows.length < 500) break;
  }
  const [busiest] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  test.skip(!busiest, 'No delegation is recorded here.');
  await page.goto(`/?page=Threads&id=${encodeURIComponent(busiest)}&story=1`);
  await expect(page.getByRole('button', { name: /Pause|Play/ })).toBeVisible({ timeout: 120_000 });
  expect(await page.locator('.story-hit').count()).toBeGreaterThan(1);
  expect(await page.evaluate(frameRate)).toBeGreaterThan(30);
});
