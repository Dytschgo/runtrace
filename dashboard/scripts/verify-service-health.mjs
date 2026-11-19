// Real scratch-server termination/restart plus an explicitly injected stale snapshot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const repo = path.resolve('..');
const exe = path.join(repo, 'target/release/runtrace.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtrace-health-ui-'));
const config = path.join(root, 'config.toml');
const output = 'test-results/reliability';
fs.mkdirSync(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RUNTRACE_') && !k.startsWith('T3UI_')));
env.RUNTRACE_NOW = '2026-11-08T13:37:00Z';
const now = Date.parse(env.RUNTRACE_NOW);
const sock = net.createServer();
await new Promise((resolve) => sock.listen(0, '127.0.0.1', resolve));
const port = sock.address().port;
await new Promise((resolve) => sock.close(resolve));
const slash = (p) => p.replaceAll('\\', '/');
let text = fs.readFileSync(path.join(repo, 'config/default.toml'), 'utf8').replace('port = 4310', `port = ${port}`).replace('./data/t3-usage.duckdb', slash(path.join(root, 'data/fixture.duckdb'))).replace('./data/archive', slash(path.join(root, 'archive')));
text = text.replace('sqlite_path = ""', `sqlite_path = "${slash(path.join(root, 'absent.sqlite'))}"`).replace('collect_on_serve = true', 'collect_on_serve = false').replace('checks = true', 'checks = false').replace('notifications = true', 'notifications = false');
fs.writeFileSync(config, text + '\n[update]\ncheck = false\n');
const log = fs.openSync(path.join(root, 'serve.log'), 'a');
const base = `http://127.0.0.1:${port}`;
let server;
let browser;
async function start() {
  server = spawn(exe, ['serve', '--config', config], { env, windowsHide: true, stdio: ['ignore', log, log] });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Scratch service exited');
    try {
      const health = await (await fetch(base + '/health/ready', { signal: AbortSignal.timeout(2_000) })).json();
      if (health.pid !== server.pid) throw new Error('Unexpected port owner');
      if (health.ready) return health;
    } catch (e) { if (String(e).includes('Unexpected port owner')) throw e; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Scratch readiness timed out');
}
async function stop() {
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill('SIGKILL'); });
}
try {
  execFileSync(exe, ['fixture', '--now', env.RUNTRACE_NOW, '--config', config], { env, windowsHide: true, stdio: ['ignore', log, log] });
  const original = await start();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', timezoneId: 'Europe/Zurich' });
  await context.clock.install({ time: new Date(now) });
  const page = await context.newPage();
  await page.goto(base + '/?page=Overview');
  await expect(page.locator('.collector-notice')).toContainText('Automatic collection is off.');
  const fakeReady = (route) => route.fulfill({ json: { ready: true, poll_seconds: 60, collector: { state: 'synced', last_successful_sync_at: new Date(now - 10 * 60_000).toISOString() } } });
  await page.route('**/health/ready', fakeReady);
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.locator('.collector-notice')).toContainText('Collection is stale.');
  const staleAxe = await new AxeBuilder({ page }).analyze();
  expect(staleAxe.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: output + '/stale-390.png' });
  await page.unroute('**/health/ready', fakeReady);
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.locator('.collector-notice')).toContainText('Automatic collection is off.');
  await stop();
  await context.clock.fastForward(31_000);
  const offline = page.getByRole('alert').filter({ hasText: 'Cannot reach the local service.' });
  await expect(offline).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.screenshot({ path: output + '/offline-390.png' });
  const offlineAxe = await new AxeBuilder({ page }).analyze();
  expect(offlineAxe.violations).toEqual([]);
  const began = Date.now();
  const restarted = await start();
  expect(restarted.storage_identity).toBe(original.storage_identity);
  await offline.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(offline).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.locator('.collector-notice')).toContainText('Automatic collection is off.');
  console.log(JSON.stringify({ real_server_termination_detected: true, same_database_after_restart: true, recovered_ui_ms: Date.now() - began, stale_snapshot: 'injected readiness; real API liveness stayed up', stale_axe_violations: staleAxe.violations.length, offline_axe_violations: offlineAxe.violations.length, mobile_overflow: false }));
} finally {
  if (browser) await browser.close();
  await stop();
  fs.closeSync(log);
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('runtrace-health-ui-')) throw new Error('Unexpected cleanup target');
  fs.rmSync(root, { recursive: true, force: true });
}
