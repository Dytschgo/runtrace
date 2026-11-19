# Next implementation increments

Completed in the performance iteration: concurrent single-process collection/API serving, indexed source revision skips, prepared writes, project/1,000-entity recovery boundaries, per-project retries/checkpoints, per-turn token metadata, existing Just Run It correlation, a complete interactive dashboard, typed analytical caches, lossless normalized Parquet snapshots/restore, and installation-scoped purge-ledger protection.

Remaining work, in order of value:

1. The historical 34-project backfill completed in the November 6 iteration. The current frozen-source first-import memory qualification is separate and remains unqualified; see [the current evidence](hill-climb-20261118.md). Further first-import memory tuning is stopped after the bounded retry, per the user. Any new profiling experiment requires revisiting that instruction. Use profiling to reduce row-by-row cold import work; preserve secret filtering and terminal-run evidence. Add a projection-watermark-aware cursor over the verified generic orchestration event log, with prune-gap fallback to revision scans.
2. Implement supported authenticated HTTP/WebSocket transport using inspected contracts, OS-keychain credential references and a real linked remote machine. Validate reconnect, retained-history catch-up and measured clock offset.
3. Integrate live provider-limit snapshots through an authenticated read-only interface. Persist sampling windows before presenting quota waste; historical windows without snapshots remain unavailable.
4. Add an efficient local redacted full-text index with transactional invalidation and purge/restore tests. Measure rare/common searches and million-event queries. Add query interruption, OpenAPI and complete stable filtering.
5. Full-history serving, two 500-request mixed workloads, complete stored-value restores and installed automatic eviction are now qualified in the current report. Registered Parquet unions, exact eviction/restore comparisons, tombstones, corrections and transactional reader snapshots also pass synthetic regressions. Finish immutable-file lifecycle handling and retain native hot-query speed.
6. Improve provider-session evidence for migrated history and individual model-call linkage where the source permits it. Keep native-subagent tokens separate from main-agent turns.
7. Finish derived comparisons, environment/quality filters and complete operational metrics/soak tests. Machine/status global filters and labelled observed timed delegation chains are implemented; causal wait/dependency analysis still requires source evidence.

No T3 fork is justified. Existing read contracts and usage-limit capability should be integrated first. A minimal optional read-only patch requires a specific source telemetry gap demonstrated by a failing test; none is proposed without that evidence.

The November 6 council iteration adds bounded bulk-page memory behavior, provider-turn revision skipping, cache-write aggregate coverage, purge-before-hydration ordering and pre-cache Parquet restoration tests. The November 17 iteration adds registered cold eviction and unions; it does not implement the event cursor or remote authentication.
