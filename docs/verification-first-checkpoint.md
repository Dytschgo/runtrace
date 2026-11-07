# Executed verification

Environment: Windows x64, Rust 1.95.0, Node 24.18.0. Real T3 nightly `0.1.8-nightly.20261105.4234`. Local date 2026-11-06, timezone Europe/Zurich.

## Passing checks

- cargo build --workspace; cargo fmt --all --check.
- cargo clippy --workspace --all-targets -- -D warnings.
- cargo test --workspace: 14 tests, zero failures (1 MCP schema, 5 core unit, 8 synthetic integration/acceptance).
- npm run build: TypeScript and Vite pass; 669.92 kB JavaScript / 200.14 kB gzip, with a bundle-size advisory.
- npm test: 1 basic unit test, zero failures. This is not comprehensive component coverage.
- npm run test:e2e: 3 real-data browser journeys pass in 1.3s total: project/thread/agent-page navigation; responsive overview screenshot; explicit unsupported quota empty state.
- npm audit: zero vulnerabilities after updating Vitest to 5.1.0.
- python scripts/smoke.py: MCP initialize, twenty tools, timeline query and no ciphertext in query output. Tested both direct DuckDB access and fallback through the running HTTP server.
- Real importer: initial project import created 1,205 records from 106 threads. Restarted unchanged message-slice import returned changed=0. Rich tool/agent import subsequently added 4,310 records/revisions.

No remote hosted CI, cargo-audit, cargo-deny or nextest execution is claimed. No complete remote outage, 24-hour collection, source upgrade or million-event benchmark was executed.

Additional executed checks: scripts/api_contract.py passed twelve API reads and four rejection contracts (row-limit violation, foreign Origin, invalid Host and unknown route). MCP rejected an attempted `analytics:content-full` argument. A real event archive containing 6,548 revisions was written to Zstandard Parquet (753,664 bytes) and checksum-verified.

## Real local data

The imported Just Run It T3 project contains 193 user messages, 744 assistant messages, 174 run lifecycle records, 106 threads, 99 agent records and 4,210 tool records, plus project/instance metadata. These are imported projections, not a claim of complete personal history. Messages without provable terminal runs are excluded. All source-derived entities are conservatively partial. Raw content is redacted-only in this installation. No full encryption key was provisioned because encrypted capture was not enabled.

## Performance

Five sequential HTTP requests per operation, localhost, debug Rust build, 5,528 records and 6,455 event revisions at measurement time. Full machine-wide history was not imported. Results include JSON serialization and Python client overhead. See measurements.json.

| Query | Mean milliseconds |
|---|---:|
| Overview | 6.68 |
| Hourly prompts | 3.81 |
| Models | 6.27 |
| Projects | 6.03 |
| Thread page, 100 rows | 12.72 |
| Tool page, 100 rows with content | 167.64 |
| Capture quality | 3.11 |

DuckDB file measured 15,216,640 bytes before the final archive operation. During richer project import a sampled working set was about 286 MB, exceeding the 250 MB target. Source-wide message materialization and repeated per-record SQL are known bottlenecks. Browser journey timing is not a measured cold-start benchmark. One-year/million-row query behavior, search SLA, full-import duration and quota scheduling performance remain unverified. No target guarantee is inferred from these small-dataset measurements.

Final live project catch-up took 53.892 seconds and imported 93 changed/new entities while the source continued receiving activity. It discovered 109 threads; final hot records: 199 prompts, 760 answers, 179 runs, 102 agents, 4,269 tools, 109 threads, one project and one instance (5,620 records total). Event revisions: 6,548. A sampled working set on this pass was 315 MB. Counts changing between scans reflect active source activity; unchanged synthetic imports and the earlier real message-only slice both returned zero changes. The full richer importer has not been proven unchanged against a frozen real-source snapshot.
