use crate::{config::Config, privacy::hash};
use anyhow::Result;
use duckdb::{Connection, params};
use serde_json::{Value, json};
pub struct Store {
    pub conn: Connection,
    purge_ledger: Option<std::path::PathBuf>,
    /// Where records being written came from. Only a one-time import of an older source changes this.
    pub capture_source: std::cell::Cell<&'static str>,
}
/// The instant RUNTRACE_NOW (or T3UI_NOW) pins the service's clock to, for repeatable tests. Unset, the system clock is used.
pub fn pinned_now() -> Option<chrono::DateTime<chrono::Utc>> {
    crate::config::env("NOW")
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(&v).ok())
        .map(|d| d.with_timezone(&chrono::Utc))
}
/// The service's clock: the pinned instant if there is one, otherwise the system clock.
pub fn clock() -> chrono::DateTime<chrono::Utc> {
    pinned_now().unwrap_or_else(chrono::Utc::now)
}
pub fn now() -> String {
    clock().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
/// "Now" in SQL. Exactly `now()` unless the clock is pinned, then that instant as a literal.
pub fn now_sql() -> String {
    match pinned_now() {
        Some(t) => format!(
            "TIMESTAMPTZ '{}'",
            t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        ),
        None => "now()".into(),
    }
}
pub fn id(instance: &str, kind: &str, source: &str) -> String {
    hash(&format!("{instance}\0{kind}\0{source}"))
}
impl Store {
    pub fn open(c: &Config) -> Result<Self> {
        if let Some(p) = std::path::Path::new(&c.storage.duckdb_path).parent() {
            std::fs::create_dir_all(p)?;
        }
        let conn = Connection::open(&c.storage.duckdb_path)?;
        conn.execute_batch(include_str!("../../../migrations/001_initial.sql"))?;
        conn.execute_batch(include_str!("../../../migrations/002_revision_cache.sql"))?;
        conn.execute_batch(&format!(
            "SET threads=4; SET memory_limit='{}MB'",
            c.storage.memory_limit_mb
        ))?;
        // Migrate the pre-service pause setting to the cross-process pause file.
        let legacy_paused = conn
            .query_row("SELECT value FROM settings WHERE key='paused'", [], |r| {
                r.get::<_, String>(0)
            })
            .ok();
        if legacy_paused.as_deref() == Some("true") {
            std::fs::write(
                std::path::Path::new(&c.storage.duckdb_path).with_extension("capture-paused"),
                b"paused",
            )?;
        }
        if legacy_paused.is_some() {
            conn.execute("DELETE FROM settings WHERE key='paused'", [])?;
        }
        let purge_ledger = c
            .storage
            .purge_ledger_path
            .as_ref()
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::path::Path::new(&c.storage.duckdb_path)
                    .parent()
                    .map(|p| p.join("purges.jsonl"))
            });
        let store = Self { conn, purge_ledger, capture_source: std::cell::Cell::new("t3_sqlite_v2") };
        store.apply_purge_ledger()?;
        let conn = &store.conn;
        // Added before the first analytic pass, which fills these too.
        conn.execute_batch(include_str!("../../../migrations/003_analytic_columns.sql"))?;
        conn.execute_batch(include_str!("../../../migrations/006_more_facts.sql"))?;
        conn.execute_batch(include_str!("../../../migrations/007_preview_doc.sql"))?;
        let analytic_version: i64 = conn.query_row(
            "SELECT count(*) FROM schema_migrations WHERE version=3",
            [],
            |r| r.get(0),
        )?;
        if analytic_version == 0 {
            conn.execute_batch(include_str!("../../../migrations/003_analytic_columns.sql"))?;
            hydrate_facts(conn)?;
            conn.execute(
                "INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING",
                [],
            )?;
        }
        conn.execute_batch(include_str!("../../../migrations/004_search_cache.sql"))?;
        conn.execute_batch(include_str!("../../../migrations/005_quota.sql"))?;
        hydrate_more_facts(conn)?;
        hydrate_search(conn)?;
        conn.execute(
            "INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING",
            [],
        )?;
        Ok(store)
    }
    pub fn setting(&self, k: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key=?", [k], |r| r.get(0))
            .ok()
    }
    pub fn try_clone(&self) -> Result<Self> {
        Ok(Self {
            conn: self.conn.try_clone()?,
            purge_ledger: self.purge_ledger.clone(),
            capture_source: std::cell::Cell::new(self.capture_source.get()),
        })
    }
    pub fn revisions(
        &self,
        instance: &str,
        project: Option<&str>,
    ) -> Result<std::collections::HashMap<(String, String), String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT kind,source_id,revision FROM source_revisions s WHERE instance_id=? AND (? IS NULL OR EXISTS (SELECT 1 FROM records r WHERE r.instance_id=s.instance_id AND r.project_id=? AND r.source_id=s.source_id AND (r.kind=s.kind OR (s.kind='message' AND r.kind IN ('prompt','answer')))))")?;
        let rows = stmt.query_map(params![instance, project, project], |r| {
            Ok(((r.get(0)?, r.get(1)?), r.get(2)?))
        })?;
        Ok(rows.collect::<duckdb::Result<_>>()?)
    }
    pub fn save_revision(
        &self,
        instance: &str,
        kind: &str,
        source: &str,
        revision: &str,
    ) -> Result<()> {
        self.conn.prepare_cached("INSERT INTO source_revisions VALUES (?,?,?,?) ON CONFLICT(instance_id,kind,source_id) DO UPDATE SET revision=excluded.revision")?.execute(params![instance,kind,source,revision])?;
        Ok(())
    }
    pub fn set(&self, k: &str, v: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![k, v],
        )?;
        Ok(())
    }
    pub fn blocked(&self, thread: &str, project: &str, date: &str) -> Result<bool> {
        let n:i64=self.conn.query_row("SELECT count(*) FROM tombstones WHERE (scope='thread' AND source_id=?) OR (scope='project' AND source_id=?) OR (scope='before' AND source_id>?)",params![thread,project,date],|r|r.get(0))?;
        Ok(n > 0)
    }
    // Source identity and provenance are explicit at this persistence boundary.
    #[allow(clippy::too_many_arguments)]
    pub fn put(
        &self,
        instance: &str,
        kind: &str,
        source: &str,
        project: &str,
        thread: &str,
        run: &str,
        date: &str,
        updated: &str,
        quality: &str,
        version: &str,
        data: Value,
    ) -> Result<bool> {
        let key = id(instance, kind, source);
        let payload = data.to_string();
        let mut canonical = data.clone();
        if let Some(o) = canonical.as_object_mut() {
            o.insert(
                "_source_attribution".into(),
                json!({"project_id":project,"thread_id":thread,"run_id":run,"occurred_at":date}),
            );
            o.remove("content_ciphertext");
            o.remove("repository_path_encrypted");
            o.insert(
                "_encrypted_repository_path_present".into(),
                json!(
                    data.get("repository_path_encrypted")
                        .is_some_and(|v| !v.is_null())
                ),
            );
            o.insert(
                "_encrypted_content_present".into(),
                json!(data.get("content_ciphertext").is_some_and(|v| !v.is_null())),
            );
        }
        let digest = hash(&canonical.to_string());
        let old: Option<(String, String)> = self
            .conn
            .prepare_cached("SELECT payload_hash,source_updated_at FROM records WHERE id=?")?
            .query_row([&key], |r| Ok((r.get(0)?, r.get(1)?)))
            .ok();
        if let Some((old_hash, old_updated)) = old.as_ref()
            && old_hash == &digest
        {
            // Fresh source metadata must not regress just because content is equal.
            if parse_time(old_updated)
                .zip(parse_time(updated))
                .is_some_and(|(old, new)| new > old)
            {
                self.conn
                    .prepare_cached(
                        "UPDATE records SET source_updated_at=?,source_version=? WHERE id=?",
                    )?
                    .execute(params![updated, version, key])?;
            }
            return Ok(false);
        }
        let captured = now();
        self.conn.prepare_cached("INSERT INTO records (id,kind,instance_id,source_id,project_id,thread_id,run_id,occurred_at,source_updated_at,capture_quality,capture_source,source_version,captured_at,payload_hash,data,model,status,tool_name,tool_category,duration_ms,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,usage_status,redacted_characters,json_characters,facts_version,search_text,search_version,cache_write_tokens,exit_code,agent_provider,resolved_model,usage_scope,usage_source,has_subagents,elapsed_ms,preview_doc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,lower(json_extract_string(?,'$.content_redacted')),?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,payload_hash=excluded.payload_hash,source_updated_at=excluded.source_updated_at,captured_at=excluded.captured_at,capture_quality=excluded.capture_quality,source_version=excluded.source_version,project_id=excluded.project_id,thread_id=excluded.thread_id,run_id=excluded.run_id,occurred_at=excluded.occurred_at,model=excluded.model,status=excluded.status,tool_name=excluded.tool_name,tool_category=excluded.tool_category,duration_ms=excluded.duration_ms,input_tokens=excluded.input_tokens,cached_input_tokens=excluded.cached_input_tokens,output_tokens=excluded.output_tokens,reasoning_tokens=excluded.reasoning_tokens,total_tokens=excluded.total_tokens,usage_status=excluded.usage_status,redacted_characters=excluded.redacted_characters,json_characters=excluded.json_characters,facts_version=excluded.facts_version,search_text=excluded.search_text,search_version=excluded.search_version,cache_write_tokens=excluded.cache_write_tokens,exit_code=excluded.exit_code,agent_provider=excluded.agent_provider,resolved_model=excluded.resolved_model,usage_scope=excluded.usage_scope,usage_source=excluded.usage_source,has_subagents=excluded.has_subagents,elapsed_ms=excluded.elapsed_ms,preview_doc=excluded.preview_doc")?.execute(params![key,kind,instance,source,project,thread,run,date,updated,quality,self.capture_source.get(),version,captured,digest,payload,data.get("model").and_then(Value::as_str).or_else(||data.get("requested_model").and_then(Value::as_str)),data.get("status").and_then(Value::as_str),data.get("tool_name").and_then(Value::as_str),data.get("tool_category").and_then(Value::as_str),data.get("duration_ms").and_then(Value::as_i64),data.get("input_tokens").and_then(Value::as_i64),data.get("cached_input_tokens").and_then(Value::as_i64),data.get("output_tokens").and_then(Value::as_i64),data.get("reasoning_tokens").and_then(Value::as_i64),data.get("total_tokens").and_then(Value::as_i64),data.get("usage_status").and_then(Value::as_str),data.get("content_redacted").and_then(Value::as_str).map(|s|s.chars().count() as i64),payload.chars().count() as i64,3i32,payload,2i32,data.get("cache_write_tokens").and_then(Value::as_i64),data.get("exit_code").and_then(Value::as_i64),data.get("provider").and_then(Value::as_str).filter(|s|!s.is_empty()).or_else(||data.get("provider_thread_id").and_then(Value::as_str).and_then(provider_in_id)),data.get("resolved_model").and_then(Value::as_str).filter(|s|!s.is_empty()),data.get("usage_scope").and_then(Value::as_str),data.get("usage_source").and_then(Value::as_str),data.get("has_subagents").and_then(Value::as_bool),elapsed_ms(&data),preview_doc(&data)])?;
        self.conn
            .prepare_cached(
                "INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            )?
            .execute(params![
                hash(&format!("{key}:{digest}")),
                key,
                format!("{kind}.observed"),
                date,
                captured,
                digest,
                instance,
                project,
                thread,
                quality,
                self.capture_source.get(),
                version,
                updated
            ])?;
        Ok(true)
    }
    pub fn rows(&self, sql: &str, args: &[&dyn duckdb::ToSql]) -> Result<Vec<Value>> {
        let mut stmt = self.conn.prepare(sql)?;
        let mapped = stmt.query_map(args, |r| r.get::<_, String>(0))?;
        mapped.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn stats(&self) -> Result<Value> {
        let counts=self.rows("SELECT json_object('table',kind,'rows',count(*))::VARCHAR FROM records GROUP BY kind ORDER BY kind",&[])?;
        let db_bytes = self
            .conn
            .path()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len());
        let content=self.conn.query_row("SELECT coalesce(sum(redacted_characters),0),coalesce(sum(json_characters),0),min(occurred_at) FILTER(WHERE kind<>'instance'),max(occurred_at) FILTER(WHERE kind<>'instance') FROM records",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?)))?;
        Ok(
            json!({"rows":counts,"events":self.conn.query_row("SELECT count(*) FROM events",[],|r|r.get::<_,i64>(0))?,"duckdb_bytes":db_bytes,"redacted_content_characters":content.0,"normalized_json_characters":content.1,"oldest_at":content.2,"newest_at":content.3,"capture_source":"t3_sqlite_v2"}),
        )
    }

    pub fn purge(&self, scope: &str, source: &str) -> Result<()> {
        anyhow::ensure!(
            ["thread", "project", "before"].contains(&scope),
            "Invalid purge scope"
        );
        let cutoff = if scope == "before" {
            Some(
                parse_time(source)
                    .ok_or_else(|| anyhow::anyhow!("Purge cutoff must be YYYY-MM-DD or RFC3339"))?
                    .to_rfc3339(),
            )
        } else {
            None
        };
        let source = cutoff.as_deref().unwrap_or(source);
        if let Some(path) = self.purge_ledger_path() {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?;
            writeln!(
                file,
                "{}",
                json!({"scope":scope,"source_id":source,"purged_at":now()})
            )?;
            file.sync_all()?;
        }
        self.conn.execute_batch("BEGIN")?;
        let result = (|| {
            self.conn.execute(
                "INSERT INTO tombstones VALUES (?,?,?) ON CONFLICT DO NOTHING",
                params![scope, source, now()],
            )?;
            let column = match scope {
                "thread" => "thread_id",
                "project" => "project_id",
                _ => "occurred_at",
            };
            let op = if scope == "before" { "<" } else { "=" };
            let condition = if scope == "before" {
                "try_cast(occurred_at AS TIMESTAMPTZ)<try_cast(? AS TIMESTAMPTZ)".into()
            } else {
                format!("{column}{op}?")
            };
            self.conn
                .execute(&format!("DELETE FROM events WHERE {condition}"), [source])?;
            self.conn
                .execute(&format!("DELETE FROM records WHERE {condition}"), [source])?;
            Ok::<_, anyhow::Error>(())
        })();
        if result.is_ok() {
            self.conn.execute_batch("COMMIT; CHECKPOINT")?
        } else {
            self.conn.execute_batch("ROLLBACK")?
        }
        result
    }
    fn purge_ledger_path(&self) -> Option<std::path::PathBuf> {
        self.purge_ledger.clone()
    }
    /// The current installation's purge ledger also protects restoration of older snapshots.
    pub fn apply_purge_ledger(&self) -> Result<()> {
        use std::io::BufRead;
        let Some(path) = self.purge_ledger_path().filter(|p| p.exists()) else {
            return Ok(());
        };
        for line in std::io::BufReader::new(std::fs::File::open(path)?).lines() {
            let entry: Value = serde_json::from_str(&line?)?;
            let scope = entry["scope"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid purge ledger"))?;
            let source = entry["source_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid purge ledger"))?;
            let condition = match scope {
                "thread" => "thread_id=?",
                "project" => "project_id=?",
                "before" => {
                    anyhow::ensure!(parse_time(source).is_some(), "Invalid purge date in ledger");
                    "try_cast(occurred_at AS TIMESTAMPTZ)<try_cast(? AS TIMESTAMPTZ)"
                }
                _ => anyhow::bail!("Invalid purge scope in ledger"),
            };
            self.conn.execute(
                "INSERT INTO tombstones VALUES (?,?,?) ON CONFLICT DO NOTHING",
                params![scope, source, entry["purged_at"].as_str().unwrap_or("")],
            )?;
            self.conn
                .execute(&format!("DELETE FROM records WHERE {condition}"), [source])?;
            self.conn
                .execute(&format!("DELETE FROM events WHERE {condition}"), [source])?;
        }
        Ok(())
    }
}
pub fn parse_time(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc))
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc())
        })
}
pub fn time_before(a: &str, b: &str) -> bool {
    parse_time(a).zip(parse_time(b)).is_some_and(|(a, b)| a < b)
}

/// Populate metadata in small chunks. This never changes original captured JSON.
pub fn hydrate_facts(conn: &Connection) -> Result<()> {
    loop {
        let ids: Vec<String> = conn
            .prepare(
                "SELECT id FROM records WHERE facts_version=0 OR facts_version IS NULL LIMIT 128",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<duckdb::Result<_>>()?;
        if ids.is_empty() {
            break;
        }
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "WITH extracted AS (SELECT id,json_extract_string(data,['$.model','$.requested_model','$.status','$.tool_name','$.tool_category','$.duration_ms','$.input_tokens','$.cached_input_tokens','$.output_tokens','$.reasoning_tokens','$.total_tokens','$.usage_status','$.content_redacted']) f,length(data::VARCHAR) json_len FROM records WHERE id IN ({placeholders})) UPDATE records r SET model=coalesce(e.f[1],e.f[2]),status=e.f[3],tool_name=e.f[4],tool_category=e.f[5],duration_ms=try_cast(e.f[6] AS BIGINT),input_tokens=try_cast(e.f[7] AS BIGINT),cached_input_tokens=try_cast(e.f[8] AS BIGINT),output_tokens=try_cast(e.f[9] AS BIGINT),reasoning_tokens=try_cast(e.f[10] AS BIGINT),total_tokens=CASE WHEN e.f[12]='complete' THEN try_cast(e.f[11] AS BIGINT) ELSE NULL END,usage_status=e.f[12],redacted_characters=length(e.f[13]),json_characters=e.json_len,facts_version=1 FROM extracted e WHERE r.id=e.id"
        );
        conn.execute(&sql, duckdb::params_from_iter(ids))?;
    }
    hydrate_more_facts(conn)
}

/// The later analytic columns and the list view (version 3), filled in one pass for rows written before they existed or restored from an older snapshot.
pub fn hydrate_more_facts(conn: &Connection) -> Result<()> {
    let pending: i64 = conn.query_row("SELECT count(*) FROM records WHERE facts_version IN (1,2)", [], |r| r.get(0))?;
    if pending == 0 {
        return Ok(());
    }
    // In slices of rows, because one pass over every document can exceed the service's query memory.
    let end: i64 = conn.query_row("SELECT coalesce(max(rowid),-1)+1 FROM records", [], |r| r.get(0))?;
    let sql = "UPDATE records SET  cache_write_tokens=try_cast(json_extract_string(data,'$.cache_write_tokens') AS BIGINT),  exit_code=try_cast(json_extract_string(data,'$.exit_code') AS BIGINT),  agent_provider=coalesce(nullif(json_extract_string(data,'$.provider'),''),nullif(regexp_extract(coalesce(json_extract_string(data,'$.provider_thread_id'),''),'(?:^|:)provider:([^:]+)',1),'')),  resolved_model=nullif(json_extract_string(data,'$.resolved_model'),''),  usage_scope=json_extract_string(data,'$.usage_scope'),  usage_source=json_extract_string(data,'$.usage_source'),  has_subagents=try_cast(json_extract_string(data,'$.has_subagents') AS BOOLEAN),  elapsed_ms=CASE WHEN duration_ms>=0 THEN duration_ms WHEN date_diff('millisecond',try_cast(json_extract_string(data,'$.started_at') AS TIMESTAMPTZ),try_cast(json_extract_string(data,'$.completed_at') AS TIMESTAMPTZ))>=0 THEN date_diff('millisecond',try_cast(json_extract_string(data,'$.started_at') AS TIMESTAMPTZ),try_cast(json_extract_string(data,'$.completed_at') AS TIMESTAMPTZ)) END,  preview_doc=json_merge_patch(json_merge_patch(data,'{\"content_ciphertext\":null,\"repository_path_encrypted\":null,\"content_redacted\":null}'),json_object('content_redacted',left(json_extract_string(data,'$.content_redacted'),512),'content_truncated',length(json_extract_string(data,'$.content_redacted'))>512))::VARCHAR,  facts_version=3 WHERE facts_version IN (1,2)";
    // The bounds are written into the statement: as parameters they are not used to narrow the scan, and every slice reads the whole table.
    tracing::info!(operation = "hydrate_more_facts", pending_rows = pending, "Filling analytic columns");
    for start in (0..end).step_by(10_000) {
        conn.execute_batch(&format!("{sql} AND rowid>={start} AND rowid<{}", start + 10_000))?;
        if start % 50_000 == 0 {
            tracing::info!(operation = "hydrate_more_facts", done_rows = (start + 10_000).min(end), total_rows = end);
        }
    }
    Ok(())
}

/// The agent named in a provider id such as provider-thread:provider:codex:native-thread:abc.
fn provider_in_id(id: &str) -> Option<&str> {
    let at = if let Some(rest) = id.strip_prefix("provider:") { rest } else { &id[id.find(":provider:")? + ":provider:".len()..] };
    at.split(':').next().filter(|s| !s.is_empty())
}

/// The list view of a record, as the version 3 backfill writes it: no full text or encrypted fields, and the first 512 characters of the text.
pub fn preview_doc(data: &Value) -> String {
    let mut doc = data.clone();
    if let Some(o) = doc.as_object_mut() {
        let text = match o.remove("content_redacted") {
            Some(Value::String(s)) => Some(s),
            Some(Value::Null) | None => None,
            Some(other) => Some(other.to_string()),
        };
        o.remove("content_ciphertext");
        o.remove("repository_path_encrypted");
        if let Some(text) = text {
            let mut chars = text.chars();
            let preview: String = chars.by_ref().take(512).collect();
            o.insert("content_truncated".into(), json!(chars.next().is_some()));
            o.insert("content_redacted".into(), json!(preview));
        }
    }
    doc.to_string()
}

/// How long a record ran: its own duration, else the time between its start and end.
fn elapsed_ms(data: &Value) -> Option<i64> {
    if let Some(d) = data.get("duration_ms").and_then(Value::as_i64).filter(|d| *d >= 0) {
        return Some(d);
    }
    let at = |k: &str| data.get(k).and_then(Value::as_str).and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
    let ms = (at("completed_at")? - at("started_at")?).num_milliseconds();
    (ms >= 0).then_some(ms)
}

/// Exact comparison without building a hash table containing all conversation content.
/// The relation is an internal SQL identifier, never supplied by an API/MCP client.
pub fn verify_original_records(conn: &Connection, prior: &str) -> Result<i64> {
    anyhow::ensure!(prior == "prior.records", "Unexpected comparison relation");
    let mut different = 0;
    let end: i64 = conn.query_row("SELECT greatest(coalesce((SELECT max(rowid) FROM records),-1),coalesce((SELECT max(rowid) FROM prior.records),-1))+1", [], |r| r.get(0))?;
    let cols = "id,kind,instance_id,source_id,project_id,thread_id,run_id,occurred_at,source_updated_at,capture_quality,capture_source,source_version,captured_at,payload_hash,data";
    // Additive migrations preserve physical order. Sequential ranges avoid
    // decompressing random large string blocks repeatedly through ID indexes.
    // An equal backup with a different physical order conservatively fails.
    for start in (0..end).step_by(128) {
        let read = |table: &str| -> Result<Vec<Vec<Option<String>>>> {
            let sql =
                format!("SELECT {cols} FROM {table} WHERE rowid>=? AND rowid<? ORDER BY rowid");
            let mut stmt = conn.prepare(&sql)?;
            Ok(stmt
                .query_map(params![start, start + 128], |row| {
                    (0..15).map(|i| row.get::<_, Option<String>>(i)).collect()
                })?
                .collect::<duckdb::Result<_>>()?)
        };
        let current = read("records")?;
        let old = read(prior)?;
        different += current.iter().zip(&old).filter(|(a, b)| a != b).count() as i64
            + current.len().abs_diff(old.len()) as i64;
        if start % 8192 == 0 {
            tracing::info!(
                operation = "verify_original_records",
                row_count = (start + 128).min(end),
                total_rows = end
            );
        }
    }
    Ok(different)
}

/// Version 2 caches DuckDB lowercase of stored redacted JSON. Each update is atomic; an
/// interrupted migration resumes from search_version without exposing partial reads.
pub fn hydrate_search(conn: &Connection) -> Result<()> {
    loop {
        let start: Option<i64> = conn.query_row(
            "SELECT min(rowid) FROM records WHERE search_version IS DISTINCT FROM 2",
            [],
            |r| r.get(0),
        )?;
        let Some(start) = start else { break };
        conn.execute(
            "UPDATE records SET search_text=lower(json_extract_string(data,'$.content_redacted')),search_version=2 WHERE rowid>=? AND rowid<? AND (search_version IS DISTINCT FROM 2)",
            params![start, start + 512])?;
    }
    Ok(())
}

/// Clear every copy of expired content in one statement, including derived caches.
pub fn retain_content(conn: &Connection, days: i64) -> Result<()> {
    conn.execute("UPDATE records SET data=json_merge_patch(data,'{\"content_redacted\":null,\"content_ciphertext\":null}'),search_text=NULL,search_version=2,facts_version=0 WHERE kind IN ('prompt','answer','tool','agent') AND try_cast(occurred_at AS TIMESTAMP)< current_timestamp - INTERVAL 1 DAY * ?", [days])?;
    hydrate_facts(conn)
}
