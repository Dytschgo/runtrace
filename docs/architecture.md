# Architecture and decisions

1. **Sidecar over fork.** Read verified local T3 projections through SQLite read-only snapshot transactions. Supported HTTP/MCP contracts exist, but analytics authentication/network adapters remain unfinished. Child MCP reads can acknowledge delivery; the importer avoids that side effect. No T3 patch or provider execution change is installed.
2. **DuckDB and Parquet.** Native DuckDB handles hot queries. Typed analytical columns avoid parsing large JSON content for totals. Complete normalized snapshots use Parquet/Zstandard level 8 and 2,048-row groups, selected from thirteen measured codec/group candidates. Exact field comparisons and checksums protect archival integrity. No hot eviction is enabled.
3. **Events plus projections.** Deterministic source identities, immutable metadata revision events and protected normalized records. Original JSON remains authoritative; a lowercased derived redacted-text cache accelerates substring search. Project and 1,000-entity transaction boundaries allow recovery; final scope checkpoints advance only after success.
4. **Encryption.** XChaCha20-Poly1305 with random 24-byte nonces and an OS-keychain key. Default redacted-only capture avoids retaining full originals. Structured tool values are redacted before serialization to preserve JSON validity. Encryption presence participates in revision hashes.
5. **Remote collection.** Explicit instance identities support separately configured consistent offline snapshots. No authenticated network discovery/transport is implemented or claimed tested. Source revision scans catch up from retained history.
6. **MCP.** Dedicated Rust stdio JSON-RPC server, twenty allowlisted read-only tools, resources and eight prompts. It uses the same analytics service as HTTP, directly when the database is free or through HTTP while the service owns it. Full-content scope is unsupported and fails closed.
7. **Dashboard.** React/TypeScript/Vite, TanStack Query, Recharts, bundled Geist fonts and local CSS. Opus implemented the visual system and interactive pages. There are no external analytics, fonts or CDN requests. Tailwind was removed because it was unused.
8. **Quota.** No historical reconstruction without snapshots. A tested calculation primitive labels complete/partial windows; live provider-limit sampling is not implemented.

The Rust workspace has a core crate and CLI crate, with concrete modules for import, storage, privacy, analytics, quota and compression; it does not create empty crate boundaries.

The service binds loopback before starting collection. One process owns DuckDB, with separate writer and reader connections. Queries see committed snapshots while source backfills continue. The emergency pause file is independent of the database lock. Readiness includes the owned PID and collector state; logs contain metadata, never captured conversation content.

A verified generic T3 orchestration event log could reduce future polling work. Any cursor must respect the projection commit watermark and detect pruned gaps before catch-up. The present adapter uses indexed revision scans rather than pretending an unimplemented event cursor is safe.
