# Executed verification — 2026-11-06 performance iteration

Windows x64, Rust 1.95, Node 24, inspected T3 nightly 0.1.8-nightly.20261105.4234. Production binaries, config, database, archives and logs live in D:/Code/Runtrace. Source remains in C:/Users/DylanFerraro/.t3/projects/runtrace.

## Executed checks

- Rust workspace: 37 tests passed (1 MCP schema, 5 core unit, 31 acceptance/integration); no ignored tests. Cargo fmt and clippy with -D warnings passed.
- Frontend: TypeScript/Vite production build and all 91 unit/component tests passed. Current split bundle starts with about 304 kB JavaScript (96 kB gzip), with charts loaded separately.
- Browser: the real-data suite exercises all eleven pages, project/thread/agent journeys, actual API counts/tokens/tree edges, search/tool details, URL filters, keyboard paths, empty/failure cases, axe checks and 390px overflow. All 37 tests passed in the final integrated run (50.8 seconds), including database-wide tool rankings and incomplete import coverage.
- API: twelve reads and four rejection contracts passed (limit 501, foreign Origin, invalid Host, unknown endpoint).
- MCP: initialization, twenty tool schemas, ten returned timeline rows, ciphertext exclusion and rejected full-content scope escalation passed through the installed binary.
- MCP identity: a separate locked database/service accepted its matching client and rejected a client aimed at the production port before returning content.
- Encryption: authenticated round trip and wrong-key failure, policy transitions and structured JSON secret cases passed. Production remains redacted-only; no production content key was provisioned.
- Migration: all fifteen original columns across 127,537 records matched the stopped pre-migration backup exactly. Zero differences. Sequential bounded verification completed in about 26 seconds after random index-based verification proved unnecessarily expensive.
- Archive: a 127,537-record / 134,090-event frozen snapshot passed exact bidirectional field comparison and checksums, then restored into an empty database in 9,767 ms. All fourteen model groups matched via the shared MCP query layer.
- A newer production snapshot was registered and archive verification passed for it and the retained legacy event archive. Its six Parquet files occupy 140,975,087 bytes. Hot rows were retained.
- Six entity-page response digests were identical before and after query-path changes. Conversation content was not written to comparison evidence.

Hosted CI, cargo-nextest, cargo-audit, cargo-deny, a 24-hour remote outage, manual screen-reader audit and a million-event performance proof were not executed.

## Real-data checkpoint and quality

The measured checkpoint had 127,537 records: 21 projects, 1,898 threads, 5,228 runs, 6,705 prompts, 25,426 answers, 665 agents, 85,746 tools, 1,843 provider turns, four Just Run It correlations and one instance. These are imported observations, not a completed machine-wide history claim.

All source entities are conservatively partial. Unknown individual model calls, resolved model, cost, first-token timing, native-subagent token split and historical quota remain unavailable. Legacy messages without terminal-run evidence are withheld. There were zero missing thread relationships in the measured imported subset. Full source backfill continues independently; Data Quality shows checkpoints and committed progress rather than declaring it complete.

## Query measurements

Five sequential samples per operation, release build, localhost HTTP including JSON/client overhead, same paused 127,537-row checkpoint, 512 MB DuckDB budget. Some source fields were re-redacted before measurement; all before/after comparisons below use the same frozen production state.

| Query | Original median ms | Retained query path median ms |
|---|---:|---:|
| Overview | 2.20 | 2.32 |
| Models | 17.12 | 5.93 |
| Usage by project | 10.27 | 6.84 |
| Tool aggregates | 31.74 | 22.80 |
| Threads, 100 | 55.47 | 47.06 |
| Tools, 100 | 640.61 | 264.05 |
| Tools, 500 / offset 1,500 | 607.01 | 428.59 |
| Provider turns, 500 | 152.45 | 71.71 |
| Storage | 27.29 | 30.02 |
| Search, test / 25 | 2,151.98 | 1,598.35 |

A general two-stage ID fetch regressed large pages and was rejected for those paths. The retained approach uses narrow late fetch only for small tool pages, preserves sequential bulk queries and moves JSON reconstruction after pagination. Read snapshots keep multi-statement pages consistent. Timing variation in unaffected aggregate paths is not all attributed to this change.

Search still misses the one-second target; 500-tool pages miss 300 ms on this dataset. No fabricated performance guarantee is made. Initial backfill working set has exceeded 250 MB. Earlier observed peaks were 410–500 MB; later scoped importer samples have been around 280–300 MB, not a steady-state guarantee.

Raw evidence: production-before-pagination.json, production-after-pagination.json (rejected general path), production-hybrid-pagination.json, page-query-verification.json, restore-verification.json and performance-and-compression.md. Source and benchmark databases stay local under D:/Code/Runtrace; real conversations are not committed as fixtures.

Final provenance regression: a newer source timestamp with identical content advances record freshness without creating duplicate events; a stale repeat cannot regress that timestamp. The additional regression passed in the final 37-test Rust suite. The latest sampled large-project backfill working set again exceeded 400 MB; the 250 MB target remains unmet.

Latest operating observation (during the continuing backfill): 144,555 source records, all conservatively labelled partial; complete/inferred/unavailable record counts were zero. Field-level unavailable telemetry remains null rather than represented by fake records. Twenty of 34 project scopes had completed the current pass, with project 21 committing further batches. Zero missing thread links were observed in the imported subset. Counts continue changing while collection runs.


Continuation search-cache checks: 39 Rust tests passed (1 CLI/MCP, 5 core, 33 acceptance), cargo fmt check and clippy with warnings denied passed. Seven-request before/after measurements on the same frozen completed 34-project dataset produced matching complete response digests for all 14 routes. See performance-and-compression.md and D:/Code/Runtrace/benchmarks/full-20261106. No frontend files changed and the earlier frontend/browser suites were not rerun for this backend cache change.

Deployed migration 004: exact comparison against D:/Code/Runtrace/backups/pre-search-cache-20261106/t3-usage.duckdb found zero changed original rows. Production binary SHA-256 matches the tested release build. All 14 deployed routes succeeded in three-request samples; search median was 1430.75 ms. Twelve API read contracts plus four rejection cases passed; twenty MCP tools initialize, timeline retrieval works, full-content escalation is rejected, matching database proxy identity is accepted and mismatched identity is rejected. Post-deploy health: 34/34 synced, changed=0, zero project errors/orphans, unchanged import 12200 ms. Collection remains enabled.

Latest council iteration: 44 Rust tests pass, fmt/clippy pass, all14frozen API existing fields equivalent, original record/event rows unchanged, 280+60 deployed stress requests with zero failures, full275336-record snapshot/checksums/restore pass. Every restored field was included in identity-keyed SHA256 comparisons across all6tables, zero differences. See hill-climb-20261106.md for precise scopes, budgets, one-time cache cost and council dispositions. Frontend unchanged; prior browser suites were not rerun.

Search/cache-write visibility continuation:46Rust,94frontend tests and40browser journeys verified; the initial full39journey run passed37, withtwo fixture/selector failures subsequently fixed andrerun, plusnewcache-onlycoveragecase. Three targeted journeys passed deployed. Pairedseven-query API responses andten full matching-ID sets preserved; fifteen originalfields exactzero differences. Fullv1cache snapshot275336records restored/upgraded121.047s at4GB,correctcacheforallrows. Installedhashes/assetidentity match;60deployed concurrentbulkrequests zero failures,34/34healthy. See search-and-token-visibility-20261106.md.
