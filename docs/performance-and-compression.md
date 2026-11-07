# Performance and lossless compression — 2026-11-06

## Workload and measurement

The ingestion comparison used a frozen read-only subset of the real T3 database: 112 threads, 185 runs, 1,056 messages, 10,366 turn items, 105 subagents, 211 provider turns and their node relationships. It occupied 150,929,408 bytes as SQLite. Baseline and optimized databases were separate. The temporary source copy was removed after measurement; the original T3 database was untouched. Captured benchmark databases retain redacted data under the configured capture policy. No real conversation content is committed as a fixture.

Results are in `D:/Code/Runtrace/benchmarks/{baseline,optimized-v2,optimized-release}/results.json`. First imports differ in telemetry coverage: the improved version imports 210 additional terminal provider-turn entities. Compare unchanged repeat runs for the cleanest performance signal. Background compilation/compression overlapped portions of first-run measurements, so their timings are not a controlled speed ratio.

| Build | First import | Unchanged repeat 1 | Unchanged repeat 2 | Warm peak working set |
|---|---:|---:|---:|---:|
| Original debug | 137.744 s | 57.940 s | 55.800 s | 71.3–71.5 MB |
| Improved debug | 87.261 s | 1.080 s | 1.134 s | 59.6–59.9 MB |
| Improved release | 32.224 s | 0.329 s | 0.329 s | 56.5–56.8 MB |

Both unchanged runs returned changed=0. Subsequent source refinements add project-scoped run reads, thinner lineage context, project checkpoints and 1,000-entity commit batches. Their synthetic tests pass; the earlier timing table is not silently relabeled as a measurement of those later refinements.

## What changed

- Source message/tool metadata is scanned through verified indexes; unchanged payloads are skipped before JSON decoding, redaction and writes.
- Revision fingerprints include source update time, terminal run state/completion, source version and privacy policy. Normalization adapter revisions are explicit. `--repair` bypasses this cache. Same-timestamp source corrections require repair.
- Prepared SQL replaces repeated parsing/planning for record, event and revision operations.
- Thread ancestry retains only lineage context; run payloads are read for the selected project. Messages/tools stream rather than collecting their entire history into memory.
- Import commits independently by project and every 1,000 changed entities. Record/event persistence stays atomic; a missing cache entry after a crash only causes safe reprocessing. Final project/global checkpoints advance only after successful completion. A late-source-failure regression test proves resumption without duplicate events.
- The service owns one DuckDB process with separate reader/writer connections. Queries can read committed snapshots during collection. Process readiness is verified over HTTP using the owned PID.
- List views return bounded previews after pagination. Explicit detail/timeline queries retain full stored redacted content. Ciphertext remains excluded from every analytics response.
- RFC3339 filters and ordering compare typed instants, including offset/fractional-second boundaries.

## Compression experiment

Thirteen combinations were tested on all 5,950 normalized records. Every column was compared in both directions with `EXCEPT ALL`, including duplicates, nulls and full content. SHA-256 checksums are recorded. Raw results: [compression-results.json](compression-results.json).

| Codec / level / group | File size | Write time | Median full tool-page retrieval |
|---|---:|---:|---:|
| Uncompressed / 16,384 | 37.30 MB | 107.8 ms | 31.16 ms |
| Snappy / 16,384 | 15.31 MB | 142.0 ms | 36.38 ms |
| Zstd 3 / 2,048 | 4.87 MB | 81.2 ms | 24.29 ms |
| Zstd 8 / 2,048 | 4.02 MB | 145.6 ms | 22.85 ms |
| Zstd 15 / 2,048 | 3.42 MB | 2,292.6 ms | 22.27 ms |
| Zstd 8 / 16,384 | 3.87 MB | 227.5 ms | 32.98 ms |

The selected default is Zstd level 8 with 2,048-row groups: about 89.2% smaller than the uncompressed Parquet candidate and faster retrieval on this workload. Level 15 is the smallest tested candidate, with roughly sixteen times the write CPU/time of level 8 at this group size; its small retrieval difference is within measurement noise. `storage.zstd_level` remains configurable.

Larger row groups do not establish their own advantage on a dataset smaller than one group. These are warm local release measurements with five retrieval samples, not one-year/million-row guarantees. Repeat with `t3ui storage benchmark` on a stopped service and representative current data before changing the policy.

Native DuckDB remains the hot query format. Complete Parquet snapshots contain records, events and recovery metadata; no content is truncated, downsampled or rounded, and no hot rows are deleted. This avoids introducing archive-union latency or data-loss risk while the cold query/eviction pipeline remains unfinished.

## Current limits

The broader live backfill has exceeded 250 MB working set despite smaller frozen-source measurements; observed samples were about 410–440 MB before the latest project-scoped run-memory refinement. DuckDB's configured memory limit is not a total-process RSS guarantee. Normal steady-state full-history memory, one-million-event query latency, cold-cache retrieval and a 24-hour remote outage still need measurement. Initial backfill can be CPU-heavy because every newly captured secret-bearing payload must be examined. Cache speedups do not remove that privacy work.

The implementation uses documented DuckDB concurrency and Parquet features: [concurrency](https://duckdb.org/docs/stable/connect/concurrency), [Parquet options](https://duckdb.org/docs/stable/data/parquet/overview), and [Apache Parquet compression](https://parquet.apache.org/docs/file-format/data-pages/compression/). No lossy compression is used.

## Production query and backup validation

Migration 003 adds lossless typed caches without changing original JSON. All fifteen original fields of 127,537 records matched the pre-migration backup exactly. Aggregates no longer parse nearly a gigabyte of JSON merely to count tokens or stored text. The real 128 MB allocation failure was reproduced; the same query succeeded with 512 MB, now the normal budget. Full snapshot verification uses an explicit offline 4 GB maintenance budget.

A registered production snapshot contains 140,975,087 bytes across complete normalized record/event/recovery files; it was exact-round-trip checked and checksum-verified. A frozen 127,537-record / 134,090-event snapshot restored in 9,767 ms, with all model aggregates matching. These sizes describe different checkpoint contents from the thirteen-candidate compression benchmark above; they are not mixed into that codec comparison.

The retained query path measured 264 ms for 100 tools, 429 ms for 500 tools, 72 ms for 500 provider turns and 1,598 ms for a full-content search on the same paused production checkpoint. The general late-fetch experiment regressed bulk pages and was rejected there. Six returned-page digests remained identical. Search indexing and the 300 ms large-page target remain open. Full evidence and conditions are in verification.md.


## Completed 34-project dataset: search cache (2026-11-06)

This continuation benchmark freezes **275,253 normalized records** from all 34 discovered projects. Runtime evidence is under `D:/Code/Runtrace/benchmarks/full-20261106/`; unlike the older tables above this is the completed discoverable dataset. Both release binaries used the same frozen DuckDB, four query threads, 512 MB budget, no collector on benchmark port 4311, and seven sequential HTTP requests per route. The original binary ran first, so this is a warm before/after comparison rather than a randomized cold-cache experiment.

Search `q=test&limit=25` improved from **2,311.99 ms median to 1,417.24 ms** (38.7% less latency). Complete response SHA-256 digests match for **all 14 routes**, including search, bulk tool pages, model/token aggregates and data quality. Other timings vary; no improvement is claimed for unchanged queries. Plans and rejected materialized-join/semijoin experiments are retained locally: both pagination alternatives regressed bulk retrieval and were rejected.

Migration 004 adds an exact nullable `search_text` cache derived solely from `data.content_redacted`. It avoids JSON extraction across every searchable payload, preserves ILIKE wildcard/Unicode semantics and ordering, and leaves the original JSON intact. New upserts maintain it atomically; purge removes it with its owning record; retention clears JSON, ciphertext and this cache in one statement. Bounded, independently committed hydration resumes after interruption. Snapshots retain the cache; older snapshots hydrate missing cache columns before returning from restore. The cache is derived, lossless data, not new telemetry. Native DuckDB compression remains in use; codec defaults and archive policy are unchanged.

Live investigation also reproduced intermittent HTTP 503 memory failures for `tool-calls?limit=500&offset=1500` at the normal 512 MB budget (one failure in three initial requests). These did not reproduce on the isolated frozen seven-request pass; they remain unresolved under concurrent collection. Unchanged full-instance collection remained about 12.6 seconds before this search change. Logs attribute roughly 3.3 seconds each to two large projects. Isolated project revision-cache reads totaled 1.33 seconds. A separate source read/parser diagnostic is recorded in `source-profile.json`; its full payload scans are **not** the unchanged collector's metadata-scan workload. No collector speedup is claimed.

Regression coverage includes cache replacement, null/empty/wildcard/Unicode search, ciphertext exclusion, purge, resumable hydration, retention, migration from the original schema and search after snapshot restore. The benchmark script now records HTTP failures and response digests instead of abandoning the entire report at the first failure. Conversation content is never written to benchmark JSON.


## Council iteration on the completed dataset

See [hill-climb report](hill-climb-20261106.md) for the independently accepted collector/query/storage improvements. The later iteration supersedes the unresolved bulk-query failure noted in the preceding historical section: 280 alternating preview/full requests over three healthy collection cycles passed at 512 MB. Warm unchanged collection fell from 11,298 to 6,805 ms median. Full streamed snapshot and restoration now pass on 275,336 records; the snapshot is 570,052,805 bytes including events/recovery metadata. Old sorted full export failed at the same offline 4 GB budget. Codec defaults remain unchanged.


The later [search/token visibility iteration](search-and-token-visibility-20261106.md) replaces the raw derived cache with DuckDB-lowercase cache adapter v2, improves seven paired full-content search workloads and documents the intentional ASCII-only Unicode correction. Original JSON remains exact. See its separate benchmark conditions and one-time conversion cost.
