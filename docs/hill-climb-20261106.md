# Runtrace hill climb and independent council — 6 November 2026

The target was 4/4 for four bounded delivery increments. This is an evidence ladder, not an overall product-quality rating: 1 = baseline, 2 = implemented, 3 = equivalence/regression proof, 4 = deployed and independently accepted. All four targets reached 4 after the checks below.

| Increment | Baseline | Target / accepted | Evidence |
| --- | --- | --- | --- |
| Bulk-query reliability during collection | 1 | 4 / 4 | Materialized page IDs; 280 alternating preview/full 500-tool requests across three healthy collection cycles, zero failures at 512 MB. Final archive build additionally passed 60 requests and a healthy cycle. |
| Unchanged collector performance | 1 | 4 / 4 | Same full frozen 34-project source: warm median 11,298 to 6,805 ms; exact original record/event equality. |
| Cache-write analytics | 1 | 4 / 4 | Nullable cache-write token sums and observed-turn coverage in models API/MCP; semantics and zero/null regression. |
| Full snapshots and recovery | 1 | 4 / 4 | Streamed complete snapshot, exact export comparison, checksums, older-schema restore tests, full restore and all-table fingerprints. |

## Measured changes

Provider-turn profiling found 5,613 ms of an 11,298 ms unchanged pass in that phase, including 5,164 ms in record checks. The new revision cache fingerprints exact turn payload plus source version, effective policy, node/run linkage and full linked-run evidence. Same-timestamp usage corrections and model relinks invalidate it; repair bypasses it. Warm runs were 11,298/11,685/11,295 ms before and 6,805/6,539/7,383 ms after: 39.8% lower median. Initial cache population took 36,090 ms on the frozen source and 49,604 ms during heavy live queries. That is a one-time cost, not a warm-pass speedup.

The baseline stress reproduced one 503 in 100 preview requests. The successful post-change workload was stronger: 280 alternating preview/full requests across three healthy cycles. Median was 635.88 ms, p95 713.83 ms, maximum 1,216.12 ms. Preview and full modes have different response sizes, so no before/after latency ratio is claimed. A focused test first drives the old wide path into OOM, then verifies connection recovery and the new page under the same constrained budget. Chunked ID retrieval was rejected at roughly 2.3 seconds; the joined query maintained approximately the original latency in controlled measurements.

All 14 frozen API routes preserve their prior response fields. Models deliberately adds cache_write_tokens and cache_write_observed_turns. The post-deployment observation had 11,197 of 12,015 provider turns with recorded cache writes, across 11 of 16 model groups. Known cache-write values summed to 111,165,081. Missing values stay null; cache reads/writes are already included in input and are never added again to total tokens. These observations were already captured in normalized JSON and are now available as aggregate analytics. The later search-and-token-visibility-20261106.md iteration adds dashboard presentation.

The former sorted full-snapshot export failed at the existing offline 4 GB budget. Streaming COPY avoids the wide sort. The verifier checks every exported column in bounded source rowid windows against a separate dense Parquet row cursor, checks schema/types and counts, and rejects unsupported future types or any order/value mismatch before publication. The same transaction protects the source snapshot. Explicit insertion-order preservation follows the [DuckDB order-preservation contract](https://duckdb.org/docs/sql/dialect/order_preservation).

The completed frozen snapshot contains 275,336 records, 370,265 events and recovery metadata: 570,052,805 bytes with Zstandard 8 / 2,048-row groups. Export plus full comparison took 179.599 seconds. Checksum/count verification passed; empty-target restore took 86.589 seconds under the same maintenance budget. All six restored tables had zero identity-keyed SHA-256 fingerprint differences across every typed native field. Restore may change physical row order; the fingerprint comparison deliberately ignores it. Native hot rows and codec defaults remain unchanged. These sizes are separate from the older sorted codec experiment and do not establish a comparable compression ratio.

## Council findings and dispositions

Three independent gpt-6.1-sol reviewers used separate contexts and read-only access. The coordinator implemented all changes and retained deployment ownership.

- Reliability reviewer required an actual concurrent failure loop, same-connection OOM recovery, frozen response equivalence, full-content pages, and healthy project reports rather than freshness timestamps alone. All gates passed; accepted scoped 4/4.
- Collector/telemetry reviewer identified the uncached provider-turn work and required linkage/usage invalidation, exact record/event equality and honest null/token semantics. All gates passed; accepted both scoped increments at 4/4. Usage and linkage invalidation were also split into independent regression assertions.
- Storage/privacy reviewer found purge replay occurred after hydration and that previous tests did not actually restore Parquet missing search-cache columns. Purges now precede hydration; a real older-schema Parquet fixture passes. The reviewer also required all-field comparison, rowid-gap handling and full-dataset export/restore. All gates passed; accepted scoped 4/4. Order-mismatch rejection was added to the verifier test.

Startup hydration resumes committed batches. Restore remains atomic: an interrupted restore rolls back and restarts. The current installation purge ledger is replayed before hydration in both paths.

## Delivery and limits

44 Rust tests passed (1 CLI/MCP, 6 core, 37 acceptance); formatting and clippy with warnings denied passed. Focused refinements to two tests also passed. API 12-read/4-rejection contracts and MCP 20-tool, scope and database-identity checks passed. Final installed binary matches the validated release build. Dashboard source/design was untouched. Runtime data and evidence remain under D:/Code/Runtrace; the T3 source database was never modified. Existing uncommitted implementation remains uncommitted.

The evidence files are under D:/Code/Runtrace/benchmarks/council-20261106. Full report data includes concurrency-before/after/final.json, collector-before/after.json, collector-equivalence.json, event-equivalence.json, api-equivalence.json, telemetry-availability.json, full-snapshot.json, archive-verify.json, restore.json and restore-field-fingerprints.json.

Remote authentication/transport, live quota history, individual model calls, event cursors, automatic cold eviction/expiry, million-event capacity remain incomplete. The thirteen-candidate codec benchmark has not been requalified on this completed dataset; it still uses global sorts/full EXCEPT comparisons. The new full-snapshot path is separately qualified. Finite stress success does not guarantee every possible future query or write workload will fit memory.

The temporary raw source-projection checkpoint was removed after measurements to avoid retaining an additional plaintext conversation copy. Its size/SHA256 provenance remains in source-checkpoint-provenance.json. Redacted analytics checkpoints and verification artifacts are retained; the original T3 source remains untouched.

The later search-and-token-visibility-20261106.md iteration supersedes cache-write presentation and fixes partial-usage copy/count semantics. The scores above remain historical delivery gates.
