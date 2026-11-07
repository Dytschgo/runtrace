# Remote machines

Inspection found zero peer_environment_links on this installation. Authenticated network collection, automated discovery and clock-skew estimation are not implemented or tested. This is an implementation gap, not proof T3 cannot expose remote data.

An explicit offline fallback is supported: copy a consistent SQLite backup from the remote machine using its existing secure backup process, then configure a separate TOML `source.instance_id`, `source.display_name`, `source.sqlite_path`. Use a unique instance identity and the same analytics database, running import commands sequentially. Never copy a live WAL database using only its main file; use SQLite's backup API on the source. No credentials belong in the snapshot or DuckDB. The current dashboard has an instance filter through `?instance=<id>`.

Temporary missing-source failures back off exponentially (up to one hour), do not commit a checkpoint and retry. Full message scans catch up when source retained history returns. Network disconnect and 24-hour outage recovery have not been validated. Source timestamps are retained; clock offset is unavailable.
