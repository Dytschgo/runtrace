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
$env:RUNTRACE_BASE_URL='http://127.0.0.1:4310'
npx playwright test
cd ..
python scripts/api_contract.py
$env:T3UI_CONFIG='D:/Code/Runtrace/config/default.toml'
$env:T3UI_EXECUTABLE='D:/Code/Runtrace/bin/t3ui.exe'
python scripts/smoke.py
```

Browser tests exercise the built app and real history, plus deterministic failure/empty states. Screenshots are written to dashboard/test-results; the reviewed overview is copied to docs/screenshots/overview.png. Synthetic Rust fixtures contain no real conversations or credentials. MCP smoke subprocesses explicitly decode UTF-8 on Windows.

core/importer.rs is the verified source adapter. Storage, privacy, analytics, quota and compression have separate modules; API/MCP live in the CLI crate. Add versioned migrations for analytics changes. Never migrate or write the T3 source DB. Source diagnostics print row positions/schema errors, not captured content.

Performance experiments must state build, dataset, concurrent work, samples and coverage. See performance-and-compression.md and scripts/benchmark_import.py. Hosted CI was authored but not run. cargo-nextest, cargo-audit and cargo-deny were not installed during this session.
