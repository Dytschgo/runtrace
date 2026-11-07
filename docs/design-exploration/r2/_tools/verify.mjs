// Confirms the two fixes and that the comparison page runs its embedded dashboards.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const b = await chromium.launch({ headless: true });
const url = (n) => pathToFileURL(path.join(root, n + '.html')).href;

for (const w of [1280, 1440, 1536]) {
  const p = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage();
  await p.goto(url('sol-mockup-5'));
  await p.waitForTimeout(800);
  console.log('m5 nav overflow at', w, await p.evaluate(() => { const h = document.querySelector('nav'); return h.scrollWidth - h.clientWidth; }));
  await p.context().close();
}
const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await m.goto(url('fable-2'));
await m.waitForTimeout(1500);
console.log('f2 phone overflow', await m.evaluate(() => document.documentElement.scrollWidth - innerWidth));

// How the Fable 2 filter shows a non-match.
const f = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await f.goto(url('fable-2'));
await f.waitForTimeout(3000);
const op = () => f.evaluate(() => [...document.querySelectorAll('#tape .lane')].map((l) => getComputedStyle(l).opacity + '/' + l.getAttribute('class')).join(' ').slice(0, 100));
console.log('f2 lanes before', await op());
await f.locator('#q').fill('zzzz');
await f.waitForTimeout(500);
console.log('f2 lanes filtered', await op());

const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url('index'));
await p.waitForTimeout(1500);
console.log('frames at top', await p.evaluate(() => [...document.querySelectorAll('iframe')].filter((i) => i.getAttribute('src')).map((i) => i.dataset.src)));
const fr = p.frameLocator('iframe[data-src="fable-2.html"]');
console.log('embedded clock', await fr.locator('#clock').innerText());
await p.screenshot({ path: path.join(root, 'shots', 'index.png') });
for (const n of [1, 2, 3, 4, 5]) {
  await p.locator(`iframe[data-src="sol-mockup-${n}.html"]`).scrollIntoViewIfNeeded();
  await p.waitForTimeout(500);
  console.log('mockup', n, 'loaded', await p.evaluate((k) => !!document.querySelector(`iframe[data-src="sol-mockup-${k}.html"]`).getAttribute('src'), n));
}
console.log('broken images', await p.evaluate(async () => { const a = [...document.images]; a.forEach((i) => { i.loading = 'eager'; }); await new Promise((r) => setTimeout(r, 2500)); return a.filter((i) => !i.complete || !i.naturalWidth).map((i) => i.src); }));
console.log('errors', errs);
console.log('h-scroll', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth));
await b.close();
