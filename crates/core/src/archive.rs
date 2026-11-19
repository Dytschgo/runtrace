use crate::{
    config::Config,
    privacy::hash,
    storage::{Store, now},
};
use anyhow::Result;
use serde_json::{Value, json};
struct RollbackGuard<'a>(&'a duckdb::Connection);
impl Drop for RollbackGuard<'_> {
    fn drop(&mut self) {
        let _ = self.0.execute_batch("ROLLBACK");
    }
}
struct TemporarySnapshotViews<'a> {
    conn: &'a duckdb::Connection,
    views: Vec<&'static str>,
}
impl Drop for TemporarySnapshotViews<'_> {
    fn drop(&mut self) {
        for name in &self.views {
            let _=self.conn.execute_batch(&format!("DROP TABLE IF EXISTS temp.main.flat_snapshot_{name}; DROP VIEW IF EXISTS temp.main.{name}"));
        }
    }
}
fn checksum(p: &str) -> Result<String> {
    Ok(hash(
        &std::fs::read(p)?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
    ))
}
fn legacy_verify(c: &Config, s: &Store, action: &str) -> Result<Value> {
    anyhow::ensure!(
        ["run", "verify"].contains(&action),
        "Use archive run or archive verify"
    );
    std::fs::create_dir_all(&c.storage.archive_path)?;
    if action == "verify" {
        let rows=s.rows("SELECT json_object('path',path,'sha256',sha256,'rows',row_count)::VARCHAR FROM archives",&[])?;
        for r in &rows {
            let recorded = r["path"].as_str().unwrap();
            let actual = match checksum(recorded) {
                Err(error)
                    if std::path::Path::new(recorded).is_relative()
                        && error
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    // Older exports stored paths relative to the command's cwd.
                    // The configured archive directory supplies the location;
                    // the original checksum still has to establish byte identity.
                    let filename = std::path::Path::new(recorded)
                        .file_name()
                        .ok_or_else(|| anyhow::anyhow!("Legacy archive filename missing"))?;
                    checksum(
                        &std::path::Path::new(&c.storage.archive_path)
                            .join(filename)
                            .to_string_lossy(),
                    )?
                }
                result => result?,
            };
            anyhow::ensure!(
                actual == r["sha256"].as_str().unwrap(),
                "Archive checksum mismatch"
            )
        }
        return Ok(json!({"verified":rows.len()}));
    }
    let path = std::path::Path::new(&c.storage.archive_path)
        .join(format!("events-{}.parquet", uuid::Uuid::now_v7()))
        .to_string_lossy()
        .to_string();
    let escaped = path.replace('\'', "''");
    s.conn.execute_batch(&format!("COPY (SELECT * FROM events ORDER BY occurred_at,event_id) TO '{escaped}.tmp' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)"))?;
    let count: i64 = s.conn.query_row(
        &format!("SELECT count(*) FROM read_parquet('{escaped}.tmp')"),
        [],
        |r| r.get(0),
    )?;
    std::fs::rename(format!("{path}.tmp"), &path)?;
    s.conn.execute(
        "INSERT INTO archives VALUES (?,?,?,?)",
        duckdb::params![path, checksum(&path)?, count, now()],
    )?;
    Ok(
        json!({"path":path,"rows":count,"hot_deleted":false,"mode":"event backup; hot eviction not implemented"}),
    )
}

/// Full normalized lossless snapshot. Hot rows stay queryable in native DuckDB.
pub fn run(c: &Config, s: &Store, action: &str) -> Result<Value> {
    anyhow::ensure!(
        ["run", "verify"].contains(&action),
        "Use archive run or archive verify"
    );
    if action == "verify" {
        let cold = crate::cold::verify(s)?;
        let old = legacy_verify(c, s, "verify")?;
        let manifests=s.rows("SELECT json_object('directory',directory,'sha256',manifest_sha256)::VARCHAR FROM snapshot_exports",&[])?;
        for entry in &manifests {
            let dir = std::path::Path::new(entry["directory"].as_str().unwrap());
            let manifest_path = dir.join("manifest.json");
            anyhow::ensure!(
                crate::compression::checksum(&manifest_path)? == entry["sha256"].as_str().unwrap(),
                "Snapshot manifest checksum mismatch"
            );
            let manifest: Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
            for file in manifest["files"].as_array().unwrap() {
                let path = dir.join(file["file"].as_str().unwrap());
                anyhow::ensure!(
                    crate::compression::checksum(&path)? == file["sha256"].as_str().unwrap(),
                    "Snapshot file checksum mismatch"
                );
                let quoted = path.to_string_lossy().replace('\'', "''");
                let n: i64 = s.conn.query_row(
                    &format!("SELECT count(*) FROM read_parquet('{quoted}')"),
                    [],
                    |r| r.get(0),
                )?;
                anyhow::ensure!(
                    Some(n) == file["rows"].as_i64(),
                    "Snapshot row count mismatch"
                );
            }
        }
        return Ok(
            json!({"verified":old["verified"].as_u64().unwrap_or(0)+manifests.len() as u64,"snapshot_bundles":manifests.len(),"cold":cold}),
        );
    }
    crate::cold::verify(s)?;
    std::fs::create_dir_all(&c.storage.archive_path)?;
    let final_dir = std::path::Path::new(&c.storage.archive_path)
        .join(format!("snapshot-{}", uuid::Uuid::now_v7()));
    let temporary = final_dir.with_extension("tmp");
    std::fs::create_dir(&temporary)?;
    s.conn.execute_batch("BEGIN")?;
    let _rollback = RollbackGuard(&s.conn);
    let _temporary_views = TemporarySnapshotViews {
        conn: &s.conn,
        views: crate::cold::install_views(s)?,
    };
    let result = (|| {
        let mut files = vec![];
        let mut record_count = 0;
        for table in [
            "records",
            "events",
            "checkpoints",
            "settings",
            "tombstones",
            "source_revisions",
            "quota_samples",
            "quota_events",
        ] {
            let file = format!("{table}.parquet");
            let path = temporary.join(&file);
            let quoted = path.to_string_lossy().replace('\'', "''");
            // Preserve native scan order without sorting every large JSON payload.
            // Verification below checks the exact sequence, including rowid gaps.
            s.conn.execute_batch("SET preserve_insertion_order=true")?;
            let source = if _temporary_views.views.contains(&table) {
                let source = format!("flat_snapshot_{table}");
                s.conn.execute_batch(&format!(
                    "CREATE TEMP TABLE {source} AS SELECT * FROM {table}"
                ))?;
                source
            } else {
                table.to_string()
            };
            s.conn.execute_batch(&format!("COPY (SELECT * FROM {source}) TO '{quoted}' (FORMAT PARQUET,COMPRESSION ZSTD,COMPRESSION_LEVEL {},ROW_GROUP_SIZE 2048)",c.storage.zstd_level))?;
            let count: i64 = s.conn.query_row(
                &format!("SELECT count(*) FROM read_parquet('{quoted}')"),
                [],
                |r| r.get(0),
            )?;
            let different = verify_streamed_table(&s.conn, &source, &quoted)?;
            anyhow::ensure!(different == 0, "Archive round-trip differs from hot data");
            if table == "records" {
                record_count = count;
            }
            files.push(json!({"file":file,"table":table,"rows":count,"bytes":std::fs::metadata(&path)?.len(),"sha256":crate::compression::checksum(&path)?,"exact_roundtrip":true}));
            if source != table {
                s.conn.execute_batch(&format!("DROP TABLE {source}"))?;
            }
        }
        let manifest = json!({"schema_version":4,"created_at":now(),"codec":"zstd","level":c.storage.zstd_level,"row_group_size":2048,"files":files,"hot_eviction":false,"cold_rows_included":true,"encryption_keys_included":false});
        std::fs::write(
            temporary.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        Ok::<_, anyhow::Error>((record_count, manifest))
    })();
    if result.is_err() {
        s.conn.execute_batch("ROLLBACK")?;
        return result.map(|_| json!({}));
    }
    let (count, manifest) = result?;
    std::fs::rename(&temporary, &final_dir)?;
    s.conn.execute(
        "INSERT INTO snapshot_exports VALUES (?,?,?)",
        duckdb::params![
            final_dir.to_string_lossy(),
            crate::compression::checksum(&final_dir.join("manifest.json"))?,
            now()
        ],
    )?;
    s.conn.execute_batch("COMMIT")?;
    Ok(
        json!({"path":final_dir,"rows":count,"manifest":manifest,"hot_deleted":false,"mode":"verified complete normalized snapshot; native hot queries retained"}),
    )
}

pub fn restore(s: &Store, directory: &std::path::Path) -> Result<Value> {
    let existing:i64=s.conn.query_row("SELECT (SELECT count(*) FROM records)+(SELECT count(*) FROM events)+(SELECT count(*) FROM quota_samples)+(SELECT count(*) FROM quota_events)+(SELECT count(*) FROM cold_segments)",[],|r|r.get(0))?;
    anyhow::ensure!(
        existing == 0,
        "Restore requires an empty analytics database; choose a new T3UI_DB path"
    );
    let manifest: Value = serde_json::from_slice(&std::fs::read(directory.join("manifest.json"))?)?;
    anyhow::ensure!(
        matches!(manifest["schema_version"].as_u64(), Some(2..=4)),
        "Unsupported snapshot version"
    );
    s.conn.execute_batch("BEGIN")?;
    let _rollback = RollbackGuard(&s.conn);
    let result = (|| {
        let mut tables = vec![
            "records",
            "events",
            "checkpoints",
            "settings",
            "tombstones",
            "source_revisions",
        ];
        if manifest["schema_version"].as_u64() == Some(4) {
            tables.extend(["quota_samples", "quota_events"]);
        }
        for table in tables {
            let file = format!("{table}.parquet");
            let meta = manifest["files"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("Missing snapshot files"))?
                .iter()
                .find(|v| v["file"] == file && v["table"] == table)
                .ok_or_else(|| anyhow::anyhow!("Required snapshot table missing"))?;
            let path = directory.join(&file);
            anyhow::ensure!(
                crate::compression::checksum(&path)? == meta["sha256"].as_str().unwrap_or(""),
                "Snapshot checksum mismatch"
            );
            let quoted = path.to_string_lossy().replace('\'', "''");
            s.conn.execute_batch(&format!(
                "INSERT INTO {table} BY NAME SELECT * FROM read_parquet('{quoted}') ON CONFLICT DO NOTHING"
            ))?;
            let rows: i64 =
                s.conn
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
            anyhow::ensure!(
                (table == "tombstones" && Some(rows) >= meta["rows"].as_i64())
                    || Some(rows) == meta["rows"].as_i64(),
                "Restored row count mismatch"
            );
        }
        s.apply_purge_ledger()?;
        crate::storage::retain_content(&s.conn, s.content_retention_days)?;
        crate::storage::hydrate_facts(&s.conn)?;
        crate::storage::hydrate_search(&s.conn)?;
        let restored: i64 = s
            .conn
            .query_row("SELECT count(*) FROM records", [], |r| r.get(0))?;
        Ok::<_, anyhow::Error>(restored)
    })();
    s.conn
        .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
    Ok(
        json!({"restored_records":result?,"capture_quality":"partial","encryption_key_restored":false}),
    )
}

/// Compare every stored column in bounded physical ranges. A separate dense
/// Parquet offset accounts for native rowid gaps after purge. Unexpected order
/// changes fail closed, before a snapshot can be published.
pub(crate) fn verify_streamed_table(
    conn: &duckdb::Connection,
    table: &str,
    quoted_path: &str,
) -> Result<i64> {
    let (first, end): (i64, i64) = conn.query_row(
        &format!("SELECT coalesce(min(rowid),0),coalesce(max(rowid),-1)+1 FROM {table}"),
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    verify_selected_table(conn, table, quoted_path, "true", first, end)
}

pub(crate) fn verify_selected_table(
    conn: &duckdb::Connection,
    table: &str,
    quoted_path: &str,
    predicate: &str,
    first: i64,
    end: i64,
) -> Result<i64> {
    anyhow::ensure!(
        [
            "records",
            "events",
            "checkpoints",
            "settings",
            "tombstones",
            "source_revisions",
            "quota_samples",
            "quota_events",
            "cold_restore_probe",
            "flat_snapshot_records",
            "flat_snapshot_events",
            "flat_snapshot_quota_samples",
            "flat_snapshot_quota_events"
        ]
        .contains(&table),
        "Unexpected snapshot table"
    );
    let schema: Vec<(String, String)> = conn
        .prepare(&format!("PRAGMA table_info('{table}')"))?
        .query_map([], |r| Ok((r.get(1)?, r.get(2)?)))?
        .collect::<duckdb::Result<_>>()?;
    anyhow::ensure!(
        schema.iter().all(
            |(_, t)| ["VARCHAR", "JSON", "BIGINT", "INTEGER", "BOOLEAN", "DOUBLE"]
                .contains(&t.as_str())
        ),
        "Unsupported exact snapshot comparison type"
    );
    let archived_schema: Vec<(String, String)> = conn
        .prepare(&format!(
            "DESCRIBE SELECT * FROM read_parquet('{quoted_path}')"
        ))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<duckdb::Result<_>>()?;
    anyhow::ensure!(
        schema.len() == archived_schema.len()
            && schema
                .iter()
                .zip(&archived_schema)
                .all(|((n, t), (an, at))| n == an && (t == at || (t == "JSON" && at == "VARCHAR"))),
        "Snapshot column schema differs"
    );
    let columns: Vec<String> = schema.into_iter().map(|(name, _)| name).collect();
    let projection = columns
        .iter()
        .map(|c| format!("CAST(\"{}\" AS VARCHAR)", c.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(",");
    let mut original = conn.prepare(&format!(
        "SELECT {projection} FROM {table} WHERE rowid>=? AND rowid<? AND ({predicate}) ORDER BY rowid"
    ))?;
    let mut archived=conn.prepare(&format!("SELECT {projection} FROM read_parquet('{quoted_path}',file_row_number=true) WHERE file_row_number>=? AND file_row_number<? ORDER BY file_row_number"))?;
    let mut offset = 0i64;
    let mut different = 0i64;
    let mut positions=conn.prepare(&format!("SELECT rowid FROM {table} WHERE rowid>=? AND rowid<? AND ({predicate}) ORDER BY rowid LIMIT 128"))?;
    let mut cursor = first;
    while cursor < end {
        let ids: Vec<i64> = positions
            .query_map(duckdb::params![cursor, end], |r| r.get(0))?
            .collect::<duckdb::Result<_>>()?;
        let Some(last) = ids.last() else { break };
        let start = ids[0];
        let stop = *last + 1;
        cursor = stop;
        let mut left = original.query(duckdb::params![start, stop])?;
        let mut right = archived.query(duckdb::params![offset, offset + ids.len() as i64])?;
        let mut original_rows = 0;
        loop {
            match (left.next()?, right.next()?) {
                (Some(a), Some(b)) => {
                    original_rows += 1;
                    let mut row_differs = false;
                    // Every projected value is VARCHAR or null. Borrow the Arrow
                    // bytes instead of copying conversation content into Rust strings.
                    // ValueRef equality keeps null distinct from an empty string.
                    for column in 0..columns.len() {
                        row_differs |= a.get_ref(column)? != b.get_ref(column)?;
                    }
                    different += i64::from(row_differs);
                }
                (Some(_), None) => {
                    original_rows += 1;
                    different += 1;
                }
                (None, Some(_)) => different += 1,
                (None, None) => break,
            }
        }
        offset += original_rows;
    }
    let count: i64 = conn.query_row(
        &format!("SELECT count(*) FROM read_parquet('{quoted_path}')"),
        [],
        |r| r.get(0),
    )?;
    different += offset.abs_diff(count) as i64;
    Ok(different)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_relative_archive_verifies_in_configured_directory_without_rewriting_registration() {
        let temp = tempfile::tempdir().unwrap();
        let mut config: Config =
            toml::from_str(include_str!("../../../config/default.toml")).unwrap();
        config.storage.duckdb_path = temp.path().join("fixture.duckdb").to_string_lossy().into();
        config.storage.archive_path = temp.path().join("archive").to_string_lossy().into();
        let store = Store::open(&config).unwrap();
        let created = legacy_verify(&config, &store, "run").unwrap();
        let absolute = created["path"].as_str().unwrap();
        let filename = std::path::Path::new(absolute).file_name().unwrap();
        let relative = std::path::Path::new("retired-neutral-install/data/archive")
            .join(filename)
            .to_string_lossy()
            .into_owned();
        assert!(!std::path::Path::new(&relative).exists());
        store
            .conn
            .execute("UPDATE archives SET path=?", [&relative])
            .unwrap();
        assert_eq!(
            legacy_verify(&config, &store, "verify").unwrap()["verified"],
            1
        );
        let registered: String = store
            .conn
            .query_row("SELECT path FROM archives", [], |r| r.get(0))
            .unwrap();
        assert_eq!(registered, relative);
        // An explicit absolute location is never replaced by a guessed location.
        let missing_absolute = temp
            .path()
            .join("missing")
            .join(filename)
            .to_string_lossy()
            .into_owned();
        store
            .conn
            .execute("UPDATE archives SET path=?", [&missing_absolute])
            .unwrap();
        assert!(legacy_verify(&config, &store, "verify").is_err());
        store
            .conn
            .execute("UPDATE archives SET path=?", [&relative])
            .unwrap();
        std::fs::write(absolute, b"neutral damaged archive").unwrap();
        assert!(
            legacy_verify(&config, &store, "verify")
                .unwrap_err()
                .to_string()
                .contains("checksum mismatch")
        );
        std::fs::remove_file(absolute).unwrap();
        assert!(legacy_verify(&config, &store, "verify").is_err());
    }
    #[test]
    fn restore_verification_handles_committed_and_transaction_local_rowids() {
        let temp = tempfile::tempdir().unwrap();
        let conn = duckdb::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TEMP TABLE cold_restore_probe(id VARCHAR,data JSON); INSERT INTO cold_restore_probe VALUES('committed','{}'); BEGIN; INSERT INTO cold_restore_probe VALUES('a','{\"x\":1}'),('b','{}')").unwrap();
        let bounds: (i64, i64) = conn
            .query_row(
                "SELECT min(rowid),max(rowid) FROM cold_restore_probe",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(bounds.1 - bounds.0 >= 2);
        let path = temp
            .path()
            .join("probe.parquet")
            .to_string_lossy()
            .replace('\'', "''");
        conn.execute_batch(&format!(
            "COPY cold_restore_probe TO '{path}' (FORMAT PARQUET)"
        ))
        .unwrap();
        assert_eq!(
            verify_streamed_table(&conn, "cold_restore_probe", &path).unwrap(),
            0
        );
        conn.execute_batch("ROLLBACK").unwrap();
    }
    #[test]
    fn streamed_comparison_handles_gaps_nulls_and_detects_every_field_change() {
        let temp = tempfile::tempdir().unwrap();
        let conn = duckdb::Connection::open_in_memory().unwrap();
        conn.execute_batch("SET preserve_insertion_order=true; CREATE TABLE records(id VARCHAR,data JSON,search_text VARCHAR,n BIGINT); INSERT INTO records VALUES('a','{\"x\":1}',NULL,0),('deleted','{}','gone',1),('b','{}','',9223372036854775807); DELETE FROM records WHERE id='deleted'").unwrap();
        let path = temp
            .path()
            .join("records.parquet")
            .to_string_lossy()
            .replace('\'', "''");
        let check = |sql: &str| {
            conn.execute_batch(&format!("COPY ({sql}) TO '{path}' (FORMAT PARQUET)"))
                .unwrap();
            verify_streamed_table(&conn, "records", &path).unwrap()
        };
        assert_eq!(check("SELECT * FROM records"), 0);
        assert!(check("SELECT * FROM records ORDER BY id DESC") > 0);
        assert!(check("SELECT id,data,coalesce(search_text,'' ) search_text,n FROM records") > 0);
        assert!(check("SELECT id,'{}'::JSON data,search_text,n FROM records") > 0);
        assert!(
            check("SELECT id,data,search_text,CASE WHEN id='a' THEN 1 ELSE n END n FROM records")
                > 0
        );
        assert!(check("SELECT * FROM records WHERE id='a'") > 0);
        assert!(check("SELECT * FROM records UNION ALL SELECT * FROM records WHERE id='a'") > 0);
    }
    #[test]
    fn streamed_comparison_preserves_multiple_pages_and_transaction_local_gaps() {
        let temp = tempfile::tempdir().unwrap();
        let conn = duckdb::Connection::open_in_memory().unwrap();
        conn.execute_batch("SET preserve_insertion_order=true; CREATE TABLE records(id VARCHAR,data JSON,search_text VARCHAR,n BIGINT); INSERT INTO records SELECT i::VARCHAR,json_object('body',repeat('neutral λ',i%5)),CASE WHEN i%2=0 THEN NULL ELSE '' END,i FROM range(300) t(i); DELETE FROM records WHERE n%7=0; BEGIN; INSERT INTO records SELECT 'local-'||i,json_object('body',repeat('neutral λ',i%5)),CASE WHEN i%2=0 THEN NULL ELSE '' END,i+1000 FROM range(150) t(i)").unwrap();
        let path = temp
            .path()
            .join("pages.parquet")
            .to_string_lossy()
            .replace('\'', "''");
        conn.execute_batch(&format!(
            "COPY (SELECT * FROM records ORDER BY rowid) TO '{path}' (FORMAT PARQUET)"
        ))
        .unwrap();
        assert_eq!(verify_streamed_table(&conn, "records", &path).unwrap(), 0);
        conn.execute_batch("UPDATE records SET search_text='changed' WHERE id='local-149'")
            .unwrap();
        assert!(verify_streamed_table(&conn, "records", &path).unwrap() > 0);
        conn.execute_batch("ROLLBACK").unwrap();
    }
}
