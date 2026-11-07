// Targeted tests of the two Fable dashboards and the layout clip in mockup 5.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const b = await chromium.launch({ headless: true });
const open = async (name, w = 1440, h = 900) => {
  const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  await p.goto(pathToFileURL(path.join(root, name + '.html')).href, { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  return p;
};
const log = (k, v) => console.log(k.padEnd(34), JSON.stringify(v));

// fable-1
{
  const p = await open('fable-1');
  const reader = () => p.locator('#reader-h').innerText().then((t) => t.slice(0, 60));
  const lede = () => p.locator('#lede').innerText();
  const stats = () => p.locator('#stats').innerText();
  const r0 = await reader();
  await p.locator('#list .row').nth(2).click();
  await p.waitForTimeout(400);
  log('f1 list row opens reader', (await reader()) !== r0);
  const r1 = await reader();
  await p.mouse.move(5, 5);
  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press('j');
  await p.waitForTimeout(300);
  log('f1 j moves selection', (await reader()) !== r1);
  await p.keyboard.press('/');
  log('f1 / focuses filter', await p.evaluate(() => document.activeElement?.id));
  await p.keyboard.type('zzzz');
  await p.waitForTimeout(300);
  log('f1 empty filter text', (await p.locator('#list').innerText()).slice(0, 60));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  log('f1 Esc restores list', await p.locator('#list .row').count());
  const s0 = await stats();
  await p.locator('#range button[data-v="30d"]').click();
  await p.waitForTimeout(900);
  log('f1 30d changes stats', (await stats()) !== s0);
  await p.locator('#range button[data-v="7d"]').click();
  await p.waitForTimeout(900);
  const s1 = await stats();
  await p.locator('#chips .chip').first().click();
  await p.waitForTimeout(900);
  log('f1 project chip changes stats', (await stats()) !== s1);
  await p.locator('#chips .chip').first().click();
  await p.waitForTimeout(600);
  // Click a bar on the tape.
  const tape = p.locator('#tape');
  await tape.scrollIntoViewIfNeeded();
  const bars = await p.evaluate(() => [...document.querySelectorAll('#tape [data-id]')].length);
  log('f1 clickable tape bars', bars);
  const r2 = await reader();
  if (bars) {
    await p.locator('#tape [data-id]').nth(3).click({ force: true });
    await p.waitForTimeout(400);
    log('f1 tape bar opens reader', (await reader()) !== r2);
  }
  // Drag across the tape: is there a time selection?
  const box = await tape.boundingBox();
  const s2 = await stats();
  await p.mouse.move(box.x + 300, box.y + 60);
  await p.mouse.down();
  await p.mouse.move(box.x + 700, box.y + 60, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(600);
  log('f1 drag on tape changes stats', (await stats()) !== s2);
  const bg0 = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await p.locator('#theme').click();
  await p.waitForTimeout(400);
  log('f1 theme toggle', [bg0, await p.evaluate(() => getComputedStyle(document.body).backgroundColor)]);
  await p.locator('#theme').click();
  log('f1 errors', p.errs);
}

// fable-2
{
  const p = await open('fable-2');
  const clock = () => p.locator('#clock').innerText();
  const counts = () => p.locator('#cP').innerText();
  const c0 = await clock();
  const box = await p.locator('#tape').boundingBox();
  const k0 = await p.locator('#cK').innerText();
  await p.mouse.move(box.x + 300, box.y + 30);
  await p.mouse.down();
  await p.mouse.move(box.x + 450, box.y + 30, { steps: 8 });
  await p.waitForTimeout(150);
  const mid = await clock();
  await p.mouse.up();
  await p.waitForTimeout(500);
  log('f2 drag moves playhead', [c0, mid, await clock()]);
  log('f2 drag changes counters', [k0, await p.locator('#cK').innerText()]);
  await p.screenshot({ path: path.join(root, 'shots', 'fable-2-drag.png') });
  const c1 = await clock();
  await p.locator('#play').click();
  await p.waitForTimeout(1500);
  const c2 = await clock();
  log('f2 play advances clock', [c1, c2]);
  await p.locator('#play').click();
  await p.waitForTimeout(200);
  const c3 = await clock();
  await p.waitForTimeout(600);
  log('f2 pause stops clock', [c3, await clock()]);
  await p.mouse.move(5, 5);
  await p.evaluate(() => document.activeElement?.blur());
  const c4 = await clock();
  await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(300);
  log('f2 arrow scrubs', [c4, await clock()]);
  await p.keyboard.press(' ');
  await p.waitForTimeout(800);
  const c5 = await clock();
  await p.keyboard.press(' ');
  log('f2 space plays', c5);
  const sp0 = await p.locator('#speed').innerText();
  await p.locator('#speed').click();
  log('f2 speed cycles', [sp0, await p.locator('#speed').innerText()]);
  await p.keyboard.press('/');
  log('f2 / focuses filter', await p.evaluate(() => document.activeElement?.id));
  const lanes0 = await p.locator('#tape .lane').count();
  await p.keyboard.type('zzzz');
  await p.waitForTimeout(400);
  log('f2 filter lanes', [lanes0, await p.locator('#tape .lane').count()]);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  log('f2 Esc restores lanes', await p.locator('#tape .lane').count());
  const title0 = await p.locator('#title').innerText();
  await p.locator('#strip .day').nth(10).click();
  await p.waitForTimeout(900);
  log('f2 day strip switches day', [title0, await p.locator('#title').innerText()]);
  log('f2 lanes after switch', await p.locator('#tape .lane').count());
  log('f2 errors', p.errs);
  const m = await open('fable-2', 390, 844);
  log('f2 phone overflowers', await m.evaluate(() => [...document.body.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 && !e.closest('svg'); }).slice(0, 6).map((e) => e.tagName + '#' + e.id + '.' + e.className + ' r=' + Math.round(e.getBoundingClientRect().right))));
}

// mockup 5 header clip
{
  const p = await open('sol-mockup-5');
  log('m5 header clipped', await p.evaluate(() => [...document.querySelectorAll('header *, nav *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('svg')).slice(0, 6).map((e) => e.tagName + '.' + e.className + ' "' + e.textContent.trim().slice(0, 12) + '" r=' + Math.round(e.getBoundingClientRect().right))));
  log('m5 bar css', await p.evaluate(() => { const h = document.querySelector('header') || document.querySelector('nav'); const s = getComputedStyle(h); return { tag: h.tagName, cls: h.className, display: s.display, overflow: s.overflow, wrap: s.flexWrap, gap: s.gap, w: h.getBoundingClientRect().width, sw: h.scrollWidth }; }));
  for (const w of [1280, 1440, 1536, 1920]) {
    const q = await open('sol-mockup-5', w, 900);
    log('m5 clip at ' + w, await q.evaluate(() => { const h = document.querySelector('header') || document.querySelector('nav'); return h.scrollWidth - h.clientWidth; }));
    await q.context().close();
  }
}
await b.close();
