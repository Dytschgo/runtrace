# Development and verification

Verified environment: Rust 1.95, Node 24, Windows x64. Cargo.lock and package-lock.json pin dependencies. The default bundled Windows build links DuckDB statically and is verified without a separate DLL. Custom dynamic builds require the matching DLL beside the binary or on PATH. A Cargo check alone does not prove runtime startup.

Keep the source checkout separate from installed files: the intended development location is `D:/Code/Runtrace/source`, while `bin`, `config`, `data` and `backups` belong to the live installation. Do not merge the checkout into the installation root or copy its live-data junction. Before project commands, dot-source `scripts/scratch-env.ps1 -Task <task-name>` so all six build/cache/scratch paths stay on D:.

Use a fresh Cargo target for release qualification after relocating the workspace. A copied target can retain absolute linker paths in build-script output even when Cargo considers its timestamp checks current. The migration qualification reproduced this with the embedded Windows manifest. Only the affected package's build-output/fingerprint pair was archived, hash-verified and invalidated; native dependencies and diagnostic evidence were preserved. The manifest test must pass after rebuilding. Do not treat a successful clippy check as proof that linking works.

Version-fixture builds must use a separate Cargo target from the main build. Round 24 reproduced a shared-cache collision: after compiling a private version fixture, a nominally fresh main build left the named executable at the fixture version. Archive and hash-verify the affected workspace cache units before invalidating them; preserve native dependencies and diagnostic evidence. A qualification receipt identifies one frozen executable by SHA-256. Later mutable build outputs are not interchangeable with that qualified file, even when their version strings match.

Build the installed release from the source checkout:

```powershell
./scripts/install.ps1
```

The installer preserves existing data/configuration and invokes the installed binary's stop command before replacement. For the live installation, use its `stop.ps1` and `start.ps1` wrappers and prepare a verified database/configuration rollback before replacing files. For source/debug development, scripts/build.ps1 retains the original workflow.

```powershell
. ./scripts/scratch-env.ps1 -Task verify
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
cd dashboard
npm ci
npm run build
cd ..
cargo build --release --workspace --locked
$env:RUNTRACE_EXE = Join-Path $env:CARGO_TARGET_DIR "release/runtrace.exe"
cd dashboard
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
| `RUNTRACE_EXE` / `RUNTRACE_T3UI` | Explicit service binary; otherwise browser setup uses `CARGO_TARGET_DIR/release/runtrace(.exe)` or the checkout target directory. |
| `RUNTRACE_KEEP_FIXTURE` | Keep the temporary directory after the run. |
| `RUNTRACE_BASE_URL` | Test a running service instead, such as `http://127.0.0.1:4310`. No fixture is built and the clock is left alone; tests that need the fixture's known moments skip. |

Tests that need a moment of the fixture name it through `FIXTURE` and `day(n, hh, mm)` in tests/fixture.ts, which count days back from midnight UTC of the fixture instant, the same way the fixture does. Change both together.

The frame-rate check (tests/frames.spec.ts) is its own Playwright project. It runs alone after the other tests, with the real browser clock, because a frame rate measured beside parallel browsers measures the machine. If another test fails it is not run; run it by itself with `npx playwright test --project=frame-rate --no-deps`.

`T3UI_NOW` is for tests only. Unset, the service uses the system clock exactly as before.

## State machines

Offline `runtrace import` now defaults to at most 112 MB of DuckDB memory and one database worker, independently of the configured serving budget. A lower configured memory budget is preserved. `--memory-limit-mb` (64–8192) and `--threads` (1–16) explicitly override the offline choices. `import --verify` keeps its previous at-most-128 MB default because it runs analytics rather than a backfill. The import JSON report includes the effective `import_memory_limit_mb` and `import_threads`. The database memory budget is not a process working-set cap. A 64 MB experiment failed checkpointing and a 96 MB late replay failed native work; do not infer that a smaller budget always works. The 112 MB candidate passes eight-batch late-checkpoint checks but its full import exceeds 400 MB; this remains an unqualified candidate, not a process-memory cap.

Imports commit at 1,000 changed rows or roughly 4 MiB of retained content, whichever arrives first. The content boundary prevents large tool outputs from remaining pinned for an entire 1,000-row transaction. Regression coverage checks every byte of 64 one-megabyte results at a 128 MB database budget and verifies an unchanged second import. Full-history memory qualification remains unproved after the bounded retry; see hill-climb-20261118.md. Windows MSVC binaries embed the segment-heap setting, which lowers measured working set in paired partial runs but does not prevent late native database-budget failures.

Collection (`serve` or `collect`) runs cold maintenance when the last successful check is at least one hour old. `archive compact` runs it explicitly with the service stopped. The default moves rows older than 30 days, preserving immutable Parquet files behind a transactional manifest. Reads begin their transaction before loading that manifest and install temporary logical views; do not query native tables directly for user-facing history. `cold_record_keys` supplies lightweight source freshness and membership without parsing old payloads. A corrected hot row shadows cold history, and the latest published generation wins after its next eviction. Failed publication rolls back hot deletion; unregistered files are ignored. Content expiry and purge are logical for existing immutable files, not physical erasure or automatic orphan cleanup.

Snapshot schema 4 flattens hot/cold history and includes quota samples/events. Restore accepts schemas 2–4 into a new database and applies the current installation purge ledger. Verification walks actual row IDs in bounded batches, including gaps and DuckDB transaction-local IDs. SQL time comparisons use Rust-registered `runtrace_time_us` / `runtrace_epoch_ms`; migration timestamps come from Rust. Do not introduce DuckDB ICU timestamp conversion or arithmetic.

Quota warning claims live in settings under `quota:notification:<hash>` and survive process restarts and normal snapshots. `quota_alerts::dispatch` accepts a sink for deterministic logic tests; the Windows CLI sink acknowledges `BalloonTipShown`, not merely process creation. `quota:notifications` contains the last check state and `quota:power` contains only paired observer sleep/wake timestamps. Native warning checks run after quota collection in `serve`, `collect` and `quota-collect`; `quota-notify` uses stored readings. Scratch collectors must explicitly set `notifications = false` unless the test intentionally displays warnings. Use `scripts/verify_quota_notifications.py --native` only for that qualification.

For direct access through a trusted local TLS proxy, keep `server.host = "127.0.0.1"` and add its exact public authority to `[server]`, for example `allowed_hosts = ["dashboard.example.test:12443"]`. Then point the proxy directly at Runtrace's loopback port. Entries have no scheme, path or wildcard; non-default public ports must be included. Empty or omitted `allowed_hosts` admits only exact loopback authorities on the configured service port. Other Host headers, duplicate Host headers, cross-origin requests and spoofed forwarded-host headers are rejected. This policy covers assets, API and health. The update installation action still requires localhost; allowing a dashboard host does not grant remote installation privileges. The live proxy mapping has not been changed by scratch qualification.

`python scripts/verify_supervisor.py --exe target/debug/runtrace.exe` qualifies supervised crash recovery and intentional stop on a fresh temporary database and unused port. `start` creates `runtrace.running` beside the logs; a supervisor holds `runtrace.supervisor.lock` for its lifetime and restarts only the child it owns. `stop` removes intent and waits for the supervisor to exit before stopping an older unsupervised service. Do not remove intent/lock files manually from a running installation. Autostart still requires explicit registration and actual logon qualification; these scratch checks do not prove it.

Windows detached creation excludes the caller's standard handles from incidental inheritance, then restores their flags. The new child uses explicit log handles. `python scripts/probe_start_return.py --exe target/release/runtrace.exe` proves a redirected PowerShell caller returns while its service remains alive. `scripts/verify_install.ps1` creates a fresh install on an unused port with collection/checks/notifications disabled, runs the actual installer and stop script, and checks the optional DLL copy. Stop development/preview processes using the checkout before `npm ci`; the installer now fails immediately if dependency installation fails.

`scripts/prepare_update_fixture.py` builds a newer version only inside a temporary source copy. Pass that executable and the current binary to `scripts/verify_update.py` to exercise the real updater against a local release server. The test includes checksum rejection, executable replacement, cold data equality, backup verification and start/stop. The synthetic newer version is never published or installed in the live folder.

`scripts/verify_direct_tailscale.py --exe target/release/runtrace.exe --existing-url <existing-HTTPS-link>` tests a separate temporary HTTPS port and removes only that port afterward. It asserts every pre-existing Serve handler is unchanged and the original link still answers. It never uses `tailscale serve reset`. The live direct mapping is qualified in Round 22; a real logon remains a separate pending acceptance gate.

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

Machine and containing-run status are global dashboard URL filters: `instance=machine-east&run_status=failed`. `run_status` accepts running, completed, failed and cancelled. The Tool Calls page retains its separate `status` parameter for individual call status. Unknown run statuses are rejected by the API. `usage/efficiency` reports whole-scope observed ratios and their coverage denominators; explicit run-attempt projection rows feed each run's normalized `attempts` summary. A missing attempt table or ordinal never means zero retries.

`global-filters.spec.ts` visits all thirteen pages at 1280/390 with both global filters selected, checks URL persistence/reload, API-backed efficiency, visible installation-wide quota/physical storage/collection reports and their scope labels, axe, overflow and navigation hit targets. Its captures use only the neutral fixture. Header overlap can exist without document overflow, so both checks are required.

`pending-scope.spec.ts` holds global-filter responses at both widths to check readable previous-selection totals. Picked-model requests are released independently of the global overview, and the displayed Prompts count must match their successful response. Loading skeletons and fresh picked counts must never inherit the unpicked query's previous-selection label. Selection and focus keep model names and coverage text at normal contrast; selected names remain underlined.

Harness comparison rates use only turns reporting a status. Missing statuses keep the Failed/Stopped columns visible with a coverage denominator; an all-zero shorthand is shown only for fully reported status history. `pages.spec.ts` covers 0/2, 1/2 and 2/2 status coverage at 1280/390, with axe and overflow checks. The single-harness cases also require distinct Balance labels, preventing a fallback from comparing a harness against itself.

Quota endpoints preserve their installation-wide values when `instance` or `run_status` is selected and add `scope` / `scope_reason` to their envelope. Storage applies scope to logical record counts/content/dates; file sizes, cold segments, maintenance and event-history totals remain installation-wide with `physical_scope` / `physical_scope_reason`. Data Quality keeps installation-wide collector reports with `collection_scope` / `collection_scope_reason`, alongside filtered record coverage. Browser/service settings remain explicitly installation-wide.

Exclusive offline `import` now publishes each committed batch's selected record/event identities to cold storage, including a nonempty final tail. Batches commit at 1,000 changed rows or roughly 4 MiB of retained content. Recent rows can therefore move before 30 days; unrelated hot rows remain untouched. `Options::archive_batches` enables this for the CLI, while normal collection keeps hourly age-based maintenance. Copy and native-restore checks run before publication. The selected bounded copy is ordered by physical row ID, matching exact verification even after deleted row groups are reused. A 3,005-output regression first reproduced the unordered-copy failure, then passed byte-for-byte with explicit ordering. This candidate still needs completed full-history memory and stress qualification.


Cold manifests persist absolute file paths at publication. Existing relative entries are re-anchored only after matching the stored checksum against their original location or the configured archive directory. An unresolved entry fails closed with an actionable error. Keep the configured archive directory with its database; changing the working directory does not relocate published files.

New purge ledger entries include the selected normalized record identities as well as the requested scope. Keep this current ledger with an older snapshot so corrections to project/thread attribution cannot resurrect those identities. Pre-existing scope-only entries retain their original semantics; they cannot reconstruct identities absent from that ledger. Restore applies the current content-retention policy before rebuilding derived facts/search caches. Hydration advances between actual pending row IDs, including transaction-local restored rows.

Run `python -m unittest discover -s scripts -p test_storage_qualification.py -v` for the benchmark's affirmative acceptance gates. `qualified` is false until every applicable stage passes; a low peak alone is insufficient.


Offline pending spill IDs are stored in `settings` in the same transaction as their hot rows. They are scoped to the source instance and project. Retry resumes that bounded queue before revision skipping, and clears it only after publication succeeds. A full offline import first drains all queues for its source instance, including prior thread-limited imports and projects no longer present in source discovery; other instances are untouched. Replaying a published but unacknowledged queue creates no duplicate files. Pause, dry-run and ordinary collector paths do not start this offline publication. Pending settings are retained in full snapshots.

After acknowledging each offline publication, ordinary `CHECKPOINT` releases resident index/deleted-row state before the next batch. It runs outside the import transaction; publication is already durable. A checkpoint error reports that publication and acknowledgement succeeded, rather than implying a failed copy. The pending queue stays cleared. Normal collection does not use this offline checkpoint policy. An isolated checkpoint replay shows more headroom in its next batch, but the full frozen-history measurement must qualify this candidate separately.


`python scripts/prepare_update_fixture.py --shared-target` builds a newer-version fixture in temporary source, uses the existing Cargo target with a distinct `runtrace-qualification` binary name, and asserts that the checkout manifest, lockfile and normal executable are unchanged. It avoids copying large C++ build caches. The version change exists only in that temporary fixture. Run `python scripts/verify_update.py --exe target/release/runtrace.exe --candidate <fixture-exe> --standalone` to qualify the default static build without a side-by-side DuckDB DLL, including a loaded-module check after update.


Updater rollback copies contain their own checksummed cold segments. Copied databases and WALs live in a dedicated `database/` subdirectory and completion metadata stays outside it. Generation allocation is exclusive, including repeated attempts for the same target in one second. The updater keeps the new completed copy, its completed predecessor and every older directory referenced by the active database. Incomplete and unmarked legacy directories are not automatically pruned. A rollback database file can still refer to its original rollback directory; keep that directory in place. Use archive snapshots for portable restores. A failed backup restarts a previously running service before returning the error, and the executable is not replaced.


The source installer and update-fixture builder also honor `CARGO_TARGET_DIR`. A relative value is resolved against the source checkout. Isolated update builds explicitly use their temporary target; shared qualification builds use a distinct binary name in the selected target. When copying an executable for a verification command, select it from that configured target rather than assuming `source/target` contains the latest build.


The 18 November local qualification installs the recorded candidate under `D:/Code/Runtrace/bin`, retaining the separate source checkout. Logon startup invokes that exact installed executable with its installed configuration. The existing Tailscale HTTPS port now forwards directly to loopback 4310; the relay process is stopped and its script is retained for rollback. A verified pre-transition database/WAL/executable/configuration generation is preserved under the installed backups directory. The real-session observer is armed, but registration alone earns no logon/reboot credit. See the current hill-climb report for proof and the user's deferred sign-in cycle.

Serve-time quota sampling owns a serial worker independent of import/maintenance. It starts immediately, uses a fresh connection per attempt and waits at most 60 seconds after each completed attempt. Failures and worker panics retry on fresh connections; `health/ready.quota_sampler` distinguishes pass progress from provider freshness. Quota history, offsets and the cold manifest are read in the same transaction. One transaction guard commits on success and owns rollback on error/panic. Provider `checked_at`, source timestamps and unavailable reasons still determine actual metric coverage. Test homes and caches are explicit parameters in focused native tests; do not redirect global user homes to create fixtures.
