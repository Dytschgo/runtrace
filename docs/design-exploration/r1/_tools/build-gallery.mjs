// Builds the round 1 comparison page from the concept files.
// Output: ../index.html (open locally) and ../_publish/runtrace-design-round-1.html (artifact source, no document skeleton).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ids = [...'ABCDEFGHIJ'];

// My own review notes after reading each rendered state. Facts only, shown under each concept.
const NOTES = {
  A: { tag: 'Recommended', note: 'Closest to your reference and the easiest to read. Its card system also carries over to tables and the other 11 pages. Small models get thin in the daily chart.' },
  B: { tag: 'Most striking', note: 'The strongest single image in the set. The dial takes the whole screen, so pages with tables would need a different layout. The scattered nav icons are easy to miss.' },
  C: { tag: 'Softest', note: 'Polished and calm, with a background that shifts with your model mix. Heavy blur may cost performance, which I have not measured. Small models are hard to tell apart in the tubes.' },
  D: { tag: 'Most hardware', note: 'Feels like a real object, and the step sequencer is great. The token total is too small for a hero, and dot-matrix numbers get hard to read at stat size.' },
  E: { tag: 'Most memorable', note: 'Your data is the interface, which suits colored models well. Exact daily comparison is weak and the bottom row is tight. I faded the edges so they stop looking like data.' },
  F: { tag: 'Boldest color', note: 'The clearest answer to "models are colored", with the best slider of the ten. Tile sizes are adjusted so small models stay readable, so they need true proportions before shipping.' },
  G: { tag: 'Most precise', note: 'Clean and exact, and it would scale well to dense pages. It has the least wow of the set, and thin chart lines make the models harder to separate.' },
  H: { tag: 'Most elegant', note: 'The boldest typography and a very good logo. Color plays the smallest role here, and the daily chart bundles into two or three visible lines.' },
  I: { tag: 'Most playful', note: 'The time-lapse play button is the most fun control here. The particle clouds show activity as a mood, so exact daily values cannot be read from them.' },
  J: { tag: 'Only light option', note: 'A real alternative to dark, with a lovely bead slider. It is the furthest from your reference. Its model colors are deep and some sit close together, gold beside crimson.' },
};

let dataTag = null;
const concepts = {};
const metas = {};
for (const id of ids) {
  const html = read(`concept-${id}.html`);
  const m = html.match(/<script id="rt-data">window\.RT=[\s\S]*?<\/script>/);
  if (!m) throw new Error('no data tag in ' + id);
  const norm = m[0].replace(/;?\s*<\/script>$/, ';</script>');
  if (dataTag && dataTag !== norm) throw new Error('data differs in ' + id);
  dataTag = norm;
  concepts[id] = html.replace(m[0], () => '<!--RT-->');
  const meta = JSON.parse(read(`meta-${id}.json`));
  const logo = 'data:image/svg+xml;base64,' + Buffer.from(read(`logo-${id}.svg`).trim()).toString('base64');
  metas[id] = { ...meta, logo, ...NOTES[id], agent: /grok/i.test(meta.by) ? 'Grok' : 'Codex' };
}

const families = [...new Set(ids.flatMap((id) => Object.values(metas[id].fonts)))].filter((f) => f !== 'Geist' && f !== 'Geist Mono');
const fontUrl = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&' + families.map((f) => 'family=' + f.replace(/ /g, '+')).join('&') + '&display=swap';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const embed = (o) => JSON.stringify(o).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const ICON = {
  play: '<path d="M5 5a2 2 0 0 1 3-1.7l12 7a2 2 0 0 1 0 3.4l-12 7A2 2 0 0 1 5 19z"/>',
  redo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  slider: '<path d="M21 12h-8"/><path d="M7 12H3"/><circle cx="10" cy="12" r="3"/>',
  motion: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  mark: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>',
};
const icon = (n, s = 16) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

const wall = ids.map((id) => {
  const m = metas[id];
  return `<a class="wall-cell" href="#r1-${id.toLowerCase()}" style="--bg:${m.palette[0]};--fg:${m.palette[2]}" aria-label="${esc(m.name)} logo, go to R1-${id}"><img class="wall-mark" src="${m.logo}" alt=""><span class="wall-foot"><img src="${m.logo}" width="16" height="16" alt=""><b>${id}</b></span></a>`;
}).join('');

const cards = ids.map((id) => {
  const m = metas[id];
  const swatches = Object.entries(m.modelColors).map(([k, v]) => `<span class="sw" style="background:${v}" title="${esc(k)}"><span class="sr-only">${esc(k)}</span></span>`).join('');
  return `<article class="concept" id="r1-${id.toLowerCase()}" data-id="${id}">
  <header class="c-head">
    <div class="c-title"><span class="c-id">R1-${id}</span><h2>${esc(m.name)}</h2><span class="c-tag${id === 'A' ? ' is-rec' : ''}">${esc(m.tag)}</span></div>
    <div class="c-actions"><span class="c-by">${m.agent}</span><button type="button" data-act="replay" aria-label="Replay ${esc(m.name)}" title="Replay">${icon('redo')}</button><button type="button" data-act="full" aria-label="Show ${esc(m.name)} full screen" title="Full screen">${icon('full')}</button></div>
  </header>
  <div class="stage" style="--bg:${m.palette[0]};--fg:${m.palette[2]}">
    <button type="button" class="poster" data-act="run" aria-label="Run ${esc(m.name)}"><img src="${m.logo}" alt=""><span>${icon('play', 14)} Run</span></button>
  </div>
  <div class="spec" style="--bg:${m.palette[0]};--sf:${m.palette[1]};--fg:${m.palette[2]};--ac:${m.palette[3]}">
    <div class="fonts">
      <div><span class="big" style="font-family:'${m.fonts.display}',sans-serif">23.2B</span><small>${esc(m.fonts.display)}</small></div>
      <div><span class="mid" style="font-family:'${m.fonts.ui}',sans-serif">Prompts</span><small>${esc(m.fonts.ui)}</small></div>
      <div><span class="mid" style="font-family:'${m.fonts.data}',monospace">192,823</span><small>${esc(m.fonts.data)}</small></div>
    </div>
    <div class="swatches" role="img" aria-label="Model colors">${swatches}</div>
    <ul class="ideas">
      <li>${icon('mark')}<span>${esc(m.logoIdea)}</span></li>
      <li>${icon('slider')}<span>${esc(m.sliderIdea)}</span></li>
      <li>${icon('motion')}<span>${esc(m.signatureMotion)}</span></li>
    </ul>
  </div>
  <p class="c-note">${esc(m.note)}</p>
</article>`;
}).join('\n');

const body = `<title>Runtrace Design Round</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fontUrl}">
<style>
/* A neutral screening room: one column of live stages, each trailed by its own type and color. */
:root{--room:#0d0d0f;--panel:#17171a;--line:#2a2a2f;--ink:#f3f3f1;--mute:#a3a3ab;--rec:#e8ad65;--ui:'Geist',system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace;color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{background:var(--room);color:var(--ink);font:15px/1.5 var(--ui)}
.wrap{max-width:1180px;margin-inline:auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:40px 64px;display:grid;gap:48px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
h1{font-size:clamp(26px,4vw,38px);font-weight:600;letter-spacing:-.02em;line-height:1.15;margin:0;text-wrap:balance}
.intro{display:grid;gap:18px}
.intro p{margin:0;color:var(--mute);max-width:62ch}
.pick{display:flex;flex-wrap:wrap;gap:8px}
.pick a{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--line);border-radius:99px;color:var(--ink);text-decoration:none;font-size:14px}
.pick a b{font:500 12px var(--mono);color:var(--mute)}
.pick a.is-rec{border-color:var(--rec);color:var(--rec)}
.pick a.is-rec b{color:var(--rec)}
.pick a:hover{background:var(--panel)}
.wall{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
.wall-cell{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:18px 14px 10px;display:grid;gap:12px;justify-items:center;text-decoration:none;transition:transform .18s cubic-bezier(.23,1,.32,1)}
.wall-cell:hover{transform:translateY(-3px)}
.wall-mark{height:68px;width:100%;object-fit:contain}
.wall-foot{display:flex;align-items:center;gap:8px;font:500 12px var(--mono)}
.wall-foot img{object-fit:contain}
.wall-foot b{font-weight:500}
.concepts{display:grid;gap:56px}
.concept{display:grid;gap:12px;scroll-margin-top:16px;min-width:0}
.c-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px}
.c-title{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-width:0}
.c-id{font:500 12px var(--mono);color:var(--mute)}
h2{font-size:21px;font-weight:600;letter-spacing:-.01em;margin:0}
.c-tag{font-size:12px;padding:2px 9px;border-radius:99px;background:var(--panel);color:var(--mute)}
.c-tag.is-rec{background:var(--rec);color:#1b1408;font-weight:500}
.c-actions{display:flex;align-items:center;gap:6px}
.c-by{font:12px var(--mono);color:var(--mute);margin-inline-end:6px}
.c-actions button{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--line);border-radius:9px;background:none;color:var(--ink);cursor:pointer}
.c-actions button:hover{background:var(--panel)}
:focus-visible{outline:2px solid var(--rec);outline-offset:2px}
.stage{position:relative;aspect-ratio:1440/900;max-width:100%;background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.stage:fullscreen{border:0;border-radius:0;aspect-ratio:auto;background:#000}
.stage iframe{position:absolute;left:0;top:0;width:1440px;height:900px;border:0;transform-origin:0 0;transform:translate(var(--x,0),var(--y,0)) scale(var(--s,1))}
.poster{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:18px;background:none;border:0;color:var(--fg);cursor:pointer;font:500 14px var(--ui)}
.poster img{height:clamp(56px,12vw,120px);width:clamp(56px,12vw,120px);object-fit:contain}
.poster span{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border:1px solid currentColor;border-radius:99px}
.spec{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:16px;min-width:0}
.fonts{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:end}
.fonts div{display:grid;gap:4px;min-width:0}
.fonts small{font:12px var(--mono);opacity:.72;overflow-wrap:anywhere}
.big{font-size:clamp(30px,5vw,46px);line-height:1.1;white-space:nowrap}
.mid{font-size:clamp(17px,2.6vw,22px);line-height:1.2;overflow-wrap:anywhere}
.swatches{display:flex;gap:6px}
.sw{flex:1;height:14px;border-radius:4px;min-width:0}
.ideas{list-style:none;margin:0;padding:0;display:grid;gap:7px;font-size:14px}
.ideas li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:9px;align-items:start}
.ideas svg{margin-top:3px;color:var(--ac);opacity:.95}
.c-note{margin:0;color:var(--mute);max-width:78ch}
.foot{border-top:1px solid var(--line);padding-top:20px;color:var(--mute);font-size:14px;display:grid;gap:8px}
.foot p{margin:0;max-width:78ch}
@media (max-width:620px){.wall{grid-template-columns:repeat(2,minmax(0,1fr))}.fonts{grid-template-columns:1fr 1fr}.fonts div:first-child{grid-column:1/-1}.c-by{display:none}}
@media (prefers-reduced-motion:reduce){.wall-cell{transition:none}.wall-cell:hover{transform:none}}
</style>
<div class="wrap">
  <section class="intro">
    <h1>Runtrace, ten design directions</h1>
    <p>Every stage is live and uses your real history. Drag the time slider, hover a model, click the nav.</p>
    <nav class="pick" aria-label="Jump to a direction">
      ${ids.map((id) => `<a href="#r1-${id.toLowerCase()}"${id === 'A' ? ' class="is-rec"' : ''}><b>${id}</b>${esc(metas[id].name)}</a>`).join('')}
    </nav>
  </section>
  <section aria-label="Logos, large and at 16 pixels"><div class="wall">${wall}</div></section>
  <div class="concepts">
${cards}
  </div>
  <footer class="foot">
    <p>All ten show the same local data, captured 6 November 2026. Project names are aliased, and only the Overview page is designed so far.</p>
    <p>The slider covers 3 October to 6 November, so the full range shows 2,750 threads. Another 220 stored threads are older than that and stay out of the range.</p>
    <p>Grok and Muse report no token usage. They appear hatched, because a blank is not the same as zero. Cost and quota are not captured, so no design shows them.</p>
    <p>Stages are built for desktop at 1440 by 900. Responsive layouts come after you choose a direction.</p>
  </footer>
</div>
<script>
const RT_TAG=${embed(dataTag)};
const C=${embed(concepts)};
(function(){
  const MAX_LIVE=2;
  const live=[];
  const stageOf=(card)=>card.querySelector('.stage');
  function fit(stage){
    const f=stage.querySelector('iframe');
    if(!f)return;
    const w=stage.clientWidth,h=stage.clientHeight,s=Math.min(w/1440,h/900);
    f.style.setProperty('--s',s);
    f.style.setProperty('--x',((w-1440*s)/2)+'px');
    f.style.setProperty('--y',((h-900*s)/2)+'px');
  }
  function stop(card){
    const i=live.indexOf(card);
    if(i>-1)live.splice(i,1);
    const stage=stageOf(card),f=stage.querySelector('iframe');
    if(f)f.remove();
    stage.querySelector('.poster').hidden=false;
  }
  function start(card){
    const stage=stageOf(card);
    if(stage.querySelector('iframe'))return;
    while(live.length>=MAX_LIVE)stop(live[0]);
    const f=document.createElement('iframe');
    f.title=card.querySelector('h2').textContent+' live mockup';
    f.setAttribute('sandbox','allow-scripts');
    f.srcdoc=C[card.dataset.id].replace('<!--RT-->',()=>RT_TAG);
    stage.prepend(f);
    fit(stage);
    stage.querySelector('.poster').hidden=true;
    live.push(card);
  }
  const cards=[...document.querySelectorAll('.concept')];
  const ro=new ResizeObserver((es)=>es.forEach((e)=>fit(e.target)));
  cards.forEach((c)=>ro.observe(stageOf(c)));
  if('IntersectionObserver' in window){
    const io=new IntersectionObserver((es)=>es.forEach((e)=>{
      const card=e.target.closest('.concept');
      if(e.isIntersecting)start(card);else if(document.fullscreenElement!==e.target)stop(card);
    }),{threshold:.25});
    cards.forEach((c)=>io.observe(stageOf(c)));
  }
  document.addEventListener('click',(ev)=>{
    const b=ev.target.closest('[data-act]');
    if(!b)return;
    const card=b.closest('.concept'),stage=stageOf(card),act=b.dataset.act;
    if(act==='run')start(card);
    if(act==='replay'){stop(card);start(card);}
    if(act==='full'){start(card);stage.requestFullscreen?.().catch(()=>{});}
  });
})();
</script>
`;



const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body style="margin:0">';
fs.writeFileSync(path.join(root, 'index.html'), head + body + '</body></html>');
console.log('index.html', (fs.statSync(path.join(root, 'index.html')).size / 1024).toFixed(0) + 'KB', 'families', families.length);
