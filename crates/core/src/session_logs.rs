//! One-time import of token usage that exists only in the agents' own session logs, as summarised in T3's usage cache.
//!
//! Only the time before T3's current database is read, and a session that belongs to a thread in the previous database is
//! skipped, because that import already counts it. What remains is grouped per session, model and hour, so the chart can
//! draw it without inventing turns. Each group is marked `usage_source: session_log` and is not a provider turn.
use crate::storage::Store;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const SOURCE: &str = "session_logs";

/// Encodes a folder the way Claude names its log folders: every character that is not a letter or digit becomes a dash.
pub fn claude_folder(root: &str) -> String {
    root.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

#[derive(Default)]
struct Block {
    first: i64,
    last: i64,
    calls: u64,
    input: u64,
    cached: u64,
    written: u64,
    output: u64,
    reasoning: u64,
    provider: String,
    project: String,
}

/// With no store this only reads and reports what an import would write.
pub fn import(c: &crate::config::Config, s: Option<&Store>, cache: &str, old_db: &str) -> Result<Value> {
    let raw = std::fs::read_to_string(cache).context("Cannot read the usage cache")?;
    let d: Value = serde_json::from_str(&raw)?;
    let names = |key: &str| -> Vec<String> { d[key].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default() };
    let (models, sessions) = (names("models"), names("sessions"));

    let current = rusqlite::Connection::open_with_flags(&c.source.sqlite_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let cutoff: String = current.query_row("SELECT min(started_at) FROM orchestration_v2_projection_provider_turns", [], |r| r.get(0))?;
    let cutoff_ms = chrono::DateTime::parse_from_rfc3339(&cutoff)?.timestamp_millis();
    let old = rusqlite::Connection::open_with_flags(old_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    // Sessions the previous database already accounts for.
    let mut covered: HashSet<String> = HashSet::new();
    {
        let mut stmt = old.prepare("SELECT provider_thread_id, provider_session_id FROM projection_thread_sessions")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            for i in 0..2 {
                if let Some(v) = r.get::<_, Option<String>>(i)? {
                    covered.insert(v);
                }
            }
        }
        let mut stmt = old.prepare("SELECT resume_cursor_json FROM provider_session_runtime WHERE resume_cursor_json IS NOT NULL")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let raw: String = r.get(0)?;
            if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&raw) {
                covered.extend(m.values().filter_map(Value::as_str).map(str::to_string));
            }
        }
    }

    // A Claude log folder names the project it ran in. Live projects win over deleted copies of the same folder.
    let mut folders: HashMap<String, String> = HashMap::new();
    for (conn, which) in [(&old, "deleted_at IS NOT NULL"), (&old, "deleted_at IS NULL"), (&current, "deleted_at IS NOT NULL"), (&current, "deleted_at IS NULL")] {
        let mut stmt = conn.prepare(&format!("SELECT project_id, workspace_root FROM projection_projects WHERE workspace_root IS NOT NULL AND {which}"))?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let (id, root): (String, String) = (r.get(0)?, r.get(1)?);
            folders.insert(claude_folder(&root), id);
        }
    }

    let mut blocks: BTreeMap<(String, i64, String), Block> = BTreeMap::new();
    let mut seen: HashSet<(String, i64, u64, u64, u64, u64)> = HashSet::new();
    let mut skipped_covered = 0u64;
    let files = d["files"].as_object().context("No files in the usage cache")?;
    for (path, f) in files {
        let family = f["p"].as_str().unwrap_or("");
        let provider = match family {
            "claude" => "claudeAgent".to_string(),
            "codex" if path.contains(".codex-meta") => "codex-meta".to_string(),
            "codex" if path.contains(".codex-ollama") => "codex-ollama".to_string(),
            other => other.to_string(),
        };
        let parts: Vec<&str> = path.split(['\\', '/']).collect();
        let project = if family == "claude" && parts.len() >= 2 { folders.get(parts[parts.len() - 2]).cloned().unwrap_or_default() } else { String::new() };
        for r in f["r"].as_array().into_iter().flatten() {
            let n = |i: usize| r.get(i).and_then(Value::as_u64).unwrap_or(0);
            let ts = r.get(0).and_then(Value::as_i64).unwrap_or(0);
            if ts <= 0 || ts >= cutoff_ms {
                continue;
            }
            // The same call can be logged by more than one file, which is how the usage screen counts it too.
            if !seen.insert((family.to_string(), ts, n(3), n(4), n(5), n(6))) {
                continue;
            }
            let session = r.get(2).and_then(Value::as_u64).and_then(|i| sessions.get(i as usize)).cloned().unwrap_or_default();
            if session.is_empty() || covered.contains(&session) {
                skipped_covered += 1;
                continue;
            }
            let model = r.get(1).and_then(Value::as_u64).and_then(|i| models.get(i as usize)).cloned().unwrap_or_default();
            let hour = ts - ts.rem_euclid(3_600_000);
            let b = blocks.entry((session, hour, model)).or_default();
            if b.calls == 0 {
                b.first = ts;
                b.provider = provider.clone();
                b.project = project.clone();
            }
            b.first = b.first.min(ts);
            b.last = b.last.max(ts);
            b.calls += 1;
            b.input += n(3) + n(4) + n(5);
            b.cached += n(4);
            b.written += n(5);
            b.output += n(6);
            b.reasoning += n(7);
        }
    }

    let iso = |ms: i64| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default();
    let mut tokens: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let (mut written, mut with_project, mut pending) = (0u64, 0u64, 0u32);
    if let Some(s) = s {
        s.capture_source.set(SOURCE);
        s.conn.execute_batch("BEGIN")?;
    }
    let result = (|| -> Result<()> {
        for ((session, hour, model), b) in &blocks {
            let total = b.input + b.output;
            let first = iso(b.first);
            *tokens.entry(first.chars().take(7).collect()).or_default().entry(b.provider.clone()).or_default() += total;
            written += 1;
            if !b.project.is_empty() {
                with_project += 1;
            }
            let Some(s) = s else { continue };
            if s.setting(&format!("privacy:{}", b.project)).as_deref() == Some("disabled") || s.blocked("", &b.project, &first)? {
                continue;
            }
            let data = json!({
                "usage_scope": "main_agent", "usage_status": "complete", "usage_source": "session_log", "calls": b.calls,
                "input_tokens": b.input, "cached_input_tokens": b.cached, "cache_write_tokens": b.written, "output_tokens": b.output,
                "reasoning_tokens": if b.reasoning > 0 { json!(b.reasoning) } else { Value::Null }, "total_tokens": total,
                "provider": b.provider, "requested_model": model, "resolved_model": null, "model": model, "status": "completed",
                "duration_ms": b.last - b.first, "started_at": first, "completed_at": iso(b.last), "node_id": null,
                "provider_thread_id": session, "prompt_id": null,
            });
            s.put(&c.source.instance_id, "model_turn", &format!("log:{session}:{hour}:{model}"), &b.project, "", "", &first, &iso(b.last), "partial", SOURCE, data)?;
            pending += 1;
            if pending >= 2000 {
                s.conn.execute_batch("COMMIT; BEGIN")?;
                pending = 0;
            }
        }
        Ok(())
    })();
    if let Some(s) = s {
        s.capture_source.set("t3_sqlite_v2");
        match &result {
            Ok(()) => s.conn.execute_batch("COMMIT; CHECKPOINT")?,
            Err(_) => {
                let _ = s.conn.execute_batch("ROLLBACK");
            }
        }
    }
    result?;
    let session_count = blocks.keys().map(|k| k.0.as_str()).collect::<HashSet<_>>().len();
    Ok(json!({"dry_run": s.is_none(), "source": SOURCE, "before": cutoff, "usage_blocks": written, "with_project": with_project,
        "calls_skipped_as_already_imported": skipped_covered, "sessions": session_count, "tokens_by_month_and_provider": tokens}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn claude_folders_encode_every_symbol_as_a_dash() {
        assert_eq!(super::claude_folder("D:\\Code\\Thesis"), "D--Code-Thesis");
        assert_eq!(super::claude_folder("C:\\Users\\a\\.t3\\projects\\example-site.ch"), "C--Users-a--t3-projects-example-site-ch");
    }
}
