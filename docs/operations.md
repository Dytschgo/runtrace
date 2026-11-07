# Operations

Production root: `D:/Code/Runtrace`. Source checkout: `C:/Users/DylanFerraro/.t3/projects/runtrace`.

```powershell
Set-Location D:/Code/Runtrace
./start.ps1
./t3ui.cmd capture pause
./t3ui.cmd capture resume
./stop.ps1
```

The launcher starts a hidden release process, saves its PID, redirects logs into logs/, and verifies HTTP readiness with a matching process ID. Windows socket inventory proved unreliable in this environment, so readiness does not depend on it. stop.ps1 stops only this installation's binary and waits for process exit before upgrades. Forced stops rely on DuckDB transaction recovery; committed import batches remain intact.

`serve` collects through a dedicated DuckDB connection while readers use a separate connection. Collection backs off on source errors and catches up from retained projections. Every project and every 1,000 changed entities form commit boundaries. Final checkpoints advance after successful scope completion. Existing history may be visible in stages during the first backfill; capture quality remains partial.

Pause uses a small cross-process file next to the database. It does not wait for a database writer lock. The importer checks it between entities and rolls back the current uncommitted batch. Legacy database pause settings migrate to that file on startup. Resume does not change provider execution.

Stop the service before standalone import, purge, retention, archive or compression benchmark commands. MCP can query the running service through HTTP. Automatic Windows logon/service registration is not installed; start.ps1 is the explicit launcher.

## Backup, restore and purge

`archive run` now creates a complete normalized Zstandard Parquet snapshot: records, events, checkpoints, privacy settings, tombstones and source revision cache. It verifies every column bidirectionally against hot tables, records SHA-256 checksums, writes a manifest and atomically publishes the directory. Old event-only archive manifests remain verifiable. No hot rows are deleted, and native DuckDB remains the query store.

`archive verify` checks manifests, file checksums and counts. Restore with `archive restore --path <snapshot-directory>` into an empty database selected through T3UI_DB. Encryption keys are not included; encrypted content still needs the original OS keychain entry. Keep the current data/purges.jsonl ledger with any restore: it is applied to older snapshots so locally purged conversations do not reappear. Backups moved to another installation need that current ledger too. Set storage.purge_ledger_path to its explicit location; T3UI_DB overrides keep the original installation ledger by default. Old archive bytes are not physically rewritten by logical purge; remove obsolete external backups/exports for complete physical removal.

For an ordinary file backup, stop the service and copy data/, config/ and the current purge ledger. Do not copy a live DuckDB file independently of its active writer. For source T3 backups use SQLite's backup API; never copy only a live SQLite main file while its WAL is active.

Retention removes expired content from prompt, answer, tool and agent records when explicitly run. Metadata remains. It does not automatically rewrite old backup snapshots. Export remains a bounded redacted page, not a full disaster-recovery backup.

## Upgrade and removal

Stop the installed runtime, preserve a backup, then run scripts/install.ps1 from the source checkout. It builds optimized Rust and frontend artifacts, preserves configuration/data, and refuses to replace a running binary. Restart and check health/ready, which includes collector state. Current source schemas are inspected and source SQLite is always read-only.

Uninstall by stopping the runtime, removing D:/Code/Runtrace and any external backups/exports, then removing the optional OS credential entry t3-usage-intelligence/content-key-v1 if encrypted capture was enabled. Remove the source checkout separately if desired. Original T3 history is unaffected.

The source checkout data directory is a Windows junction to the installed D: data directory. This keeps legacy relative archive paths working without leaving an analytics database on C:. The earlier prototype is preserved under backups/source-checkout-data. Remove the junction itself separately if removing the source checkout; its target is the live installed data directory.

The explicit maintenance configuration at D:/Code/Runtrace/config/maintenance.toml uses a 4,096 MB DuckDB budget for full snapshot verification; the normal service retains 512 MB. Run expensive maintenance offline. Live queries use the normal configuration again after start.ps1.

For migration 004, stop and back up the database, run `t3ui init` offline, then start the service. Full-history search-cache hydration can take minutes and is resumable; it must finish before the launcher's 20-second readiness window. Older snapshot restores rebuild missing search cache versions. Retention clears the cache and captured content together.

Full snapshots stream native row order with insertion-order preservation and verify every column in bounded ranges before publication. Unexpected ordering/schema/value differences fail closed. Replay of the current purge ledger precedes cache hydration. The completed-dataset snapshot and restore are qualified using the existing offline 4 GB maintenance budget; normal serving stays at 512 MB. See hill-climb-20261106.md for measured durations.


For the search-cache v2 upgrade, stop and back up the database including any WAL, run the new binary's `init` offline, then start. On the frozen 275k-row checkpoint the one-time rebuild took 220 seconds, beyond the launcher's readiness window. Keep the installation's latest purge ledger with the backup.

For an offline rollback to a v1-cache binary, preserve original records and rebuild the derived cache: stop the service, invalidate cache versions in the analytics database, run the OLD binary's `init`, then restart that binary. With this installation's Python/DuckDB available, the invalidation command is:

```powershell
python -c "import duckdb; c=duckdb.connect('D:/Code/Runtrace/data/t3-usage.duckdb'); c.execute('UPDATE records SET search_version=0'); c.execute('CHECKPOINT'); c.close()"
```

Run this only with Runtrace stopped, against its analytics database. Merely switching executables does not restore the old cache representation; original JSON is retained so regeneration preserves newly collected data. Never run the command against the T3 source SQLite database.
