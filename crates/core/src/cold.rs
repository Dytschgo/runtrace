//! Registered Parquet segments and transaction-consistent logical reads.
//! Files are immutable. Only a committed manifest makes a file queryable.
use crate::{
    config::Config,
    storage::{Store, clock, now},
};
use anyhow::{Context, Result, ensure};
use duckdb::{Connection, params};
use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub(crate) struct Table {
    pub name: &'static str,
    pub keys: &'static [&'static str],
    age: &'static str,
}
pub(crate) const TABLES: [Table; 4] = [
    Table {
        name: "records",
        keys: &["id"],
        age: "occurred_at",
    },
    Table {
        name: "events",
        keys: &["event_id"],
        age: "occurred_at",
    },
    Table {
        name: "quota_samples",
        keys: &["provider", "window_kind", "sampled_at"],
        age: "sampled_at",
    },
    Table {
        name: "quota_events",
        keys: &["provider", "kind", "happened_at"],
        age: "happened_at",
    },
];
fn table(name: &str) -> Result<Table> {
    TABLES
        .into_iter()
        .find(|t| t.name == name)
        .ok_or_else(|| anyhow::anyhow!("Unknown cold table"))
}
fn index(spec: Table) -> &'static str {
    match spec.name {
        "records" => "cold_record_keys",
        "events" => "cold_event_keys",
        "quota_samples" => "cold_quota_sample_keys",
        "quota_events" => "cold_quota_event_keys",
        _ => unreachable!(),
    }
}
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// One multi-file reader keeps the plan independent of segment count.
/// Generation still comes from the reader transaction's committed manifest.
fn raw_segments(files: &[(i64, String)]) -> Result<String> {
    let mut paths = Vec::with_capacity(files.len());
    let mut generations = Vec::with_capacity(files.len());
    for (generation, path) in files {
        let path = literal(&absolute_segment_path(std::path::Path::new(path))?);
        paths.push(path.clone());
        generations.push(format!("({generation},{path})"));
    }
    Ok(format!(
        "SELECT p.* EXCLUDE(filename),m.generation AS _cold_generation FROM read_parquet([{}],filename=true,hive_partitioning=false) p JOIN (VALUES {}) m(generation,path) ON p.filename=m.path",
        paths.join(","),
        generations.join(",")
    ))
}

fn absolute_segment_path(path: &std::path::Path) -> Result<String> {
    let absolute = std::fs::canonicalize(path)?;
    let text = absolute.to_string_lossy();
    Ok(if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        text.strip_prefix(r"\\?\")
            .unwrap_or(&text)
            .replace('\\', "/")
    })
}

/// Upgrade unpublished relative manifests only when an existing file's checksum
/// proves the original location or the configured archive directory is correct.
pub(crate) fn anchor_relative_segments(c: &Config, s: &Store) -> Result<()> {
    let entries: Vec<(i64, String, String)> = s
        .conn
        .prepare("SELECT generation,path,sha256 FROM cold_segments")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<duckdb::Result<_>>()?;
    for (generation, path, digest) in entries {
        let original = std::path::Path::new(&path);
        if original.is_absolute() {
            continue;
        }
        let fallback = original
            .file_name()
            .map(|name| std::path::Path::new(&c.storage.archive_path).join(name));
        let mut resolved = None;
        for candidate in std::iter::once(original.to_path_buf()).chain(fallback) {
            if candidate.is_file() && crate::compression::checksum(&candidate)? == digest {
                resolved = Some(absolute_segment_path(&candidate)?);
                break;
            }
        }
        let resolved = resolved.ok_or_else(|| anyhow::anyhow!("Cannot resolve a registered relative segment. Set storage.archive_path to its original absolute directory."))?;
        s.conn.execute(
            "UPDATE cold_segments SET path=? WHERE generation=?",
            params![resolved, generation],
        )?;
    }
    Ok(())
}

/// Detach a stopped database backup from the installation's immutable files.
/// Only the copied database is rewritten; callers preserve older backups until
/// this succeeds. A failed copy leaves the original installation untouched.
pub fn make_backup_self_contained(
    database: &std::path::Path,
    directory: &std::path::Path,
) -> Result<Vec<std::path::PathBuf>> {
    let directory = std::fs::canonicalize(directory)?;
    let database = std::fs::canonicalize(database)?;
    ensure!(
        database.parent() == Some(directory.join("database").as_path()),
        "Backup database must be inside its dedicated database directory"
    );
    let conn = Connection::open_with_flags(
        &database,
        duckdb::Config::default()
            .with("autoinstall_known_extensions", "false")?
            .with("autoload_known_extensions", "false")?,
    )?;
    let has_manifest: bool = conn.query_row(
        "SELECT count(*)>0 FROM information_schema.tables WHERE table_catalog=current_database() AND table_schema='main' AND table_name='cold_segments'",
        [], |row| row.get(0),
    )?;
    if !has_manifest {
        conn.execute_batch("CHECKPOINT")?;
        drop(conn);
        finish_backup_database(&database, &directory)?;
        return Ok(Vec::new());
    }
    let files: Vec<(i64, String, String)> = conn
        .prepare("SELECT generation,path,sha256 FROM cold_segments ORDER BY generation")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<duckdb::Result<_>>()?;
    let mut replacements = Vec::with_capacity(files.len());
    let mut source_paths = Vec::with_capacity(files.len());
    for (generation, source, digest) in &files {
        ensure!(
            std::path::Path::new(source).is_absolute(),
            "Registered cold paths must be anchored before backing up"
        );
        let segments = directory.join("cold");
        std::fs::create_dir_all(&segments)?;
        let destination = segments.join(format!("segment-{generation}.parquet"));
        std::fs::copy(source, &destination)?;
        ensure!(
            crate::compression::checksum(&destination)? == *digest,
            "Copied backup segment checksum mismatch"
        );
        sync_backup_file(&destination)?;
        source_paths.push(std::fs::canonicalize(source)?);
        replacements.push((*generation, absolute_segment_path(&destination)?));
    }
    #[cfg(unix)]
    if !files.is_empty() {
        std::fs::File::open(directory.join("cold"))?.sync_all()?;
    }
    conn.execute_batch("BEGIN")?;
    for (generation, path) in replacements {
        conn.execute(
            "UPDATE cold_segments SET path=? WHERE generation=?",
            params![path, generation],
        )?;
    }
    conn.execute_batch("COMMIT; CHECKPOINT")?;
    drop(conn);
    finish_backup_database(&database, &directory)?;
    Ok(source_paths)
}

fn finish_backup_database(database: &std::path::Path, directory: &std::path::Path) -> Result<()> {
    sync_backup_file(database)?;
    #[cfg(not(unix))]
    let _ = directory;
    #[cfg(unix)]
    {
        std::fs::File::open(directory.join("database"))?.sync_all()?;
        std::fs::File::open(directory)?.sync_all()?;
    }
    Ok(())
}

fn sync_backup_file(path: &std::path::Path) -> Result<()> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()?;
    Ok(())
}

pub(crate) fn record_index_source(conn: &Connection) -> Result<String> {
    let catalog: String = conn.query_row("SELECT current_database()", [], |r| r.get(0))?;
    let catalog = ident(&catalog);
    let columns = "id,instance_id,kind,source_id,project_id,thread_id,occurred_at,payload_hash,source_updated_at,source_version";
    Ok(format!(
        "(SELECT {columns} FROM {catalog}.main.records UNION ALL SELECT {columns} FROM {catalog}.main.cold_record_keys c WHERE NOT EXISTS(SELECT 1 FROM {catalog}.main.records h WHERE h.id=c.id) AND NOT EXISTS(SELECT 1 FROM {catalog}.main.tombstones t WHERE (t.scope='thread' AND t.source_id=c.thread_id) OR(t.scope='project' AND t.source_id=c.project_id) OR(t.scope='before' AND runtrace_time_us(c.occurred_at)<runtrace_time_us(t.source_id)) OR(t.scope='record' AND t.source_id=c.id)))"
    ))
}

/// Logical source for writer-side membership checks. Caller controls its transaction.
pub(crate) fn source(conn: &Connection, name: &str, content_days: i64) -> Result<String> {
    let spec = table(name)?;
    let catalog: String = conn.query_row("SELECT current_database()", [], |r| r.get(0))?;
    let native = format!("{}.main.{}", ident(&catalog), ident(name));
    let tombstones = format!("{}.main.tombstones", ident(&catalog));
    let files: Vec<(i64, String)> = conn
        .prepare(
            "SELECT generation,path FROM cold_segments WHERE table_name=? ORDER BY generation",
        )?
        .query_map([name], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<duckdb::Result<_>>()?;
    if files.is_empty() {
        return Ok(native);
    }
    let columns: Vec<String> = conn
        .prepare(&format!("PRAGMA table_info('{}')", name))?
        .query_map([], |r| r.get(1))?
        .collect::<duckdb::Result<_>>()?;
    let raw = raw_segments(&files)?;
    let native_index = format!("{}.main.{}", ident(&catalog), ident(index(spec)));
    let same = |left: &str, right: &str| {
        spec.keys
            .iter()
            .map(|k| format!("{left}.{}={right}.{}", ident(k), ident(k)))
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    let expired = format!(
        "c.kind IN ('prompt','answer','tool','agent') AND runtrace_time_us(c.occurred_at)<{}",
        (clock() - chrono::Duration::days(content_days)).timestamp_micros()
    );
    let cleared =
        "json_merge_patch(c.data,'{\"content_redacted\":null,\"content_ciphertext\":null}')";
    let projection = columns.iter().map(|column| {
        let value = if name=="records" { match column.as_str() {
            "data" => Some(cleared.to_string()),
            "preview_doc" => Some("json_merge_patch(c.preview_doc,'{\"content_redacted\":null,\"content_truncated\":null}')".to_string()),
            "search_text"|"redacted_characters" => Some("NULL".to_string()),
            "json_characters" => Some(format!("length(CAST({cleared} AS VARCHAR))")),
            _ => None,
        }} else { None };
        match value { Some(value) if column=="data"=>format!("CAST(CASE WHEN {expired} THEN {value} ELSE c.data END AS JSON) AS data"), Some(value) if column=="preview_doc"=>format!("CAST(CASE WHEN {expired} THEN {value} ELSE c.preview_doc END AS VARCHAR) AS preview_doc"), Some(value)=>format!("CASE WHEN {expired} THEN {value} ELSE c.{} END AS {}",ident(column),ident(column)), None if name=="records" && matches!(column.as_str(),"source_updated_at"|"source_version")=>format!("l.{}",ident(column)), None=>format!("c.{}",ident(column)) }
    }).collect::<Vec<_>>().join(",");
    let purge = if matches!(name, "records" | "events") {
        let record_mask = if name == "records" {
            " OR (t.scope='record' AND t.source_id=c.id)"
        } else {
            " OR (t.scope='record' AND t.source_id=c.entity_id)"
        };
        format!(
            "AND NOT EXISTS(SELECT 1 FROM {tombstones} t WHERE (t.scope='thread' AND t.source_id=c.thread_id) OR (t.scope='project' AND t.source_id=c.project_id) OR (t.scope='before' AND runtrace_time_us(c.occurred_at)<runtrace_time_us(t.source_id)){record_mask})"
        )
    } else {
        String::new()
    };
    Ok(format!(
        "(WITH cold_raw AS NOT MATERIALIZED ({raw}) SELECT {projection} FROM cold_raw c JOIN {native_index} l ON {} AND c._cold_generation=l.generation WHERE NOT EXISTS(SELECT 1 FROM {native} h WHERE {}) {purge} UNION ALL SELECT * FROM {native})",
        same("c", "l"),
        same("c", "h")
    ))
}

pub struct ReadSnapshot<'a> {
    conn: &'a Connection,
}
impl Drop for ReadSnapshot<'_> {
    fn drop(&mut self) {
        let _ = self.conn.execute_batch("ROLLBACK");
    }
}
/// Begin before reading the manifest so hot deletion and cold publication are
/// observed in the same MVCC snapshot. Temporary views roll back on guard drop.
pub fn read_snapshot(s: &Store) -> Result<ReadSnapshot<'_>> {
    s.conn.execute_batch("BEGIN")?;
    let guard = ReadSnapshot { conn: &s.conn };
    install_views(s)?;
    Ok(guard)
}
pub(crate) fn install_views(s: &Store) -> Result<Vec<&'static str>> {
    let mut installed = vec![];
    for spec in TABLES {
        let sql = source(&s.conn, spec.name, s.content_retention_days)?;
        if sql.starts_with('(') {
            s.conn.execute_batch(&format!(
                "CREATE OR REPLACE TEMP VIEW {} AS SELECT * FROM {sql}",
                ident(spec.name)
            ))?;
            installed.push(spec.name);
        }
    }
    Ok(installed)
}

/// Copy, compare, restore, and publish a bounded batch before evicting hot rows.
pub fn compact(c: &Config, s: &Store) -> Result<Value> {
    compact_with_hook(c, s, |_| Ok(()))
}
fn compact_with_hook(c: &Config, s: &Store, hook: impl FnMut(&str) -> Result<()>) -> Result<Value> {
    compact_selected(
        c,
        s,
        Selection::Age(
            (clock() - chrono::Duration::days(c.storage.hot_retention_days)).timestamp_micros(),
        ),
        hook,
    )
}

#[derive(Clone, Copy)]
enum Selection<'a> {
    Age(i64),
    Batch(&'a [String]),
}

/// Spill only this offline import's committed records, including recent large outputs.
/// Existing unrelated hot history and quota state keep their normal age policy.
pub(crate) fn spill_committed(c: &Config, s: &Store, ids: &[String]) -> Result<Value> {
    compact_selected(c, s, Selection::Batch(ids), |_| Ok(()))
}

fn compact_selected(
    c: &Config,
    s: &Store,
    selection: Selection<'_>,
    mut hook: impl FnMut(&str) -> Result<()>,
) -> Result<Value> {
    let archive_directory = std::path::absolute(&c.storage.archive_path)?;
    std::fs::create_dir_all(&archive_directory)?;
    crate::storage::retain_content(&s.conn, c.storage.content_retention_days)?;
    let cutoff = match selection {
        Selection::Age(at) => Some(at),
        Selection::Batch(_) => None,
    };
    let budget = (c.storage.memory_limit_mb as usize * 1024 * 1024 / 16)
        .clamp(1024 * 1024, 64 * 1024 * 1024);
    let mut moved = 0i64;
    let mut segments = 0;
    for spec in TABLES {
        // Read only positions and bounded size metadata, never full documents.
        let estimate = if spec.name == "records" {
            "16384+4*coalesce(redacted_characters,0)"
        } else {
            "4096"
        };
        let eligible = match selection {
            Selection::Age(at) => format!("runtrace_time_us({})<{at}", ident(spec.age)),
            Selection::Batch(ids)
                if !ids.is_empty() && matches!(spec.name, "records" | "events") =>
            {
                let key = if spec.name == "records" {
                    "id"
                } else {
                    "entity_id"
                };
                format!(
                    "{key} IN ({})",
                    ids.iter()
                        .map(|id| literal(id))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            Selection::Batch(_) => "false".into(),
        };
        let rows: Vec<(i64, i64)> = s
            .conn
            .prepare(&format!(
                "SELECT rowid,{estimate} FROM main.{} WHERE {eligible} ORDER BY rowid",
                ident(spec.name)
            ))?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<duckdb::Result<_>>()?;
        let mut at = 0;
        while at < rows.len() {
            let start = at;
            let mut bytes = 0usize;
            while at < rows.len()
                && (at == start || bytes.saturating_add(rows[at].1.max(0) as usize) <= budget)
            {
                bytes = bytes.saturating_add(rows[at].1.max(0) as usize);
                at += 1;
            }
            let first = rows[start].0;
            let end = rows[at - 1].0 + 1;
            let predicate = format!("rowid>={first} AND rowid<{end} AND {eligible}");
            let final_path = archive_directory.join(format!(
                "cold-{}-{}.parquet",
                spec.name,
                uuid::Uuid::now_v7()
            ));
            let temporary = final_path.with_extension("parquet.tmp");
            let file = temporary.to_string_lossy().replace('\\', "/");
            s.conn
                .execute_batch("BEGIN; SET preserve_insertion_order=true")?;
            let result = (|| {
                // Membership filters can change scan order. Sort this bounded
                // slice to match the exact verifier's physical-row sequence.
                s.conn.execute_batch(&format!("COPY (SELECT * FROM main.{} WHERE {predicate} ORDER BY rowid) TO {} (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL {}, ROW_GROUP_SIZE 2048)",ident(spec.name),literal(&file),c.storage.zstd_level))?;
                ensure!(
                    crate::archive::verify_selected_table(
                        &s.conn,
                        spec.name,
                        &file.replace('\'', "''"),
                        &predicate,
                        first,
                        end
                    )? == 0,
                    "Cold copy differs from hot rows"
                );
                hook("after_copy")?;
                let count = s.conn.execute(
                    &format!("DELETE FROM main.{} WHERE {predicate}", ident(spec.name)),
                    [],
                )? as i64;
                hook("after_delete")?;
                // Restore into native column types after deletion, before commit.
                s.conn.execute_batch(&format!("CREATE TEMP TABLE cold_restore_probe AS SELECT * FROM main.{} LIMIT 0; INSERT INTO cold_restore_probe BY NAME SELECT * FROM read_parquet({})",ident(spec.name),literal(&file)))?;
                ensure!(
                    crate::archive::verify_streamed_table(
                        &s.conn,
                        "cold_restore_probe",
                        &file.replace('\'', "''")
                    )? == 0,
                    "Cold restore differs from Parquet"
                );
                s.conn.execute_batch("DROP TABLE cold_restore_probe")?;
                std::fs::rename(&temporary, &final_path)?;
                hook("after_rename")?;
                let path = absolute_segment_path(&final_path)?;
                let digest = crate::compression::checksum(&final_path)?;
                s.conn.execute("INSERT INTO cold_segments SELECT coalesce(max(generation),0)+1,?,?,?,?,? FROM cold_segments",params![spec.name,path,count,digest,now()])?;
                let generation: i64 =
                    s.conn
                        .query_row("SELECT max(generation) FROM cold_segments", [], |r| {
                            r.get(0)
                        })?;
                if spec.name == "records" {
                    s.conn.execute_batch(&format!("INSERT INTO cold_record_keys SELECT id,{generation},instance_id,kind,source_id,project_id,thread_id,occurred_at,payload_hash,source_updated_at,source_version FROM read_parquet({}) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,instance_id=excluded.instance_id,kind=excluded.kind,source_id=excluded.source_id,project_id=excluded.project_id,thread_id=excluded.thread_id,occurred_at=excluded.occurred_at,payload_hash=excluded.payload_hash,source_updated_at=excluded.source_updated_at,source_version=excluded.source_version",literal(&path)))?;
                } else {
                    let keys = spec
                        .keys
                        .iter()
                        .map(|k| ident(k))
                        .collect::<Vec<_>>()
                        .join(",");
                    s.conn.execute_batch(&format!("INSERT INTO {} SELECT {keys},{generation} FROM read_parquet({}) ON CONFLICT({keys}) DO UPDATE SET generation=excluded.generation",index(spec),literal(&path)))?;
                }
                hook("before_commit")?;
                Ok::<_, anyhow::Error>(count)
            })();
            let result = result.and_then(|count| {
                s.conn.execute_batch("COMMIT")?;
                hook("after_commit")?;
                Ok(count)
            });
            match result {
                Ok(count) => {
                    moved += count;
                    segments += 1;
                }
                Err(error) => {
                    // COMMIT can fail after the engine has already ended the
                    // transaction. Establish a fresh snapshot before deciding
                    // whether its files are still unregistered.
                    let rollback = s.conn.execute_batch("ROLLBACK");
                    if let Err(cleanup) = remove_uncommitted_files(
                        &s.conn,
                        &[temporary.as_path(), final_path.as_path()],
                    ) {
                        return Err(error.context(format!(
                            "Publication file cleanup deferred: {cleanup:#}; initial rollback: {}",
                            rollback
                                .err()
                                .map_or_else(|| "confirmed".into(), |e| e.to_string())
                        )));
                    }
                    return Err(error);
                }
            }
        }
    }
    Ok(
        json!({"moved_rows":moved,"segments":segments,"cutoff_epoch_us":cutoff,"copy_verified":true,"restore_verified":true}),
    )
}

/// After a rollback attempt, establish and close an independent read snapshot.
/// If the prior transaction is still active, BEGIN fails and files are retained.
/// Validate every candidate before removing any; a committed path is never an
/// orphan, including when COMMIT reports an error after making data durable.
fn remove_uncommitted_files(conn: &Connection, paths: &[&std::path::Path]) -> Result<()> {
    conn.execute_batch("BEGIN")
        .context("Cannot establish an independent publication snapshot")?;
    let removable = (|| {
        let mut removable = Vec::new();
        for path in paths {
            if !path.try_exists()? {
                continue;
            }
            let absolute = absolute_segment_path(path)?;
            let registered: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM cold_segments WHERE path=?)",
                [absolute],
                |row| row.get(0),
            )?;
            ensure!(
                !registered,
                "A publication file is registered; retaining files"
            );
            removable.push(*path);
        }
        Ok::<_, anyhow::Error>(removable)
    })();
    conn.execute_batch("ROLLBACK")
        .context("Cannot close the independent publication snapshot; retaining files")?;
    for path in removable? {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub fn verify(s: &Store) -> Result<Value> {
    let entries: Vec<(String, i64, String)> = s
        .conn
        .prepare("SELECT path,row_count,sha256 FROM cold_segments ORDER BY generation")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<duckdb::Result<_>>()?;
    for (path, count, digest) in &entries {
        ensure!(
            crate::compression::checksum(std::path::Path::new(path))? == *digest,
            "Cold segment checksum mismatch"
        );
        let actual: i64 = s.conn.query_row(
            &format!("SELECT count(*) FROM read_parquet({})", literal(path)),
            [],
            |r| r.get(0),
        )?;
        ensure!(actual == *count, "Cold segment row count mismatch");
    }
    for spec in TABLES {
        let files: Vec<(i64, String)> = s
            .conn
            .prepare(
                "SELECT generation,path FROM cold_segments WHERE table_name=? ORDER BY generation",
            )?
            .query_map([spec.name], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<duckdb::Result<_>>()?;
        let keys = spec
            .keys
            .iter()
            .map(|k| ident(k))
            .collect::<Vec<_>>()
            .join(",");
        let expected = if files.is_empty() {
            format!("SELECT {keys},generation FROM {} WHERE false", index(spec))
        } else {
            let raw = raw_segments(&files)?;
            format!(
                "SELECT {keys},max(_cold_generation) AS generation FROM ({raw}) GROUP BY {keys}"
            )
        };
        let different:i64=s.conn.query_row(&format!("WITH expected AS ({expected}), actual AS (SELECT {keys},generation FROM {}) SELECT count(*) FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected))",index(spec)),[],|r|r.get(0))?;
        ensure!(
            different == 0,
            "Cold identity index differs from registered Parquet"
        );
    }
    Ok(json!({"verified_cold_segments":entries.len()}))
}

/// Hourly maintenance follows normal collector rounds. A failed run keeps the
/// last success and retries on the next round; it never publishes partial files.
pub fn maintain_due(c: &Config, s: &Store) -> Result<Value> {
    let previous: Value = s
        .setting("storage:maintenance")
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or(Value::Null);
    let now_ms = clock().timestamp_millis();
    if let Some(last) = previous["last_success_epoch_ms"].as_i64()
        && now_ms >= last
        && now_ms - last < 60 * 60 * 1000
    {
        return Ok(previous);
    }
    let result = compact(c, s);
    let status = match &result {
        Ok(report) => json!({"state":"synced","last_success_epoch_ms":now_ms,"report":report}),
        Err(_) => {
            json!({"state":"failed","last_success_epoch_ms":previous["last_success_epoch_ms"],"error_category":"archive_maintenance_failed"})
        }
    };
    s.set("storage:maintenance", &status.to_string())?;
    result.map(|_| status)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quota_sampling_commits_while_cold_publication_is_uncommitted() {
        let temp = tempfile::tempdir().unwrap();
        let mut config: Config =
            toml::from_str(include_str!("../../../config/default.toml")).unwrap();
        config.storage.duckdb_path = temp.path().join("test.duckdb").to_string_lossy().into();
        config.storage.archive_path = temp.path().join("archive").to_string_lossy().into();
        let writer = Store::open(&config).unwrap();
        let sample = writer.try_clone().unwrap();
        let now = clock();
        writer
            .conn
            .execute(
                "INSERT INTO quota_samples VALUES(?,?,?,?,?,?,?,?)",
                params![
                    "neutral",
                    "five_hour",
                    (now - chrono::Duration::days(40)).to_rfc3339(),
                    10.0,
                    (now - chrono::Duration::days(39)).to_rfc3339(),
                    300,
                    "neutral",
                    "synthetic"
                ],
            )
            .unwrap();
        let cache = temp.path().join("caches");
        std::fs::create_dir(&cache).unwrap();
        std::fs::write(cache.join("neutral.json"), json!({"driver":"synthetic","instanceId":"neutral","enabled":true,"usageLimits":{"checkedAt":now.to_rfc3339(),"windows":[{"id":"five_hour","usedPercent":80.0,"resetsAt":(now+chrono::Duration::hours(1)).to_rfc3339(),"windowDurationMins":300}]}}).to_string()).unwrap();
        let mut sampled = false;
        let moved = compact_with_hook(&config, &writer, |stage| {
            if stage == "before_commit" {
                let report = crate::quota_sources::collect_from(
                    &sample,
                    &temp.path().join("neutral-home"),
                    Some(&cache),
                )?;
                assert_eq!(report["samples_added"], 1);
                sampled = true;
            }
            Ok(())
        })
        .unwrap();
        assert!(sampled);
        assert_eq!(moved["moved_rows"], 1);
        assert_eq!(verify(&writer).unwrap()["verified_cold_segments"], 1);
        let result =
            crate::analytics::query(&sample, "quota/samples", &Default::default()).unwrap();
        assert_eq!(result["data"].as_array().unwrap().len(), 2);
        assert_eq!(
            sample
                .conn
                .query_row("SELECT count(*) FROM quota_samples", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn cold_preview_keeps_native_column_types() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c: Config = toml::from_str(include_str!("../../../config/default.toml")).unwrap();
        c.storage.duckdb_path = tmp.path().join("test.duckdb").to_string_lossy().into();
        c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
        let s = Store::open(&c).unwrap();
        let old = (clock() - chrono::Duration::days(40)).to_rfc3339();
        s.put(
            "local",
            "tool",
            "neutral-tool",
            "p",
            "t",
            "r",
            &old,
            &old,
            "partial",
            "fixture",
            json!({"tool_name":"neutral_tool","content_redacted":"Neutral output"}),
        )
        .unwrap();
        let schema = |table: &str| -> Vec<(String, String)> {
            s.conn
                .prepare(&format!("DESCRIBE SELECT * FROM {table}"))
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<duckdb::Result<_>>()
                .unwrap()
        };
        let native = schema("main.records");
        compact(&c, &s).unwrap();
        s.conn.execute_batch("BEGIN").unwrap();
        install_views(&s).unwrap();
        let logical = schema("records");
        s.conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(native, logical);
    }

    #[test]
    fn expired_preview_queries_stay_identical_after_eviction() {
        for days in [40, 120] {
            let tmp = tempfile::tempdir().unwrap();
            let mut c: Config =
                toml::from_str(include_str!("../../../config/default.toml")).unwrap();
            c.storage.duckdb_path = tmp.path().join("test.duckdb").to_string_lossy().into();
            c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
            let s = Store::open(&c).unwrap();
            let old = (clock() - chrono::Duration::days(days)).to_rfc3339();
            s.put(
                "local",
                "tool",
                "neutral-tool",
                "p",
                "t",
                "r",
                &old,
                &old,
                "partial",
                "fixture",
                json!({"tool_name":"neutral_tool","content_redacted":"Neutral expired output"}),
            )
            .unwrap();
            drop(s);
            c.storage.content_retention_days = 30;
            let s = Store::open(&c).unwrap();
            crate::storage::retain_content(&s.conn, c.storage.content_retention_days).unwrap();
            let before = crate::analytics::query(&s, "tool-calls", &Default::default()).unwrap();
            assert_eq!(before["data"].as_array().unwrap().len(), 1);
            assert!(before["data"][0]["data"].get("content_redacted").is_none());
            compact(&c, &s).unwrap();
            let after = crate::analytics::query(&s, "tool-calls", &Default::default()).unwrap();
            assert_eq!(before, after, "record age: {days} days");
        }
    }

    #[test]
    fn failed_publication_cleanup_refuses_registered_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c: Config = toml::from_str(include_str!("../../../config/default.toml")).unwrap();
        c.storage.duckdb_path = tmp.path().join("fixture.duckdb").to_string_lossy().into();
        c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
        let s = Store::open(&c).unwrap();
        let old = (clock() - chrono::Duration::days(40)).to_rfc3339();
        s.put(
            "local",
            "tool",
            "committed",
            "p",
            "t",
            "r",
            &old,
            &old,
            "partial",
            "fixture",
            json!({"content_redacted":"Neutral committed value"}),
        )
        .unwrap();
        compact(&c, &s).unwrap();
        let path: String = s
            .conn
            .query_row(
                "SELECT path FROM cold_segments ORDER BY generation LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let committed = std::path::Path::new(&path);
        let checksum = crate::compression::checksum(committed).unwrap();
        let pending = tmp.path().join("pending.parquet.tmp");
        std::fs::write(&pending, b"Retain until all ownership checks pass").unwrap();
        assert!(remove_uncommitted_files(&s.conn, &[pending.as_path(), committed]).is_err());
        assert_eq!(
            std::fs::read(&pending).unwrap(),
            b"Retain until all ownership checks pass"
        );
        assert_eq!(crate::compression::checksum(committed).unwrap(), checksum);
        assert_eq!(verify(&s).unwrap()["verified_cold_segments"], 2);
        s.conn.execute_batch("BEGIN").unwrap();
        assert!(remove_uncommitted_files(&s.conn, &[pending.as_path()]).is_err());
        assert!(pending.is_file());
        // A failed independent BEGIN must not end the caller's transaction.
        s.conn.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn failed_publication_removes_only_its_uncommitted_files() {
        for fail_at in [
            "after_copy",
            "after_delete",
            "after_rename",
            "before_commit",
            "commit_wal",
            "after_commit",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let mut c: Config =
                toml::from_str(include_str!("../../../config/default.toml")).unwrap();
            c.storage.duckdb_path = tmp.path().join("test.duckdb").to_string_lossy().into();
            c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
            c.storage.content_retention_days = 3650;
            let s = Store::open(&c).unwrap();
            let old = (clock() - chrono::Duration::days(40)).to_rfc3339();
            for id in ["committed", "pending"] {
                s.put(
                    "local",
                    "tool",
                    id,
                    "p",
                    "t",
                    "r",
                    &old,
                    &old,
                    "partial",
                    "fixture",
                    json!({"content_redacted":format!("Neutral {id} output")}),
                )
                .unwrap();
                if id == "committed" {
                    compact(&c, &s).unwrap();
                }
            }
            let directory = std::path::Path::new(&c.storage.archive_path);
            std::fs::write(directory.join("unrelated.parquet"), b"Keep unrelated bytes").unwrap();
            let files = || {
                std::fs::read_dir(directory)
                    .unwrap()
                    .map(|entry| {
                        let path = entry.unwrap().path();
                        (
                            path.file_name().unwrap().to_os_string(),
                            crate::compression::checksum(&path).unwrap(),
                        )
                    })
                    .collect::<std::collections::BTreeMap<_, _>>()
            };
            let before_files = files();
            let before = crate::analytics::query(&s, "tool-calls", &Default::default()).unwrap();
            let wal = std::path::PathBuf::from(format!("{}.wal", c.storage.duckdb_path));
            if fail_at == "commit_wal" {
                s.conn.execute_batch("CHECKPOINT").unwrap();
                assert!(!wal.exists());
            }
            let error = compact_with_hook(&c, &s, |stage| {
                if stage == fail_at {
                    anyhow::bail!("Neutral publication failure");
                }
                if fail_at == "commit_wal" && stage == "before_commit" {
                    // Fail the engine's real WAL creation, not the hook.
                    std::fs::create_dir(&wal)?;
                }
                Ok(())
            })
            .unwrap_err();
            if fail_at == "commit_wal" {
                std::fs::remove_dir(&wal).unwrap();
                assert!(
                    format!("{error:#}").contains("Failed to commit"),
                    "{error:#}"
                );
            }
            if fail_at == "after_commit" {
                let after_files = files();
                assert_eq!(after_files.len(), before_files.len() + 1);
                for (name, digest) in &before_files {
                    assert_eq!(after_files.get(name), Some(digest));
                }
                assert!(format!("{error:#}").contains("registered"), "{error:#}");
            } else {
                assert_eq!(
                    files(),
                    before_files,
                    "Uncommitted files remain after {fail_at}"
                );
            }
            assert_eq!(
                crate::analytics::query(&s, "tool-calls", &Default::default()).unwrap(),
                before
            );
            assert_eq!(
                verify(&s).unwrap()["verified_cold_segments"],
                if fail_at == "after_commit" { 3 } else { 2 }
            );
        }
    }

    #[test]
    fn interrupted_publication_keeps_hot_rows_and_recovers_after_reopen() {
        for fail_at in [
            "after_copy",
            "after_delete",
            "after_rename",
            "before_commit",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let mut c: Config =
                toml::from_str(include_str!("../../../config/default.toml")).unwrap();
            c.storage.duckdb_path = tmp.path().join("test.duckdb").to_string_lossy().into();
            c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
            c.storage.content_retention_days = 3650;
            let s = Store::open(&c).unwrap();
            let old = (clock() - chrono::Duration::days(40)).to_rfc3339();
            s.put(
                "local",
                "tool",
                "a",
                "p",
                "t",
                "r",
                &old,
                &old,
                "partial",
                "fixture",
                json!({"content_redacted":"Synthetic retained output"}),
            )
            .unwrap();
            assert!(
                compact_with_hook(&c, &s, |stage| {
                    if stage == fail_at {
                        anyhow::bail!("Synthetic interruption")
                    }
                    Ok(())
                })
                .is_err()
            );
            assert_eq!(
                s.conn
                    .query_row("SELECT count(*) FROM main.records", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                s.conn
                    .query_row("SELECT count(*) FROM cold_segments", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                s.conn
                    .query_row("SELECT count(*) FROM cold_record_keys", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            drop(s);
            let reopened = Store::open(&c).unwrap();
            assert_eq!(compact(&c, &reopened).unwrap()["moved_rows"], 2);
            assert_eq!(crate::analytics::query(&reopened,"tool-calls",&Default::default()).unwrap()["data"].as_array().unwrap().len(),1);
        }
    }
}
