# Threat model

Assets: personal prompts, code, tool outputs, project identities, usage patterns, encryption keys and T3 credentials. Boundaries: source read-only SQLite, analytics DuckDB/Parquet, local HTTP browser, stdio MCP and OS keychain.

Mitigations: no T3 authentication extraction; no source writes; pre-persistence secret filtering; optional authenticated encryption; ciphertext exclusion at common analytics boundary; allowlisted read-only MCP; no SQL tool; SQL parameters; row limits; foreign-origin and DNS-rebinding host rejection; loopback-only binding; redacted exports; purge tombstones; transactional checkpoints.

Residual risks: redaction false negatives; inference from content hashes; plaintext redacted data accessible to same-user processes/backups; OS compromise; huge source payload memory; arbitrary MCP client with same-user access; no signed provenance for offline snapshots; missing remote authentication transport; untested macOS/Linux keychain behavior; no at-rest encryption for metadata. Do not expose this service via a tunnel or proxy.
