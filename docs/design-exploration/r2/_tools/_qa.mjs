// Drives each round 2 mockup with a real mouse and keyboard, and captures settled states.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });
const pages = ['fable-1', 'fable-2', 'sol-mockup-1', 'sol-mockup-2', 'sol-mockup-3', 'sol-mockup-4', 'sol-mockup-5'];
const b = await chromium.launch({ headless: true });

for (const name of pages) {
  const r = { name, kb: +(fs.statSync(path.join(root, name + '.html')).size / 1024).toFixed(0) };
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('page: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto(pathToFileURL(path.join(root, name + '.html')).href, { waitUntil: 'load' });
  await p.waitForTimeout(5000);
  await p.screenshot({ path: path.join(shots, name + '.png') });
  const text = () => p.evaluate(() => document.body.innerText);
  Object.assign(r, await p.evaluate(() => ({
    pageH: document.documentElement.scrollHeight,
    hScroll: document.documentElement.scrollWidth - innerWidth,
    sliders: document.querySelectorAll('input[type=range],[role=slider]').length,
    buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input:not([type=range]),select').length,
  })));

  // Mouse drag on the first slider handle.
  const t0 = await text();
  const h = p.locator('[role=slider],input[type=range]').first();
  if (r.sliders) {
    await h.scrollIntoViewIfNeeded();
    const box = await h.boundingBox();
    if (box) {
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, { steps: 10 });
      await p.mouse.up();
      await p.waitForTimeout(1200);
      r.dragChanges = (await text()) !== t0;
      await p.screenshot({ path: path.join(shots, name + '-drag.png') });
    } else r.dragChanges = 'no box';
    const t1 = await text();
    await h.focus();
    for (let i = 0; i < 6; i++) await p.keyboard.press('ArrowLeft');
    await p.waitForTimeout(800);
    r.keyChanges = (await text()) !== t1;
  } else r.dragChanges = 'no [role=slider]';

  // Click every visible button once, and report the ones that do nothing visible.
  const n = await p.locator('button:visible').count();
  let dead = 0, tried = 0;
  const deadNames = [];
  for (let i = 0; i < Math.min(n, 40); i++) {
    const btn = p.locator('button:visible').nth(i);
    const label = ((await btn.getAttribute('aria-label').catch(() => null)) || (await btn.textContent().catch(() => '')) || '').trim().slice(0, 20);
    const a = await p.screenshot({ type: 'jpeg', quality: 40 }).catch(() => null);
    const ok = await btn.click({ timeout: 800 }).then(() => true).catch(() => false);
    if (!ok) continue;
    tried++;
    await p.waitForTimeout(350);
    const c = await p.screenshot({ type: 'jpeg', quality: 40 }).catch(() => null);
    if (a && c && a.equals(c)) { dead++; deadNames.push(label); }
  }
  r.buttonsTried = tried;
  r.noVisibleChange = deadNames.slice(0, 8);

  // Search and keyboard shortcuts, where they exist.
  const search = p.locator('input[type=search],input[placeholder*="earch" i],input[placeholder*="ilter" i]').first();
  if (await search.count()) {
    const before = await text();
    await search.fill('zzzz').catch(() => {});
    await p.waitForTimeout(500);
    r.searchChanges = (await text()) !== before;
    await search.fill('').catch(() => {});
  }
  await p.keyboard.press('Escape');
  r.errors = errs.length;
  if (errs.length) r.firstError = errs[0].slice(0, 160);

  // Phone width.
  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await m.goto(pathToFileURL(path.join(root, name + '.html')).href, { waitUntil: 'load' });
  await m.waitForTimeout(1500);
  r.phoneOverflow = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await m.context().close();

  // Reduced motion: no looping animations.
  const q = await (await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage();
  await q.goto(pathToFileURL(path.join(root, name + '.html')).href, { waitUntil: 'load' });
  await q.waitForTimeout(800);
  r.reducedLoops = await q.evaluate(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations === Infinity && a.playState === 'running').length);
  await q.context().close();

  await ctx.close();
  console.log(JSON.stringify(r));
}
await b.close();
