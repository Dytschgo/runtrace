# Performance and lossless compression

Latest qualification, 18 November: the bounded segment-heap attempt peaks at 328.339 MB working set / 320.709 MB private commit, but completes only 27/36 projects before native database-budget failures. Its concurrent NT-heap control peaks at 406.147 MB and completes 29/36. Neither qualifies a complete import or reaches the mixed-request stage. The prior 112 MB / one-worker candidate was stopped at 401.560 MB. Earlier sections retain historical budgets/results. No first full import has yet qualified under 400 MB. See [the current report](hill-climb-20261118.md), Round 17, for exact scope and executable distinctions.

## Workload and measurement

### Full-source serving qualification — 18 November 2026

The final candidate `a2ed3e44de1da3bd917555acc3f283b4e3ff1771724bae58a26f9ebbb28b115f` serves the resumed immutable history with 36/36 projects, 4,583 discovered threads, no partial sync and zero project errors. This follows a stopped partial offline import and resumed normal collection; it is not a fresh full offline import under 400 MB.

| Measurement | Result |
| --- | ---: |
| Seed | 2026111821 |
| Mixed requests / workers / route types | 500 / 4 / 12 |
| HTTP 200 / HTTP 503 | 500 / 0 |
| Workload time | 199.797 s |
| Median / p95, HTTP plus JSON handling | 1,110 / 4,640 ms |
| Serving database budget | 2,048 MB |
| Observed process working set, not lifetime peak | 2,688,536,576 bytes |
| Automatic maintenance moved rows / segments | 163,032 / 65 |
| Later explicit compaction moved rows / segments | 62,977 / 17 |
| Complete post-move snapshot records / tables | 380,746 / 8 |
| Snapshot Parquet bytes | 800,663,523 |

The successful collector timestamp advances from 16:10:49.958 to 16:14:03.695 UTC during requests. The seeded workload includes bulk/offset/full-content tools, turns, models, projects, tool aggregates, field quality and quota. Automatic and explicit compaction report exact copy/native-restore checks. Complete snapshot restore succeeds. Independent all-column verification matches all eight tables, including all 40 record columns, with zero row-hash multiplicity differences. Observed unordered scan sequences differ; stored-value equality is checked independently of scan order. The 2 GB serving budget matches the inspected installed configuration; it is not a total-process cap, and the 400 MB first-import gate remains failed. No clean-machine speed comparison is claimed.

Evidence: `runtrace-harness-final-large-stress.log`, the scratch result, `target/evidence/harness-final-large-stress-summary.json`, and `runtrace-harness-final-large-restore.log`. The live service remains unchanged. The initial-readiness timeout and same-database continuation are recorded in hill-climb-20261118.md.

### Historical ingestion comparison

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

Qualification on 17 November 2026 uses a fresh scratch database, a frozen read-only SQLite snapshot, this checkout's release build, the default 2,048 MB DuckDB budget, and Windows `GetProcessMemoryInfo.PeakWorkingSetSize`. The first full import has already reached **628,064,256 bytes (628.064 MB decimal)**. This is an observed lower bound while the run is active, not its final peak; it already fails the requested 400 MB ceiling. No memory improvement is claimed. `scripts/qualify_storage.py` records the completed measurement and runs 500 seeded mixed requests with four workers during collection. Results must include a complete import and an advancing healthy collector; merely receiving no 503 responses is insufficient.

Later observation of that run reached **2,037,829,632 bytes (2,037.830 MB decimal)**. The process subsequently used less memory; a peak is a high-water working set, not current usage or a speed measurement. A second first-import experiment uses the same frozen source with a 128 MB database budget. Both are still active at this report checkpoint. Their overlap prevents a controlled speed comparison. The source snapshot has 39 project rows, 4,583 thread rows and 14,638 run rows; no titles or project names are included in the evidence report.

Those two failing runs were subsequently aborted: observed peaks were **2,149.380 MB** and **414.593 MB**, respectively, before completion. They do not qualify the first-full-import gate. A focused 64 × 1 MiB neutral-output import reproduced a partial-project database memory failure at 128 MB. Committing by content bytes as well as row count fixed that case: the same release workload completed with a **355.115 MB** peak and exact content preservation. With one import worker it completed at **353.198 MB**. This is a scoped failure fix, not a full-history memory result or a speed improvement claim. A 64 MB budget failed checkpointing.

The byte-bounded full-history candidate at 128 MB / one worker was stopped after reaching **440.807 MB** without completing. It fails the ceiling. Focused 64-output cases at 80 MB and 96 MB completed at **307.360 MB** and **324.243 MB**. A full frozen-history 80 MB / one-worker run is active, with **322.060 MB** observed at 18:23 local time on November 17. This is provisional, not a completed-import pass. The following mixed API qualification is planned for 500 seeded requests, four clients and a separate 2,048 MB serving budget. `runtrace import` still defaults to at most 128 MB pending complete evidence; it reports its effective budget/workers and does not change service configuration.

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

## Registered cold storage — 2026-11-17

Collection checks hourly for `hot_retention_days` (default 30). Records, events and quota history move in bounded batches into Zstd Parquet with the configured compression level and 2,048-row groups. Every selected column is compared before eviction and again after restoration into native temporary columns. Hot deletion, cold manifest and compact identity indexes commit atomically. Files without a committed manifest are ignored. Reader transactions union current cold generations with hot replacements and apply tombstones and content expiry.

The 85-test workspace run passes exact full-content equality across 16 API routes before eviction, after eviction and after snapshot restore. It also covers concurrent reader snapshots, replacement generations, same-content freshness, purge/reopen, expiry, zero unchanged reimports and four injected interruption stages. Snapshot schema 4 includes logical hot/cold rows and quota tables, with no dependency on the original cold directory after restore. This is correctness evidence on neutral synthetic history, not a full-history performance measurement or a power-loss qualification. Full-history cold query latency and the 500-request concurrent pass remain pending.

The full 80 MB import later failed during checkpointing; its observed peak does not qualify. A fresh 96 MB / one-worker full run is pending. The synthetic service qualification automatically moved 139 rows into seven verified segments, but its 500 requests returned **410 HTTP 200 and 90 HTTP 503** in **19.641 seconds**, with an advancing collector. The failure reproduced on hot data too: DuckDB's JSON envelope builder exhausted the 2,048 MB budget on 64 one-megabyte outputs, while raw JSON reads/merges succeeded. Rust now assembles full response envelopes per row; the hot/cold regression passes, and the original HTTP workload is being rerun. No successful 500-request result is claimed yet.

After that fix, the identical seeded workload passed **500 HTTP 200 / zero 503**, four clients, with a synced collector advancing across the run. It included 53 full-content tool pages. Observed duration **24.578 s**, median **140 ms**, p95 **687 ms**. The serving budget was 2,048 MB. Its synthetic 64 × 1 MiB source first imported completely in **5.828 s**, peaking at **305.680 MB**, at an 80 MB / one-worker import budget. This is not the full-history memory gate. Compilation/browser work overlapped, so these timings do not establish a speed ratio. The 96 MB full-history qualification remains active.

The 96 MB / one-worker full import subsequently failed after **3,111.063 seconds**, at a measured peak of **371,736,576 bytes (371.737 MB decimal)**. The exit code was 1. DuckDB invalidated the database after rollback could not pin another 256 KiB at **91.4/91.5 MiB** of its engine budget. This stayed under 400 MB but did not finish, so it does not satisfy the gate. Raw logs and result metadata are in the local temporary `runtrace-storage-trlowlna` directory. An obsolete 15,645,663,232-byte raw source copy from a stopped earlier experiment was removed after checking process ownership and the retained frozen input; this reclaimed disk space without touching the source or live installation. The memory error is not attributed to disk pressure.

Cold expiry/purges hide content logically. Immutable bytes remain in older files and backups, and crash-orphan files are not automatically removed. Disk usage must not be presented as only the newest logical rows. The storage API reports registered segment bytes/counts and the last maintenance state separately from database bytes.


The 18 November native uncompressed controls did not qualify a fix. On the same immutable full source, the 256 MB / one-worker run was stopped at 400,842,752 bytes after 169.203 s; the 192 MB / one-worker run was stopped at 411,435,008 bytes after 333.375 s. Both used the driver's 400,000,000-byte abort threshold and saved final OS counters. Neither completed; elapsed times cannot be compared as import throughput. Native compression defaults were restored. Full-import acceptance remains open.


Intermediate cold publication during an offline backfill has a successful short reproduction: 256 neutral one-megabyte outputs dated within content retention but beyond hot retention. The control was stopped at **422,916,096 bytes after 6.047 s**. With the same source, native compression and 128 MB / one-worker defaults, the candidate completed all 260 normalized records in **26.313 s at 150,474,752 bytes**, without partial projects. The stop-before-completion control does not establish a throughput comparison. The exact-content regression checks sixteen one-megabyte outputs after intermediate eviction, verifies registered files and reimports unchanged source with zero changes and identical API values. Full frozen-history import and subsequent 500-request stress remain in progress. Logs: `runtrace-old-256-control.log`, `runtrace-old-256-archive-batches.log`, `runtrace-backfill-cold-regression.log`.


## Current qualification checkpoint — 18 November

This checkpoint supersedes the provisional active-run descriptions above. No full-history import has qualified under the 400 MB ceiling.

| Workload / candidate | Peak working set (bytes) | Elapsed (s) | Completion |
| --- | ---: | ---: | --- |
| Full frozen source, age-only intermediate publication, 128 MB / one worker | 403,398,656 | 1,285.797 | Aborted above ceiling; 9/36 projects |
| Recent 256 × 1 MiB outputs, no intermediate publication | 421,847,040 | 5.813 | Aborted above ceiling |
| Same recent synthetic source, byte-bounded recent-batch publication | 158,363,648 | 26.938 | Complete; 260 normalized records, no partial projects |
| Full frozen source, recent-batch publication and flat multi-file reader, 128 MB / one worker | 370,884,608 | 953.406 | Partial; 7/36 projects, 29 native memory errors |

The last full run's peak private commit was 343,527,424 bytes. A lower working-set peak does not qualify a partial import, and elapsed times for incomplete runs are not throughput comparisons. Its executable SHA-256 was `07032588a10f4be8859c5cceb44193ced510f53a45d32c8feecbb0bac16fed52`. Logs: `runtrace-full-cold-batches.log`, `runtrace-recent-256-control.log`, `runtrace-recent-256-spill.log`, `runtrace-full-recent-spill.log`. Raw source content stays outside the repository.

Offline byte-bounded publication may move a large recent batch into Parquet before its 30-day age limit. Logical values and unchanged-source revision skipping are preserved; unrelated recent hot rows remain hot. Normal collection still checks age-based eviction hourly. The 1,201-file regression first exhausted a 2 GB native budget with per-file unions; one multi-file `read_parquet` reader then returned identical API values in 4.21 s. This fixture has two logical records and measures planning fanout, not full-history latency.

The qualification driver now requires affirmative non-paused, non-dry-run completion, zero project errors, exact active-project and selected-thread source counts, positive changed rows, and an available peak no greater than 400,000,000 bytes in both modes. Six Python regression tests cover missing fields, partial discovery, false counters and over-budget normal exits. Mixed mode additionally requires all 500 requests to return 200 and a healthy collector to advance. The earlier successful 500-request result remains limited to the synthetic 64-output workload; no full-history concurrent pass is claimed.


A follow-up offline-only native-uncompressed / 256 MB / one-worker candidate completed the recent 256 × 1 MiB synthetic source in **19.313 s** at **172,326,912 bytes peak working set** and **173,346,816 bytes peak private commit**. The affirmative qualifier checked all source counts; 260 records changed, no partial projects. Executable SHA-256: `fa1db76a19126e89758473056630f6953cb2d3c2dc1a9a693a7f3a2ef7defb59`. Log: `runtrace-recent-256-spill-uncompressed.log`. This is a synthetic result. The full-source candidate was subsequently aborted above the ceiling at **410,243,072 bytes peak working set**, **405,925,888 bytes peak private commit**, after **358.922 s**. It did not complete, so no full-history stress run followed. Log: `runtrace-full-spill-uncompressed-256.log`. Native compression for serving remains automatic, Parquet remains Zstd, and the offline budget default remains 128 MB until full evidence supports a change.


The ordered, durable every-batch candidate (`19ee86fc682ecd82fe477da9ee2a42f4f996c78d86d79d0b9544805131c18abc`) did not qualify. Full frozen history was stopped at **403,390,464 bytes peak working set / 385,900,544 bytes private commit after 910.609 s**. Its same-budget neutral 100,000 × 1 KiB candidate completed **100,004 records** at **284,508,160 / 266,452,992 bytes** in **952.906 s**, versus control **258,650,112 / 247,894,016 bytes** in **917.922 s**. No improvement is claimed. Logs: `runtrace-full-ordered-pending.log`, `runtrace-small-100k-ordered-pending.log`, `runtrace-small-100k-control.log`. CLI defaults were 128 MB / one worker; the aborted driver's old failure metadata incorrectly echoed configured 2048 MB / four workers instead. Aborted default-mode results now distinguish configuration from unknown effective values.

A source-allocation comparison uses sixteen neutral 5 MiB outputs under the same 128 MB / one-worker / native-uncompressed settings. Its held-source control completed in **4.750 s**, at **219,234,304 working-set bytes / 251,109,376 private-commit bytes**. The input is held fixed for subsequent candidates. This small workload neither reproduces the full 400 MB breach nor qualifies the full-history gate.


Three interleaved 5 MiB runs per stage measure the allocation change. Releasing the raw source, parsed payload and protected-content input before persistence reduces median working-set peak from **219,684,864 to 201,768,960 bytes**, and median private-commit peak from **251,351,040 to 235,560,960 bytes**. Scoping the canonical hash clone and delaying persistence serialization then reduces a new source-only median from **201,834,496 to 196,878,336 bytes**, and private commit from **235,044,864 to 229,855,232 bytes**. This is a scoped memory reduction, not a full-history result. Interleaved run times vary, and no speed ratio is claimed. Complete per-run values and hashes are in [the current hill-climb report](hill-climb-20261118.md). The 20 stored identity/payload hashes and event IDs match across all three stages; existing regressions check actual content separately.

The corresponding full frozen-history candidate **failed** the gate at **400,232,448 bytes peak working set / 387,117,056 bytes private commit after 1,714.515 s**. It was stopped before completion; no full-history concurrent request result follows from it. Binary `b66e16887e929d3ff26bd5f47f8e068cb4b00c862737aa2c607cbf63a8c85f59`, log `runtrace-full-released-lifetimes.log`.

Subsequent borrowed-column comparison, streamed canonical SHA serialization and direct search-text binding have not demonstrated a lower total-process peak on the 16 × 5 MiB source. In the latest three-per-side comparison, JSON extraction has median working set **196,308,992 bytes** and direct binding **196,714,496 bytes** (private commit **230,076,416 / 230,010,880 bytes**). Both complete every expected row. This is a negative optimization result, not a full-history pass. Logs: `runtrace-wide-searchpaired-{1..6}-{json|direct}.log`. Full-history qualification remains open.

Direct search binding was subsequently removed after a regression demonstrated different native rendering of exponent-valued JSON. The native extraction path and forced cache-hydration equality pass the expanded test. No memory benefit was lost by rejecting that candidate.

Replaying four more batches from a disposable copy of the failed checkpoint with the actual bundled engine completes at **286,126,080 bytes working set / 275,021,824 bytes private commit**. This is a resumed diagnostic, not a first full import. A separate controlled replay warms four batches in deterministic thread order, then compares the identical next batch. Sampled maximum current working sets are **269,651,968 bytes** without intervention, **270,974,976** after statement-cache flushing and **211,779,584** after ordinary checkpointing; private commits are **257,716,224 / 260,222,976 / 204,881,920**. Whole-replay peaks are **285,011,968 / 287,928,320 / 293,646,336**: the last is higher, so no whole-run reduction is claimed. Logs: `runtrace-phase-next-{control,cache,checkpoint}.log`. The offline candidate checkpoints only after verified publication and durable acknowledgement. Its fresh full import and mixed-request qualification are pending in `runtrace-full-checkpointed-batches.log`.


The full per-batch-checkpoint candidate also **failed**: **406,650,880 bytes peak working set / 401,072,128 bytes private commit after 2,476.328 s**. It was stopped above the ceiling before writing a complete report; there is no full-history mixed-request result. Binary `1f8755a2f74042a2ada8bd72bfb2ce97a8f9fd88dc8fe8c100811490be312bf7`, log `runtrace-full-checkpointed-batches.log`. The controlled next-batch improvement did not establish the full-import requirement. Late-checkpoint process-heap diagnostics are the next measurement.

The Windows heap experiment releases about 9.6–11.3 MB of private commit at rest but shows no reliable next-batch peak reduction. No production heap call was added. A 96 MB late replay fails at its first spill despite a 256.7 MB process peak. The isolated revision-key comparison also rejects a schema change: resident ART is 15,728,640 bytes for the existing composite key, 25,165,824 for hex digests and 16,252,928 for binary digests on the same 201,761 rows. Each arm passes field equality and a cardinality-preserving upsert. These are diagnostics, not first-import passes. Per-arm evidence is in [the current report](hill-climb-20261118.md).

The retained-content trigger is now roughly **4 MiB**, still capped at 1,000 changed rows. Three interleaved wide-output imports per side reduce median working-set peak from **171,704,320 to 159,600,640 bytes** and private commit from **198,836,224 to 191,508,480 bytes**. Every run completes the same 20 records. Logs: `runtrace-batch-size-{1..6}-{eight|four}.log`. This synthetic result earns no full-history credit. The fresh full candidate fails at **400,973,824 working-set bytes / 387,731,456 private-commit bytes after 2,022.641 s**, before completion or mixed requests. Log: `runtrace-full-batch4.log`; seed 2026111813; 128 MB / one-worker defaults; binary `d5088d2a34ff2bbc633078b44eccf5ca85ec1d3199b2a79a0da8c93e08d52dfa`. The unchanged driver ceiling terminates only its owned scratch process.

Astra identified completed lineage and attempt maps retained across later source ingestion. Four equivalent actual-engine checkpoint replays, in retain/release/release/retain order, measure working-set peaks **308,133,888 / 280,940,544 / 281,059,328 / 297,488,384 bytes** and private-commit peaks **291,590,144 / 273,817,600 / 272,728,064 / 295,514,112 bytes**. Each completes five published batches. Explicit release changes no native DuckDB tag at its boundary; the owned Rust source data is freed after its final reader. The checkout adopts these two lifetime changes after Astra's bounded semantic review. Logs: `runtrace-map-release-{1..4}-{control|drop-maps}.log`. Its first full import nevertheless **fails** at **400,023,552 working-set bytes / 383,991,808 private bytes after 1,672.094 s**, before completion or mixed requests. Binary `cb870381b9a589179a71b91a6af77d99a3f926cd0dc7464551150cb5b9f5c988`; log `runtrace-full-released-maps.log`.

Streaming global thread preparation lowers memory at that phase, but four actual-engine replays do not show a reliable whole-peak reduction and private peaks are higher. It remains a disposable experiment. Exact values and matching canonical map fingerprints are in [the current report](hill-climb-20261118.md).

Closing and reopening only the attached data catalog releases about 53 MB at rest but does not reliably lower the identical fifth batch's peak. Current-private maxima are 263,376,896 / 270,811,136 bytes in controls and 272,003,072 / 270,868,480 after reattach. Catalog/table placement, Rust time functions and key inventories agree. No production attach/detach behavior was added. The next experiment closes the whole Store in the same process, with source frames unwound in both arms; setup remains part of measured lifetime peak.

The completed whole-Store comparison lowers resumed-work peaks in both pairs, but a production ownership gap would need shared writer coordination. No reopen behavior was adopted. A simpler same-Store budget comparison completes eight batches twice at 112 MB: **284,246,016 / 278,196,224 peak working-set bytes**, **276,234,240 / 274,739,200 private bytes**, with matching key inventories checked against 128 MB controls. The new interleaved 128 MB control reaches **303,087,616 / 294,469,632 bytes**. The default candidate is now 112 MB, preserving explicit overrides and `import --verify`'s prior default. Fresh full-history and mixed-request qualification remain pending in `runtrace-full-budget112.log`; binary `2f72c6c0fc88dc30daba401c6e102a22cd4b9d006943a77785a8e2b3839beae6`. Full per-arm numbers and limits are in [the current report](hill-climb-20261118.md).

That full run subsequently **fails** at **401,559,552 working-set bytes / 383,594,496 private bytes after 3,272.297 s**, before completion or mixed requests. The unchanged driver cutoff stops its owned process. The explicit sixteen-output 5 MiB source separately completes at **160,866,304 / 192,229,376 bytes** in **5.609 s**; full-content API values match the complete neutral source. This earns no full-history credit. The bounded Opus 5.5 retry also fails complete-import qualification; memory tuning is stopped per the user.


### Final preview-type correction — 18 November 2026

The final executable `ba44da937644c9a678a0dcff0c73a591337d15abf2d63804e1a3a84ec5e43bc2` repeats the complete-history serving stress with seed 2026111822: 500/500 HTTP 200, zero 503, four workers, twelve route types, 196.797 s, median 1,125 ms and p95 4,704 ms. The collector advances while 36/36 projects remain synced. The copied database retains committed prior progress and the normal 2,048 MB serving budget; no first-import memory credit follows. Browser testing overlaps this run, so timings do not prove a speed improvement.

A copied older analytical backup independently has identical JSON digests on all twelve API routes across hot/cold eviction after controlling retention. Its snapshot restores 441,832 records; all columns in all eight tables have zero row-hash multiplicity differences. The full-source snapshot separately restores 380,746 records with the same complete stored-value check. The checker accounts explicitly for historical preview JSON/VARCHAR serialization and column order, while rejecting missing columns, changed preview text and unrelated types. See Round 20 of the current journal for the failed old sequence assertion and evidence limits.


### Installed operational transition — 18 November 2026

A fresh frozen copy of the installed analytical database/WAL is independently checked before replacement: migration/statistics on a warm-cache copy takes 0.484 s, original-row comparison has zero differences, twelve routes succeed and a warm candidate starts in 3.891 s. A separate copy starts with the old executable and retains logical statistics. These measurements concern already-imported data, not a new full import.

The final transition takes a second fresh verified rollback copy. Four local routes pass by 16.781 s and four direct public HTTPS routes by 17.0 s after transition begins. The installed collector later reports 37/37 discovered project scopes synced, no partial sync and no project errors. Automatic cold maintenance reports 499,450 moved rows with copy/native-restore verification. A durable byte-verified rollback generation is retained under the installed backups directory; prior backups are untouched. No process-memory ceiling or cold-boot timing is inferred from these observations.

### Round 23 debug integration — 18 November 2026

Current-source debug executable `4c723c013cbda42ba2e38a5c01012c38490122d4b73e7471e46b8e5a147bc280` passes 500 mixed requests over copied completed scratch history, seed 2026111823, four workers and twelve route types: 500 HTTP 200, zero 503, 230.594 s, median 1,250 ms and p95 5,406 ms. Collection advances with 36/36 scopes synced and no project errors. Automatic eviction moves 38 rows in two segments with copy/restore checks true. The browser suite runs concurrently; debug execution and concurrent load prevent a release speed comparison. This is a normal 2,048 MB serving-budget check on prior committed progress. It provides no first-import or 400 MB process-memory credit. Further memory tuning remains stopped.

### Round 24 release-profile qualification — 18 November 2026

Frozen bundled candidate `4dafe7774bdb88ceb344780ddbb72236a24151a22751957aac57c3dde39f3bd5` passes a new 500-request workload during advancing collection, seed 2026111824: four workers, twelve route types, 500 HTTP 200, zero 503, 181.453 s, median 1,015 ms, p95 4,094 ms. All 36 scratch scopes remain synced. Automatic eviction moves 38 rows in two segments with copy/restore checks true. It uses already-committed scratch history and the normal 2,048 MB serving budget, with other qualification checks overlapping. No first-import memory ceiling or paired speed improvement is inferred.

The current-code synthetic version fixture also verifies the updater's two cold backup segments after hiding the original archive, with four exact API digests and recovery after injected backup failure. It is a same-code version fixture, not a published historical implementation. Published 0.2.3 contains ICU SQL; its separate compatibility probe is retired and excluded from compliant qualification. The eight migration files omitted from the first fixture copy are subsequently hash-verified and included. See Round 24 for the complete evidence and limitations.

### Round 25 corrected publication candidate — 18 November 2026

Frozen bundled candidate `161fc0f85cad6d4fe7b8b87fdac876f8897025dfe4046aeb4b5000f4586b84ea` serves 500 randomized mixed reads during advancing collection, seed 2026111825, four workers, twelve route types: 500 HTTP 200, zero 503, 198.875 s, median 1,125 ms, p95 4,281 ms. All 36 scratch scopes remain synced, with no partial sync or project errors. Automatic maintenance moves 99 rows in three segments with copy/restore checks true. This reuses completed scratch history at the normal 2,048 MB serving budget; concurrent qualification work prevents a controlled speed comparison. It provides no first-import or 400 MB process-memory credit. Further memory tuning remains stopped. Private evidence: `D:/Scratch/Runtrace/transition-round25-20261118/tmp/stress.log`.

Round 26 installs the same qualified candidate and completes the fresh freeze, replacement and local/public verification in 52.625 s, including backup checksum work. This is not HTTP-downtime or logon timing. Portable recovery verifies 207 copied files, 192 cold segments, one legacy archive and one snapshot bundle; restored logical statistics match. All 630 pre-existing backup files remain preserved. The first installed collection pass is still progressing at this checkpoint. No first-import memory credit is awarded. See [Round 26](hill-climb-20261119.md#round-26--installation-qualification).

Round 30 mixed-load qualification uses the installed frozen hash `39cbbb253bec054fb57ba4ebc4c90bb71782ef0df6f4372b90abed49cd14870a`, seed 2026111930, four workers and twelve routes: 500 HTTP 200, zero 503, 205.375 s, median 1,250 ms, p95 4,344 ms. Collection advances across 36 copied scopes, and a changed neutral quota reading is observed during requests. Maintenance moves 99 rows in three verified segments. This uses prior committed history at 2,048 MB; it does not qualify first-import memory or a speed improvement. The live first quota pass takes 581 ms during initial import; a later pass takes 709 ms. Full transition/check duration is 70.266 s including backup work, not measured downtime. Portable recovery verifies 209 files and 194 cold segments, and all 839 previous backup files remain preserved.
