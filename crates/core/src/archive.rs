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
            anyhow::ensure!(
                checksum(r["path"].as_str().unwrap())? == r["sha256"].as_str().unwrap(),
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
            json!({"verified":old["verified"].as_u64().unwrap_or(0)+manifests.len() as u64,"snapshot_bundles":manifests.len()}),
        );
    }
    std::fs::create_dir_all(&c.storage.archive_path)?;
    let final_dir = std::path::Path::new(&c.storage.archive_path)
        .join(format!("snapshot-{}", uuid::Uuid::now_v7()));
    let temporary = final_dir.with_extension("tmp");
    std::fs::create_dir(&temporary)?;
    s.conn.execute_batch("BEGIN")?;
    let _rollback = RollbackGuard(&s.conn);
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
        ] {
            let file = format!("{table}.parquet");
            let path = temporary.join(&file);
            let quoted = path.to_string_lossy().replace('\'', "''");
            // Preserve native scan order without sorting every large JSON payload.
            // Verification below checks the exact sequence, including rowid gaps.
            s.conn.execute_batch("SET preserve_insertion_order=true")?;
            s.conn.execute_batch(&format!("COPY (SELECT * FROM {table}) TO '{quoted}' (FORMAT PARQUET,COMPRESSION ZSTD,COMPRESSION_LEVEL {},ROW_GROUP_SIZE 2048)",c.storage.zstd_level))?;
            let count: i64 = s.conn.query_row(
                &format!("SELECT count(*) FROM read_parquet('{quoted}')"),
                [],
                |r| r.get(0),
            )?;
            let different = verify_streamed_table(&s.conn, table, &quoted)?;
            anyhow::ensure!(different == 0, "Archive round-trip differs from hot data");
            if table == "records" {
                record_count = count;
            }
            files.push(json!({"file":file,"table":table,"rows":count,"bytes":std::fs::metadata(&path)?.len(),"sha256":crate::compression::checksum(&path)?,"exact_roundtrip":true}));
        }
        let manifest = json!({"schema_version":3,"created_at":now(),"codec":"zstd","level":c.storage.zstd_level,"row_group_size":2048,"files":files,"hot_eviction":false,"encryption_keys_included":false});
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
    let existing: i64 = s
        .conn
        .query_row("SELECT count(*) FROM records", [], |r| r.get(0))?;
    anyhow::ensure!(
        existing == 0,
        "Restore requires an empty analytics database; choose a new T3UI_DB path"
    );
    let manifest: Value = serde_json::from_slice(&std::fs::read(directory.join("manifest.json"))?)?;
    anyhow::ensure!(
        matches!(manifest["schema_version"].as_u64(), Some(2 | 3)),
        "Unsupported snapshot version"
    );
    s.conn.execute_batch("BEGIN")?;
    let _rollback = RollbackGuard(&s.conn);
    let result = (|| {
        for table in [
            "records",
            "events",
            "checkpoints",
            "settings",
            "tombstones",
            "source_revisions",
        ] {
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
fn verify_streamed_table(conn: &duckdb::Connection, table: &str, quoted_path: &str) -> Result<i64> {
    anyhow::ensure!(
        [
            "records",
            "events",
            "checkpoints",
            "settings",
            "tombstones",
            "source_revisions"
        ]
        .contains(&table),
        "Unexpected snapshot table"
    );
    let schema: Vec<(String, String)> = conn
        .prepare(&format!("PRAGMA table_info('{table}')"))?
        .query_map([], |r| Ok((r.get(1)?, r.get(2)?)))?
        .collect::<duckdb::Result<_>>()?;
    anyhow::ensure!(
        schema
            .iter()
            .all(|(_, t)| ["VARCHAR", "JSON", "BIGINT", "INTEGER"].contains(&t.as_str())),
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
    let end: i64 = conn.query_row(
        &format!("SELECT coalesce(max(rowid),-1)+1 FROM {table}"),
        [],
        |r| r.get(0),
    )?;
    let mut original = conn.prepare(&format!(
        "SELECT {projection} FROM {table} WHERE rowid>=? AND rowid<? ORDER BY rowid"
    ))?;
    let mut archived=conn.prepare(&format!("SELECT {projection} FROM read_parquet('{quoted_path}',file_row_number=true) WHERE file_row_number>=? AND file_row_number<? ORDER BY file_row_number"))?;
    let mut offset = 0i64;
    let mut different = 0i64;
    for start in (0..end).step_by(128) {
        let a: Vec<Vec<Option<String>>> = original
            .query_map(duckdb::params![start, start + 128], |row| {
                (0..columns.len()).map(|i| row.get(i)).collect()
            })?
            .collect::<duckdb::Result<_>>()?;
        if a.is_empty() {
            continue;
        }
        let b: Vec<Vec<Option<String>>> = archived
            .query_map(duckdb::params![offset, offset + a.len() as i64], |row| {
                (0..columns.len()).map(|i| row.get(i)).collect()
            })?
            .collect::<duckdb::Result<_>>()?;
        different += a.iter().zip(&b).filter(|(a, b)| a != b).count() as i64
            + a.len().abs_diff(b.len()) as i64;
        offset += a.len() as i64;
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
}
