// Fresh settled captures for the in-thread overview, plus the logo wall.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const dir = path.join(root, 'shots', 'thumbs');
fs.mkdirSync(dir, { recursive: true });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 0.75 });
for (const id of 'ABCDEFGHIJ') {
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(path.join(root, `concept-${id}.html`)).href, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(6000);
  await p.screenshot({ path: path.join(dir, `${id}.jpg`), type: 'jpeg', quality: 74 });
  await p.close();
}
const w = await (await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })).newPage();
await w.goto(pathToFileURL(path.join(root, 'index.html')).href, { waitUntil: 'load' });
await w.evaluate(() => document.fonts.ready);
await w.waitForTimeout(500);
await w.locator('.wall').screenshot({ path: path.join(dir, 'logos.jpg'), type: 'jpeg', quality: 85 });
await b.close();
for (const f of fs.readdirSync(dir)) console.log(f, (fs.statSync(path.join(dir, f)).size / 1024).toFixed(0) + 'KB');
