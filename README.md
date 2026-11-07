# T3 Usage Intelligence

A local Rust sidecar for examining personal T3 Code history. This repository contains a working first version with real imported history, a React dashboard, DuckDB storage, redaction/encryption primitives and a read-only MCP server. The full original product scope remains incomplete; current operational and telemetry limits are documented explicitly. See [known limitations](docs/known-limitations.md) and [self-review](docs/self-review.md).

![Dashboard displaying imported local T3 history](docs/screenshots/overview.png)

## Prerequisites

- Rust stable and a working native compiler/linker; verified here with Rust 1.95 on Windows x64.
- Node.js 24 and npm.
- T3 Code with the inspected v2 SQLite projections. Verified installation: `0.1.8-nightly.20261105.4234`.
- Initial network access for Cargo/npm dependencies and DuckDB runtime download. The built dashboard runs without external services.

## Production installation (PowerShell)

```powershell
# From the source checkout:
./scripts/install.ps1
Set-Location D:/Code/Runtrace
./start.ps1
```

Open **http://127.0.0.1:4310**. The release binary, DuckDB runtime, dashboard, configuration, database, archives and logs live under `D:/Code/Runtrace`. The source checkout stays in its original project folder. Its data directory is a Windows junction to D:/Code/Runtrace/data; the earlier prototype is preserved in D:/Code/Runtrace/backups/source-checkout-data. `serve` now collects in the background using a separate DuckDB connection while serving queries. The launcher checks the owned process ID in the HTTP readiness response.

Use `./stop.ps1` before upgrading binaries or running offline maintenance. The installer preserves existing data/configuration and refuses to replace a running production binary. `./t3ui.cmd capture pause` works while the service is running; resume re-enables capture. The pause file is independent of DuckDB's writer lock.

For source development, `./scripts/build.ps1` retains the debug workflow. Production uses an optimized release build with thin LTO.

## T3 connection and history

By default the importer resolves the current user's `.t3/userdata/statev2.sqlite`, opens it read-only, checks the expected schema through prepared queries and reads one consistent snapshot. It never extracts T3 authentication credentials. Inspected HTTP/MCP interfaces and reasons for choosing the local persistence fallback are in [integration evidence](docs/integration-evidence.md).

```powershell
./t3ui.cmd import --all
./t3ui.cmd import --instance local
./t3ui.cmd import --project 53a8a553-5b8b-4c8d-8496-846d81ec0150
./t3ui.cmd import --since 2026-11-01T00:00:00Z
./t3ui.cmd import --dry-run
./t3ui.cmd import --verify
./t3ui.cmd import --repair
```

Output is JSON with changed records, discovered threads, skipped incomplete/purged messages and checkpoint. An unchanged repeat returns `"changed":0`; this was verified with real history and synthetic acceptance tests. `--verify` currently reports capture-quality counts, not the full requested relationship repair audit. `--repair` rescans retained history; it cannot reconstruct telemetry the source lacks.

## Continuous collection

```powershell
./t3ui.cmd collect
```

Polls completed source messages every 60 seconds, with exponential retry backoff after failure and transactional checkpoints. Stop with Ctrl+C. `serve` already runs collection. Use standalone `collect` only when the service is stopped; DuckDB has one writer process, with separate concurrent reader/writer connections inside that process. MCP can query through the running HTTP service without taking a second writer lock.

## Configuration

Edit [config/default.toml](config/default.toml). Defaults: Europe/Zurich display, loopback port 4310, redacted-only capture, 90-day content retention. `T3UI_CONFIG`, `T3UI_DB` and `T3UI_SOURCE` override configuration location, analytics database path and source SQLite path. Source instance_id separates identities across explicitly configured offline snapshots; network remote collection is not implemented. Quota schedule values are reserved for the future live adapter.

## MCP

Configure a client that supports stdio MCP:

```json
{
  "mcpServers": {
    "t3-usage-intelligence": {
      "command": "D:\\Code\\Runtrace\\bin\\t3ui.exe",
      "args": ["mcp", "serve"],
      "cwd": "D:\\Code\\Runtrace",
      "env": {"T3UI_CONFIG": "D:\\Code\\Runtrace\\config\\default.toml"}
    }
  }
}
```

Registered: twenty read-only tools, resources and eight reusable analysis prompts. Some advanced tool names expose partial underlying lists rather than full derived analytics. Full content is never available through MCP. See [MCP details](docs/mcp.md).

## Privacy and operations

Secret-pattern and entropy redaction runs before storage. Default redacted_only stores no full original text. Set default_policy to full_encrypted and run init to create an OS-keychain key for XChaCha20-Poly1305 encryption. Keychain errors fail closed. Metadata_only and disabled reduce capture further. This release has no API/MCP full-content decryption endpoint.

```powershell
./t3ui.cmd capture pause
./t3ui.cmd capture resume
./t3ui.cmd project privacy <t3-project-id> metadata_only
./t3ui.cmd purge thread <t3-thread-id>
./t3ui.cmd purge project <t3-project-id>
./t3ui.cmd purge before 2026-01-01
./t3ui.cmd archive run
./t3ui.cmd archive verify
./t3ui.cmd retention run
./t3ui.cmd storage stats
./t3ui.cmd export --output data/redacted-export.json
```

Purges are logical deletes with reimport tombstones. Archive bytes and exports/backups require separate removal. Preserve the current installation purge ledger with every restore. Archive now backs up normalized records, events, checkpoints, capture settings, tombstones and revision state into lossless Zstandard Parquet bundles with exact round-trip comparison and SHA-256 manifests. Hot rows remain in native DuckDB for retrieval speed. Restore is supported into an empty target database with `archive restore --path <snapshot-directory>`; automatic hot eviction/union queries remain unimplemented. Export is a bounded page of at most 500 redacted records.

For backup/restore, stop all processes and copy data plus config; encrypted content requires the original OS keychain. Upgrade by backing up, rebuilding and running doctor/import verification. Uninstall by stopping processes, deleting the analytics data/archives/exports/backups and removing the keychain entry if created. Original T3 data remains untouched. Details: [operations](docs/operations.md), [security](docs/security.md), [threat model](docs/threat-model.md).

## Development and status

See [development](docs/development.md), [architecture decisions](docs/architecture.md), [data model](docs/data-model.md), [dictionary](docs/data-dictionary.md), [metrics](docs/metrics.md), [remote machines](docs/remote-machines.md), [quota tracking](docs/quota-tracking.md), [measurements](docs/verification.md) and [roadmap](docs/roadmap.md).

The UI screenshot uses imported local data, not seeded chart totals. Verified per-turn token data is imported where T3 exposes it; unknown token fields, resolved models, costs and quota remain unavailable. Counts of run lifecycle records are not substituted for proven model-call counts. Historical messages without a provably terminal run are withheld. These limitations constrain interpretation of every chart.

## Performance and compression work

On the same frozen 112-thread source, unchanged imports fell from 55.8–57.9 seconds in the original debug build to 0.329 seconds in the optimized release build. The importer uses indexed source metadata, durable revision caching and prepared writes, with bounded commits for recovery. A 5,950-record Parquet benchmark compared thirteen codec/row-group combinations and verified every restored field. Zstandard level 8 / 2,048-row groups produced 4.02 MB versus 37.3 MB uncompressed, with 22.9 ms versus 31.2 ms measured full tool-page retrieval. These are dataset-specific measurements, not universal guarantees.

See [current performance evidence](docs/performance-and-compression.md). The current [self-review](docs/self-review.md) is 7.13/10 against the full original scope; remote/quota and other gaps remain explicit. See [executed verification](docs/verification.md) and [known limitations](docs/known-limitations.md).
