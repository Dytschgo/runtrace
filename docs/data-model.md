# Data model

Migrations 001–004 define the implemented schema. A consolidated records table uses deterministic SHA-256 IDs over instance/kind/source identity and a unique (instance_id, kind, source_id) constraint. Kinds include instance, project, thread, run, prompt, answer, agent, tool, model_turn and external_request. No project merge relies on display names.

Migration 003 adds typed analytical metadata alongside the original JSON: model, status, tool name/category, duration, token counters, usage status and text-size counters. It does not replace or truncate source content. The production migration compared all fifteen original columns of 127,537 records exactly with a stopped pre-migration backup; zero differences were found. The migration verifier compares bounded sequential physical ranges and conservatively fails if an otherwise equal backup has a different physical record order.

Events are append-only metadata revisions keyed by entity ID and canonical payload digest. They do not duplicate prompt/tool content. They are not sufficient on their own to rebuild all protected content; normalized records and snapshots remain necessary. Hashes exclude random ciphertext bytes but include encryption presence and source attribution, so policy/relationship changes are not hidden.

One read-only SQLite snapshot is used per source project. Run lifecycle metadata can be persisted before completion. Final prompts/answers and terminal tools require durable terminal evidence. Streaming content and legacy messages lacking a terminal run are withheld. Explicit subagent lineage is followed with cycle detection; forks do not create delegation edges.

Revision fingerprints include adapter/source version, update time, terminal state/completion and capture policy. Unchanged payloads are skipped before decoding/redaction. Checkpoints are separated by instance and project; a quiet project cannot inherit another project's freshness. Failed scopes back off independently, and completed 1,000-entity batches survive restart. A missing revision cache entry after a crash causes safe reprocessing.

Provider turns use normalized turnTokenUsage only, not mid-turn context snapshots. Nullable input/cache/output/reasoning values are retained. Total is input + output only when usage is complete; cached input and reasoning are subsets, not additions. Individual model-call counts remain unknown.

API comparisons/order use typed source instants. Source timestamp strings remain available; clock skew is not silently repaired. Collector timestamps are UTC, dashboard display defaults to Europe/Zurich. Source identifiers are deterministic; new snapshot identifiers use UUIDv7.

Snapshots contain complete records, event metadata, instance checkpoints, settings, tombstones and source revision cache. SHA-256 manifests and exact Parquet round-trip comparisons precede publication. Hot rows stay queryable in DuckDB. The current installation purge ledger is applied before restored content becomes visible.

Migration 004 introduced a nullable redacted search cache alongside JSON; current adapter version 2 stores its DuckDB-lowercased form. The cache is maintained in the owning record transaction and cleared atomically with retained content. Startup hydrates missing versions in bounded, committed, resumable batches. Older-snapshot restore hydrates inside its atomic restore transaction; interruption rolls back and restarts the complete restore. It contains no ciphertext or additional original content.

Provider-turn revision fingerprints include exact source payload, source version, effective privacy policy, node-to-run linkage and linked run evidence. Corrections invalidate the cache even when completion timestamps stay unchanged. Cache-write input is exposed with observed-turn coverage in model aggregates; it remains a subset of input and is not added to total tokens.

Search cache adapter version 2 stores DuckDB lowercase of already-redacted JSON, enabling LIKE on a lowercased query pattern without repeated haystack case conversion. This derived value is not the original text; original captured JSON remains authoritative. Startup and old-snapshot restore rebuild older cache versions, including after retention/purge processing. The isolated ASCII-only Unicode correction is documented in search-and-token-visibility-20261106.md.
