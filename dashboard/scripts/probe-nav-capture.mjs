// Diagnostic: compare hidden tooltip paint with an unrendered tooltip control.
import fs from 'node:fs';
import { chromium } from 'playwright';
process.env.RUNTRACE_FIXTURE_PORT = '4397';
const { default: setup } = await import('../tests/global-setup.ts');
const teardown = await setup();
const browser = await chromium.launch({ headless: true, args: process.argv.includes('--software') ? ['--disable-gpu'] : [] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', timezoneId: 'Europe/Zurich' });
  await context.clock.install({ time: new Date('2026-11-08T13:37:00Z') });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4397/?page=Storage');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  fs.mkdirSync('test-results/nav-probe', { recursive: true });
  const styles = await page.locator('.nav-tip').evaluateAll((nodes) => nodes.map((el) => ({ text: el.textContent, visibility: getComputedStyle(el).visibility, opacity: getComputedStyle(el).opacity, display: getComputedStyle(el).display })));
  await page.screenshot({ path: 'test-results/nav-probe/viewport.png' });
  await page.screenshot({ path: 'test-results/nav-probe/before.png', fullPage: true });
  await page.addStyleTag({ content: '@media (min-width: 761px) { .nav-tip { display: none; } .nav-link:hover .nav-tip, .nav-link:focus-visible .nav-tip { display: block; } }' });
  await page.screenshot({ path: 'test-results/nav-probe/control.png', fullPage: true });
  const heading=await page.locator('h1').evaluate((el)=>({color:getComputedStyle(el).color,opacity:getComputedStyle(el).opacity,visibility:getComputedStyle(el).visibility}));
  await page.locator('.nav-link').first().hover();
  await page.locator('.nav-tip').first().waitFor({state:'visible'});
  console.log(JSON.stringify({ styles,heading,hoverVisible:await page.locator('.nav-tip').first().isVisible(), before: 'test-results/nav-probe/before.png', control: 'test-results/nav-probe/control.png' }));
} finally {
  await browser.close();
  await teardown();
}
