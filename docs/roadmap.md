# Next implementation increments

Completed in the performance iteration: concurrent single-process collection/API serving, indexed source revision skips, prepared writes, project/1,000-entity recovery boundaries, per-project retries/checkpoints, per-turn token metadata, existing Just Run It correlation, a complete interactive dashboard, typed analytical caches, lossless normalized Parquet snapshots/restore, and installation-scoped purge-ledger protection.

Remaining work, in order of value:

1. The full discoverable 34-project backfill is complete. Continue profiling initial import and unchanged collection. Use profiling to reduce row-by-row cold import work; preserve secret filtering and terminal-run evidence. Add a projection-watermark-aware cursor over the verified generic orchestration event log, with prune-gap fallback to revision scans.
2. Implement supported authenticated HTTP/WebSocket transport using inspected contracts, OS-keychain credential references and a real linked remote machine. Validate reconnect, retained-history catch-up and measured clock offset.
3. Integrate live provider-limit snapshots through an authenticated read-only interface. Persist sampling windows before presenting quota waste; historical windows without snapshots remain unavailable.
4. Add an efficient local redacted full-text index with transactional invalidation and purge/restore tests. Measure rare/common searches and million-event queries. Add query interruption, OpenAPI and complete stable filtering.
5. Complete canonical fact tables, partitioned cold-query unions and verified hot eviction. Preserve current native hot-query speed and apply current tombstones across every cold read.
6. Improve provider-session evidence for migrated history and individual model-call linkage where the source permits it. Keep native-subagent tokens separate from main-agent turns.
7. Finish derived comparisons, critical-path analysis, full global filters and complete operational metrics/soak tests.

No T3 fork is justified. Existing read contracts and usage-limit capability should be integrated first. A minimal optional read-only patch requires a specific source telemetry gap demonstrated by a failing test; none is proposed without that evidence.

The November 6 council iteration adds bounded bulk-page memory behavior, provider-turn revision skipping, cache-write aggregate coverage, purge-before-hydration ordering and pre-cache Parquet restoration tests. It does not implement the event cursor, remote auth, live quota sampling or automatic cold eviction.
