// Applies the two review fixes once, then builds r2/index.html and the thumbnails used in the thread.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../../../dashboard/package.json'));
const { chromium } = require('@playwright/test');

const once = (file, a, b) => {
  const f = path.join(root, file);
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes(b)) return;
  if (s.split(a).length !== 2) throw new Error(`${file}: expected one match of ${a.slice(0, 40)}`);
  fs.writeFileSync(f, s.replace(a, () => b));
  console.log('patched', file);
};
// Mockup 5: the top bar overflowed below 1536px, which cut off the date.
once('sol-mockup-5.html', '@media(max-width:1100px){.cols{', '@media(max-width:1535px){.nav{gap:2px}.nav button{font-size:17px;padding:5px 11px;gap:8px}.nav button .ic{font-size:21px}.nav .date{padding-left:14px}}\n@media(max-width:1100px){.cols{');
// Fable 2: one no-wrap label pushed the page 17px wider than a phone.
once('fable-2.html', '</style>', '@media(max-width:500px){#selm{white-space:normal!important}}\n</style>');

const IMG = (dir, name) => `${dir}/${name}.png`;
const live = (file, title) => `<figure class="f"><div class="stage"><iframe data-src="${file}" title="${title}"></iframe><button class="run" type="button">Run ${title}</button></div><figcaption><b>${title}</b><a href="${file}" target="_blank" rel="noopener">Open full page</a></figcaption></figure>`;
const pic = (src, title) => `<figure class="f"><a class="pic" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${title}" loading="lazy"></a><figcaption><b>${title}</b></figcaption></figure>`;

const pairs = ['Dark console', 'Light editorial', 'Navy timeline', 'Day dial', 'Model columns'].map((t, i) => {
  const n = i + 1;
  return `<div class="pair">${pic(IMG('sol-images', `sol-${n}`), `Sol image ${n}: ${t}`)}${live(`sol-mockup-${n}.html`, `Fable mockup ${n}`)}</div>`;
}).join('');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runtrace Design Round 2</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap">
<style>
:root{--room:#0d0d0f;--panel:#17171a;--line:#2a2a2f;--ink:#f3f3f1;--mute:#a3a3ab;--ac:#e8ad65;color-scheme:dark}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--room);color:var(--ink);font:15px/1.5 Geist,system-ui,sans-serif}
.wrap{max-width:1500px;margin-inline:auto;padding:40px 16px 64px;display:grid;gap:48px}
h1{font-size:clamp(26px,4vw,38px);font-weight:600;letter-spacing:-.02em;line-height:1.15;margin:0 0 8px}
h2{font-size:21px;font-weight:600;margin:0 0 4px}
p{margin:0;color:var(--mute);max-width:70ch}
section{display:grid;gap:14px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.grid3{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px}
.grid3>*{grid-column:span 2}.grid3>:nth-last-child(-n+2){grid-column:span 3}
.pairs{display:grid;gap:22px}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.f{margin:0;display:grid;gap:7px;min-width:0}
figcaption{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--mute)}
figcaption b{font-weight:500;color:var(--ink)}
figcaption a{color:var(--ac)}
.pic img{display:block;width:100%;border:1px solid var(--line);border-radius:10px}
.stage{position:relative;aspect-ratio:1440/900;max-width:100%;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.stage iframe{position:absolute;left:0;top:0;width:1440px;height:900px;border:0;transform-origin:0 0}
.run{position:absolute;inset:0;margin:auto;width:max-content;height:max-content;padding:9px 16px;background:var(--room);color:var(--ink);border:1px solid var(--line);border-radius:99px;font:500 14px Geist,sans-serif;cursor:pointer}
:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
@media(max-width:760px){.grid2,.pair{grid-template-columns:1fr}.grid3>*,.grid3>:nth-last-child(-n+2){grid-column:1/-1}}
</style></head><body><div class="wrap">
<header><h1>Runtrace, design round 2</h1><p>All fake data. The dashboards are live and clickable. Sol's pictures are static. <a href="../r1/index.html" style="color:var(--ac)">Round 1</a></p></header>
<section><div><h2>Fable's own dashboards</h2><p>Two separate runs, with only the project and goal as a brief.</p></div><div class="grid2">${live('fable-1.html', 'Fable 1: Tape and Reader')}${live('fable-2.html', 'Fable 2: Tape')}</div></section>
<section><div><h2>Less fancy: Sol's images and Fable's mockups</h2><p>Sol's image on the left, Fable's working version on the right.</p></div><div class="pairs">${pairs}</div></section>
<section><div><h2>Sol, bento style</h2><p>Follows your bento reference. Static pictures.</p></div><div class="grid3">${[1, 2, 3, 4, 5].map((n) => pic(IMG('sol-bento', `bento-${n}`), `Bento ${n}`)).join('')}</div></section>
<section><div><h2>Sol, no style guide</h2><p>Sol got only the project information. Static pictures.</p></div><div class="grid3">${[1, 2, 3, 4, 5].map((n) => pic(IMG('sol-free', `free-${n}`), `Free ${n}`)).join('')}</div></section>
</div>
<script>
(function(){
  const stages=[...document.querySelectorAll('.stage')],live=[];
  const fit=(s)=>{const f=s.querySelector('iframe');f.style.transform='scale('+s.clientWidth/1440+')'};
  const stop=(s)=>{const i=live.indexOf(s);if(i>-1)live.splice(i,1);const f=s.querySelector('iframe');f.removeAttribute('src');s.querySelector('.run').hidden=false};
  const start=(s)=>{if(live.includes(s))return;while(live.length>=3)stop(live[0]);const f=s.querySelector('iframe');f.src=f.dataset.src;s.querySelector('.run').hidden=true;live.push(s)};
  const ro=new ResizeObserver((e)=>e.forEach((x)=>fit(x.target)));
  const io=new IntersectionObserver((e)=>e.forEach((x)=>{x.isIntersecting?start(x.target):stop(x.target)}),{threshold:.3});
  stages.forEach((s)=>{ro.observe(s);io.observe(s);s.querySelector('.run').onclick=()=>start(s)});
})();
</script></body></html>`;
fs.writeFileSync(path.join(root, 'index.html'), html);

// Thumbnails for the in-thread overview.
const thumbs = path.join(root, 'shots', 'thumbs');
fs.mkdirSync(thumbs, { recursive: true });
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 0.5 });
for (const n of ['fable-1', 'fable-2', 'sol-mockup-1', 'sol-mockup-2', 'sol-mockup-3', 'sol-mockup-4', 'sol-mockup-5']) {
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(path.join(root, n + '.html')).href, { waitUntil: 'load' });
  await p.waitForTimeout(4500);
  await p.screenshot({ path: path.join(thumbs, n + '.jpg'), type: 'jpeg', quality: 72 });
  await p.close();
}
const imgs = [...[1, 2, 3, 4, 5].map((n) => ['sol-images', `sol-${n}`]), ...[1, 2, 3, 4, 5].map((n) => ['sol-bento', `bento-${n}`]), ...[1, 2, 3, 4, 5].map((n) => ['sol-free', `free-${n}`])];
const pg = await (await b.newContext({ viewport: { width: 720, height: 480 } })).newPage();
for (const [d, n] of imgs) {
  await pg.goto(pathToFileURL(path.join(root, d, n + '.png')).href);
  await pg.evaluate(() => { const i = document.querySelector('img'); document.body.style.margin = 0; i.style.cssText = 'display:block;width:720px;height:auto'; });
  await pg.locator('img').screenshot({ path: path.join(thumbs, n + '.jpg'), type: 'jpeg', quality: 72 });
}
await b.close();
let total = 0;
for (const f of fs.readdirSync(thumbs)) total += fs.statSync(path.join(thumbs, f)).size;
console.log('thumbs', fs.readdirSync(thumbs).length, (total / 1024).toFixed(0) + 'KB');
