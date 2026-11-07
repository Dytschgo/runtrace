// Contact sheet of one screenshot state. Usage: node sheet.mjs <suffix> <out.png>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');
const suffix = process.argv[2] ?? '';
const outPath = process.argv[3];
const cells = [...'ABCDEFGHIJ'].map((x) => {
  const u = pathToFileURL(path.join(root, 'shots', `${x}${suffix}.png`)).href;
  return `<figure><img src="${u}"><figcaption>${x}</figcaption></figure>`;
}).join('');
const html = `<!doctype html><style>body{margin:0;background:#333;display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:6px;width:1600px}figure{margin:0;position:relative}img{width:100%;display:block}figcaption{position:absolute;top:4px;left:50%;background:#fff;color:#000;font:700 16px sans-serif;padding:2px 8px}</style>${cells}`;
const tmp = path.join(path.dirname(outPath), 'sheet.html');
fs.writeFileSync(tmp, html);
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1612, height: 900 } })).newPage();
await p.goto(pathToFileURL(tmp).href);
await p.waitForTimeout(500);
await p.screenshot({ path: outPath, fullPage: true });
await b.close();
fs.unlinkSync(tmp);
