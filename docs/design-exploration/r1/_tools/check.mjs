// Usage: node check.mjs <concept letter>. Verifies one concept against the shared brief.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');

const id = (process.argv[2] || '').toUpperCase();
const file = path.join(root, `concept-${id}.html`);
const out = { id, fails: [], warns: [] };
const fail = (m) => out.fails.push(m);
const warn = (m) => out.warns.push(m);

if (!fs.existsSync(file)) {
  console.log(JSON.stringify({ id, fails: ['missing concept file'] }));
  process.exit(1);
}
const kb = fs.statSync(file).size / 1024;
out.kb = +kb.toFixed(1);
if (kb > 42) fail(`file is ${kb.toFixed(0)}KB, limit 42KB`);

const html = fs.readFileSync(file, 'utf8');
if (!html.includes('<script id="rt-data">window.RT=')) fail('data must be inlined as <script id="rt-data">window.RT=...');
const ext = [...html.matchAll(/(?:src|href)=["'](https?:[^"']+)/g)].map((m) => m[1]).filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
if (ext.length) fail('external resources other than Google Fonts: ' + ext.join(', '));

const metaP = path.join(root, `meta-${id}.json`);
const logoP = path.join(root, `logo-${id}.svg`);
let meta = null;
if (!fs.existsSync(metaP)) fail('missing meta json');
else {
  try { meta = JSON.parse(fs.readFileSync(metaP, 'utf8')); } catch { fail('meta json invalid'); }
}
if (!fs.existsSync(logoP)) fail('missing logo svg');
else {
  const l = fs.readFileSync(logoP, 'utf8');
  if (!/^\s*<svg/.test(l)) fail('logo must start with <svg');
  if (/<script|<text|https?:\/\/(?!www\.w3\.org)/.test(l)) fail('logo may not contain script, text or remote refs');
  if (l.length > 6000) warn('logo over 6KB');
}

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await p.waitForTimeout(2600);
await p.evaluate(() => document.fonts.ready);
if (errs.length) fail('console/page errors: ' + errs.slice(0, 4).join(' | '));

const m = await p.evaluate(() => {
  const d = document.documentElement;
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.01;
  };
  const clipped = [...document.body.querySelectorAll('*')]
    .filter((e) => vis(e) && !e.closest('svg') && !['SCRIPT', 'STYLE'].includes(e.tagName))
    .filter((e) => !e.closest('[aria-hidden="true"]'))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1; })
    .slice(0, 5)
    .map((e) => e.tagName + '.' + e.className);
  let words = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode;
    if (n.parentElement.closest('script,style,svg,[hidden],.sr-only')) continue;
    if (!vis(n.parentElement)) continue;
    words += (n.textContent.match(/[A-Za-z][A-Za-z.-]+/g) || []).length;
  }
  const models = [...new Set([...document.querySelectorAll('[data-model]')].filter(vis).map((e) => e.dataset.model))];
  const nav = [...document.querySelectorAll('nav a, nav button, [data-nav] a, [data-nav] button')].filter(vis);
  return {
    sw: d.scrollWidth, sh: d.scrollHeight, clipped, words, models,
    navCount: nav.length,
    navNamed: nav.filter((e) => e.getAttribute('aria-label') || e.textContent.trim()).length,
    svgs: document.querySelectorAll('svg').length,
    sliders: document.querySelectorAll('[data-time-slider]').length,
    readouts: document.querySelectorAll('[data-readout]').length,
    logo: !!document.querySelector('[data-logo] svg'),
    fams: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
  };
});
Object.assign(out, { words: m.words, models: m.models.length, navCount: m.navCount, svgs: m.svgs, loadedFonts: [...new Set(m.fams)] });
if (m.sw > 1441 || m.sh > 901) fail(`page scrolls: ${m.sw}x${m.sh}`);
if (m.clipped.length) fail('elements clipped by the 1440x900 stage: ' + m.clipped.join(', '));
if (m.words > 130) fail(`too much visible text: ${m.words} words, limit 130`);
if (m.models.length < 8) fail(`only ${m.models.length} distinct visible [data-model] values, need 8`);
if (m.navCount < 12 || m.navNamed < m.navCount) fail(`nav must expose 12 named items, got ${m.navCount}/${m.navNamed}`);
if (!m.logo) fail('missing [data-logo] svg');
if (!m.sliders) fail('missing [data-time-slider]');
if (m.readouts < 3) fail('need at least 3 [data-readout] values');
if (m.svgs < 18) warn('few SVG icons');
if (meta) {
  for (const k of ['display', 'ui', 'data']) {
    const fam = meta.fonts?.[k];
    if (!fam) fail('meta.fonts.' + k + ' missing');
    else if (!m.fams.includes(fam)) fail(`font not loaded on the page: ${fam}`);
  }
}
await p.screenshot({ path: path.join(root, 'shots', `${id}.png`) });

const read = () => p.evaluate(() => [...document.querySelectorAll('[data-readout]')].map((e) => e.textContent.trim()).join('|'));
const before = await read();
const s = p.locator('[data-time-slider]').first();
await s.focus();
if (!(await p.evaluate(() => document.activeElement?.matches('[data-time-slider]')))) fail('slider not keyboard focusable');
for (let i = 0; i < 12; i++) await p.keyboard.press('ArrowRight');
await p.waitForTimeout(1300);
let after = await read();
if (after === before) {
  for (let i = 0; i < 24; i++) await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(1300);
  after = await read();
}
if (after === before) fail('keyboard on the slider did not change any [data-readout]');
if (errs.length) fail('errors while using the slider: ' + errs.slice(0, 3).join(' | '));
await p.screenshot({ path: path.join(root, 'shots', `${id}-slid.png`) });
out.readoutBefore = before.slice(0, 80);
out.readoutAfter = after.slice(0, 80);

const ctx2 = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const q = await ctx2.newPage();
await q.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await q.waitForTimeout(900);
const inf = await q.evaluate(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations === Infinity && a.playState === 'running').length);
if (inf) fail(`${inf} looping animations still run under reduced motion`);
await q.screenshot({ path: path.join(root, 'shots', `${id}-reduced.png`) });

await b.close();
out.pass = out.fails.length === 0;
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
