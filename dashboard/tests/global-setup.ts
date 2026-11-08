import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the synthetic fixture into a fresh temporary directory, outside the repository, and serves it on its own port
// with the service's clock pinned to the fixture's instant. The returned function is the teardown: it stops exactly the
// process started here, by its PID, and removes the directory.
// Nothing here touches another installation, its data or its port.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_PORT = Number(process.env.RUNTRACE_FIXTURE_PORT ?? 4398);

function executable() {
  const named = process.env.RUNTRACE_T3UI;
  const exe = named ?? path.join(repo, 'target', 'release', process.platform === 'win32' ? 't3ui.exe' : 't3ui');
  if (!fs.existsSync(exe)) throw new Error(`No service binary at ${exe}. Build it with "cargo build --release", or name one in RUNTRACE_T3UI.`);
  return exe;
}

/** DuckDB is linked dynamically on Windows, so its DLL must be on the PATH when it is not beside the binary. */
function duckdbDir(exe: string) {
  if (fs.existsSync(path.join(path.dirname(exe), 'duckdb.dll'))) return null;
  const build = path.join(path.dirname(exe), 'build');
  if (!fs.existsSync(build)) return null;
  const found = fs.readdirSync(build).filter((d) => d.startsWith('libduckdb-sys')).map((d) => path.join(build, d, 'out')).find((d) => fs.existsSync(path.join(d, 'duckdb.dll')));
  return found ?? null;
}

const toml = (p: string) => p.replace(/\\/g, '/');

async function ready(port: number, pid: number, child: ReturnType<typeof spawn>, log: string) {
  const deadline = Date.now() + 60_000;
  let exited: number | null = null;
  child.once('exit', (code) => { exited = code ?? -1; });
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`t3ui serve exited with ${exited}. Log:\n${fs.readFileSync(log, 'utf8')}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      const body = await res.json() as { ready?: boolean; pid?: number };
      // Port taken by something else: never test against it.
      if (body.pid !== pid) throw new Error(`Port ${port} answers for process ${body.pid}, not the fixture service ${pid}. Free the port or set RUNTRACE_FIXTURE_PORT.`);
      if (body.ready) return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Port ')) throw error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`t3ui serve did not become ready on port ${port}. Log:\n${fs.readFileSync(log, 'utf8')}`);
}

export default async function globalSetup() {
  if (process.env.RUNTRACE_BASE_URL) return;
  const now = process.env.RUNTRACE_FIXTURE_NOW ?? '2026-11-08T13:37:00.000Z';
  const exe = executable();
  const dist = path.join(repo, 'dashboard', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('The dashboard is not built. Run "npm run build" in dashboard/ first.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtrace-fixture-'));
  const config = path.join(dir, 'config.toml');
  fs.writeFileSync(config, [
    '[server]', 'host = "127.0.0.1"', `port = ${FIXTURE_PORT}`,
    '[dashboard]', 'timezone = "Europe/Zurich"', `assets_path = "${toml(dist)}"`,
    '[storage]', `duckdb_path = "${toml(path.join(dir, 'fixture.duckdb'))}"`, `archive_path = "${toml(path.join(dir, 'archive'))}"`,
    'hot_retention_days = 30', 'content_retention_days = 90', 'zstd_level = 3', 'memory_limit_mb = 1024',
    '[capture]', 'default_policy = "redacted_only"', 'store_stream_chunks = false',
    // No real source is ever read: the path does not exist and collection is off.
    '[source]', 'instance_id = "local"', 'display_name = "Fixture"', `sqlite_path = "${toml(path.join(dir, 'no-source.sqlite'))}"`, 'poll_seconds = 60', 'collect_on_serve = false', '',
  ].join('\n'));

  const env: NodeJS.ProcessEnv = { ...process.env, T3UI_CONFIG: config, T3UI_NOW: now };
  // These would point the service at another database or source.
  delete env.T3UI_DB;
  delete env.T3UI_SOURCE;
  const dll = duckdbDir(exe);
  if (dll) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[key] = `${dll}${path.delimiter}${env[key] ?? ''}`;
  }

  const started = Date.now();
  const report = execFileSync(exe, ['fixture', '--now', now], { env, cwd: dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'fixture-report.json'), report);
  const log = path.join(dir, 'serve.log');
  const out = fs.openSync(log, 'a');
  const child = spawn(exe, ['serve'], { env, cwd: dir, stdio: ['ignore', out, out], windowsHide: true });
  const pid = child.pid;
  if (!pid) throw new Error('t3ui serve did not start');
  fs.writeFileSync(path.join(dir, 'serve.pid'), String(pid));
  try {
    await ready(FIXTURE_PORT, pid, child, log);
  } catch (error) {
    child.kill();
    throw error;
  }
  console.log(`Fixture at ${now} built and served in ${((Date.now() - started) / 1000).toFixed(1)} s: http://127.0.0.1:${FIXTURE_PORT} (pid ${pid}, ${dir})`);

  return async () => {
    // Exactly the process started above, by its PID. Nothing is stopped by name.
    if (child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      process.kill(pid);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
    }
    fs.closeSync(out);
    if (process.env.RUNTRACE_KEEP_FIXTURE) console.log(`Fixture kept in ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
