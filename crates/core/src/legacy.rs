//! One-time import of T3's previous database (`state.sqlite`), which stopped being written when T3 moved to
//! `statev2.sqlite`. Threads moved across, but their turns, messages, tool calls and token usage did not.
//!
//! Records keep the current shape and go through the same privacy handling and `Store::put`, so a repeat run changes nothing.
//! They are marked `t3_sqlite_v1`. Anything from the moment the new database began is left to the normal importer.
use crate::{importer::text, privacy, storage::Store};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const SOURCE: &str = "t3_sqlite_v1";

struct Turn {
    id: String,
    thread: String,
    requested: String,
    started: Option<String>,
    completed: Option<String>,
    state: String,
    pending: Option<String>,
}

/// Tokens reported for one turn. Each field stays unknown until some call reported it.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Usage {
    pub calls: u64,
    pub input: u64,
    pub cached: Option<u64>,
    pub output: u64,
    pub reasoning: Option<u64>,
}

/// Where a run of token updates has got to in one thread, so an update repeating the last one is not counted again.
#[derive(Default)]
pub struct UsageCursor {
    processed: Option<u64>,
    used: Option<u64>,
}

const U: fn(&Value, &str) -> Option<u64> = |v, k| v.get(k).and_then(Value::as_u64);

/// Adds one `context-window.updated` payload.
///
/// T3 recorded these differently per provider. Codex reports the last model call separately along with a running total,
/// and that total moving is what shows a new call happened. Others report only the size of the last call, which is
/// input (including cache) plus output, so a repeat of the same size is treated as the same report.
pub fn add_usage(total: &mut Usage, cursor: &mut UsageCursor, v: &Value) {
    if let Some(input) = U(v, "lastInputTokens") {
        let processed = U(v, "totalProcessedTokens");
        if processed.is_some() && processed == cursor.processed {
            return;
        }
        cursor.processed = processed;
        total.calls += 1;
        total.input += input;
        total.output += U(v, "lastOutputTokens").unwrap_or(0);
        if let Some(cached) = U(v, "lastCachedInputTokens") {
            total.cached = Some(total.cached.unwrap_or(0) + cached);
        }
        if let Some(reasoning) = U(v, "lastReasoningOutputTokens") {
            total.reasoning = Some(total.reasoning.unwrap_or(0) + reasoning);
        }
        return;
    }
    let used = U(v, "lastUsedTokens").or(U(v, "usedTokens"));
    if used.is_none() || used == cursor.used {
        return;
    }
    cursor.used = used;
    total.calls += 1;
    match (U(v, "inputTokens"), U(v, "outputTokens")) {
        (Some(input), Some(output)) => {
            total.input += input;
            total.output += output;
        }
        _ => total.input += used.unwrap_or(0),
    }
}

fn millis(a: Option<&String>, b: Option<&String>) -> Value {
    let parse = |s: &String| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (a.and_then(parse), b.and_then(parse)) {
        (Some(a), Some(b)) if b >= a => json!((b - a).num_milliseconds()),
        _ => Value::Null,
    }
}

fn month(at: &str) -> String {
    at.chars().take(7).collect()
}

/// With no store this only reads the source and reports what an import would write.
pub fn import_v1(c: &crate::config::Config, s: Option<&Store>, path: &str) -> Result<Value> {
    let source = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("Cannot open the old T3 SQLite read-only")?;
    source.busy_timeout(std::time::Duration::from_secs(5))?;

    // The new database takes over from its first provider turn, and nothing from then on is read here.
    let current = rusqlite::Connection::open_with_flags(&c.source.sqlite_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("Cannot open the current T3 SQLite read-only")?;
    let cutoff: String = current.query_row("SELECT min(started_at) FROM orchestration_v2_projection_provider_turns", [], |r| r.get(0))?;

    let mut threads: HashMap<String, (String, Value, String, Option<String>)> = HashMap::new();
    {
        let mut stmt = source.prepare("SELECT t.thread_id,t.project_id,t.model_selection_json,s.provider_instance_id,s.provider_thread_id FROM projection_threads t LEFT JOIN projection_thread_sessions s ON s.thread_id=t.thread_id")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let selection: Option<String> = r.get(2)?;
            let selection = selection.and_then(|x| serde_json::from_str(&x).ok()).unwrap_or(Value::Null);
            threads.insert(r.get(0)?, (r.get(1)?, selection, r.get::<_, Option<String>>(3)?.unwrap_or_default(), r.get(4)?));
        }
    }

    // The model a turn asked for is only kept on the event that started it.
    let mut selections: HashMap<String, Value> = HashMap::new();
    {
        let mut stmt = source.prepare("SELECT payload_json FROM orchestration_events WHERE event_type='thread.turn-start-requested'")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let raw: String = r.get(0)?;
            let v: Value = serde_json::from_str(&raw)?;
            if let (Some(m), Some(sel)) = (v.get("messageId").and_then(Value::as_str), v.get("modelSelection")) {
                selections.insert(m.to_string(), sel.clone());
            }
        }
    }

    let mut turns: Vec<Turn> = vec![];
    {
        let mut stmt = source.prepare("SELECT turn_id,thread_id,requested_at,started_at,completed_at,state,pending_message_id FROM projection_turns WHERE turn_id IS NOT NULL AND requested_at IS NOT NULL ORDER BY thread_id,requested_at")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            turns.push(Turn { id: r.get(0)?, thread: r.get(1)?, requested: r.get(2)?, started: r.get(3)?, completed: r.get(4)?, state: r.get(5)?, pending: r.get(6)? });
        }
    }
    turns.retain(|t| t.requested < cutoff && threads.contains_key(&t.thread));
    let mut by_thread: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, t) in turns.iter().enumerate() {
        by_thread.entry(&t.thread).or_default().push(i);
    }
    let by_id: HashMap<&str, usize> = turns.iter().enumerate().map(|(i, t)| (t.id.as_str(), i)).collect();
    let by_prompt: HashMap<&str, usize> = turns.iter().enumerate().filter_map(|(i, t)| t.pending.as_deref().map(|p| (p, i))).collect();
    // The turn running at a moment: the last one requested by then, or the thread's first.
    let turn_at = |thread: &str, at: &str| -> Option<usize> {
        let list = by_thread.get(thread)?;
        let n = list.partition_point(|&i| turns[i].requested.as_str() <= at);
        Some(list[n.saturating_sub(1)])
    };
    let model_of = |t: &Turn| -> (Value, Value) {
        let thread = &threads[&t.thread];
        let selection = t.pending.as_ref().and_then(|p| selections.get(p));
        let model = selection.and_then(|v| v.get("model")).or_else(|| thread.1.get("model")).cloned().unwrap_or(Value::Null);
        let provider = selection.and_then(|v| v.get("instanceId")).cloned().unwrap_or_else(|| if thread.2.is_empty() { Value::Null } else { json!(thread.2) });
        (model, provider)
    };

    let mut usage: HashMap<usize, Usage> = HashMap::new();
    let mut report_calls: BTreeMap<String, u64> = BTreeMap::new();
    {
        let mut stmt = source.prepare("SELECT thread_id,created_at,payload_json FROM projection_thread_activities WHERE kind='context-window.updated' ORDER BY thread_id,created_at,sequence")?;
        let mut rows = stmt.query([])?;
        let mut cursors: HashMap<String, UsageCursor> = HashMap::new();
        while let Some(r) = rows.next()? {
            let thread: String = r.get(0)?;
            let at: String = r.get(1)?;
            let Some(i) = turn_at(&thread, &at) else { continue };
            if at >= cutoff {
                continue;
            }
            let raw: String = r.get(2)?;
            let v: Value = serde_json::from_str(&raw)?;
            let cursor = cursors.entry(thread).or_default();
            let entry = usage.entry(i).or_default();
            let before = entry.calls;
            add_usage(entry, cursor, &v);
            if entry.calls > before {
                *report_calls.entry(month(&at)).or_default() += 1;
            }
        }
    }

    // A project's stricter capture rule still applies to its old records.
    let rank = |p: &str| match p {
        "disabled" => 3,
        "metadata_only" => 2,
        "redacted_only" => 1,
        _ => 0,
    };
    let policy_of = |project: &str| -> String {
        s.and_then(|s| s.setting(&format!("privacy:{project}")))
            .filter(|v| rank(v) > rank(&c.capture.default_policy))
            .unwrap_or_else(|| c.capture.default_policy.clone())
    };
    let key = if c.capture.default_policy == "full_encrypted" && s.is_some() { Some(privacy::key(false)?) } else { None };

    // Records the current importer already has are its to keep.
    let existing: HashSet<(String, String)> = match s {
        Some(s) => {
            let mut stmt = s.conn.prepare("SELECT kind,source_id FROM records WHERE kind IN ('prompt','answer','tool','run','model_turn') AND capture_source<>?")?;
            let rows = stmt.query_map([SOURCE], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<duckdb::Result<_>>()?
        }
        None => HashSet::new(),
    };

    let instance = c.source.instance_id.clone();
    let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
    let mut months: BTreeMap<String, BTreeMap<&str, u64>> = BTreeMap::new();
    let mut tokens: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut pending = 0u32;
    if let Some(s) = s {
        s.capture_source.set(SOURCE);
        s.conn.execute_batch("BEGIN")?;
    }
    let mut put = |kind: &'static str, source_id: &str, project: &str, thread: &str, run: &str, at: &str, updated: &str, data: Value| -> Result<()> {
        if existing.contains(&(kind.to_string(), source_id.to_string())) {
            *counts.entry("skipped_already_present").or_default() += 1;
            return Ok(());
        }
        if let Some(s) = s {
            if s.blocked(thread, project, at)? {
                *counts.entry("skipped_purged").or_default() += 1;
                return Ok(());
            }
            s.put(&instance, kind, source_id, project, thread, run, at, updated, "partial", SOURCE, data)?;
            pending += 1;
            if pending >= 2000 {
                s.conn.execute_batch("COMMIT; BEGIN")?;
                pending = 0;
            }
        }
        *counts.entry(kind).or_default() += 1;
        *months.entry(month(at)).or_default().entry(kind).or_default() += 1;
        Ok(())
    };

    let result = (|| -> Result<()> {
        for (i, t) in turns.iter().enumerate() {
            let thread = &threads[&t.thread];
            if policy_of(&thread.0) == "disabled" {
                continue;
            }
            let (model, provider) = model_of(t);
            let run_id = format!("v1:{}", t.id);
            let status = match t.state.as_str() {
                "error" => "failed",
                other => other,
            };
            let started = t.started.as_ref().unwrap_or(&t.requested);
            let updated = t.completed.as_deref().unwrap_or(&t.requested);
            let duration = millis(Some(started), t.completed.as_ref());
            put("run", &run_id, &thread.0, &t.thread, &run_id, &t.requested, updated, json!({
                "duration_ms": duration, "provider": provider, "requested_model": model, "resolved_model": null, "status": status,
                "started_at": t.started, "completed_at": t.completed, "user_message_id": t.pending,
                "input_tokens": null, "cached_input_tokens": null, "output_tokens": null, "reasoning_tokens": null, "total_tokens": null,
            }))?;
            let found = usage.get(&i);
            let mut data = json!({
                "usage_scope": if found.is_some() { "main_agent" } else { "unavailable" },
                "usage_status": if found.is_some() { "complete" } else { "unavailable" },
                "usage_source": "context_window_v1",
                "input_tokens": null, "cached_input_tokens": null, "output_tokens": null, "reasoning_tokens": null, "total_tokens": null,
                "provider": provider, "requested_model": model, "resolved_model": null, "model": model, "status": status, "duration_ms": duration,
                "started_at": t.started, "completed_at": t.completed, "node_id": null, "provider_thread_id": thread.3, "prompt_id": t.pending,
            });
            if let Some(u) = found {
                data["input_tokens"] = json!(u.input);
                data["cached_input_tokens"] = json!(u.cached);
                data["output_tokens"] = json!(u.output);
                data["reasoning_tokens"] = json!(u.reasoning);
                data["total_tokens"] = json!(u.input + u.output);
                let family = provider.as_str().unwrap_or("unknown").to_string();
                *tokens.entry(month(&t.requested)).or_default().entry(family).or_default() += u.input + u.output;
            }
            put("model_turn", &run_id, &thread.0, &t.thread, &run_id, started, updated, data)?;
        }

        let mut first_prompt: HashSet<String> = HashSet::new();
        let mut stmt = source.prepare("SELECT message_id,thread_id,turn_id,role,text,created_at,updated_at FROM projection_thread_messages WHERE role IN ('user','assistant') AND coalesce(is_streaming,0)=0 ORDER BY thread_id,created_at")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let (id, thread_id): (String, String) = (r.get(0)?, r.get(1)?);
            let (turn_id, role): (Option<String>, String) = (r.get(2)?, r.get(3)?);
            let (body, at, updated): (Option<String>, String, String) = (r.get(4)?, r.get(5)?, r.get(6)?);
            if at >= cutoff {
                continue;
            }
            let Some(thread) = threads.get(&thread_id) else { continue };
            let policy = policy_of(&thread.0);
            if policy == "disabled" {
                continue;
            }
            let i = by_prompt.get(id.as_str()).copied()
                .or_else(|| turn_id.as_deref().and_then(|x| by_id.get(x).copied()))
                .or_else(|| turn_at(&thread_id, &at));
            let turn = i.map(|i| &turns[i]);
            let mut data = serde_json::to_value(privacy::protect(body.as_deref().unwrap_or(""), &policy, key.as_ref())?)?;
            data["source_message_id"] = json!(id);
            data["model"] = turn.map(|t| model_of(t).0).unwrap_or(Value::Null);
            data["status"] = turn.map(|t| json!(if t.state == "error" { "failed" } else { t.state.as_str() })).unwrap_or(Value::Null);
            data["prompt_id"] = turn.map(|t| json!(t.pending)).unwrap_or(Value::Null);
            data["prompt_type"] = json!(if role != "user" {
                "unknown"
            } else if first_prompt.insert(thread_id.clone()) {
                "primary"
            } else {
                "follow_up"
            });
            let run = turn.map(|t| format!("v1:{}", t.id)).unwrap_or_default();
            put(if role == "user" { "prompt" } else { "answer" }, &id, &thread.0, &thread_id, &run, &at, &updated, data)?;
        }

        // A call reports several times as it runs, so only its last completion counts, timed from its first start.
        let mut starts: HashMap<String, String> = HashMap::new();
        {
            let mut stmt = source.prepare("SELECT json_extract(payload_json,'$.toolCallId'),min(created_at) FROM projection_thread_activities WHERE kind='tool.started' GROUP BY 1")?;
            let mut rows = stmt.query([])?;
            while let Some(r) = rows.next()? {
                if let Some(id) = r.get::<_, Option<String>>(0)? {
                    starts.insert(id, r.get(1)?);
                }
            }
        }
        let mut seen: HashSet<String> = HashSet::new();
        let mut stmt = source.prepare("SELECT activity_id,thread_id,turn_id,created_at,payload_json FROM projection_thread_activities WHERE kind='tool.completed' ORDER BY created_at DESC")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let (activity, thread_id): (String, String) = (r.get(0)?, r.get(1)?);
            let (turn_id, at, raw): (Option<String>, String, String) = (r.get(2)?, r.get(3)?, r.get(4)?);
            if at >= cutoff {
                continue;
            }
            let Some(thread) = threads.get(&thread_id) else { continue };
            let policy = policy_of(&thread.0);
            if policy == "disabled" {
                continue;
            }
            let v: Value = serde_json::from_str(&raw)?;
            let call = v.get("toolCallId").and_then(Value::as_str).map(str::to_string);
            let id = format!("v1:{}", call.clone().unwrap_or(activity));
            if !seen.insert(id.clone()) {
                continue;
            }
            let d = v.get("data").cloned().unwrap_or(Value::Null);
            let content = json!({
                "arguments": d.get("input"),
                "result": d.get("result").or_else(|| d.get("output")).or_else(|| d.get("rawOutput")),
                "diff": d.get("diff"),
                "file": d.get("file").or_else(|| d.get("path")),
                "detail": v.get("detail"),
            });
            let mut data = serde_json::to_value(privacy::protect_json(&content, &policy, key.as_ref())?)?;
            let i = turn_id.as_deref().and_then(|x| by_id.get(x).copied()).or_else(|| turn_at(&thread_id, &at));
            let turn = i.map(|i| &turns[i]);
            let start = call.as_ref().and_then(|c| starts.get(c));
            let item = text(&v, "itemType");
            data["status"] = v.get("status").cloned().unwrap_or(Value::Null);
            data["duration_ms"] = millis(start, Some(&at));
            data["model"] = turn.map(|t| model_of(t).0).unwrap_or(Value::Null);
            data["started_at"] = start.map(|x| json!(x)).unwrap_or(Value::Null);
            data["completed_at"] = json!(at);
            data["tool_name"] = d.get("toolName").filter(|x| !x.is_null()).cloned().unwrap_or_else(|| json!(item));
            data["tool_category"] = json!(match item {
                "command_execution" => "shell",
                "file_change" => "file_write",
                "file_search" | "web_search" => "search",
                _ => "unknown",
            });
            data["exit_code"] = d.get("exitCode").cloned().unwrap_or(Value::Null);
            data["parent_tool_call_id"] = Value::Null;
            let run = turn.map(|t| format!("v1:{}", t.id)).unwrap_or_default();
            put("tool", &id, &thread.0, &thread_id, &run, start.unwrap_or(&at), &at, data)?;
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
    Ok(json!({
        "dry_run": s.is_none(),
        "source": SOURCE,
        "before": cutoff,
        "written": counts,
        "records_by_month": months,
        "tokens_by_month_and_provider": tokens,
        "counted_model_calls_by_month": report_calls,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_counts_a_call_only_when_its_running_total_moves() {
        let (mut total, mut cursor) = (Usage::default(), UsageCursor::default());
        let call = |tp: u64, input: u64| json!({"lastInputTokens":input,"lastCachedInputTokens":input / 2,"lastOutputTokens":10,"lastReasoningOutputTokens":1,"totalProcessedTokens":tp,"lastUsedTokens":input + 10});
        add_usage(&mut total, &mut cursor, &call(110, 100));
        add_usage(&mut total, &mut cursor, &call(110, 100));
        add_usage(&mut total, &mut cursor, &call(330, 200));
        assert_eq!(total, Usage { calls: 2, input: 300, cached: Some(150), output: 20, reasoning: Some(2) });
    }

    #[test]
    fn others_count_each_call_size_once_and_leave_cache_unknown() {
        let (mut total, mut cursor) = (Usage::default(), UsageCursor::default());
        let call = |input: u64, output: u64| json!({"usedTokens":input + output,"lastUsedTokens":input + output,"inputTokens":input,"outputTokens":output,"totalProcessedTokens":999});
        add_usage(&mut total, &mut cursor, &call(100, 5));
        add_usage(&mut total, &mut cursor, &call(100, 5));
        add_usage(&mut total, &mut cursor, &call(200, 7));
        assert_eq!(total, Usage { calls: 2, input: 300, cached: None, output: 12, reasoning: None });
    }

    #[test]
    fn a_report_with_only_a_size_still_counts_that_size() {
        let (mut total, mut cursor) = (Usage::default(), UsageCursor::default());
        add_usage(&mut total, &mut cursor, &json!({"lastUsedTokens":40,"usedTokens":40}));
        assert_eq!(total.input, 40);
        assert_eq!(total.calls, 1);
    }
}
