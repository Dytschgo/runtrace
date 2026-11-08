# Operations

A release install keeps the program, settings, data and logs in the per-user folder that `runtrace status` names (see the README). A source-built install made with `scripts/install.ps1` keeps them side by side in one folder, with `start.ps1`, `stop.ps1` and `runtrace.cmd` wrappers that pass its settings file.

```sh
runtrace start          # update the database in the foreground, then start the service and wait until it answers
runtrace status
runtrace capture pause
runtrace capture resume
runtrace stop
runtrace update         # back up the database, install the latest release, start again
```

`runtrace start` runs one-time database updates (for example filling new analytic columns, about 20 to 40 s on a large history) before the service starts, so they never race the readiness wait. It records the process id beside the data folder and confirms readiness with the process id the service reports. `runtrace stop` stops only a process that answers as this install, by its database identity.

Updates: the service asks GitHub for the latest release about 20 s after starting and then daily (`[update] check`, or `RUNTRACE_NO_UPDATE_CHECK=1`). The dashboard offers a newer release; starting it sends a POST that only this computer's dashboard can make (loopback host, same-origin, and a custom header a foreign page cannot send). The update runs in its own process: it downloads the platform's file, checks it against the release's SHA256SUMS, stops the service, copies the database and its write-ahead log into `backups/before-update-*` (keeping only the newest such copy), swaps the program and starts the new version, which applies its own database updates first.

`serve` collects through a dedicated DuckDB connection while readers use a separate connection. Collection backs off on source errors and catches up from retained projections. Every project and every 1,000 changed entities form commit boundaries. Final checkpoints advance after successful scope completion. Existing history may be visible in stages during the first backfill; capture quality remains partial.

Pause uses a small cross-process file next to the database. It does not wait for a database writer lock. The importer checks it between entities and rolls back the current uncommitted batch. Legacy database pause settings migrate to that file on startup. Resume does not change provider execution.

Stop the service before standalone import, purge, retention, archive or compression benchmark commands. MCP can query the running service through HTTP. Automatic Windows logon/service registration is not installed; start.ps1 is the explicit launcher.

## Backup, restore and purge

`archive run` now creates a complete normalized Zstandard Parquet snapshot: records, events, checkpoints, privacy settings, tombstones and source revision cache. It verifies every column bidirectionally against hot tables, records SHA-256 checksums, writes a manifest and atomically publishes the directory. Old event-only archive manifests remain verifiable. No hot rows are deleted, and native DuckDB remains the query store.

`archive verify` checks manifests, file checksums and counts. Restore with `archive restore --path <snapshot-directory>` into an empty database selected through T3UI_DB. Encryption keys are not included; encrypted content still needs the original OS keychain entry. Keep the current data/purges.jsonl ledger with any restore: it is applied to older snapshots so locally purged conversations do not reappear. Backups moved to another installation need that current ledger too. Set storage.purge_ledger_path to its explicit location; T3UI_DB overrides keep the original installation ledger by default. Old archive bytes are not physically rewritten by logical purge; remove obsolete external backups/exports for complete physical removal.

For an ordinary file backup, stop the service and copy data/, config/ and the current purge ledger. Do not copy a live DuckDB file independently of its active writer. For source T3 backups use SQLite's backup API; never copy only a live SQLite main file while its WAL is active.

Retention removes expired content from prompt, answer, tool and agent records when explicitly run. Metadata remains. It does not automatically rewrite old backup snapshots. Export remains a bounded redacted page, not a full disaster-recovery backup.

## Upgrade and removal

A release install updates with `runtrace update` or from the dashboard. A source-built install updates by running scripts/install.ps1 again: it builds the dashboard and the release program, stops the running service, swaps the program, keeps settings and data, and starts it again. Current source schemas are inspected and source SQLite is always read-only.

Uninstall by stopping the runtime, removing D:/Code/Runtrace and any external backups/exports, then removing the optional OS credential entry t3-usage-intelligence/content-key-v1 if encrypted capture was enabled. Remove the source checkout separately if desired. Original T3 history is unaffected.

The source checkout data directory is a Windows junction to the installed D: data directory. This keeps legacy relative archive paths working without leaving an analytics database on C:. The earlier prototype is preserved under backups/source-checkout-data. Remove the junction itself separately if removing the source checkout; its target is the live installed data directory.

The explicit maintenance configuration at D:/Code/Runtrace/config/maintenance.toml uses a 4,096 MB DuckDB budget for full snapshot verification; the normal service retains 512 MB. Run expensive maintenance offline. Live queries use the normal configuration again after start.ps1.

`runtrace start` applies database updates before starting the service; if they fail, the service is not started and the database is left as it was. Older snapshot restores rebuild missing search cache versions. Retention clears the cache and captured content together.

Full snapshots stream native row order with insertion-order preservation and verify every column in bounded ranges before publication. Unexpected ordering/schema/value differences fail closed. Replay of the current purge ledger precedes cache hydration. The completed-dataset snapshot and restore are qualified using the existing offline 4 GB maintenance budget; normal serving stays at 512 MB. See hill-climb-20261106.md for measured durations.


For the search-cache v2 upgrade, stop and back up the database including any WAL, run the new binary's `init` offline, then start. On the frozen 275k-row checkpoint the one-time rebuild took 220 seconds, beyond the launcher's readiness window. Keep the installation's latest purge ledger with the backup.

For an offline rollback to a v1-cache binary, preserve original records and rebuild the derived cache: stop the service, invalidate cache versions in the analytics database, run the OLD binary's `init`, then restart that binary. With this installation's Python/DuckDB available, the invalidation command is:

```powershell
python -c "import duckdb; c=duckdb.connect('D:/Code/Runtrace/data/t3-usage.duckdb'); c.execute('UPDATE records SET search_version=0'); c.execute('CHECKPOINT'); c.close()"
```

Run this only with Runtrace stopped, against its analytics database. Merely switching executables does not restore the old cache representation; original JSON is retained so regeneration preserves newly collected data. Never run the command against the T3 source SQLite database.
