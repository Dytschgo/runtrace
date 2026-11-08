# Development and verification

Verified environment: Rust 1.95, Node 24, Windows x64. Cargo.lock and package-lock.json pin dependencies. DuckDB is dynamically linked on Windows; the DLL must sit beside the binary. A Cargo check alone does not prove runtime startup.

Build the installed release from the source checkout:

```powershell
./scripts/install.ps1
```

The installer preserves D:/Code/Runtrace data/configuration and refuses to replace a running installed binary. Stop that runtime before upgrading. For source/debug development, scripts/build.ps1 retains the original workflow.

```powershell
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
cd dashboard
npm ci
npm run build
npm test
npm audit
npx playwright test
cd ..
python scripts/api_contract.py
$env:T3UI_CONFIG='D:/Code/Runtrace/config/default.toml'
$env:T3UI_EXECUTABLE='D:/Code/Runtrace/bin/t3ui.exe'
python scripts/smoke.py
```

Browser tests exercise the built app against a synthetic fixture history (below), plus deterministic failure/empty states. Screenshots are written to dashboard/test-results; the reviewed overview is copied to docs/screenshots/overview.png. Synthetic Rust fixtures contain no real conversations or credentials. MCP smoke subprocesses explicitly decode UTF-8 on Windows.

core/importer.rs is the verified source adapter. Storage, privacy, analytics, quota and compression have separate modules; API/MCP live in the CLI crate. Add versioned migrations for analytics changes. Never migrate or write the T3 source DB. Source diagnostics print row positions/schema errors, not captured content.

Performance experiments must state build, dataset, concurrent work, samples and coverage. See performance-and-compression.md and scripts/benchmark_import.py. Hosted CI was authored but not run. cargo-nextest, cargo-audit and cargo-deny were not installed during this session.

## Browser tests on the fixture

`npx playwright test` builds a small synthetic history and tests against it, so a run gives the same result on any day and at any hour. It needs the release binary and the built dashboard of this checkout:

```powershell
cargo build --release
cd dashboard
npm ci
npm run build
npx playwright test
```

What happens (dashboard/tests/global-setup.ts):

1. A fresh directory is made under the system temp folder, outside the repository, with a config for port 4398, `collect_on_serve = false`, this checkout's `dashboard/dist`, and a DuckDB file in that directory. The source path points at nothing, so no real T3 database is ever read.
2. `t3ui fixture --now <instant>` fills the empty database. The command is hidden and refuses a database that already holds rows. Every record is placed relative to `--now` and nothing is random, so one instant always gives the same records. crates/core/src/fixture.rs describes the layout: session-log hours only before day 88, a 15-day stretch with no records, provider turns from five providers and eleven models (plus turns that name no model), delegation trees, tool calls with redacted placeholder secrets, and Codex and Claude quota with resets past and future and limits hit.
3. `t3ui serve` starts with `T3UI_NOW` set to the same instant, so quota queries compare resets with that instant instead of the wall clock. The setup waits for `/health/ready` and checks the PID it answers with is the process it started.
4. Each browser context gets the same instant on its clock (`context.clock.install`, in tests/fixture.ts). Time runs on from there, so timers and React Query keep working, and the dashboard's own time zone stays Europe/Zurich.
5. When the run ends, exactly that service process is stopped by its PID and the directory is removed. Set `RUNTRACE_KEEP_FIXTURE=1` to keep it for a look.

Options:

| Variable | Effect |
| --- | --- |
| `RUNTRACE_FIXTURE_NOW` | The instant to build and test at. Default `2026-11-08T13:37:00.000Z`. `2026-11-08T01:00:00Z` is 02:00 in Zurich. |
| `RUNTRACE_FIXTURE_PORT` | Port for the fixture service. Default 4398. |
| `RUNTRACE_T3UI` | Another service binary than `target/release/t3ui(.exe)`. |
| `RUNTRACE_KEEP_FIXTURE` | Keep the temporary directory after the run. |
| `RUNTRACE_BASE_URL` | Test a running service instead, such as `http://127.0.0.1:4310`. No fixture is built and the clock is left alone; tests that need the fixture's known moments skip. |

Tests that need a moment of the fixture name it through `FIXTURE` and `day(n, hh, mm)` in tests/fixture.ts, which count days back from midnight UTC of the fixture instant, the same way the fixture does. Change both together.

The frame-rate check (tests/frames.spec.ts) is its own Playwright project. It runs alone after the other tests, with the real browser clock, because a frame rate measured beside parallel browsers measures the machine. If another test fails it is not run; run it by itself with `npx playwright test --project=frame-rate --no-deps`.

`T3UI_NOW` is for tests only. Unset, the service uses the system clock exactly as before.

## State machines

Behaviour that is really a set of states lives in one named place, so a page, a command or an agent reads the state instead of re-deriving it from flags.

| What | Where | States |
|---|---|---|
| Background collector | `crates/cli/src/collector.rs` (`CollectorStatus::after`) | `disabled`, `starting`, `synced`, `partial`, `paused`, `retrying`, `failed`. The last good sync time survives failures and pauses; a crashed import round retries with a fresh connection. Reported as `collector` in `/health/ready`. |
| Updates | `crates/cli/src/update.rs` (`UpdateStatus`) | `disabled`, `not_checked`, `up_to_date`, `available`, `applying`, `apply_failed`. One update at a time; an updater that exits while the service still runs is `apply_failed` with its log. Reported by `GET /api/v1/update`. |
| The service on this install's port | `crates/cli/src/control.rs` (`probe`, `Service`) | `stopped`, `running`, `port_in_use`. `start`, `stop`, `status` and `open` all decide from it; `runtrace status --json` prints it. |
| Record hydration | `crates/core/src/storage.rs` (`FACTS_*`, `SEARCH_CURRENT`) | `facts_version` moves FACTS_NONE → FACTS_BASE → FACTS_CURRENT; retention sends a record back to FACTS_NONE. |
| Where a value stands in the dashboard | `dashboard/src/lib/load.ts` (`Load`, `fromQuery`, `fromQueries`) | `loading`, `failed`, `ready` (with `stale` after a failed refresh). `Async` and `StatValue` render it; several queries summed together are ready only when all are. |
| Whether loaded turns cover a window | `useLiveTurns(...).coverage(since)` in `dashboard/src/lib/data.ts` | `loading`, `failed`, `ready`. Overview, Threads and Agent Trees all use it. |
| Tool sample, then full read | `useToolAnalysis` in `dashboard/src/lib/data.ts`, `ScanNote` | sample, reading (with progress per filter), complete, failed with retry. |
| Update dialog | `dashboard/src/components/UpdateNotice.tsx` (`Phase`) | idle, starting, waiting, slow, failed; follows an update another tab started. |

Gestures keep their state in refs and are named in comments where they live: the time slider (idle, pressed, dragging, typed), the chart's pinned reading (held by bucket time), the story player (playing, paused, ended), and the Overview's one-way history latch.
