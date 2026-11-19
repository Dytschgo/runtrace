// Capture synthetic fixture pages for human review; never point this at private history.
import fs from 'node:fs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const dir = 'test-results/hill-climb';
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ timezoneId: 'Europe/Zurich', reducedMotion: 'reduce' });
await context.clock.install({ time: new Date('2026-11-08T13:37:00Z') });
const page = await context.newPage();
const result = [];
try {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of process.argv.length > 2 ? process.argv.slice(2) : ['Overview', 'Activity', 'Models', 'Harnesses', 'Projects', 'Threads', 'Agent Trees', 'Tool Calls', 'Quota and Resets', 'Storage', 'Data Quality', 'Settings', 'Search']) {
      await page.goto('http://127.0.0.1:4397/?page=' + encodeURIComponent(name) + (name === 'Search' ? '&q=synthetic' : ''));
      await page.getByRole('heading', { name, level: 1, exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      const path = dir + '/' + name.replaceAll(' ', '-') + '-' + width + '.png';
      await page.screenshot({ path, fullPage: true });
      const axe = await new AxeBuilder({ page }).analyze();
      result.push({ page: name, width, overflow, axe: axe.violations.map((v) => v.id), path });
      console.log(JSON.stringify(result.at(-1)));
    }
  }
} finally {
  fs.writeFileSync(dir + '/result.json', JSON.stringify(result, null, 2));
  await browser.close();
}
