use crate::{
    config::Config,
    privacy,
    storage::{Store, now},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::HashMap;
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn terminal(v: &Value) -> bool {
    [
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "rolled_back",
    ]
    .contains(&text(v, "status"))
}
#[derive(Default, Clone)]
pub struct Options {
    pub project: Option<String>,
    pub since: Option<String>,
    pub dry_run: bool,
    pub thread_limit: Option<usize>,
}
pub fn lineage(id: &str, threads: &HashMap<String, Value>) -> (String, usize, bool) {
    let mut cur = id.to_string();
    let mut seen = std::collections::HashSet::new();
    let mut depth = 0;
    while let Some(v) = threads.get(&cur) {
        if !seen.insert(cur.clone()) {
            return (cur, depth, false);
        }
        if v.pointer("/lineage/relationshipToParent")
            .and_then(Value::as_str)
            != Some("subagent")
        {
            break;
        }
        let Some(parent) = v.pointer("/lineage/parentThreadId").and_then(Value::as_str) else {
            return (cur, depth, false);
        };
        cur = parent.into();
        depth += 1;
    }
    let known = threads.contains_key(&cur);
    (cur, depth, known)
}
fn import_project(c: &Config, s: &Store, o: &Options) -> Result<Value> {
    if pause_path(c).exists() || c.capture.default_policy == "disabled" {
        return Ok(json!({"paused":true}));
    }
    let source = rusqlite::Connection::open_with_flags(
        &c.source.sqlite_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .context("Cannot open T3 SQLite read-only; check source.sqlite_path")?;
    source.busy_timeout(std::time::Duration::from_secs(5))?;
    source.execute_batch("BEGIN")?;
    let version = std::path::Path::new(&c.source.sqlite_path)
        .parent()
        .and_then(|p| std::fs::read_to_string(p.join("server-runtime.json")).ok())
        .and_then(|x| serde_json::from_str::<Value>(&x).ok())
        .map(|v| text(&v, "serverVersion").to_string())
        .unwrap_or("unknown".into());
    // Per-project freshness must never inherit another project's global watermark.
    // This is observation metadata; source revision scans remain the catch-up authority.
    let checkpoint = s.conn.query_row(
        "SELECT source_updated_at FROM records WHERE instance_id=? AND (? IS NULL OR project_id=?) AND kind<>'instance' ORDER BY try_cast(source_updated_at AS TIMESTAMPTZ) DESC NULLS LAST LIMIT 1",
        duckdb::params![c.source.instance_id,o.project,o.project], |r| r.get::<_,String>(0),
    ).ok().unwrap_or_default();
    let has_project_column = source
        .prepare("PRAGMA table_info(orchestration_v2_projection_threads)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|n| n == "project_id");
    let mut threads = Vec::new();
    let mut foreign_thread_errors = 0u64;
    let project_column = if has_project_column {
        "project_id"
    } else {
        "NULL"
    };
    let mut thread_stmt = source.prepare(&format!("SELECT payload_json,{project_column} FROM orchestration_v2_projection_threads ORDER BY updated_at"))?;
    let mut thread_rows = thread_stmt.query([])?;
    while let Some(row) = thread_rows.next()? {
        let raw: String = row.get(0)?;
        let project: Option<String> = row.get(1)?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(thread) => threads.push(thread),
            Err(_)
                if o.project
                    .as_ref()
                    .zip(project.as_ref())
                    .is_some_and(|(wanted, actual)| wanted != actual) =>
            {
                foreign_thread_errors += 1
            }
            Err(error) => return Err(error.into()),
        }
    }
    let all: HashMap<_, _> = threads
        .iter()
        .map(|t| {
            (
                text(t, "id").to_string(),
                json!({"lineage":t.get("lineage")}),
            )
        })
        .collect();
    let selected: HashMap<_, _> = threads
        .into_iter()
        .filter(|t| o.project.as_ref().is_none_or(|p| text(t, "projectId") == p))
        .take(o.thread_limit.unwrap_or(usize::MAX))
        .map(|t| (text(&t, "id").to_string(), t))
        .collect();
    let mut run_map = HashMap::new();
    let mut run_stmt=source.prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal")?;
    for tid in selected.keys() {
        let rows = run_stmt.query_map([tid], |r| r.get::<_, String>(0))?;
        for row in rows {
            let v: Value = serde_json::from_str(&row?)?;
            run_map.insert(text(&v, "id").to_string(), v);
        }
    }
    let revisions = s.revisions(&c.source.instance_id, o.project.as_deref())?;
    let mut policies = HashMap::new();
    for t in selected.values() {
        let p = text(t, "projectId");
        policies.entry(p.to_string()).or_insert_with(|| {
            let rank = |p: &str| match p {
                "disabled" => 3,
                "metadata_only" => 2,
                "redacted_only" => 1,
                _ => 0,
            };
            let override_policy = s.setting(&format!("privacy:{p}"));
            override_policy
                .filter(|v| rank(v) > rank(&c.capture.default_policy))
                .unwrap_or(c.capture.default_policy.clone())
        });
    }
    let tombstones = s.rows(
        "SELECT json_object('scope',scope,'id',source_id)::VARCHAR FROM tombstones",
        &[],
    )?;
    let key = if c.capture.default_policy == "full_encrypted" {
        Some(privacy::key(false)?)
    } else {
        None
    };
    let mut changed = 0;
    let skipped = std::cell::Cell::new(0usize);
    let cached = std::cell::Cell::new(0usize);
    let mut newest = checkpoint;
    if !o.dry_run {
        s.conn.execute_batch("BEGIN")?;
    }
    let result = (|| {
        let mut put = |kind: &str,
                       v: &Value,
                       data: Value,
                       quality: &str,
                       date: &str,
                       thread: &str,
                       project: &str,
                       run: &str|
         -> Result<()> {
            if policies
                .get(project)
                .is_some_and(|policy| policy == "disabled")
                || (!project.is_empty()
                    && !policies.contains_key(project)
                    && s.setting(&format!("privacy:{project}")).as_deref() == Some("disabled"))
            {
                return Ok(());
            }
            anyhow::ensure!(
                !pause_path(c).exists(),
                "Capture paused; current import transaction rolled back"
            );
            let updated = text(v, "updatedAt");
            let updated = if updated.is_empty() { date } else { updated };
            if updated > newest.as_str() {
                newest = updated.into();
            }
            if tombstones.iter().any(|t| match t["scope"].as_str() {
                Some("thread") => t["id"] == thread,
                Some("project") => t["id"] == project,
                Some("before") => t["id"]
                    .as_str()
                    .is_some_and(|d| crate::storage::time_before(date, d)),
                _ => false,
            }) {
                skipped.set(skipped.get() + 1);
                return Ok(());
            }
            if !o.dry_run
                && s.put(
                    &c.source.instance_id,
                    kind,
                    text(v, "id"),
                    project,
                    thread,
                    run,
                    date,
                    updated,
                    quality,
                    &version,
                    data,
                )?
            {
                changed += 1;
                if changed % 1000 == 0 {
                    let progress_key = format!("collector_progress:{}", c.source.instance_id);
                    let mut progress = s
                        .setting(&progress_key)
                        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
                        .unwrap_or(json!({}));
                    progress["project_id"] = json!(project);
                    progress["committed_changes_in_project"] = json!(changed);
                    progress["last_committed_at"] = json!(now());
                    s.set(&progress_key, &progress.to_string())?;
                    s.conn.execute_batch("COMMIT;BEGIN")?;
                    tracing::info!(
                        operation = "import_batch",
                        instance_id = c.source.instance_id,
                        project_id = project,
                        row_count = changed,
                        capture_quality = "partial"
                    );
                }
            }
            Ok(())
        };
        let has_root = source
            .prepare("PRAGMA table_info(projection_projects)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|n| n == "workspace_root");
        let root_column = if has_root { "workspace_root" } else { "''" };
        let mut stmt=source.prepare(&format!("SELECT project_id,title,created_at,updated_at,{root_column} FROM projection_projects WHERE deleted_at IS NULL"))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (id, title, created, updated, root) = row?;
            if o.project.as_ref().is_some_and(|p| p != &id) {
                continue;
            }
            let policy = policies
                .get(&id)
                .cloned()
                .or_else(|| {
                    s.setting(&format!("privacy:{id}"))
                        .map(|p| effective_policy(&c.capture.default_policy, &p))
                })
                .unwrap_or(c.capture.default_policy.clone());
            let revision = privacy::hash(&format!(
                "project4:{version}:{updated}:{policy}:{}",
                chrono::Utc::now().date_naive()
            ));
            if o.since.as_deref() != Some("")
                && revisions.get(&("project".into(), id.clone())) == Some(&revision)
            {
                cached.set(cached.get() + 1);
                continue;
            }
            let mut data = json!({"name":privacy::redact(&title).0,"t3_project_id":id,"repository_path_hash":privacy::hash(&root),"repository_root_alias":std::path::Path::new(&root).file_name().map(|s|s.to_string_lossy().to_string()),"git_remote_hash":null,"git_remote_alias":null,"logical_project_id":null,"current_branch":null});
            if !root.is_empty() && std::path::Path::new(&root).is_dir() {
                let git = |args: &[&str]| {
                    std::process::Command::new("git")
                        .arg("-C")
                        .arg(&root)
                        .args(args)
                        .output()
                        .ok()
                        .filter(|o| o.status.success())
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .map(|s| s.trim().to_string())
                };
                if let Some(remote) = git(&["config", "--get", "remote.origin.url"]) {
                    let canonical = canonical_remote(&remote);
                    data["git_remote_hash"] = json!(privacy::hash(&canonical));
                    data["logical_project_id"] = json!(privacy::hash(&canonical));
                    data["git_remote_alias"] = json!(privacy::redact(&canonical).0);
                }
                data["current_branch"] = git(&["symbolic-ref", "--short", "HEAD"])
                    .map(|s| json!(privacy::redact(&s).0))
                    .unwrap_or(Value::Null);
                if policy == "full_encrypted" {
                    data["repository_path_encrypted"] = json!(privacy::encrypt(
                        &root,
                        key.as_ref()
                            .ok_or_else(|| anyhow::anyhow!("Encryption key required"))?
                    )?);
                }
            }
            put(
                "project",
                &json!({"id":id,"updatedAt":updated}),
                data,
                "partial",
                &created,
                "",
                &id,
                "",
            )?;
            if !o.dry_run {
                s.save_revision(&c.source.instance_id, "project", &id, &revision)?;
            }
        }
        for (id, t) in &selected {
            let (root, depth, known) = lineage(id, &all);
            let policy = policies
                .get(text(t, "projectId"))
                .map(String::as_str)
                .unwrap_or(&c.capture.default_policy);
            let revision = privacy::hash(&format!(
                "thread4:{version}:{policy}:{}:{root}:{depth}:{known}",
                t
            ));
            if o.since.as_deref() != Some("")
                && revisions.get(&("thread".into(), id.clone())) == Some(&revision)
            {
                cached.set(cached.get() + 1);
                continue;
            }
            let rel = t
                .pointer("/lineage/relationshipToParent")
                .and_then(Value::as_str);
            let typ = if rel == Some("subagent") {
                "child"
            } else if t.pointer("/lineage/parentThreadId").is_some() {
                "primary"
            } else {
                "unknown"
            };
            let data = json!({"title":privacy::redact(text(t,"title")).0,"thread_type":typ,"parent_thread_id":t.pointer("/lineage/parentThreadId"),"root_thread_id":root,"depth":depth,"lineage_resolved":known,"relationship_to_parent":rel,"branch":privacy::redact(text(t,"branch")).0,"worktree_available":!text(t,"worktreePath").is_empty(),"model":t.pointer("/modelSelection/model"),"archived_at":t.get("archivedAt"),"tool_coverage":"partial","token_usage":null});
            put(
                "thread",
                t,
                data,
                "partial",
                text(t, "createdAt"),
                id,
                text(t, "projectId"),
                "",
            )?;
            if !o.dry_run {
                s.save_revision(&c.source.instance_id, "thread", id, &revision)?;
            }
        }
        for r in run_map.values() {
            let tid = text(r, "threadId");
            let Some(t) = selected.get(tid) else { continue };
            let policy = policies
                .get(text(t, "projectId"))
                .map(String::as_str)
                .unwrap_or(&c.capture.default_policy);
            let revision = privacy::hash(&format!("run4:{version}:{policy}:{}", r));
            if o.since.as_deref() != Some("")
                && revisions.get(&("run".into(), text(r, "id").into())) == Some(&revision)
            {
                cached.set(cached.get() + 1);
                continue;
            }
            let data = json!({"duration_ms":duration_ms(r),"provider":r.get("providerInstanceId"),"requested_model":r.pointer("/modelSelection/model"),"resolved_model":null,"status":r.get("status"),"started_at":r.get("startedAt"),"completed_at":r.get("completedAt"),"user_message_id":r.get("userMessageId"),"input_tokens":null,"cached_input_tokens":null,"output_tokens":null,"reasoning_tokens":null,"total_tokens":null});
            put(
                "run",
                r,
                data,
                "partial",
                text(r, "requestedAt"),
                tid,
                text(t, "projectId"),
                text(r, "id"),
            )?;
            if !o.dry_run {
                s.save_revision(&c.source.instance_id, "run", text(r, "id"), &revision)?;
            }
        }
        let mut message_meta=source.prepare("SELECT message_id,updated_at,run_id FROM orchestration_v2_projection_messages WHERE thread_id=? ORDER BY created_at,message_id")?;
        let mut message_payload = source.prepare(
            "SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id=?",
        )?;
        for (tid, t) in &selected {
            let project = text(t, "projectId");
            let policy = policies
                .get(project)
                .map(String::as_str)
                .unwrap_or(&c.capture.default_policy);
            if policy == "disabled" {
                continue;
            }
            let mut rows = message_meta.query([tid])?;
            while let Some(row) = rows.next()? {
                let mid: String = row.get(0)?;
                let updated: String = row.get(1)?;
                let rid: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
                let run = run_map.get(&rid);
                if run.is_none_or(|r| !terminal(r)) {
                    skipped.set(skipped.get() + 1);
                    continue;
                }
                if o.since
                    .as_ref()
                    .is_some_and(|d| !d.is_empty() && crate::storage::time_before(&updated, d))
                {
                    continue;
                }
                let revision = privacy::hash(&format!(
                    "adapter4:{version}:{updated}:{}:{}:{policy}",
                    run.map(|r| text(r, "status")).unwrap_or(""),
                    run.map(|r| text(r, "completedAt")).unwrap_or("")
                ));
                if o.since.as_deref() != Some("")
                    && revisions.get(&("message".to_string(), mid.clone())) == Some(&revision)
                {
                    cached.set(cached.get() + 1);
                    continue;
                }
                let raw: String = message_payload.query_row([&mid], |r| r.get(0))?;
                let m: Value = serde_json::from_str(&raw)?;
                if m.get("streaming") == Some(&Value::Bool(true)) {
                    skipped.set(skipped.get() + 1);
                    continue;
                }
                let role = text(&m, "role");
                if !["user", "assistant"].contains(&role) {
                    continue;
                }
                let protected = privacy::protect(text(&m, "text"), policy, key.as_ref())?;
                let mut data = serde_json::to_value(protected)?;
                data["source_message_id"] = m["id"].clone();
                data["model"] = run
                    .and_then(|r| r.pointer("/modelSelection/model"))
                    .cloned()
                    .unwrap_or(Value::Null);
                data["status"] = run.map(|r| r["status"].clone()).unwrap_or(Value::Null);
                data["prompt_id"] = run
                    .map(|r| r["userMessageId"].clone())
                    .unwrap_or(Value::Null);
                data["prompt_type"] = json!(if t
                    .pointer("/lineage/relationshipToParent")
                    .and_then(Value::as_str)
                    == Some("subagent")
                {
                    if run.and_then(|r| r.get("ordinal")).and_then(Value::as_i64) == Some(1) {
                        "subagent_task"
                    } else {
                        "unknown"
                    }
                } else if m.get("createdBy").and_then(Value::as_str) == Some("user") {
                    if run.and_then(|r| r.get("ordinal")).and_then(Value::as_i64) == Some(1) {
                        "primary"
                    } else {
                        "follow_up"
                    }
                } else {
                    "unknown"
                });
                put(
                    if role == "user" { "prompt" } else { "answer" },
                    &m,
                    data,
                    "partial",
                    text(&m, "createdAt"),
                    tid,
                    project,
                    &rid,
                )?;
                if !o.dry_run {
                    s.save_revision(&c.source.instance_id, "message", &mid, &revision)?;
                }
            }
        }
        let provider_scan_started = std::time::Instant::now();
        let mut provider_put_ms = 0u128;
        let mut provider_rows = 0u64;
        if table_exists(&source, "orchestration_v2_projection_provider_turns")?
            && table_exists(&source, "orchestration_v2_projection_nodes")?
        {
            let mut stmt=source.prepare("SELECT p.payload_json,n.run_id,p.provider_turn_id FROM orchestration_v2_projection_provider_turns p LEFT JOIN orchestration_v2_projection_nodes n ON p.node_id=n.node_id WHERE p.thread_id=?")?;
            for (tid, t) in &selected {
                let mut rows = stmt.query([tid])?;
                while let Some(row) = rows.next()? {
                    let raw: String = row.get(0)?;
                    let rid: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
                    let source_id: String = row.get(2)?;
                    let run = run_map.get(&rid);
                    let policy = policies
                        .get(text(t, "projectId"))
                        .map(String::as_str)
                        .unwrap_or(&c.capture.default_policy);
                    // Hash exact payload + linkage evidence, not timestamps alone: usage
                    // corrections and run/model relinks must invalidate unchanged turns.
                    let revision = privacy::hash(&format!(
                        "provider_turn1:{version}:{policy}:{rid}:{raw}:{}",
                        run.map(Value::to_string).unwrap_or_default()
                    ));
                    if o.since.as_deref() != Some("")
                        && revisions.get(&("model_turn".into(), source_id.clone()))
                            == Some(&revision)
                    {
                        cached.set(cached.get() + 1);
                        continue;
                    }
                    let v: Value = serde_json::from_str(&raw)?;
                    if !terminal(&v) {
                        continue;
                    }
                    let usage = v.get("turnTokenUsage").cloned().unwrap_or(Value::Null);
                    let mut data = token_fields(&usage);
                    data["provider"] = run
                        .map(|r| r["providerInstanceId"].clone())
                        .unwrap_or(Value::Null);
                    data["requested_model"] = run
                        .and_then(|r| r.pointer("/modelSelection/model"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    data["resolved_model"] = Value::Null;
                    data["status"] = v["status"].clone();
                    data["duration_ms"] = duration_ms(&v);
                    data["model"] = run
                        .and_then(|r| r.pointer("/modelSelection/model"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    data["started_at"] = v["startedAt"].clone();
                    data["completed_at"] = v["completedAt"].clone();
                    data["node_id"] = v["nodeId"].clone();
                    data["provider_thread_id"] = v["providerThreadId"].clone();
                    data["prompt_id"] = run
                        .map(|r| r["userMessageId"].clone())
                        .unwrap_or(Value::Null);
                    let mut source_v = v.clone();
                    source_v["updatedAt"] = v["completedAt"].clone();
                    provider_rows += 1;
                    let put_started = std::time::Instant::now();
                    put(
                        "model_turn",
                        &source_v,
                        data,
                        "partial",
                        text(&v, "startedAt"),
                        tid,
                        text(t, "projectId"),
                        &rid,
                    )?;
                    provider_put_ms += put_started.elapsed().as_micros();
                    if !o.dry_run {
                        s.save_revision(
                            &c.source.instance_id,
                            "model_turn",
                            text(&v, "id"),
                            &revision,
                        )?;
                    }
                }
            }
        }
        tracing::debug!(
            operation = "provider_turn_scan",
            project_id = o.project,
            duration_ms = provider_scan_started.elapsed().as_millis() as u64,
            put_ms = (provider_put_ms / 1000) as u64,
            rows = provider_rows
        );

        // Optional richer projections: stream rows to avoid materialising tool output in memory.
        for (table, kind) in [
            ("orchestration_v2_projection_turn_items", "tool"),
            ("orchestration_v2_projection_subagents", "agent"),
        ] {
            let exists: i64 = source.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
                [table],
                |r| r.get(0),
            )?;
            if exists == 0 {
                continue;
            }
            let id_column = if kind == "tool" {
                "turn_item_id"
            } else {
                "subagent_id"
            };
            let suffix = if kind == "tool" {
                " AND type IN ('command_execution','dynamic_tool','file_change','file_search','web_search') AND status IN ('completed','failed','cancelled','interrupted')"
            } else {
                ""
            };
            let mut stmt = source.prepare(&format!(
                "SELECT {id_column},run_id,updated_at FROM {table} WHERE thread_id=?{suffix}"
            ))?;
            let mut payload = source.prepare(&format!(
                "SELECT payload_json FROM {table} WHERE {id_column}=?"
            ))?;
            for (tid, t) in &selected {
                let project = text(t, "projectId");
                let policy = policies
                    .get(project)
                    .map(String::as_str)
                    .unwrap_or(&c.capture.default_policy);
                if policy == "disabled" {
                    continue;
                }
                let mut rows = stmt.query([tid])?;
                while let Some(row) = rows.next()? {
                    let source_id: String = row.get(0)?;
                    let rid: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
                    let updated: String = row.get(2)?;
                    let run = run_map.get(&rid);
                    if kind == "tool" && run.is_none_or(|r| !terminal(r)) {
                        continue;
                    }
                    if o.since
                        .as_ref()
                        .is_some_and(|d| !d.is_empty() && crate::storage::time_before(&updated, d))
                    {
                        continue;
                    }
                    let revision = privacy::hash(&format!(
                        "adapter4:{version}:{updated}:{}:{}:{policy}",
                        run.map(|r| text(r, "status")).unwrap_or(""),
                        run.map(|r| text(r, "completedAt")).unwrap_or("")
                    ));
                    let revision = if kind == "agent" {
                        privacy::hash(&format!("structured5:delivery2:{revision}"))
                    } else {
                        privacy::hash(&format!("structured5:{revision}"))
                    };
                    if o.since.as_deref() != Some("")
                        && revisions.get(&(kind.to_string(), source_id.clone())) == Some(&revision)
                    {
                        cached.set(cached.get() + 1);
                        continue;
                    }
                    let raw: String = payload.query_row([&source_id], |r| r.get(0))?;
                    let v: Value = serde_json::from_str(&raw)?;
                    let content = if kind == "tool" {
                        json!({"arguments":v.get("input"),"result":v.get("output"),"diff":v.get("diffStr"),"file":v.get("fileName")})
                    } else {
                        json!({"task":v.get("prompt"),"result":v.get("result")})
                    };
                    let mut data = serde_json::to_value(privacy::protect_json(
                        &content,
                        policy,
                        key.as_ref(),
                    )?)?;
                    data["status"] = v["status"].clone();
                    data["duration_ms"] = duration_ms(&v);
                    data["model"] = run
                        .and_then(|r| r.pointer("/modelSelection/model"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    data["started_at"] = v["startedAt"].clone();
                    data["completed_at"] = v["completedAt"].clone();
                    if kind == "tool" {
                        data["tool_name"] = v.get("toolName").cloned().unwrap_or(v["type"].clone());
                        data["tool_category"] = json!(match text(&v, "type") {
                            "command_execution" => "shell",
                            "file_change" => "file_write",
                            "file_search" | "web_search" => "search",
                            _ => "unknown",
                        });
                        data["exit_code"] = v["exitCode"].clone();
                        data["parent_tool_call_id"] = v["parentItemId"].clone();
                    } else {
                        data["agent_type"] = json!(if !text(&v, "childThreadId").is_empty() {
                            "t3_child"
                        } else if text(&v, "origin") == "provider_native" {
                            "provider_native_subagent"
                        } else {
                            "unknown"
                        });
                        data["child_thread_id"] = v["childThreadId"].clone();
                        data["parent_agent_run_id"] = v["parentNodeId"].clone();
                        data["model"] = v["model"].clone();
                        let delivery = v
                            .pointer("/completionDelivery/state")
                            .and_then(Value::as_str);
                        data["completion_delivery_state"] =
                            delivery.map(|d| json!(d)).unwrap_or(Value::Null);
                        data["result_returned_to_parent"] = match delivery {
                            Some("acknowledged" | "delivered") => json!(true),
                            _ => Value::Null,
                        };
                    }
                    put(
                        kind,
                        &v,
                        data,
                        "partial",
                        text(&v, "startedAt"),
                        tid,
                        project,
                        &rid,
                    )?;
                    if !o.dry_run {
                        s.save_revision(&c.source.instance_id, kind, &source_id, &revision)?;
                    }
                }
            }
        }
        if let Some(path) = &c.source.justrunit_sqlite_path {
            let external = rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            external.execute_batch("BEGIN")?;
            let mut stmt=external.prepare("SELECT j.id,j.thread_id,coalesce(j.t3_thread_id,t.t3_thread_id),j.t3_run_id,j.created_at,t.created_by,j.status FROM jobs j JOIN threads t ON t.id=j.thread_id WHERE coalesce(j.t3_thread_id,t.t3_thread_id) IS NOT NULL")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let source_id: String = row.get(0)?;
                let external_thread: String = row.get(1)?;
                let tid: String = row.get(2)?;
                let Some(t) = selected.get(&tid) else {
                    continue;
                };
                let rid: String = row.get::<_, Option<String>>(3)?.unwrap_or_default();
                let requested: i64 = row.get(4)?;
                let user: String = row.get(5)?;
                let status: String = row.get(6)?;
                let date = chrono::DateTime::from_timestamp_millis(requested)
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_default();
                put(
                    "external_request",
                    &json!({"id":source_id,"updatedAt":date}),
                    json!({"external_source":"justrunit","external_request_id":source_id,"external_thread_id":external_thread,"t3_thread_id":tid,"t3_project_id":text(t,"projectId"),"requested_at":date,"submitted_at":null,"originating_user_fingerprint":privacy::hash(&user),"originating_device":null,"status":status}),
                    "partial",
                    &date,
                    &tid,
                    text(t, "projectId"),
                    &rid,
                )?;
            }
        }
        put(
            "instance",
            &json!({"id":c.source.instance_id,"updatedAt":"1970-01-01T00:00:00Z"}),
            json!({"display_name":c.source.display_name,"connection_type":"sqlite_readonly","capabilities":["projects","threads","runs","messages","tools","agents"],"quota":"unavailable","version":version}),
            "partial",
            "1970-01-01T00:00:00Z",
            "",
            "",
            "",
        )?;
        if !o.dry_run && o.project.is_none() && o.thread_limit.is_none() {
            s.conn.execute("INSERT INTO checkpoints VALUES (?,?,?) ON CONFLICT(instance_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,last_successful_sync_at=excluded.last_successful_sync_at",duckdb::params![c.source.instance_id,newest,now()])?;
        }
        Ok::<_, anyhow::Error>(())
    })();
    if !o.dry_run {
        s.conn
            .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
    }
    result?;
    Ok(
        json!({"changed":changed,"unchanged_source_rows_skipped":cached.get(),"skipped_incomplete_or_purged":skipped.get(),"foreign_thread_parse_errors":foreign_thread_errors,"threads_discovered":selected.len(),"checkpoint":newest,"dry_run":o.dry_run,"capture_quality":"partial"}),
    )
}

fn duration_ms(v: &Value) -> Value {
    match (
        chrono::DateTime::parse_from_rfc3339(text(v, "startedAt")),
        chrono::DateTime::parse_from_rfc3339(text(v, "completedAt")),
    ) {
        (Ok(a), Ok(b)) if b >= a => json!((b - a).num_milliseconds()),
        _ => Value::Null,
    }
}

fn table_exists(c: &rusqlite::Connection, t: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
        [t],
        |r| r.get::<_, i64>(0),
    )? > 0)
}
pub fn token_fields(usage: &Value) -> Value {
    let valid = |name: &str| {
        usage
            .get(name)
            .and_then(Value::as_u64)
            .map(|v| json!(v))
            .unwrap_or(Value::Null)
    };
    let supported = text(usage, "usageScope") == "main_agent";
    let mut out = json!({"usage_scope":if supported{"main_agent"}else{"unavailable"},"usage_status":if supported{text(usage,"usageStatus")}else{"unavailable"},"input_tokens":null,"cached_input_tokens":null,"cache_write_tokens":null,"output_tokens":null,"reasoning_tokens":null,"total_tokens":null,"has_subagents":usage.get("hasSubagents")});
    if supported && text(usage, "usageStatus") != "unavailable" {
        for (target, source) in [
            ("input_tokens", "inputTokens"),
            ("cached_input_tokens", "cachedInputTokens"),
            ("cache_write_tokens", "cacheCreationTokens"),
            ("output_tokens", "outputTokens"),
            ("reasoning_tokens", "reasoningTokens"),
        ] {
            out[target] = valid(source);
        }
        if text(usage, "usageStatus") == "complete"
            && let (Some(input), Some(output)) =
                (out["input_tokens"].as_u64(), out["output_tokens"].as_u64())
        {
            out["total_tokens"] = input
                .checked_add(output)
                .map(|v| json!(v))
                .unwrap_or(Value::Null);
        }
    }
    out
}
pub fn pause_path(c: &Config) -> std::path::PathBuf {
    std::path::Path::new(&c.storage.duckdb_path).with_extension("capture-paused")
}

fn canonical_remote(remote: &str) -> String {
    let trimmed = remote.trim().split(['?', '#']).next().unwrap_or("");
    let without_protocol = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let without_credentials = without_protocol
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(without_protocol);
    without_credentials
        .replace(':', "/")
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_lowercase()
}

fn effective_policy(application: &str, project: &str) -> String {
    let rank = |p: &str| match p {
        "disabled" => 3,
        "metadata_only" => 2,
        "redacted_only" => 1,
        _ => 0,
    };
    if rank(project) > rank(application) {
        project.into()
    } else {
        application.into()
    }
}

/// Commit independently per authoritative project so initial imports are resumable
/// and readers can see completed projects before a machine-wide catch-up ends.
pub fn import(c: &Config, s: &Store, o: &Options) -> Result<Value> {
    if o.project.is_some() || o.thread_limit.is_some() {
        return import_project(c, s, o);
    }
    if pause_path(c).exists() || c.capture.default_policy == "disabled" {
        return Ok(json!({"paused":true}));
    }
    let source = rusqlite::Connection::open_with_flags(
        &c.source.sqlite_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let projects=source.prepare("SELECT project_id FROM projection_projects WHERE deleted_at IS NULL ORDER BY project_id")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(source);
    let start = std::time::Instant::now();
    let mut changed = 0u64;
    let mut threads = 0u64;
    let mut skipped = 0u64;
    let mut cached = 0u64;
    let mut checkpoint = String::new();
    let mut project_errors = vec![];
    let mut synced = 0usize;
    for (project_index, project) in projects.iter().enumerate() {
        let retry_key = format!("source_retry:{}:{project}", c.source.instance_id);
        let retry = s
            .setting(&retry_key)
            .and_then(|v| serde_json::from_str::<Value>(&v).ok());
        if o.since.as_deref() != Some("")
            && retry
                .as_ref()
                .and_then(|v| v["retry_at"].as_i64())
                .is_some_and(|t| t > chrono::Utc::now().timestamp())
        {
            project_errors.push(json!({"project_id":project,"error_category":"retry_backoff","retry_at":retry.as_ref().and_then(|v|v.get("retry_at"))}));
            continue;
        }
        let mut scoped = o.clone();
        scoped.project = Some(project.clone());
        let project_started = std::time::Instant::now();
        if !o.dry_run {
            s.set(&format!("collector_progress:{}",c.source.instance_id),&json!({"state":"importing","project_id":project,"project_position":project_index+1,"projects_discovered":projects.len(),"projects_completed_this_pass":synced,"committed_changes_in_project":0,"started_at":now()}).to_string())?;
        }
        let report = match import_project(c, s, &scoped) {
            Ok(report) => report,
            Err(error) => {
                if pause_path(c).exists() {
                    return Ok(
                        json!({"paused":true,"changed":changed,"checkpoint_not_advanced":true,"capture_quality":"partial"}),
                    );
                }
                let category = error_category(&error);
                let failures = retry
                    .as_ref()
                    .and_then(|v| v["failures"].as_u64())
                    .unwrap_or(0)
                    + 1;
                let delay = 30i64 * (1i64 << failures.min(6));
                let retry_at = chrono::Utc::now().timestamp() + delay;
                if !o.dry_run {
                    s.set(
                        &retry_key,
                        &json!({"failures":failures,"retry_at":retry_at,"error_category":category})
                            .to_string(),
                    )?;
                }
                tracing::warn!(
                    operation = "project_sync",
                    project_id = project,
                    error_category = category,
                    retry_seconds = delay
                );
                tracing::debug!(operation="project_sync",project_id=project,error_details=%privacy::redact(&error.to_string()).0);
                project_errors.push(
                    json!({"project_id":project,"error_category":category,"retry_at":retry_at}),
                );
                continue;
            }
        };
        synced += 1;
        if !o.dry_run {
            s.conn
                .execute("DELETE FROM settings WHERE key=?", [&retry_key])?;
        }
        if report["paused"] == true {
            return Ok(
                json!({"paused":true,"changed":changed,"checkpoint_not_advanced":true,"capture_quality":"partial"}),
            );
        }
        tracing::info!(
            operation = "project_sync",
            instance_id = c.source.instance_id,
            project_id = project,
            duration_ms = project_started.elapsed().as_millis() as u64,
            row_count = report["changed"].as_u64().unwrap_or(0),
            capture_quality = "partial"
        );
        changed += report["changed"].as_u64().unwrap_or(0);
        cached += report["unchanged_source_rows_skipped"]
            .as_u64()
            .unwrap_or(0);
        threads += report["threads_discovered"].as_u64().unwrap_or(0);
        skipped += report["skipped_incomplete_or_purged"].as_u64().unwrap_or(0);
        if let Some(value) = report["checkpoint"].as_str()
            && value > checkpoint.as_str()
        {
            checkpoint = value.into();
        }
        if !o.dry_run {
            s.conn.execute("INSERT INTO project_sync_checkpoints VALUES (?,?,?,?) ON CONFLICT(instance_id,project_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,last_successful_sync_at=excluded.last_successful_sync_at",duckdb::params![c.source.instance_id,project,report["checkpoint"].as_str().unwrap_or(""),now()])?;
        }
    }
    if !o.dry_run && o.since.is_none() && project_errors.is_empty() {
        s.conn.execute("INSERT INTO checkpoints VALUES (?,?,?) ON CONFLICT(instance_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,last_successful_sync_at=excluded.last_successful_sync_at",duckdb::params![c.source.instance_id,checkpoint,now()])?;
    }
    let report = json!({"changed":changed,"changed_scope":"successful_projects_only","failed_project_committed_batches_not_in_total":!project_errors.is_empty(),"threads_discovered":threads,"projects_synced":synced,"projects_discovered":projects.len(),"partial_sync":!project_errors.is_empty(),"project_errors":project_errors,"unchanged_source_rows_skipped":cached,"skipped_incomplete_or_purged":skipped,"checkpoint":checkpoint,"duration_ms":start.elapsed().as_millis(),"dry_run":o.dry_run,"capture_quality":"partial"});
    if !o.dry_run {
        s.set(&format!("collector_progress:{}",c.source.instance_id),&json!({"state":if project_errors.is_empty(){"synced"}else{"partial"},"projects_discovered":projects.len(),"projects_completed_this_pass":synced,"finished_at":now()}).to_string())?;
        s.set(
            &format!("import_report:{}", c.source.instance_id),
            &report.to_string(),
        )?;
    }
    Ok(report)
}
pub fn error_category(error: &anyhow::Error) -> &'static str {
    let message = error.to_string().to_lowercase();
    if error.downcast_ref::<serde_json::Error>().is_some() {
        "source_json_invalid"
    } else if message.contains("out of memory") || message.contains("memory limit") {
        "database_memory_limit"
    } else if message.contains("database is locked") {
        "source_busy"
    } else if message.contains("no such table") || message.contains("no such column") {
        "source_schema_mismatch"
    } else if message.contains("invalid column type") {
        "source_field_type"
    } else {
        "source_sync_failed"
    }
}

/// Read-only parser diagnostic: reports positions/errors, never source content.
pub fn validate_source(c: &Config, project: Option<&str>) -> Result<Value> {
    let source = rusqlite::Connection::open_with_flags(
        &c.source.sqlite_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut checked = 0u64;
    let mut errors = vec![];
    let started = std::time::Instant::now();
    for table in [
        "orchestration_v2_projection_threads",
        "orchestration_v2_projection_runs",
        "orchestration_v2_projection_messages",
        "orchestration_v2_projection_turn_items",
        "orchestration_v2_projection_subagents",
        "orchestration_v2_projection_provider_turns",
    ] {
        if !table_exists(&source, table)? {
            continue;
        }
        let filter = if project.is_some() {
            " WHERE thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id=?)"
        } else {
            ""
        };
        let mut stmt =
            source.prepare(&format!("SELECT rowid,payload_json FROM {table}{filter}"))?;
        let mut rows = if let Some(project) = project {
            stmt.query([project])?
        } else {
            stmt.query([])?
        };
        while let Some(row) = rows.next()? {
            let raw: String = row.get(1)?;
            checked += 1;
            if let Err(error) = serde_json::from_str::<Value>(&raw) {
                errors.push(json!({"table":table,"rowid":row.get::<_,i64>(0)?,"bytes":raw.len(),"error":error.to_string()}));
                if errors.len() >= 10 {
                    break;
                }
            }
        }
        if errors.len() >= 10 {
            break;
        }
    }
    Ok(
        json!({"checked":checked,"errors":errors,"duration_ms":started.elapsed().as_millis(),"source_modified":false}),
    )
}
