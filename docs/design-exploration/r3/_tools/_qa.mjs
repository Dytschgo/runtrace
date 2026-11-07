// Drives the r3 mockup: settled state, range switch, agent isolation, phone width, reduced motion.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });
const url = pathToFileURL(path.join(root, 'fable-style.html')).href;
const b = await chromium.launch({ headless: true });
const log = (k, v) => console.log(k.padEnd(30), JSON.stringify(v));

const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(url, { waitUntil: 'load' });
await p.waitForTimeout(300);
await p.screenshot({ path: path.join(shots, 'early.png') });
await p.waitForTimeout(700);
await p.screenshot({ path: path.join(shots, 'mid.png') });
await p.waitForTimeout(4500);
await p.screenshot({ path: path.join(shots, 'settled.png') });
await p.screenshot({ path: path.join(shots, 'full.png'), fullPage: true });
const text = () => p.evaluate(() => document.body.innerText);
const t0 = await text();
log('size KB', +(fs.statSync(path.join(root, 'fable-style.html')).size / 1024).toFixed(1));
log('page height', await p.evaluate(() => document.documentElement.scrollHeight));
log('money or cost shown', t0.match(/\$[\d,.]+|cost|savings/gi) || []);
log('buttons', await p.locator('button:visible').evaluateAll((a) => a.map((x) => (x.getAttribute('aria-label') || x.textContent).trim().slice(0, 18)).slice(0, 30)));

for (const label of ['7D', '30D', 'All']) {
  const btn = p.getByRole('button', { name: label, exact: true }).first();
  if (await btn.count()) {
    const before = await text();
    await btn.click();
    await p.waitForTimeout(1600);
    log('range ' + label + ' changes text', (await text()) !== before);
    if (label === '7D') await p.screenshot({ path: path.join(shots, 'range-7d.png') });
  } else log('range ' + label, 'not a button');
}

const row = p.locator('button:visible').filter({ hasText: /Codex|Claude|Grok|Muse/ }).first();
if (await row.count()) {
  const a = await p.screenshot({ type: 'jpeg', quality: 50 });
  await row.hover();
  await p.waitForTimeout(600);
  const c = await p.screenshot({ type: 'jpeg', quality: 50 });
  log('hover agent changes page', !a.equals(c));
  await p.screenshot({ path: path.join(shots, 'hover.png') });
  await row.click();
  await p.waitForTimeout(800);
  await p.mouse.move(2, 2);
  await p.waitForTimeout(500);
  const d = await p.screenshot({ type: 'jpeg', quality: 50 });
  await p.screenshot({ path: path.join(shots, 'isolated.png') });
  await row.click();
  await p.waitForTimeout(800);
  await p.mouse.move(2, 2);
  await p.waitForTimeout(500);
  const e = await p.screenshot({ type: 'jpeg', quality: 50 });
  log('click toggles isolation', !d.equals(e));
} else log('agent rows', 'no button matched');
log('errors', errs);

const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await m.goto(url, { waitUntil: 'load' });
await m.waitForTimeout(3500);
log('phone overflow', await m.evaluate(() => document.documentElement.scrollWidth - innerWidth));
await m.screenshot({ path: path.join(shots, 'phone.png') });

const q = await (await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage();
await q.goto(url, { waitUntil: 'load' });
await q.waitForTimeout(700);
log('reduced-motion loops', await q.evaluate(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations === Infinity && a.playState === 'running').length));
await q.screenshot({ path: path.join(shots, 'reduced.png') });
await b.close();
