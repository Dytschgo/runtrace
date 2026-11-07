// Renders the comparison page, and drives one embedded concept through scaling.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const out = process.argv[2];
const url = pathToFileURL(path.join(root, 'index.html')).href;
const b = await chromium.launch({ headless: true });

const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url, { waitUntil: 'load' });
await p.waitForTimeout(800);
await p.screenshot({ path: path.join(out, 'g-top.png') });
const liveAt = async () => p.evaluate(() => [...document.querySelectorAll('.concept')].filter((c) => c.querySelector('iframe')).map((c) => c.dataset.id));
console.log('live at top', await liveAt());

for (const id of 'ABCDEFGHIJ') {
  await p.locator(`#r1-${id.toLowerCase()} .stage`).scrollIntoViewIfNeeded();
  await p.evaluate((i) => document.querySelector(`#r1-${i.toLowerCase()}`).scrollIntoView({ block: 'start' }), id);
  await p.waitForTimeout(700);
  const frame = p.frameLocator(`#r1-${id.toLowerCase()} iframe`);
  const n = await frame.locator('[data-readout]').count().catch(() => -1);
  const before = n > 0 ? await frame.locator('[data-readout]').first().textContent() : null;
  console.log(id, 'readouts', n, 'first', (before || '').slice(0, 6), 'live', await liveAt());
}

// Pointer drag through the CSS scale on concept A.
await p.evaluate(() => document.querySelector('#r1-a').scrollIntoView({ block: 'start' }));
await p.waitForTimeout(2200);
const fa = p.frameLocator('#r1-a iframe');
const read = async () => (await fa.locator('[data-readout]').allTextContents()).join('|');
const before = await read();
const box = await fa.locator('[data-time-slider]').first().boundingBox();
await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await p.mouse.down();
await p.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 10 });
await p.mouse.up();
await p.waitForTimeout(1200);
console.log('scaled drag', before, '->', await read());
await p.screenshot({ path: path.join(out, 'g-a.png') });
await p.evaluate(() => document.querySelector('#r1-j').scrollIntoView({ block: 'start' }));
await p.waitForTimeout(2000);
await p.screenshot({ path: path.join(out, 'g-j.png') });

const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await m.goto(url, { waitUntil: 'load' });
await m.waitForTimeout(800);
console.log('phone overflow', await m.evaluate(() => document.documentElement.scrollWidth - innerWidth));
await m.screenshot({ path: path.join(out, 'g-phone.png') });
console.log('errors', errs.length, errs.slice(0, 5));
await b.close();
