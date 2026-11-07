// Pointer and state checks the contract checker does not cover. Usage: node qa.mjs [letters]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const ids = (process.argv[2] || 'ABCDEFGHIJ').split('');
const b = await chromium.launch({ headless: true });
for (const id of ids) {
  const r = { id };
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(pathToFileURL(path.join(root, `concept-${id}.html`)).href, { waitUntil: 'load' });
  await p.waitForTimeout(2400);
  const read = () => p.evaluate(() => [...document.querySelectorAll('[data-readout]')].map((e) => (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 8)).join('|'));
  const before = await read();

  // Hover: another model's row or chart should visibly change.
  const shot0 = await p.screenshot();
  const row = p.locator('[data-model="claude-opus-5-5"]').first();
  await row.hover({ force: true }).catch((e) => { r.hoverErr = e.message.slice(0, 60); });
  await p.waitForTimeout(500);
  const shot1 = await p.screenshot();
  r.hoverChangesPage = !shot0.equals(shot1);
  await p.mouse.move(2, 2);
  await p.waitForTimeout(300);

  // Pointer drag on the first handle. A circular slider gets moved along the ring.
  const h = p.locator('[data-time-slider]').first();
  const box = await h.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await p.mouse.move(cx, cy);
    await p.mouse.down();
    const dest = id === 'B' ? [[cx - 150, cy - 150], [cx - 190, cy - 260]] : [[cx + 120, cy], [cx + 320, cy]];
    for (const [x, y] of dest) { await p.mouse.move(x, y, { steps: 8 }); await p.waitForTimeout(80); }
    await p.mouse.up();
    await p.waitForTimeout(1200);
    const after = await read();
    r.dragChanges = after !== before;
    r.after = after;
  } else r.dragChanges = 'no handle box';

  // Narrow window: pull the first handle far to the right with the keyboard.
  await h.focus().catch(() => {});
  for (let i = 0; i < 40; i++) await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(1300);
  r.narrow = await read();
  r.overflow = await p.evaluate(() => [...document.body.querySelectorAll('*')].filter((e) => !e.closest('svg') && !e.closest('[aria-hidden="true"]')).filter((e) => { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden') return false; const q = e.getBoundingClientRect(); return q.width > 0 && (q.right > innerWidth + 1 || q.bottom > innerHeight + 1 || q.left < -1 || q.top < -1); }).length);
  await p.screenshot({ path: path.join(root, 'shots', `${id}-narrow.png`) });
  r.errs = errs.length;
  await p.context().close();
  console.log(JSON.stringify(r));
}
await b.close();
