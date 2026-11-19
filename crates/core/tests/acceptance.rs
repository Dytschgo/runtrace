use serde_json::json;
use t3ui_core::{
    analytics::{self, Filter},
    config::Config,
    importer::{self, Options},
    privacy,
    storage::{Store, id},
};
fn fixture() -> (tempfile::TempDir, Config) {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.sqlite");
    let db = rusqlite::Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE projection_projects(project_id TEXT,title TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
INSERT INTO projection_projects VALUES('p','Synthetic project','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL);
CREATE TABLE orchestration_v2_projection_threads(payload_json TEXT,updated_at TEXT);
CREATE TABLE orchestration_v2_projection_runs(payload_json TEXT,requested_at TEXT,completed_at TEXT,thread_id TEXT,ordinal INTEGER);
CREATE TABLE orchestration_v2_projection_messages(payload_json TEXT,updated_at TEXT,message_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,created_at TEXT);").unwrap();
    let date = "2026-01-01T00:00:00Z";
    for (tid, parent) in [("t", None), ("child", Some("t")), ("nested", Some("child"))] {
        let v = json!({"id":tid,"projectId":"p","title":"Synthetic","createdAt":date,"updatedAt":date,"lineage":{"parentThreadId":parent,"relationshipToParent":parent.map(|_|"subagent")}});
        db.execute(
            "INSERT INTO orchestration_v2_projection_threads VALUES(?,?)",
            [v.to_string(), date.into()],
        )
        .unwrap();
    }
    let r = json!({"id":"r","threadId":"t","status":"completed","ordinal":1,"userMessageId":"u","requestedAt":date,"updatedAt":date,"completedAt":"2026-01-01T00:01:00Z","modelSelection":{"model":"synthetic-model"}});
    db.execute(
        "INSERT INTO orchestration_v2_projection_runs VALUES(?,?,?,'t',1)",
        [r.to_string(), date.into(), "2026-01-01T00:01:00Z".into()],
    )
    .unwrap();
    for (mid, role, text) in [
        ("u", "user", "Test PASSWORD=super-secret"),
        ("a", "assistant", "Synthetic answer"),
    ] {
        let v = json!({"id":mid,"threadId":"t","runId":"r","role":role,"createdBy":"user","text":text,"createdAt":date,"updatedAt":date,"streaming":false});
        db.execute(
            "INSERT INTO orchestration_v2_projection_messages VALUES(?,?,?,?,?,?)",
            [
                v.to_string(),
                date.into(),
                mid.into(),
                "t".into(),
                "r".into(),
                date.into(),
            ],
        )
        .unwrap();
    }
    let mut c: Config = toml::from_str(include_str!("../../../config/default.toml")).unwrap();
    db.execute_batch("ALTER TABLE orchestration_v2_projection_threads ADD COLUMN project_id TEXT; UPDATE orchestration_v2_projection_threads SET project_id=json_extract(payload_json,'$.projectId')").unwrap();
    c.source.sqlite_path = source.to_string_lossy().into();
    c.storage.duckdb_path = tmp.path().join("test.duckdb").to_string_lossy().into();
    c.storage.archive_path = tmp.path().join("archive").to_string_lossy().into();
    // Fixed historical records exercise capture/search independently of wall-clock expiry.
    c.storage.content_retention_days = 3650;
    (tmp, c)
}
#[test]
fn global_machine_and_run_status_filters_use_related_runs_without_cross_machine_leaks() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let at = "2026-01-01T00:00:00Z";
    let scopes = [
        ("machine-east", "completed"),
        ("machine-west", "failed"),
        ("machine-active", "running"),
        ("machine-stopped", "cancelled"),
    ];
    for (machine, status) in scopes {
        for (kind, source, thread, run, data) in [
            ("project", "p", "", "", json!({"name":"Neutral project"})),
            ("thread", "t", "t", "", json!({"title":"Neutral thread"})),
            (
                "run",
                "r",
                "t",
                "r",
                json!({"status":status,"provider":"codex","model":"gpt-example"}),
            ),
            (
                "model_turn",
                "turn",
                "t",
                "r",
                json!({"status":"completed","provider":"codex","model":"gpt-example"}),
            ),
            (
                "tool",
                "tool",
                "t",
                "r",
                json!({"status":"completed","tool_name":"inspect","content_redacted":"neutral"}),
            ),
            ("agent", "agent", "t", "r", json!({"status":"completed"})),
        ] {
            s.put(
                machine, kind, source, "p", thread, run, at, at, "partial", "fixture", data,
            )
            .unwrap();
        }
    }
    // A containing run's status is independent of its completed tools/turns.
    // Reused source IDs must stay on the right machine for all four states.
    for (machine, status) in scopes {
        for instance in [None, Some(machine.to_string())] {
            let filter = Filter {
                instance,
                status: Some(status.into()),
                ..Default::default()
            };
            for route in [
                "projects",
                "threads",
                "tool-calls",
                "agents",
                "model-turns",
                "timeline",
                "search",
            ] {
                let result = analytics::query(&s, route, &filter).unwrap();
                let rows = result["data"].as_array().unwrap();
                assert!(!rows.is_empty(), "{status} {route}");
                assert!(
                    rows.iter().all(|row| row["instance_id"] == machine),
                    "{status} {route}"
                );
            }
        }
    }
    s.put(
        "machine-west",
        "instance",
        "machine-west",
        "",
        "",
        "",
        "1970-01-01T00:00:00Z",
        at,
        "partial",
        "fixture",
        json!({}),
    )
    .unwrap();
    let filter = Filter {
        instance: Some("machine-west".into()),
        status: Some("failed".into()),
        ..Default::default()
    };
    for route in [
        "projects",
        "threads",
        "tool-calls",
        "agents",
        "model-turns",
        "timeline",
        "search",
    ] {
        let result = analytics::query(&s, route, &filter).unwrap();
        let rows = result["data"].as_array().unwrap();
        assert!(!rows.is_empty(), "{route}");
        assert!(
            rows.iter().all(|r| r["instance_id"] == "machine-west"),
            "{route}"
        );
    }
    let none = Filter {
        instance: Some("machine-east".into()),
        ..filter.clone()
    };
    for route in [
        "overview",
        "threads",
        "tool-calls",
        "models",
        "usage/projects",
        "usage/machines",
        "data-quality",
    ] {
        assert!(
            analytics::query(&s, route, &none).unwrap()["data"]
                .as_array()
                .unwrap()
                .is_empty(),
            "{route}"
        );
    }
    let scoped = analytics::query(&s, "storage", &filter).unwrap();
    assert_eq!(
        scoped["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["rows"].as_u64().unwrap())
            .sum::<u64>(),
        7
    );
    assert_eq!(scoped["oldest_at"], at);
    let global_storage = analytics::query(&s, "storage", &Filter::default()).unwrap();
    assert_eq!(scoped["duckdb_bytes"], global_storage["duckdb_bytes"]);
    assert_eq!(scoped["events"], global_storage["events"]);
    assert_eq!(scoped["physical_scope"], "installation");
    assert!(scoped["scope_reason"].is_string());
    s.conn.execute_batch("INSERT INTO checkpoints VALUES('machine-east','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'); INSERT INTO quota_samples VALUES('neutral','five_hour','2026-01-01T00:00:00Z',80,'2026-01-01T05:00:00Z',300,NULL,'fixture')").unwrap();
    let quality = analytics::query(&s, "data-quality", &filter).unwrap();
    assert_eq!(quality["checkpoints"][0]["instance_id"], "machine-east");
    assert_eq!(quality["collection_scope"], "installation");
    assert!(quality["scope_reason"].is_string());
    for route in [
        "quota/current",
        "quota/live",
        "quota/windows",
        "quota/samples",
        "quota/notifications",
    ] {
        let result = analytics::query(&s, route, &filter).unwrap();
        let unfiltered = analytics::query(&s, route, &Filter::default()).unwrap();
        assert_eq!(
            result["data"], unfiltered["data"],
            "Global readings remain visible on {route}"
        );
        assert_eq!(result["scope"], "installation");
        assert!(result["scope_reason"].is_string());
    }
    assert!(
        analytics::query(
            &s,
            "overview",
            &Filter {
                status: Some("invalid".into()),
                ..Default::default()
            }
        )
        .is_err()
    );
    // The fallback harness match must not borrow another machine's same-named run.
    s.put(
        "machine-west",
        "run",
        "r",
        "p",
        "t",
        "r",
        at,
        at,
        "partial",
        "fixture",
        json!({"status":"failed","provider":"claudeAgent"}),
    )
    .unwrap();
    let codex = analytics::query(
        &s,
        "tool-calls",
        &Filter {
            harness: Some("codex".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut codex_machines: Vec<_> = codex["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["instance_id"].as_str().unwrap())
        .collect();
    codex_machines.sort_unstable();
    assert_eq!(
        codex_machines,
        ["machine-active", "machine-east", "machine-stopped"]
    );
    let before_cold = analytics::query(&s, "storage", &filter).unwrap();
    t3ui_core::cold::compact(&c, &s).unwrap();
    let after_cold = analytics::query(&s, "storage", &filter).unwrap();
    for key in [
        "rows",
        "redacted_content_characters",
        "normalized_json_characters",
        "oldest_at",
        "newest_at",
    ] {
        assert_eq!(
            after_cold[key], before_cold[key],
            "Logical scope remains equal after moving data: {key}"
        );
    }
    assert_eq!(
        after_cold["archive_bytes"],
        analytics::query(&s, "storage", &Filter::default()).unwrap()["archive_bytes"]
    );
}

#[test]
fn efficiency_uses_explicit_attempts_and_machine_scoped_run_links() {
    let (_tmp, c) = fixture();
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    let s = Store::open(&c).unwrap();
    let query = |instance: &str| {
        analytics::query(
            &s,
            "usage/efficiency",
            &Filter {
                instance: Some(instance.into()),
                ..Default::default()
            },
        )
        .unwrap()["data"][0]
            .clone()
    };
    importer::import(&c, &s, &Options::default()).unwrap();
    let unknown = query(&c.source.instance_id);
    assert!(unknown["retries_per_thread"].is_null());
    assert_eq!(unknown["covered_runs"], 0);
    source.execute_batch("CREATE TABLE orchestration_v2_projection_run_attempts(attempt_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,attempt_ordinal INTEGER,payload_json TEXT)").unwrap();
    let insert = |ordinal: i64, reason: &str| {
        let value = json!({"id":format!("attempt-{ordinal}"),"runId":"r","attemptOrdinal":ordinal,"reason":reason});
        source
            .execute(
                "INSERT INTO orchestration_v2_projection_run_attempts VALUES(?,'t','r',?,?)",
                rusqlite::params![format!("attempt-{ordinal}"), ordinal, value.to_string()],
            )
            .unwrap();
    };
    insert(1, "initial");
    importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(query(&c.source.instance_id)["retries_per_thread"], 0.0);
    insert(3, "recovery");
    importer::import(&c, &s, &Options::default()).unwrap();
    assert!(
        query(&c.source.instance_id)["retries_per_thread"].is_null(),
        "Missing ordinal 2 must not assert a complete rate"
    );
    insert(2, "steering_restart");
    importer::import(&c, &s, &Options::default()).unwrap();
    let at = "2026-01-01T00:00:00Z";
    let put = |instance: &str, kind: &str, source_id: &str, run: &str| {
        s.put(
            instance,
            kind,
            source_id,
            "p",
            "t",
            run,
            at,
            at,
            "partial",
            "fixture",
            json!({}),
        )
        .unwrap();
    };
    put(&c.source.instance_id, "model_turn", "turn-1", "r");
    put(&c.source.instance_id, "model_turn", "turn-2", "r");
    put(&c.source.instance_id, "tool", "tool-1", "r");
    put(&c.source.instance_id, "tool", "tool-2", "r");
    put(&c.source.instance_id, "tool", "tool-3", "r");
    put(&c.source.instance_id, "tool", "unlinked", "");
    put("other-machine", "tool", "collision", "r");
    let measured = query(&c.source.instance_id);
    assert_eq!(measured["retries_per_thread"], 2.0);
    assert_eq!(measured["steering_restarts"], 1);
    assert_eq!(measured["covered_threads"], 1);
    assert_eq!(measured["tools_per_turn"], 1.5);
    assert_eq!(measured["linked_tools"], 3);
    assert_eq!(measured["tools"], 4);
    assert!(query("other-machine")["tools_per_turn"].is_null());
    let all = analytics::query(&s, "usage/efficiency", &Filter::default()).unwrap();
    assert_eq!(
        all["data"][0]["linked_tools"], 3,
        "A same-named run on another machine is not a link"
    );
    t3ui_core::cold::compact(&c, &s).unwrap();
    assert_eq!(query(&c.source.instance_id), measured);
    assert_eq!(
        importer::import(&c, &s, &Options::default()).unwrap()["changed"],
        0
    );
}

#[test]
fn idempotent_and_nulls() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let first = s.stats().unwrap();
    let second = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(second["changed"], 0);
    assert_eq!(s.stats().unwrap(), first);
    let r = analytics::query(&s, "timeline", &Filter::default()).unwrap();
    assert!(!r.to_string().contains("super-secret"));
    assert!(r.to_string().contains("\"input_tokens\":null"));
}

#[test]
fn legacy_migration_clock_default_is_removed_and_rust_supplies_the_instant() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.conn.execute_batch("ALTER TABLE schema_migrations ALTER COLUMN applied_at TYPE TIMESTAMP; ALTER TABLE schema_migrations ALTER COLUMN applied_at SET DEFAULT TIMESTAMP '2000-01-01 00:00:00'; DELETE FROM schema_migrations WHERE version=8").unwrap();
    drop(s);
    let reopened = Store::open(&c).unwrap();
    let default:Option<String>=reopened.conn.query_row("SELECT column_default FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='applied_at'",[],|r|r.get(0)).unwrap();
    assert!(default.is_none());
    let instant: String = reopened
        .conn
        .query_row(
            "SELECT applied_at::VARCHAR FROM schema_migrations WHERE version=8",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(instant.starts_with(&t3ui_core::storage::now()[..10]));
}

#[test]
fn large_tool_outputs_commit_without_exhausting_the_import_budget() {
    let (_tmp, mut c) = fixture();
    c.storage.memory_limit_mb = 128;
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    source.execute_batch("CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,updated_at TEXT,type TEXT,status TEXT,payload_json TEXT)").unwrap();
    let date = "2026-01-01T00:00:00Z";
    let output = "x".repeat(1024 * 1024);
    for n in 0..64 {
        let source_id = format!("large-tool-{n}");
        let payload = json!({"id":source_id,"threadId":"t","runId":"r","type":"command_execution","status":"completed","startedAt":date,"completedAt":date,"output":output});
        source.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES(?,'t','r',?,'command_execution','completed',?)", rusqlite::params![source_id,date,payload.to_string()]).unwrap();
    }
    drop(source);
    let s = Store::open(&c).unwrap();
    let report = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(
        report["partial_sync"], false,
        "large rows must not silently leave a partial import: {report}"
    );
    assert_eq!(
        s.conn
            .query_row("SELECT count(*) FROM records WHERE kind='tool'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        64
    );
    let expected = json!({"arguments":null,"result":output,"diff":null,"file":null}).to_string();
    for n in 0..64 {
        let actual: String = s.conn.query_row("SELECT json_extract_string(data,'$.content_redacted') FROM records WHERE kind='tool' AND source_id=?", [format!("large-tool-{n}")], |r|r.get(0)).unwrap();
        assert_eq!(
            actual, expected,
            "content must survive the smaller transactions exactly"
        );
    }
    let again = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(again["partial_sync"], false);
    assert_eq!(
        again["changed"], 0,
        "byte-bounded commits must preserve revision skips"
    );
}
#[test]
fn offline_backfill_spills_large_batches_and_preserves_content_revisions_and_unrelated_hot_rows() {
    for date in [
        "2026-01-01T00:00:00Z".to_string(),
        t3ui_core::storage::now(),
    ] {
        let (_tmp, mut c) = fixture();
        c.storage.memory_limit_mb = 128;
        let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
        source.execute_batch("CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,updated_at TEXT,type TEXT,status TEXT,payload_json TEXT)").unwrap();
        let output = "x".repeat(1024 * 1024);
        for n in 0..16 {
            let source_id = format!("old-tool-{n}");
            let payload = json!({"id":source_id,"threadId":"t","runId":"r","type":"command_execution","status":"completed","startedAt":date,"completedAt":date,"output":output});
            source.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES(?,'t','r',?,'command_execution','completed',?)", rusqlite::params![source_id,date,payload.to_string()]).unwrap();
        }
        drop(source);
        let s = Store::open(&c).unwrap();
        s.conn.execute_batch("SET threads=1").unwrap();
        let recent = t3ui_core::storage::now();
        s.put(
            "local",
            "tool",
            "unrelated-hot",
            "other-project",
            "other-thread",
            "other-run",
            &recent,
            &recent,
            "partial",
            "fixture",
            json!({"content_redacted":"Unrelated recent content"}),
        )
        .unwrap();
        let options = Options {
            archive_batches: true,
            ..Default::default()
        };
        let report = importer::import(&c, &s, &options).unwrap();
        assert_eq!(
            report["partial_sync"], false,
            "backfill must complete: {report}"
        );
        let hot: i64 = s
            .conn
            .query_row(
                "SELECT count(*) FROM records WHERE kind='tool' AND project_id='p'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            hot < 16,
            "large committed outputs must spill before a first backfill ends"
        );
        let unrelated: i64 = s
            .conn
            .query_row(
                "SELECT count(*) FROM records WHERE source_id='unrelated-hot'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            unrelated, 1,
            "batch spill must not archive unrelated recent records"
        );
        // Offline import and serving have separate budgets in the CLI and qualifier.
        // This test checks content correctness, not API support at the backfill budget.
        s.conn
            .execute_batch("SET memory_limit='2048MB'; SET threads=4")
            .unwrap();
        let read_tools = || {
            analytics::query(
                &s,
                "tool-calls",
                &Filter {
                    project: Some("p".into()),
                    include_content: Some(true),
                    limit: Some(500),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let tools = read_tools();
        let rows = tools["data"].as_array().unwrap();
        assert_eq!(rows.len(), 16);
        let expected =
            json!({"arguments":null,"result":output,"diff":null,"file":null}).to_string();
        for row in rows {
            assert!(
                row["data"]["content_redacted"].as_str() == Some(expected.as_str()),
                "full content must survive intermediate eviction exactly"
            );
        }
        t3ui_core::cold::verify(&s).unwrap();
        s.conn
            .execute_batch("SET memory_limit='128MB'; SET threads=1")
            .unwrap();
        let again = importer::import(&c, &s, &options).unwrap();
        assert_eq!(again["partial_sync"], false);
        assert_eq!(
            again["changed"], 0,
            "cold identity/revision skips must survive batch eviction"
        );
        s.conn
            .execute_batch("SET memory_limit='2048MB'; SET threads=4")
            .unwrap();
        assert!(
            read_tools() == tools,
            "an unchanged import must preserve every cold API value"
        );
    }
}

#[test]
fn cold_queries_remain_flat_across_many_registered_files() {
    let (tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    for n in 0..2 {
        s.put(
            "local",
            "tool",
            &format!("many-files-{n}"),
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "fixture",
            json!({"content_redacted":format!("Neutral output {n}")}),
        )
        .unwrap();
    }
    let filter = Filter {
        include_content: Some(true),
        ..Default::default()
    };
    let before = analytics::query(&s, "tool-calls", &filter).unwrap();
    t3ui_core::cold::compact(&c, &s).unwrap();
    let (base, rows, digest): (String, i64, String) = s
        .conn
        .query_row(
            "SELECT path,row_count,sha256 FROM cold_segments WHERE table_name='records' LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    let second = tmp.path().join("second-base.parquet");
    std::fs::copy(&base, &second).unwrap();
    let mut generation = s
        .conn
        .query_row("SELECT max(generation) FROM cold_segments", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    for i in 0..1200 {
        // Keep each physical file below Windows' 1024-hard-link limit.
        let path = tmp.path().join(format!("segment-{i}.parquet"));
        std::fs::hard_link(
            if i < 600 {
                std::path::Path::new(&base)
            } else {
                &second
            },
            &path,
        )
        .unwrap();
        generation += 1;
        s.conn
            .execute(
                "INSERT INTO cold_segments VALUES(?,'records',?,?,?,?)",
                duckdb::params![
                    generation,
                    path.to_string_lossy().replace('\\', "/"),
                    rows,
                    digest,
                    t3ui_core::storage::now()
                ],
            )
            .unwrap();
    }
    s.conn
        .execute("UPDATE cold_record_keys SET generation=?", [generation])
        .unwrap();
    let after = analytics::query(&s, "tool-calls", &filter)
        .expect("a large committed manifest must remain queryable");
    assert!(
        after == before,
        "manifest fan-out must preserve every API value"
    );
}

#[test]
fn large_full_tool_pages_survive_hot_and_cold_reads() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let output = "x".repeat(1024 * 1024);
    for n in 0..64 {
        s.put(
            "local",
            "tool",
            &format!("large-{n}"),
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "fixture",
            json!({"content_redacted":output,"content_ciphertext":"excluded"}),
        )
        .unwrap();
    }
    let filter = Filter {
        limit: Some(64),
        include_content: Some(true),
        ..Default::default()
    };
    for stage in ["hot", "cold"] {
        if stage == "cold" {
            t3ui_core::cold::compact(&c, &s).unwrap();
        }
        let result = analytics::query(&s, "tool-calls", &filter)
            .unwrap_or_else(|e| panic!("{stage} full page failed: {e}"));
        let rows = result["data"].as_array().unwrap();
        assert_eq!(rows.len(), 64);
        assert!(rows.iter().all(|r| r["data"]["content_redacted"].as_str()
            == Some(output.as_str())
            && r["data"].get("content_ciphertext").is_none()));
    }
}
#[test]
fn quota_gap_reasons_survive_eviction_and_do_not_guess_sleep() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.conn.execute_batch("INSERT INTO quota_samples VALUES('synthetic','five_hour','2026-01-01T02:00:00Z',10,'2026-01-01T07:00:00Z',300,NULL,'fixture'),('synthetic','five_hour','2026-01-01T02:10:00Z',20,'2026-01-01T07:00:00Z',300,NULL,'fixture'),('synthetic','five_hour','2026-01-01T06:40:00Z',40,'2026-01-01T07:00:00Z',300,NULL,'fixture'),('synthetic','five_hour','2026-01-01T06:50:00Z',50,'2026-01-01T07:00:00Z',300,NULL,'fixture')").unwrap();
    let unknown = analytics::query(&s, "quota/windows", &Default::default()).unwrap();
    assert_eq!(unknown["data"][0]["capture_quality"], "partial");
    assert_eq!(
        unknown["data"][0]["coverage_reasons"],
        json!(["missing_readings"])
    );
    let gaps = unknown["data"][0]["gaps"].as_array().unwrap();
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0]["causes"], json!([]));
    let start = t3ui_core::storage::parse_time("2026-01-01T02:10:00Z")
        .unwrap()
        .timestamp_millis();
    let end = t3ui_core::storage::parse_time("2026-01-01T06:40:00Z")
        .unwrap()
        .timestamp_millis();
    s.set("quota:power",&json!({"state":"ready","intervals":[{"sleep_epoch_ms":start,"wake_epoch_ms":end,"source":"windows_power_event"}]}).to_string()).unwrap();
    let explained = analytics::query(&s, "quota/windows", &Default::default()).unwrap();
    assert_eq!(
        explained["data"][0]["gaps"][0]["causes"],
        json!([{"reason":"observer_asleep","start_epoch_ms":start,"end_epoch_ms":end,"source":"windows_power_event"}])
    );
    t3ui_core::cold::compact(&c, &s).unwrap();
    assert_eq!(
        analytics::query(&s, "quota/windows", &Default::default()).unwrap(),
        explained
    );
}
#[test]
fn hierarchy() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let r = analytics::query(&s, "threads", &Filter::default()).unwrap();
    let rows = r["data"].as_array().unwrap();
    assert!(
        rows.iter()
            .any(|r| r["source_id"] == "t" && r["data"]["thread_type"] == "primary")
    );
    assert!(rows.iter().any(|r| r["source_id"] == "nested"
        && r["data"]["depth"] == 2
        && r["data"]["root_thread_id"] == "t"));
}

#[test]
fn cold_eviction_preserves_all_api_values_and_source_revision_skips() {
    let (_tmp, mut c) = fixture();
    c.storage.content_retention_days = 3650;
    c.storage.archive_path = std::path::Path::new(&c.storage.archive_path)
        .with_file_name("archive's")
        .to_string_lossy()
        .into();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let recent = t3ui_core::storage::now();
    s.put(
        "local",
        "tool",
        "recent",
        "p",
        "t",
        "r",
        &recent,
        &recent,
        "partial",
        "fixture",
        json!({"content_redacted":"Synthetic recent output","duration_ms":42}),
    )
    .unwrap();
    s.conn.execute_batch("INSERT INTO quota_samples VALUES('synthetic','daily','2026-01-01T00:00:00Z',40,'2026-01-02T00:00:00Z',1440,NULL,'fixture'); INSERT INTO quota_events VALUES('synthetic','limit_reached','2026-01-01T00:00:00Z','daily','2026-01-02T00:00:00Z','fixture')").unwrap();
    let routes = [
        "overview",
        "threads",
        "projects",
        "agents",
        "tool-calls",
        "model-turns",
        "timeline",
        "models",
        "usage/projects",
        "usage/machines",
        "usage/tools",
        "data-quality/fields",
        "quota/current",
        "quota/windows",
        "quota/samples",
        "quota/resets",
    ];
    let filter = Filter {
        include_content: Some(true),
        ..Default::default()
    };
    let before: Vec<_> = routes
        .iter()
        .map(|route| analytics::query(&s, route, &filter).unwrap())
        .collect();
    let moved = t3ui_core::cold::compact(&c, &s).unwrap();
    assert!(moved["moved_rows"].as_i64().unwrap() > 0);
    assert!(moved["restore_verified"].as_bool().unwrap());
    assert_eq!(
        s.conn
            .query_row(
                "SELECT count(*) FROM main.records WHERE runtrace_time_us(occurred_at)<?",
                [(t3ui_core::storage::clock() - chrono::Duration::days(30)).timestamp_micros()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    for (route, expected) in routes.iter().zip(before) {
        assert_eq!(
            analytics::query(&s, route, &filter).unwrap(),
            expected,
            "hot/cold mismatch on {route}"
        );
    }
    assert!(s.stats().unwrap()["archive_bytes"].as_u64().unwrap() > 0);
    t3ui_core::cold::verify(&s).unwrap();
    assert_eq!(t3ui_core::cold::compact(&c, &s).unwrap()["moved_rows"], 0);
    assert_eq!(
        importer::import(&c, &s, &Options::default()).unwrap()["changed"],
        0,
        "archiving must not trigger historical reimports"
    );
    let snapshot = t3ui_core::archive::run(&c, &s, "run").unwrap();
    let mut restored_config = c.clone();
    restored_config.storage.duckdb_path = std::path::Path::new(&c.storage.duckdb_path)
        .with_file_name("restored.duckdb")
        .to_string_lossy()
        .into();
    let restored = Store::open(&restored_config).unwrap();
    t3ui_core::archive::restore(
        &restored,
        std::path::Path::new(snapshot["path"].as_str().unwrap()),
    )
    .unwrap();
    for route in routes {
        assert_eq!(
            analytics::query(&restored, route, &filter).unwrap(),
            analytics::query(&s, route, &filter).unwrap(),
            "post-eviction restore mismatch on {route}"
        );
    }
    let recent = t3ui_core::storage::now();
    assert!(
        s.put(
            "local",
            "tool",
            "after-snapshot",
            "p",
            "t",
            "r",
            &recent,
            &recent,
            "partial",
            "fixture",
            json!({"status":"completed"})
        )
        .unwrap(),
        "snapshot temporary views must not shadow later writes"
    );
}

#[test]
fn cold_versions_keep_fresh_metadata_reader_snapshots_and_purges() {
    let (_tmp, mut c) = fixture();
    c.storage.content_retention_days = 3650;
    let s = Store::open(&c).unwrap();
    let old = (t3ui_core::storage::clock() - chrono::Duration::days(40)).to_rfc3339();
    let first = json!({"content_redacted":"Synthetic first output","duration_ms":1});
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
        "v1",
        first.clone(),
    )
    .unwrap();
    let reader = s.try_clone().unwrap();
    let snapshot = t3ui_core::cold::read_snapshot(&reader).unwrap();
    assert_eq!(
        reader
            .conn
            .query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        t3ui_core::cold::maintain_due(&c, &s).unwrap()["state"],
        "synced"
    );
    assert_eq!(
        reader
            .conn
            .query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1,
        "an old reader keeps the hot rows across publication"
    );
    drop(snapshot);
    let updated = t3ui_core::storage::now();
    assert!(
        !s.put(
            "local", "tool", "a", "p", "t", "r", &old, &updated, "partial", "v2", first
        )
        .unwrap()
    );
    let f = Filter {
        include_content: Some(true),
        ..Default::default()
    };
    let read = analytics::query(&s, "tool-calls", &f).unwrap();
    assert_eq!(read["data"][0]["source_updated_at"], updated);
    assert_eq!(read["data"][0]["source_version"], "v2");
    let reader_snapshot = t3ui_core::cold::read_snapshot(&reader).unwrap();
    assert!(
        s.put(
            "local",
            "tool",
            "a",
            "p",
            "t",
            "r",
            &old,
            &updated,
            "partial",
            "v3",
            json!({"content_redacted":"Synthetic second output","duration_ms":2})
        )
        .unwrap()
    );
    t3ui_core::cold::compact(&c, &s).unwrap();
    assert_eq!(
        reader
            .conn
            .query_row(
                "SELECT json_extract_string(data,'$.content_redacted') FROM records",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "Synthetic first output"
    );
    drop(reader_snapshot);
    let read = analytics::query(&s, "tool-calls", &f).unwrap();
    assert_eq!(read["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        read["data"][0]["data"]["content_redacted"],
        "Synthetic second output"
    );
    s.purge("thread", "t").unwrap();
    assert!(
        analytics::query(&s, "tool-calls", &f).unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(s.stats().unwrap()["events"], 0);
    drop(reader);
    drop(s);
    let reopened = Store::open(&c).unwrap();
    assert!(
        analytics::query(&reopened, "tool-calls", &f).unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn cold_expiry_clears_text_ciphertext_preview_and_search() {
    let (_tmp, mut c) = fixture();
    let old = (t3ui_core::storage::clock() - chrono::Duration::days(40)).to_rfc3339();
    let s = Store::open(&c).unwrap();
    s.put("local","tool","a","p","t","r",&old,&old,"partial","fixture",json!({"content_redacted":"Synthetic expiring output","content_ciphertext":"synthetic ciphertext"})).unwrap();
    drop(s);
    c.storage.content_retention_days = 1;
    let s = Store::open(&c).unwrap();
    t3ui_core::cold::compact(&c, &s).unwrap();
    let f = Filter {
        include_content: Some(true),
        ..Default::default()
    };
    let row = analytics::query(&s, "tool-calls", &f).unwrap();
    assert!(row["data"][0]["data"]["content_redacted"].is_null());
    assert!(row["data"][0]["data"]["content_ciphertext"].is_null());
    assert!(
        analytics::query(
            &s,
            "search",
            &Filter {
                q: Some("expiring".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let preview = analytics::query(&s, "tool-calls", &Filter::default()).unwrap();
    assert!(preview["data"][0]["data"]["content_redacted"].is_null());
    let path: String = s
        .conn
        .query_row(
            "SELECT path FROM cold_segments WHERE table_name='records'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let stored: Option<String> = s
        .conn
        .query_row(
            &format!(
                "SELECT json_extract_string(data,'$.content_redacted') FROM read_parquet('{}')",
                path.replace('\'', "''")
            ),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        stored.is_none(),
        "already expired text must not enter a new cold segment"
    );
    s.put("local","tool","b","p","t","r",&old,&old,"partial","fixture",json!({"content_redacted":"Synthetic expired correction","content_ciphertext":"synthetic ciphertext"})).unwrap();
    assert!(
        !analytics::query(&s, "tool-calls", &f)
            .unwrap()
            .to_string()
            .contains("expired correction")
    );
}

#[test]
fn time_filters_and_purge_use_instants_with_microsecond_precision() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    for (source, date) in [
        ("utc", "2026-01-01T00:00:00Z"),
        ("offset", "2026-01-01T01:00:00+01:00"),
        ("micro", "2026-01-01T00:00:00.000001Z"),
        ("negative", "1969-12-31T23:59:59.999999Z"),
    ] {
        s.put(
            "local",
            "tool",
            source,
            "p",
            "t",
            "r",
            date,
            date,
            "partial",
            "fixture",
            json!({"status":"completed"}),
        )
        .unwrap();
    }
    let boundary = "2026-01-01T00:00:00.000001Z";
    let result = analytics::query(
        &s,
        "tool-calls",
        &Filter {
            since: Some(boundary.into()),
            until: Some(boundary.into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result["data"].as_array().unwrap().len(), 1);
    assert_eq!(result["data"][0]["source_id"], "micro");
    s.purge("before", boundary).unwrap();
    assert_eq!(
        s.conn
            .query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(s);
    let reopened = Store::open(&c).unwrap();
    let result = analytics::query(&reopened, "tool-calls", &Filter::default()).unwrap();
    assert_eq!(result["data"].as_array().unwrap().len(), 1);
    assert_eq!(result["data"][0]["source_id"], "micro");
}
#[test]
fn purge_and_reimport() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    s.purge("thread", "t").unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let r = analytics::query(
        &s,
        "timeline",
        &Filter {
            id: Some("t".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r["data"].as_array().unwrap().len(), 0);
}
#[test]
fn failed_source_preserves_checkpoint() {
    let (_tmp, mut c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let before = s
        .conn
        .query_row("select source_updated_at from checkpoints", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    c.source.sqlite_path = "no-such-file.sqlite".into();
    assert!(importer::import(&c, &s, &Options::default()).is_err());
    assert_eq!(
        s.conn
            .query_row("select source_updated_at from checkpoints", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        before
    );
}
#[test]
fn dry_run() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(
        &c,
        &s,
        &Options {
            dry_run: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(s.stats().unwrap()["events"], 0);
}
#[test]
fn archive_roundtrip() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let result = t3ui_core::archive::run(&c, &s, "run").unwrap();
    assert!(result["rows"].as_i64().unwrap() > 0);
    assert_eq!(
        t3ui_core::archive::run(&c, &s, "verify").unwrap()["verified"],
        1
    );
    let mut destination = c.clone();
    destination.storage.duckdb_path = format!("{}.restored", c.storage.duckdb_path);
    let restored = Store::open(&destination).unwrap();
    t3ui_core::archive::restore(
        &restored,
        std::path::Path::new(result["path"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(
        analytics::query(&s, "timeline", &Filter::default()).unwrap(),
        analytics::query(&restored, "timeline", &Filter::default()).unwrap()
    );
    let search = Filter {
        q: Some("Synthetic".into()),
        ..Default::default()
    };
    assert_eq!(
        analytics::query(&s, "search", &search).unwrap(),
        analytics::query(&restored, "search", &search).unwrap()
    );
    assert!(
        t3ui_core::archive::restore(
            &restored,
            std::path::Path::new(result["path"].as_str().unwrap())
        )
        .is_err()
    );
}
#[test]
fn encrypted_redacted_api() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let mut encrypted =
        serde_json::to_value(privacy::protect("hidden", "full_encrypted", Some(&[1; 32])).unwrap())
            .unwrap();
    encrypted["repository_path_encrypted"] = json!("synthetic-protected-path");
    s.put(
        "local",
        "prompt",
        "encrypted",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "synthetic",
        encrypted,
    )
    .unwrap();
    let r = analytics::query(&s, "search", &Filter::default()).unwrap();
    assert!(r["data"][0]["data"].get("content_ciphertext").is_none());
    assert!(
        r["data"][0]["data"]
            .get("repository_path_encrypted")
            .is_none()
    );
    let full = analytics::query(&s, "timeline", &Filter::default()).unwrap();
    assert!(full["data"][0]["data"].get("content_ciphertext").is_none());
    assert!(
        full["data"][0]["data"]
            .get("repository_path_encrypted")
            .is_none()
    );
    assert_ne!(id("local", "thread", "1"), id("remote", "thread", "1"));
}
#[test]
fn filters_reject_unknown() {
    assert!(serde_json::from_value::<Filter>(json!({"scope":"analytics:content-full"})).is_err());
    // Full content stays in small pages. Previews may come in big ones, up to a bound.
    let page = |limit: u32, include_content: Option<bool>| {
        Filter {
            limit: Some(limit),
            include_content,
            ..Default::default()
        }
        .validate()
    };
    assert!(page(501, Some(true)).is_err());
    assert!(page(501, None).is_ok());
    assert!(page(20_000, Some(false)).is_ok());
    assert!(page(20_001, None).is_err());
    assert!(page(0, None).is_err());
}

#[test]
fn token_semantics_preserve_null_and_avoid_double_counting() {
    let usage = json!({"usageScope":"main_agent","usageStatus":"complete","inputTokens":100,"cachedInputTokens":60,"cacheCreationTokens":10,"outputTokens":20,"reasoningTokens":8});
    let result = importer::token_fields(&usage);
    assert_eq!(result["total_tokens"], 120);
    assert_eq!(result["reasoning_tokens"], 8);
    let partial = importer::token_fields(
        &json!({"usageScope":"main_agent","usageStatus":"partial","inputTokens":100}),
    );
    assert!(partial["output_tokens"].is_null());
    assert!(partial["total_tokens"].is_null());
    assert!(importer::token_fields(&json!({"usageScope":"main_agent","usageStatus":"partial","inputTokens":100,"outputTokens":20}))["total_tokens"].is_null());
    let unknown = importer::token_fields(&json!({"usedTokens":1000}));
    assert!(unknown["input_tokens"].is_null());
}

#[test]
fn terminal_change_with_unchanged_message_timestamp_is_imported() {
    let (_tmp, c) = fixture();
    let db = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    db.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.status','running')",[]).unwrap();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(
        analytics::query(
            &s,
            "search",
            &Filter {
                q: Some("Synthetic answer".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    db.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.status','completed')",[]).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(
        analytics::query(
            &s,
            "search",
            &Filter {
                q: Some("Synthetic answer".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn reader_connection_remains_available_during_import_transaction() {
    let (_tmp, c) = fixture();
    let writer = Store::open(&c).unwrap();
    let reader = writer.try_clone().unwrap();
    writer.conn.execute_batch("BEGIN").unwrap();
    writer.set("isolated", "pending").unwrap();
    assert_eq!(reader.setting("isolated"), None);
    writer.conn.execute_batch("COMMIT").unwrap();
    assert_eq!(reader.setting("isolated").as_deref(), Some("pending"));
}

#[test]
fn emergency_pause_is_independent_of_database_writer_lock() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    std::fs::write(importer::pause_path(&c), "paused").unwrap();
    assert_eq!(
        importer::import(&c, &s, &Options::default()).unwrap()["paused"],
        true
    );
    assert_eq!(s.stats().unwrap()["events"], 0);
    std::fs::remove_file(importer::pause_path(&c)).unwrap();
    assert!(
        importer::import(&c, &s, &Options::default()).unwrap()["changed"]
            .as_i64()
            .unwrap()
            > 0
    );
}

#[test]
fn list_preview_preserves_full_detail_retrieval() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let original = "Long synthetic answer. ".repeat(100);
    s.put(
        "local",
        "answer",
        "long",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "synthetic",
        json!({"content_redacted":original}),
    )
    .unwrap();
    let list = analytics::query(&s, "search", &Filter::default()).unwrap();
    assert_eq!(list["data"][0]["data"]["content_truncated"], true);
    let detail = analytics::query(
        &s,
        "timeline",
        &Filter {
            id: Some("t".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(detail["data"][0]["data"]["content_redacted"], original);
}

#[test]
fn encryption_policy_transition_updates_ciphertext_without_nonce_churn() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let put = |data| {
        s.put(
            "local",
            "answer",
            "policy-change",
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "synthetic",
            data,
        )
        .unwrap()
    };
    assert!(put(serde_json::to_value(
        privacy::protect("protected content", "redacted_only", None).unwrap()
    )
    .unwrap()));
    assert!(put(serde_json::to_value(
        privacy::protect("protected content", "full_encrypted", Some(&[1; 32])).unwrap()
    )
    .unwrap()));
    assert!(!put(serde_json::to_value(
        privacy::protect("protected content", "full_encrypted", Some(&[1; 32])).unwrap()
    )
    .unwrap()));
    assert!(put(serde_json::to_value(
        privacy::protect("protected content", "redacted_only", None).unwrap()
    )
    .unwrap()));
    let cipher:Option<String>=s.conn.query_row("SELECT json_extract_string(data,'$.content_ciphertext') FROM records WHERE source_id='policy-change'",[],|r|r.get(0)).unwrap();
    assert!(cipher.is_none());
}

#[test]
fn repair_bypasses_source_revision_cache() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    s.conn
        .execute("DELETE FROM records WHERE kind='answer'", [])
        .unwrap();
    importer::import(
        &c,
        &s,
        &Options {
            since: Some(String::new()),
            ..Default::default()
        },
    )
    .unwrap();
    let count: i64 = s
        .conn
        .query_row(
            "SELECT count(*) FROM records WHERE kind='answer'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn disabled_project_blocks_all_entity_kinds() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.set("privacy:p", "disabled").unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let count: i64 = s
        .conn
        .query_row(
            "SELECT count(*) FROM records WHERE kind<>'instance'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn legacy_pause_migrates_to_file_and_can_resume() {
    let (_tmp, c) = fixture();
    {
        let s = Store::open(&c).unwrap();
        s.set("paused", "true").unwrap();
    }
    let s = Store::open(&c).unwrap();
    assert!(importer::pause_path(&c).exists());
    assert!(s.setting("paused").is_none());
    std::fs::remove_file(importer::pause_path(&c)).unwrap();
    assert!(
        importer::import(&c, &s, &Options::default()).unwrap()["changed"]
            .as_i64()
            .unwrap()
            > 0
    );
}

#[test]
fn archive_late_failure_releases_database_transaction() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    s.conn.execute_batch("DROP TABLE snapshot_exports").unwrap();
    assert!(t3ui_core::archive::run(&c, &s, "run").is_err());
    s.conn.execute_batch("BEGIN;ROLLBACK").unwrap();
}

#[test]
fn date_filters_compare_instants_not_rfc3339_spelling() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put(
        "local",
        "prompt",
        "boundary",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "synthetic",
        json!({"content_redacted":"boundary"}),
    )
    .unwrap();
    for since in ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00+01:00"] {
        let result = analytics::query(
            &s,
            "search",
            &Filter {
                since: Some(since.into()),
                until: Some("2026-01-01T00:00:00Z".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result["data"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn disabled_empty_project_is_not_discovered() {
    let (_tmp, c) = fixture();
    let db = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    db.execute("INSERT INTO projection_projects VALUES ('empty','Empty','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL)",[]).unwrap();
    let s = Store::open(&c).unwrap();
    s.set("privacy:empty", "disabled").unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let n: i64 = s
        .conn
        .query_row(
            "SELECT count(*) FROM records WHERE project_id='empty'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn committed_batches_resume_after_late_source_failure_without_duplicates() {
    let (_tmp, c) = fixture();
    let db = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    db.execute_batch("BEGIN").unwrap();
    for i in 0..1002 {
        let mid = format!("batch-{i:04}");
        let date = "2026-01-01T00:00:00Z";
        let v = json!({"id":mid,"threadId":"t","runId":"r","role":"assistant","text":"Synthetic bounded batch","createdAt":date,"updatedAt":date,"streaming":false});
        db.execute(
            "INSERT INTO orchestration_v2_projection_messages VALUES(?,?,?,?,?,?)",
            [
                v.to_string(),
                date.into(),
                mid,
                "t".into(),
                "r".into(),
                date.into(),
            ],
        )
        .unwrap();
    }
    db.execute("UPDATE orchestration_v2_projection_messages SET payload_json='invalid-json' WHERE message_id='batch-1001'",[]).unwrap();
    db.execute_batch("COMMIT").unwrap();
    let s = Store::open(&c).unwrap();
    let failed = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(failed["partial_sync"], true);
    assert_eq!(failed["project_errors"].as_array().unwrap().len(), 1);
    let committed: i64 = s
        .conn
        .query_row("SELECT count(*) FROM records", [], |r| r.get(0))
        .unwrap();
    assert!(committed >= 1000);
    let checkpoints: i64 = s
        .conn
        .query_row("SELECT count(*) FROM checkpoints", [], |r| r.get(0))
        .unwrap();
    assert_eq!(checkpoints, 0);
    let v = json!({"id":"batch-1001","threadId":"t","runId":"r","role":"assistant","text":"Synthetic bounded batch","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","streaming":false});
    db.execute("UPDATE orchestration_v2_projection_messages SET payload_json=? WHERE message_id='batch-1001'",[v.to_string()]).unwrap();
    importer::import(
        &c,
        &s,
        &Options {
            since: Some(String::new()),
            ..Default::default()
        },
    )
    .unwrap();
    let events: i64 = s
        .conn
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    let records: i64 = s
        .conn
        .query_row("SELECT count(*) FROM records", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, records);
    assert_eq!(
        importer::import(&c, &s, &Options::default()).unwrap()["changed"],
        0
    );
}

#[test]
fn old_snapshot_restore_respects_current_purge_ledger() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let snapshot = t3ui_core::archive::run(&c, &s, "run").unwrap();
    s.purge("thread", "t").unwrap();
    let mut target = c.clone();
    target.storage.purge_ledger_path = Some(
        std::path::Path::new(&c.storage.duckdb_path)
            .parent()
            .unwrap()
            .join("purges.jsonl")
            .to_string_lossy()
            .into(),
    );
    target.storage.duckdb_path = format!(
        "{}/different-directory/old-restore.duckdb",
        std::path::Path::new(&c.storage.duckdb_path)
            .parent()
            .unwrap()
            .display()
    );
    let restored = Store::open(&target).unwrap();
    t3ui_core::archive::restore(
        &restored,
        std::path::Path::new(snapshot["path"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(
        analytics::query(
            &restored,
            "timeline",
            &Filter {
                id: Some("t".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn structured_tool_redaction_preserves_json_and_removes_secrets() {
    let value = json!({"arguments":{"path":"C:\\Users\\Someone\\folder with spaces\\file.json","command":"TOKEN=super-secret"},"result":{"quote":"a \\\"quoted\\\" path C:\\private\\file","n":17},"items":["Bearer abcdefghijklmnop",null,true]});
    let protected = privacy::protect_json(&value, "full_encrypted", Some(&[1; 32])).unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(protected.content_redacted.as_deref().unwrap()).unwrap();
    assert_eq!(parsed["result"]["n"], 17);
    assert_eq!(parsed["items"][1], serde_json::Value::Null);
    assert!(!parsed.to_string().contains("super-secret"));
    let credentials=privacy::protect_json(&json!({"password":"short-private","headers":{"Authorization":"Basic abc123"},"input_tokens":12}),"redacted_only",None).unwrap();
    let credentials: serde_json::Value =
        serde_json::from_str(credentials.content_redacted.as_deref().unwrap()).unwrap();
    assert!(!credentials.to_string().contains("short-private"));
    assert!(!credentials.to_string().contains("abc123"));
    assert_eq!(credentials["input_tokens"], 12);
    let scalar_secrets = privacy::protect_json(&json!({"password":123456,"credentials":{"pin":654321},"api_key":[123,"short"],"token":false,"secret":null,"input_tokens":77}),"redacted_only",None).unwrap();
    let parsed_secrets: serde_json::Value =
        serde_json::from_str(scalar_secrets.content_redacted.as_deref().unwrap()).unwrap();
    for field in ["password", "credentials", "api_key", "token"] {
        assert_eq!(parsed_secrets[field], "[REDACTED:secret_json_field]");
    }
    assert!(parsed_secrets["secret"].is_null());
    assert_eq!(parsed_secrets["input_tokens"], 77);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &privacy::decrypt(protected.content_ciphertext.as_deref().unwrap(), &[1; 32]).unwrap()
        )
        .unwrap(),
        value
    );
}

#[test]
fn source_attribution_changes_are_not_ignored_by_content_hash() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let data = json!({"content_redacted":"same content"});
    s.put(
        "local",
        "answer",
        "moved",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "synthetic",
        data.clone(),
    )
    .unwrap();
    assert!(
        s.put(
            "local",
            "answer",
            "moved",
            "other-project",
            "other-thread",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "synthetic",
            data
        )
        .unwrap()
    );
    let project: String = s
        .conn
        .query_row(
            "SELECT project_id FROM records WHERE source_id='moved'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(project, "other-project");
}

#[test]
fn additive_fact_migration_preserves_old_captured_json() {
    let (_tmp, c) = fixture();
    {
        let old = duckdb::Connection::open(&c.storage.duckdb_path).unwrap();
        old.execute_batch(include_str!("../../../migrations/001_initial.sql"))
            .unwrap();
        old.execute("INSERT INTO records VALUES ('old','model_turn','local','source','p','t','r','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','partial','synthetic','old','2026-01-01T00:00:00Z','hash',?)",[json!({"requested_model":"kept-model","usage_status":"complete","input_tokens":100,"output_tokens":20,"total_tokens":120,"content_redacted":"preserve me"}).to_string()]).unwrap();
    }
    let migrated = Store::open(&c).unwrap();
    let model = analytics::query(&migrated, "models", &Filter::default()).unwrap();
    assert_eq!(model["data"][0]["input_tokens"], 100);
    assert_eq!(model["data"][0]["total_tokens"], 120);
    let raw: String = migrated
        .conn
        .query_row(
            "SELECT json_extract_string(data,'$.content_redacted') FROM records WHERE id='old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(raw, "preserve me");
    let search = analytics::query(
        &migrated,
        "search",
        &Filter {
            q: Some("preserve".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(search["data"].as_array().unwrap().len(), 1);
}

#[test]
fn bounded_original_verification_detects_content_change_and_missing_ids() {
    let (tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let prior = tmp.path().join("prior.duckdb");
    s.conn
        .execute_batch(&format!(
            "ATTACH '{}' AS prior; CREATE TABLE prior.records AS SELECT * FROM records",
            prior.to_string_lossy().replace('\'', "''")
        ))
        .unwrap();
    assert_eq!(
        t3ui_core::storage::verify_original_records(&s.conn, "prior.records").unwrap(),
        0
    );
    s.conn
        .execute(
            "UPDATE prior.records SET data='{\"changed\":true}' WHERE kind='prompt'",
            [],
        )
        .unwrap();
    assert!(t3ui_core::storage::verify_original_records(&s.conn, "prior.records").unwrap() > 0);
    s.conn
        .execute("DELETE FROM prior.records WHERE kind='answer'", [])
        .unwrap();
    assert!(t3ui_core::storage::verify_original_records(&s.conn, "prior.records").unwrap() > 0);
}

#[test]
fn one_failed_project_does_not_block_other_project_discovery() {
    let (_tmp, c) = fixture();
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    source.execute("UPDATE orchestration_v2_projection_messages SET payload_json='broken' WHERE message_id='a'",[]).unwrap();
    source.execute("INSERT INTO projection_projects VALUES ('healthy','Healthy','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL)",[]).unwrap();
    let s = Store::open(&c).unwrap();
    let report = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(report["partial_sync"], true);
    assert_eq!(report["projects_synced"], 1);
    assert_eq!(
        report["project_errors"][0]["error_category"],
        "source_json_invalid"
    );
    let healthy: i64 = s
        .conn
        .query_row(
            "SELECT count(*) FROM records WHERE source_id='healthy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(healthy, 1);
    let checkpoints: i64 = s
        .conn
        .query_row("SELECT count(*) FROM checkpoints", [], |r| r.get(0))
        .unwrap();
    assert_eq!(checkpoints, 0);
}

#[test]
fn project_watermark_does_not_inherit_global_or_other_project_freshness() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.conn.execute("INSERT INTO checkpoints VALUES ('local','2099-01-01T00:00:00Z','2099-01-01T00:00:00Z')", []).unwrap();
    let report = importer::import(&c, &s, &Options::default()).unwrap();
    assert!(report["checkpoint"].as_str().unwrap() < "2099");
    let again = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(again["changed"], 0);
    assert_eq!(again["checkpoint"], report["checkpoint"]);
}

#[test]
fn malformed_foreign_thread_does_not_block_healthy_project() {
    let (_tmp, c) = fixture();
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    source.execute("INSERT INTO projection_projects VALUES ('broken','Broken','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL)",[]).unwrap();
    source.execute("INSERT INTO orchestration_v2_projection_threads VALUES ('invalid-json','2026-01-01T00:00:00Z','broken')",[]).unwrap();
    let s = Store::open(&c).unwrap();
    let report = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(report["projects_synced"], 1);
    assert_eq!(report["partial_sync"], true);
    assert_eq!(report["project_errors"][0]["project_id"], "broken");
    assert_eq!(
        report["project_errors"][0]["error_category"],
        "source_json_invalid"
    );
    let prompts: i64 = s
        .conn
        .query_row(
            "SELECT count(*) FROM records WHERE kind='prompt'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(prompts, 1);
}

#[test]
fn tool_aggregates_cover_all_matching_rows_and_preserve_unknown_durations() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    for (source, project, status, duration) in [
        ("one", "p", "completed", None),
        ("two", "p", "failed", Some(50)),
        ("other", "other", "completed", Some(900)),
    ] {
        s.put("local","tool",source,project,"t","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"tool_name":"synthetic-shell","tool_category":"shell","model":"synthetic","status":status,"duration_ms":duration})).unwrap();
    }
    let f = Filter {
        project: Some("p".into()),
        limit: Some(1),
        ..Default::default()
    };
    assert_eq!(
        analytics::query(&s, "tool-calls", &f).unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let result = analytics::query(&s, "usage/tools", &f).unwrap();
    assert_eq!(result["data"][0]["calls"], 2);
    assert_eq!(result["data"][0]["failed"], 1);
    assert_eq!(result["data"][0]["timed"], 1);
    assert_eq!(result["data"][0]["p50"], 50.0);
    let summary = analytics::query(&s, "usage/tool-summary", &f).unwrap();
    assert_eq!(summary["data"][0]["calls"], 2);
    assert_eq!(summary["data"][0]["failed"], 1);
    assert_eq!(summary["data"][0]["shell"], 2);
    assert_eq!(summary["data"][0]["exitKnown"], 0);
    assert_eq!(summary["data"][0]["p50"], 50.0);
    let hours = analytics::query(&s, "usage/tool-hours", &f).unwrap();
    let by_hour = hours["data"].as_array().unwrap();
    let sum = |k: &str| by_hour.iter().map(|h| h[k].as_i64().unwrap()).sum::<i64>();
    assert_eq!(
        sum("completed") + sum("cancelled") + sum("failed") + sum("running") + sum("unknown"),
        2
    );
    assert_eq!(sum("failed"), 1);
    let of_kind = |kind: &str| {
        analytics::query(
            &s,
            "timeline",
            &Filter {
                project: Some("p".into()),
                kind: Some(kind.into()),
                ..Default::default()
            },
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(of_kind("tool"), 2);
    assert_eq!(of_kind("prompt"), 0);
    assert!(
        analytics::query(
            &s,
            "timeline",
            &Filter {
                kind: Some("tool' OR 1=1".into()),
                ..Default::default()
            }
        )
        .is_err()
    );
    let next = analytics::query(
        &s,
        "tool-calls",
        &Filter {
            offset: Some(1),
            ..f.clone()
        },
    )
    .unwrap();
    assert_eq!(next["data"].as_array().unwrap().len(), 1);
}

#[test]
fn equal_content_advances_provenance_without_duplicate_events_or_regression() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let put = |updated: &str| {
        s.put(
            "local",
            "prompt",
            "same",
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            updated,
            "partial",
            "synthetic",
            json!({"content_redacted":"unchanged"}),
        )
        .unwrap()
    };
    assert!(put("2026-01-01T00:00:00Z"));
    assert!(!put("2026-01-02T00:00:00Z"));
    assert!(!put("2026-01-01T00:00:00Z"));
    let updated: String = s
        .conn
        .query_row("SELECT source_updated_at FROM records", [], |r| r.get(0))
        .unwrap();
    assert_eq!(updated, "2026-01-02T00:00:00Z");
    let events: i64 = s
        .conn
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, 1);
}

#[test]
fn search_cache_matches_json_semantics_and_tracks_replacements() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    for (i, content) in [
        None,
        Some(""),
        Some("Hello \u{c4}pfel STRASSE"),
        Some("a_b%needle"),
        Some("unrelated"),
    ]
    .iter()
    .enumerate()
    {
        s.put(
            "local",
            "answer",
            &format!("search-{i}"),
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "test",
            json!({"content_redacted":content,"content_ciphertext":"never-searchable"}),
        )
        .unwrap();
    }
    for q in [
        "",
        "hello",
        "\u{e4}pfel",
        "%",
        "_",
        "needle",
        "never-searchable",
        "absent",
    ] {
        let pattern = format!("%{q}%");
        let expected: Vec<String> = s.conn.prepare("SELECT id FROM records WHERE json_extract_string(data,'$.content_redacted') ILIKE ? ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id LIMIT 500").unwrap().query_map([pattern], |r|r.get(0)).unwrap().collect::<duckdb::Result<_>>().unwrap();
        let actual = analytics::query(
            &s,
            "search",
            &Filter {
                q: Some(q.into()),
                limit: Some(500),
                ..Default::default()
            },
        )
        .unwrap();
        let ids: Vec<_> = actual["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, expected, "query {q}");
    }
    s.put(
        "local",
        "answer",
        "search-2",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-02T00:00:00Z",
        "partial",
        "test",
        json!({"content_redacted":"replacement"}),
    )
    .unwrap();
    let old = analytics::query(
        &s,
        "search",
        &Filter {
            q: Some("hello".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(old["data"].as_array().unwrap().is_empty());
    let new = analytics::query(
        &s,
        "search",
        &Filter {
            q: Some("replacement".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(new["data"].as_array().unwrap().len(), 1);
    s.purge("thread", "t").unwrap();
    assert!(
        analytics::query(
            &s,
            "search",
            &Filter {
                q: Some("replacement".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn search_cache_resumes_and_retention_removes_every_content_copy() {
    let (_tmp, c) = fixture();
    {
        let s = Store::open(&c).unwrap();
        s.put(
            "local",
            "answer",
            "recover",
            "p",
            "t",
            "r",
            "2020-01-01T00:00:00Z",
            "2020-01-01T00:00:00Z",
            "partial",
            "test",
            json!({"content_redacted":"recoverable","content_ciphertext":"encrypted"}),
        )
        .unwrap();
        s.conn
            .execute("UPDATE records SET search_text=NULL,search_version=0", [])
            .unwrap();
    }
    let s = Store::open(&c).unwrap();
    assert_eq!(
        analytics::query(
            &s,
            "search",
            &Filter {
                q: Some("recoverable".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    t3ui_core::storage::retain_content(&s.conn, 90).unwrap();
    let remaining: i64 = s.conn.query_row("SELECT count(*) FROM records WHERE search_text IS NOT NULL OR json_extract_string(data,'$.content_redacted') IS NOT NULL OR json_extract_string(data,'$.content_ciphertext') IS NOT NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(remaining, 0);
    assert!(
        analytics::query(
            &s,
            "search",
            &Filter {
                q: Some("recoverable".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn bulk_tools_bound_topn_memory_and_recover_after_failed_query() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.conn.execute_batch("SET memory_limit='2GB'; INSERT INTO records(id,kind,instance_id,source_id,project_id,thread_id,run_id,occurred_at,source_updated_at,capture_quality,capture_source,source_version,captured_at,payload_hash,data) SELECT md5(i::VARCHAR),'tool','local',i::VARCHAR,'p','t','r','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','partial','synthetic','v','2026-01-01T00:00:00Z',md5(i::VARCHAR),json_object('content_redacted',repeat(md5(i::VARCHAR),256),'content_ciphertext','excluded') FROM range(3000) t(i); CHECKPOINT").unwrap();
    // Rows written by SQL skip put(), so they get their analytic columns and list view the way opening the database gives them.
    t3ui_core::storage::hydrate_facts(&s.conn).unwrap();
    s.conn
        .execute_batch("CHECKPOINT; SET memory_limit='128MB'")
        .unwrap();
    let f = Filter {
        limit: Some(500),
        offset: Some(1500),
        ..Default::default()
    };
    // The former wide JSON envelope remains a failing control at this budget.
    // The API now assembles full envelopes per row in Rust and must succeed.
    let failed = match s.rows("SELECT json_object('data',json_merge_patch(data,'{\"content_ciphertext\":null}'))::VARCHAR FROM records ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id LIMIT 500 OFFSET 1500",&[]) {
        Err(error) => error,
        Ok(_) => panic!("wide JSON control must exceed the budget"),
    };
    assert_eq!(importer::error_category(&failed), "database_memory_limit");
    assert!(analytics::query(&s, "overview", &Filter::default()).is_ok());
    let full = analytics::query(&s, "timeline", &f).unwrap();
    assert_eq!(full["data"].as_array().unwrap().len(), 500);
    assert!(
        full["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["data"].get("content_ciphertext").is_none()
                && row["data"]["content_redacted"].as_str().unwrap().len() == 8192)
    );
    let actual = analytics::query(&s, "tool-calls", &f).unwrap();
    assert_eq!(actual["data"].as_array().unwrap().len(), 500);
    let expected: Vec<String> = s
        .conn
        .prepare("SELECT source_id FROM records ORDER BY id LIMIT 500 OFFSET 1500")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<duckdb::Result<_>>()
        .unwrap();
    let ids: Vec<_> = actual["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["source_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, expected);
    assert!(!actual.to_string().contains("excluded"));
    assert!(
        actual["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["data"]["content_redacted"].as_str().unwrap().len() == 512)
    );
}

#[test]
fn model_cache_write_aggregate_preserves_null_zero_and_input_totals() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    for (id, usage) in [
        (
            "known",
            json!({"usageScope":"main_agent","usageStatus":"complete","inputTokens":100,"cachedInputTokens":50,"cacheCreationTokens":20,"outputTokens":10}),
        ),
        (
            "zero",
            json!({"usageScope":"main_agent","usageStatus":"partial","inputTokens":0,"cacheCreationTokens":0}),
        ),
        (
            "unknown",
            json!({"usageScope":"main_agent","usageStatus":"unavailable"}),
        ),
    ] {
        let mut data = importer::token_fields(&usage);
        data["model"] = json!(if id == "unknown" { "unknown" } else { "known" });
        s.put(
            "local",
            "model_turn",
            id,
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "test",
            data,
        )
        .unwrap();
    }
    let result = analytics::query(&s, "models", &Filter::default()).unwrap();
    let known = result["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["model"] == "known")
        .unwrap();
    assert_eq!(known["input_tokens"], 100);
    assert_eq!(known["total_tokens"], 110);
    assert_eq!(known["cache_write_tokens"], 20);
    assert_eq!(known["cache_write_observed_turns"], 2);
    assert_eq!(known["turns_with_usage"], 2);
    let unknown = result["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["model"] == "unknown")
        .unwrap();
    assert!(unknown["cache_write_tokens"].is_null());
    assert_eq!(unknown["cache_write_observed_turns"], 0);
}

#[test]
fn provider_revision_cache_tracks_usage_linkage_and_repair() {
    let (_tmp, c) = fixture();
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    source.execute_batch("CREATE TABLE orchestration_v2_projection_nodes(node_id TEXT PRIMARY KEY,run_id TEXT); CREATE TABLE orchestration_v2_projection_provider_turns(provider_turn_id TEXT PRIMARY KEY,thread_id TEXT,node_id TEXT,payload_json TEXT); INSERT INTO orchestration_v2_projection_nodes VALUES('node',NULL)").unwrap();
    let mut turn = json!({"id":"pt","nodeId":"node","status":"running","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","turnTokenUsage":{"usageScope":"main_agent","usageStatus":"partial","inputTokens":100}});
    source
        .execute(
            "INSERT INTO orchestration_v2_projection_provider_turns VALUES('pt','t','node',?)",
            [turn.to_string()],
        )
        .unwrap();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(
        analytics::query(&s, "model-turns", &Filter::default()).unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    turn["status"] = json!("completed");
    source
        .execute(
            "UPDATE orchestration_v2_projection_provider_turns SET payload_json=?",
            [turn.to_string()],
        )
        .unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let events: i64 = s
        .conn
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    let repeat = importer::import(&c, &s, &Options::default()).unwrap();
    assert_eq!(repeat["changed"], 0);
    assert_eq!(
        events,
        s.conn
            .query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
            .unwrap()
    );
    let row = analytics::query(&s, "model-turns", &Filter::default()).unwrap();
    assert!(row["data"][0]["data"]["requested_model"].is_null());
    assert!(row["data"][0]["data"]["total_tokens"].is_null());
    turn["turnTokenUsage"]["usageStatus"] = json!("complete");
    turn["turnTokenUsage"]["outputTokens"] = json!(20);
    source
        .execute(
            "UPDATE orchestration_v2_projection_provider_turns SET payload_json=?",
            [turn.to_string()],
        )
        .unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let usage_only = analytics::query(&s, "model-turns", &Filter::default()).unwrap();
    assert_eq!(usage_only["data"][0]["data"]["total_tokens"], 120);
    assert!(usage_only["data"][0]["data"]["requested_model"].is_null());
    source
        .execute(
            "UPDATE orchestration_v2_projection_nodes SET run_id='r'",
            [],
        )
        .unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let row = analytics::query(&s, "model-turns", &Filter::default()).unwrap();
    assert_eq!(row["data"][0]["data"]["total_tokens"], 120);
    assert_eq!(row["data"][0]["data"]["requested_model"], "synthetic-model");
    source.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.modelSelection.model','changed-model','$.providerInstanceId','changed-provider')",[]).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let row = analytics::query(&s, "model-turns", &Filter::default()).unwrap();
    assert_eq!(row["data"][0]["data"]["requested_model"], "changed-model");
    assert_eq!(row["data"][0]["data"]["provider"], "changed-provider");
    let before = analytics::query(&s, "model-turns", &Filter::default()).unwrap();
    let repair = importer::import(
        &c,
        &s,
        &Options {
            since: Some("".into()),
            ..Default::default()
        },
    )
    .unwrap();
    // Repair may refresh other projections after the synthetic run mutation.
    assert_eq!(repair["partial_sync"], false);
    assert_eq!(
        before,
        analytics::query(&s, "model-turns", &Filter::default()).unwrap()
    );
    s.purge("thread", "t").unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    assert!(
        analytics::query(&s, "model-turns", &Filter::default()).unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn legacy_parquet_restore_hydrates_search_after_current_purges() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    s.put(
        "local",
        "answer",
        "kept",
        "p",
        "child",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "test",
        json!({"content_redacted":"Kept wildcard_%","content_ciphertext":"excluded"}),
    )
    .unwrap();
    let snapshot = t3ui_core::archive::run(&c, &s, "run").unwrap();
    let dir = std::path::Path::new(snapshot["path"].as_str().unwrap());
    let legacy = dir.join("legacy.parquet");
    s.conn.execute_batch(&format!("COPY (SELECT * EXCLUDE(search_text,search_version) FROM records) TO '{}' (FORMAT PARQUET,COMPRESSION ZSTD)",legacy.to_string_lossy().replace('\'',"''"))).unwrap();
    let records = dir.join("records.parquet");
    std::fs::copy(legacy, &records).unwrap();
    let manifest_path = dir.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    for file in manifest["files"].as_array_mut().unwrap() {
        if file["table"] == "records" {
            file["sha256"] = json!(t3ui_core::compression::checksum(&records).unwrap());
            file["bytes"] = json!(std::fs::metadata(&records).unwrap().len());
        }
    }
    std::fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    s.purge("thread", "t").unwrap();
    let mut target = c.clone();
    target.storage.duckdb_path = format!("{}.legacy", c.storage.duckdb_path);
    let restored = Store::open(&target).unwrap();
    t3ui_core::archive::restore(&restored, dir).unwrap();
    let kept = analytics::query(
        &restored,
        "search",
        &Filter {
            q: Some("Kept wildcard_%".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(kept["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        kept["data"][0]["data"]["content_redacted"],
        "Kept wildcard_%"
    );
    assert!(!kept.to_string().contains("excluded"));
    assert!(
        analytics::query(
            &restored,
            "search",
            &Filter {
                q: Some("Synthetic answer".into()),
                ..Default::default()
            }
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        restored
            .conn
            .query_row(
                "SELECT count(*) FROM records WHERE search_version<>2 OR search_version IS NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn lowercase_search_cache_preserves_unicode_wildcards_and_migrates_v1() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    for (i, text) in [
        "MiXeD test",
        "\u{130}stanbul I i \u{131}",
        "\u{3a3} \u{3c3} \u{3c2}",
        "Stra\u{df}e \u{1e9e}",
        "\u{212a} K k \u{17f} S s",
        "e\u{301} \u{c9}",
        "\u{1f642}\u{4e2d}",
        "percent_% \\ literal",
        "",
        "nul\0tail",
    ]
    .iter()
    .enumerate()
    {
        s.put(
            "local",
            "answer",
            &i.to_string(),
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "test",
            json!({"content_redacted":text}),
        )
        .unwrap();
    }
    // Emulate an old exact-text cache. Reopening must rebuild every v1 row.
    s.conn.execute("UPDATE records SET search_text=json_extract_string(data,'$.content_redacted'),search_version=1",[]).unwrap();
    drop(s);
    let s = Store::open(&c).unwrap();
    for q in [
        "test",
        "I",
        "\u{130}",
        "\u{131}",
        "\u{3a3}",
        "\u{3c2}",
        "\u{df}",
        "SS",
        "K",
        "s",
        "\u{c9}",
        "\u{1f642}",
        "_",
        "%",
        "\\",
        "\0",
        "",
    ] {
        let pattern = format!("%{q}%");
        let expected:Vec<String>=s.conn.prepare("SELECT id FROM records WHERE json_extract_string(data,'$.content_redacted') ILIKE ? ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id").unwrap().query_map([&pattern],|r|r.get(0)).unwrap().collect::<duckdb::Result<_>>().unwrap();
        let actual = analytics::query(
            &s,
            "search",
            &Filter {
                q: Some(q.into()),
                limit: Some(500),
                ..Default::default()
            },
        )
        .unwrap();
        let ids: Vec<String> = actual["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, expected, "pattern {q:?}");
    }
    assert_eq!(s.conn.query_row("SELECT count(*) FROM records WHERE search_text IS DISTINCT FROM lower(json_extract_string(data,'$.content_redacted'))",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn ascii_only_search_uses_original_json_unicode_semantics() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    for text in ["K", "I"] {
        s.put(
            "local",
            "answer",
            text,
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "test",
            json!({"content_redacted":text}),
        )
        .unwrap();
    }
    for (q, expected) in [("\u{212a}", "K"), ("\u{130}", "I")] {
        let pattern = format!("%{q}%");
        let oracle:i64=s.conn.query_row("SELECT count(*) FROM records WHERE json_extract_string(data,'$.content_redacted') ILIKE ?",[pattern],|r|r.get(0)).unwrap();
        assert_eq!(oracle, 1);
        let result = analytics::query(
            &s,
            "search",
            &Filter {
                q: Some(q.into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result["data"].as_array().unwrap().len(), 1);
        assert_eq!(result["data"][0]["source_id"], expected);
    }
}

#[test]
fn session_log_hours_add_tokens_but_never_count_as_provider_turns() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put("local","model_turn","turn","p","t","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"model":"m","usage_status":"complete","total_tokens":10,"input_tokens":10,"duration_ms":100})).unwrap();
    s.capture_source.set("session_logs");
    s.put("local","model_turn","log:x:1:m","p","","","2026-01-01T01:00:00Z","2026-01-01T02:00:00Z","partial","session_logs",json!({"model":"m","usage_status":"complete","usage_source":"session_log","total_tokens":90,"input_tokens":90,"duration_ms":3_600_000})).unwrap();
    s.capture_source.set("t3_sqlite_v2");
    let m = &analytics::query(&s, "models", &Filter::default()).unwrap()["data"][0];
    assert_eq!(m["observed_provider_turns"], 1);
    assert_eq!(m["session_log_blocks"], 1);
    assert_eq!(m["complete_usage_turns"], 1);
    assert_eq!(m["turns_with_usage"], 1);
    assert_eq!(m["total_tokens"], 100);
    assert_eq!(m["median_latency_ms"], 100.0);
    let p = &analytics::query(&s, "usage/projects", &Filter::default()).unwrap()["data"][0];
    assert_eq!(p["observed_provider_turns"], 1);
    assert_eq!(p["reported_turns"], 1);
    assert_eq!(p["total_tokens"], 100);
}
// The service counts the same turns as a provider's row on the dashboard, including turns that name only the agent.
#[test]
fn provider_filter_counts_turns_that_name_no_model() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put(
        "local",
        "model_turn",
        "named",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "synthetic",
        json!({"model":"gpt-6.1-sol","usage_status":"complete","total_tokens":10}),
    )
    .unwrap();
    s.put(
        "local",
        "model_turn",
        "driver",
        "p",
        "t",
        "r",
        "2026-01-01T00:01:00Z",
        "2026-01-01T00:01:00Z",
        "partial",
        "synthetic",
        json!({"model":null,"provider":"codex","usage_status":"complete","total_tokens":20}),
    )
    .unwrap();
    s.put("local","model_turn","thread-id","p","t","r","2026-01-01T00:02:00Z","2026-01-01T00:02:00Z","partial","synthetic",json!({"model":null,"provider":null,"provider_thread_id":"provider-thread:provider:codex:native-thread:x","usage_status":"complete","total_tokens":30})).unwrap();
    s.put(
        "local",
        "prompt",
        "native",
        "p",
        "thread:provider:codex:native-thread:y",
        "r",
        "2026-01-01T00:03:00Z",
        "2026-01-01T00:03:00Z",
        "partial",
        "synthetic",
        json!({}),
    )
    .unwrap();
    s.put(
        "local",
        "model_turn",
        "claude",
        "p",
        "t",
        "r",
        "2026-01-01T00:04:00Z",
        "2026-01-01T00:04:00Z",
        "partial",
        "synthetic",
        json!({"model":"claude-opus-5-5","usage_status":"complete","total_tokens":40}),
    )
    .unwrap();
    s.put(
        "local",
        "model_turn",
        "unknown",
        "p",
        "t",
        "r",
        "2026-01-01T00:05:00Z",
        "2026-01-01T00:05:00Z",
        "partial",
        "synthetic",
        json!({"usage_status":"complete","total_tokens":50}),
    )
    .unwrap();
    s.capture_source.set("session_logs");
    s.put("local","model_turn","log:x:1:m","p","","","2026-01-01T01:00:00Z","2026-01-01T02:00:00Z","partial","session_logs",json!({"model":"gpt-6.1-sol","usage_status":"complete","usage_source":"session_log","total_tokens":90})).unwrap();
    s.capture_source.set("t3_sqlite_v2");
    let count = |provider: Option<&str>, kind: &str| {
        let f = Filter {
            provider: provider.map(str::to_owned),
            ..Default::default()
        };
        analytics::query(&s, "overview", &f).unwrap()["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == kind)
            .map(|r| r["count"].as_i64().unwrap())
            .unwrap_or(0)
    };
    assert_eq!(
        count(Some("openai"), "model_turn"),
        3,
        "named, by driver and by provider thread, never the session-log hour"
    );
    assert_eq!(count(Some("openai"), "prompt"), 1);
    assert_eq!(count(Some("anthropic"), "model_turn"), 1);
    assert_eq!(
        count(None, "model_turn"),
        5,
        "session-log hours are not provider turns"
    );
    let models = analytics::query(
        &s,
        "models",
        &Filter {
            provider: Some("openai".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let total: i64 = models["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["total_tokens"].as_i64().unwrap_or(0))
        .sum();
    assert_eq!(total, 150, "tokens include the session-log hour");
    assert!(
        Filter {
            provider: Some("Open AI".into()),
            ..Default::default()
        }
        .validate()
        .is_err()
    );
}

// A lean turn carries the same values the dashboard reads from the full document, in far fewer bytes.
#[test]
fn lean_turns_match_the_full_document() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put("local","model_turn","full","p","thread:provider:codex:native-thread:x","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"model":null,"requested_model":"gpt-6.1-sol","provider":null,"provider_thread_id":"provider-thread:provider:codex:native-thread:x","node_id":"n".repeat(120),"usage_status":"complete","usage_scope":"main_agent","total_tokens":30,"input_tokens":20,"cached_input_tokens":5,"cache_write_tokens":1,"output_tokens":10,"reasoning_tokens":2,"has_subagents":true,"started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:02Z"})).unwrap();
    s.put("local","model_turn","partial","p","t","r","2026-01-01T00:01:00Z","2026-01-01T00:01:00Z","partial","synthetic",json!({"model":"claude-opus-5-5","provider":"claudeAgent","usage_status":"partial","total_tokens":99,"input_tokens":7,"duration_ms":40})).unwrap();
    let read = |shape: Option<&str>| {
        analytics::query(
            &s,
            "model-turns",
            &Filter {
                shape: shape.map(str::to_owned),
                ..Default::default()
            },
        )
        .unwrap()["data"]
            .as_array()
            .unwrap()
            .clone()
    };
    let (full, lean) = (read(None), read(Some("lean")));
    assert_eq!(full.len(), 2);
    for (a, b) in full.iter().zip(&lean) {
        assert_eq!(a["id"], b["id"]);
        assert_eq!(a["thread_id"], b["thread_id"]);
        for k in [
            "total_tokens",
            "input_tokens",
            "output_tokens",
            "usage_status",
        ] {
            assert_eq!(a["data"][k], b["data"][k], "{k}");
        }
        assert!(b["data"].get("node_id").is_none());
        assert!(b.to_string().len() < a.to_string().len());
    }
    let first = &lean[1];
    assert_eq!(first["data"]["provider"], "codex");
    assert_eq!(first["data"]["model"], "gpt-6.1-sol");
    assert_eq!(first["data"]["duration_ms"], 2000);
    assert_eq!(first["data"]["cache_write_tokens"], 1);
    assert_eq!(first["data"]["has_subagents"], true);
    assert_eq!(
        lean[0]["data"]["total_tokens"],
        serde_json::Value::Null,
        "a partial turn has no complete total"
    );
    assert_eq!(lean[0]["data"]["provider"], "claudeAgent");
    assert!(
        Filter {
            shape: Some("wide".into()),
            ..Default::default()
        }
        .validate()
        .is_err()
    );
}

// Rows written before the second set of analytic columns, or restored from an older snapshot, are filled in one pass.
#[test]
fn older_rows_get_the_new_analytic_columns() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put("local","model_turn","old","p","t","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"model":"m","provider":"codex","cache_write_tokens":7,"started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:03Z","has_subagents":false,"usage_status":"complete","total_tokens":5})).unwrap();
    s.put(
        "local",
        "tool",
        "t1",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "synthetic",
        json!({"tool_category":"shell","exit_code":2}),
    )
    .unwrap();
    s.conn.execute_batch("UPDATE records SET cache_write_tokens=NULL,exit_code=NULL,agent_provider=NULL,has_subagents=NULL,elapsed_ms=NULL,facts_version=1").unwrap();
    t3ui_core::storage::hydrate_more_facts(&s.conn).unwrap();
    let row: (i64, String, i64, bool, i32) = s.conn.query_row("SELECT cache_write_tokens,agent_provider,elapsed_ms,has_subagents,facts_version FROM records WHERE kind='model_turn'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap();
    assert_eq!(row, (7, "codex".into(), 3000, false, 3));
    let exit: i64 = s
        .conn
        .query_row("SELECT exit_code FROM records WHERE kind='tool'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(exit, 2);
    let summary = analytics::query(&s, "usage/tool-summary", &Filter::default()).unwrap();
    assert_eq!(summary["data"][0]["nonZero"], 1);
}

// List pages read a stored list view. What a write stores and what the backfill computes must be the same document.
#[test]
fn stored_list_view_matches_the_backfill() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let long = format!("{{\"arguments\":\"{}\"}}", "é🙂x".repeat(400));
    s.put("local","tool","long","p","t","r","2026-01-01T00:00:02Z","2026-01-01T00:00:02Z","partial","synthetic",json!({"tool_name":"shell","tool_category":"shell","exit_code":1,"character_count":1200,"redaction_count":2,"redaction_categories":["path"],"parent_tool_call_id":"pt","content_redacted":long,"content_ciphertext":"secret","repository_path_encrypted":"secret"})).unwrap();
    s.put(
        "local",
        "tool",
        "short",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:01Z",
        "2026-01-01T00:00:01Z",
        "partial",
        "synthetic",
        json!({"tool_name":"read","content_redacted":"{\"arguments\":\"a.txt\"}"}),
    )
    .unwrap();
    s.put(
        "local",
        "tool",
        "none",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "synthetic",
        json!({"tool_name":"read"}),
    )
    .unwrap();
    let read = || {
        analytics::query(&s, "tool-calls", &Filter::default()).unwrap()["data"]
            .as_array()
            .unwrap()
            .clone()
    };
    let written = read();
    assert_eq!(written.len(), 3);
    let first = &written[0]["data"];
    assert_eq!(
        first["content_redacted"].as_str().unwrap().chars().count(),
        512
    );
    assert_eq!(first["content_truncated"], true);
    assert!(
        first.get("content_ciphertext").is_none()
            && first.get("repository_path_encrypted").is_none()
    );
    assert_eq!(first["redaction_categories"], json!(["path"]));
    assert_eq!(first["parent_tool_call_id"], "pt");
    assert_eq!(written[1]["data"]["content_truncated"], false);
    assert!(written[2]["data"].get("content_redacted").is_none());
    s.conn
        .execute_batch("UPDATE records SET preview_doc=NULL,facts_version=2")
        .unwrap();
    t3ui_core::storage::hydrate_more_facts(&s.conn).unwrap();
    assert_eq!(
        read(),
        written,
        "the backfill computes the same list view as a write"
    );
    let full = analytics::query(
        &s,
        "tool-calls",
        &Filter {
            include_content: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        full["data"][0]["data"]["content_redacted"], long,
        "full content still comes from the document"
    );
}

// The Models page reads threads and sub-agents per model from the model list, in one query instead of one per model.
#[test]
fn models_count_their_threads_and_agents() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let put = |kind: &str, id: &str, model: &str| {
        s.put(
            "local",
            kind,
            id,
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "synthetic",
            json!({"model": model}),
        )
        .unwrap()
    };
    put("run", "r1", "m");
    put("thread", "t1", "m");
    put("thread", "t2", "m");
    put("agent", "a1", "m");
    put("thread", "t3", "only-a-thread");
    let rows = analytics::query(&s, "models", &Filter::default()).unwrap()["data"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(rows.len(), 1, "a model that never ran is not listed");
    assert_eq!(
        (
            rows[0]["model"].as_str(),
            rows[0]["observed_threads"].as_i64(),
            rows[0]["observed_agents"].as_i64(),
            rows[0]["observed_runs"].as_i64()
        ),
        (Some("m"), Some(2), Some(1), Some(1))
    );
}

// Data Quality counts field coverage over every tool call and redactions over tools and sub-agents, never a sample.
#[test]
fn field_report_counts_every_tool_call() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let put = |kind: &str, id: &str, data: serde_json::Value| {
        s.put(
            "local",
            kind,
            id,
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "synthetic",
            data,
        )
        .unwrap()
    };
    put(
        "tool",
        "a",
        json!({"tool_category":"shell","status":"completed","exit_code":0,"duration_ms":5,"redaction_categories":["path","path","bearer"]}),
    );
    put(
        "tool",
        "b",
        json!({"tool_category":"shell","status":"","redaction_categories":["path"]}),
    );
    put("tool", "c", json!({"tool_category":"unknown"}));
    put("agent", "d", json!({"redaction_categories":["email"]}));
    let r = analytics::query(&s, "data-quality/fields", &Filter::default()).unwrap();
    assert_eq!(
        r["tools"],
        json!({"calls":3,"duration":1,"status":1,"category":2,"shell":2,"exit":1})
    );
    assert_eq!(
        r["redactions"],
        json!([{"category":"path","records":2},{"category":"bearer","records":1},{"category":"email","records":1}])
    );
}

#[test]
fn turn_without_a_run_takes_its_threads_model() {
    let (_tmp, c) = fixture();
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    // A provider's own sub-agent thread names its model, and its turns link to no run.
    source.execute("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.model','thread-model') WHERE json_extract(payload_json,'$.id')='child'",[]).unwrap();
    source.execute_batch("CREATE TABLE orchestration_v2_projection_nodes(node_id TEXT PRIMARY KEY,run_id TEXT); CREATE TABLE orchestration_v2_projection_provider_turns(provider_turn_id TEXT PRIMARY KEY,thread_id TEXT,node_id TEXT,payload_json TEXT); INSERT INTO orchestration_v2_projection_nodes VALUES('node',NULL)").unwrap();
    let turn = json!({"id":"pt","nodeId":"node","status":"completed","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","providerThreadId":"provider-thread:provider:codex:native-thread:x","turnTokenUsage":{"usageScope":"main_agent","usageStatus":"complete","inputTokens":100,"outputTokens":20}});
    source
        .execute(
            "INSERT INTO orchestration_v2_projection_provider_turns VALUES('pt','child','node',?)",
            [turn.to_string()],
        )
        .unwrap();
    let s = Store::open(&c).unwrap();
    importer::import(&c, &s, &Options::default()).unwrap();
    let row = analytics::query(&s, "model-turns", &Filter::default()).unwrap();
    assert_eq!(row["data"][0]["data"]["model"], "thread-model");
    assert_eq!(row["data"][0]["data"]["model_source"], "thread");
    let models = analytics::query(&s, "models", &Filter::default()).unwrap();
    assert!(
        models["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["model"] == "thread-model" && m["observed_provider_turns"] == 1)
    );
    assert_eq!(
        importer::import(&c, &s, &Options::default()).unwrap()["changed"],
        0
    );
}

#[test]
fn harness_filter_follows_the_thread_a_record_ran_in() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let at = "2026-01-01T00:00:00Z";
    for (thread, harness) in [("codex-thread", "codex"), ("claude-thread", "claudeAgent")] {
        s.put(
            "local",
            "run",
            &format!("run-{thread}"),
            "p",
            thread,
            "",
            at,
            at,
            "partial",
            "synthetic",
            json!({"provider":harness}),
        )
        .unwrap();
        s.put(
            "local",
            "model_turn",
            &format!("turn-{thread}"),
            "p",
            thread,
            "",
            at,
            at,
            "partial",
            "synthetic",
            json!({"provider":harness,"usage_status":"complete","total_tokens":5}),
        )
        .unwrap();
        s.put(
            "local",
            "prompt",
            &format!("prompt-{thread}"),
            "p",
            thread,
            "",
            at,
            at,
            "partial",
            "synthetic",
            json!({"content_redacted":"hi"}),
        )
        .unwrap();
        s.put(
            "local",
            "tool",
            &format!("tool-{thread}"),
            "p",
            thread,
            "",
            at,
            at,
            "partial",
            "synthetic",
            json!({"tool_name":"shell"}),
        )
        .unwrap();
    }
    let counts = |harness: Option<&str>| {
        let v = analytics::query(
            &s,
            "overview",
            &Filter {
                harness: harness.map(str::to_owned),
                ..Default::default()
            },
        )
        .unwrap();
        v["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["kind"].as_str().unwrap().to_owned(),
                    r["count"].as_i64().unwrap(),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let all = counts(None);
    let codex = counts(Some("codex"));
    assert_eq!(all["prompt"], 2);
    for kind in ["prompt", "tool", "run", "model_turn"] {
        assert_eq!(codex[kind], 1, "{kind}");
    }
    assert!(counts(Some("nobody")).is_empty());
    // A thread that switched harness: its records follow their own run, so the harnesses add up to the whole.
    s.put(
        "local",
        "run",
        "switched-run",
        "p",
        "codex-thread",
        "",
        at,
        at,
        "partial",
        "synthetic",
        json!({"provider":"claudeAgent"}),
    )
    .unwrap();
    s.put(
        "local",
        "prompt",
        "switched-prompt",
        "p",
        "codex-thread",
        "switched-run",
        at,
        at,
        "partial",
        "synthetic",
        json!({"content_redacted":"hi"}),
    )
    .unwrap();
    let all = counts(None);
    let (codex, claude) = (counts(Some("codex")), counts(Some("claudeAgent")));
    for kind in ["prompt", "run", "tool", "model_turn"] {
        assert_eq!(
            codex.get(kind).unwrap_or(&0) + claude.get(kind).unwrap_or(&0),
            all[kind],
            "{kind}"
        );
    }
    assert_eq!(claude["prompt"], 2);
    assert!(
        Filter {
            harness: Some("bad name;".into()),
            ..Default::default()
        }
        .validate()
        .is_err()
    );
}

/// T3's cache of what each harness said about its limits: readings into the history, kept on change or every 15 minutes,
/// and a live snapshot of every enabled harness that never copies the account's sign-in.
#[test]
fn t3_usage_cache_feeds_readings_and_the_live_view() {
    use t3ui_core::quota_sources::collect_from;
    let (tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let home = tmp.path().join("home");
    let caches = tmp.path().join("caches");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&caches).unwrap();
    let write = |name: &str, v: serde_json::Value| {
        std::fs::write(caches.join(name), v.to_string()).unwrap()
    };
    let claude = |at: &str, used: f64| {
        json!({"driver":"claudeAgent","instanceId":"claudeAgent","displayName":"Claude","enabled":true,"status":"ready",
            "auth":{"status":"authenticated","email":"someone@example.com"},
            "usageLimits":{"checkedAt":at,"windows":[
                {"id":"five_hour","kind":"session","label":"Session","windowDurationMins":300,"usedPercent":used,"resetsAt":"2026-01-01T05:00:00.000Z"},
                {"id":"seven_day_fable","kind":"weekly","label":"Weekly · Fable","windowDurationMins":10080,"usedPercent":40,"resetsAt":"2026-01-06T23:59:59.950Z"}],
                "resetCredits":{"availableCount":2,"nextExpiresAt":"2026-02-01T00:00:00.000Z","options":[{"creditId":"full","label":"Full reset","description":"Refills both.","availableCount":1,"expiresAt":"2026-02-01T00:00:00.000Z"}]}}})
    };
    write("claudeAgent.json", claude("2026-01-01T01:00:00.000Z", 10.0));
    write(
        "grok.json",
        json!({"driver":"grok","instanceId":"grok","displayName":"Grok","enabled":true,"status":"ready",
        "usageLimits":{"checkedAt":"2026-01-01T01:00:00.000Z","windows":[{"id":"subscription","kind":"weekly","label":"Weekly","usedPercent":81,"resetsAt":"2026-01-04T04:12:48.041Z"}]}}),
    );
    write(
        "codex-ollama.json",
        json!({"driver":"codex","instanceId":"codex-ollama","displayName":"Codex","enabled":true,"status":"ready",
        "usageLimits":{"checkedAt":"2026-01-01T01:00:00.000Z","windows":[],"unavailable":{"reason":"probeFailed","message":"Codex could not read usage."}}}),
    );
    write(
        "muse.json",
        json!({"driver":"muse","instanceId":"muse","displayName":"Muse","enabled":true,"status":"ready"}),
    );
    write(
        "kiro.json",
        json!({"driver":"kiro","instanceId":"kiro","displayName":"Kiro","enabled":false,"status":"disabled"}),
    );
    write("models.json", json!({"models":[]}));
    let count = || {
        s.rows(
            "SELECT json_object('n',count(*))::VARCHAR FROM quota_samples",
            &[],
        )
        .unwrap()[0]["n"]
            .as_i64()
            .unwrap()
    };

    collect_from(&s, &home, Some(&caches)).unwrap();
    assert_eq!(count(), 3, "Claude's two windows and Grok's");
    // The same reading checked again five minutes later adds nothing; sixteen minutes later it is kept as a heartbeat.
    write("claudeAgent.json", claude("2026-01-01T01:05:00.000Z", 10.0));
    collect_from(&s, &home, Some(&caches)).unwrap();
    assert_eq!(count(), 3);
    write("claudeAgent.json", claude("2026-01-01T01:16:00.000Z", 10.0));
    collect_from(&s, &home, Some(&caches)).unwrap();
    assert_eq!(count(), 5);
    // A change is kept at once.
    write("claudeAgent.json", claude("2026-01-01T01:17:00.000Z", 12.0));
    collect_from(&s, &home, Some(&caches)).unwrap();
    assert_eq!(count(), 6);

    let names = s.rows("SELECT json_object('p',provider,'w',window_kind,'m',window_minutes,'src',source)::VARCHAR FROM (SELECT DISTINCT provider,window_kind,window_minutes,source FROM quota_samples) ORDER BY 1", &[]).unwrap();
    assert_eq!(
        names,
        vec![
            json!({"p":"claude","w":"five_hour","m":300,"src":"t3_usage_cache"}),
            json!({"p":"claude","w":"seven_day_fable","m":10080,"src":"t3_usage_cache"}),
            json!({"p":"grok","w":"weekly","m":10080,"src":"t3_usage_cache"}),
        ]
    );

    let live = analytics::query(&s, "quota/live", &Filter::default()).unwrap();
    let text = live.to_string();
    assert!(
        !text.contains("someone@example.com"),
        "the sign-in is never copied"
    );
    let rows = live["data"].as_array().unwrap();
    let harnesses: Vec<_> = rows
        .iter()
        .map(|r| r["harness"].as_str().unwrap())
        .collect();
    assert_eq!(
        harnesses,
        ["claudeAgent", "codex-ollama", "grok", "muse"],
        "disabled harnesses with nothing to show are left out"
    );
    assert_eq!(rows[0]["quota_key"], "claude");
    assert_eq!(rows[0]["windows"][0]["used_percentage"], 12.0);
    assert_eq!(rows[0]["windows"][0]["reset_at"], "2026-01-01T05:00:00Z");
    assert_eq!(rows[0]["credits"]["available"], 2);
    assert_eq!(rows[0]["credits"]["options"][0]["label"], "Full reset");
    assert_eq!(rows[1]["unavailable"]["reason"], "probeFailed");
    assert_eq!(rows[3]["reports_limits"], false);
    assert!(rows[0]["read_at"].is_string());
}

/// Runtrace's own checks, for harnesses T3 does not check, join the live view and the readings like T3's; a Codex home
/// that runs local models says it has no limit; and Muse's refusals become limits reached.
#[test]
fn own_checks_local_models_and_muse_refusals_join_the_quota_view() {
    use t3ui_core::quota_sources::collect_from;
    let (tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let home = tmp.path().join("home");
    let caches = tmp.path().join("caches");
    let local = tmp.path().join("codex-local");
    std::fs::create_dir_all(&caches).unwrap();
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(
        local.join("config.toml"),
        "model_provider = \"ollama-local\"\n[model_providers.ollama-local]\nname = \"Ollama (localhost)\"\nbase_url = \"http://127.0.0.1:11434/v1/\"\n",
    )
    .unwrap();
    std::fs::write(
        caches.join("codex-local.json"),
        json!({"driver":"codex","instanceId":"codex-local","enabled":true,"status":"ready",
            "continuation":{"groupKey":format!("codex:home:{}", local.display())},
            "usageLimits":{"checkedAt":"2026-01-01T01:00:00.000Z","windows":[],"unavailable":{"reason":"probeFailed","message":"Codex could not read usage."}}})
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        caches.join("muse.json"),
        json!({"driver":"muse","instanceId":"muse","enabled":true,"status":"ready"}).to_string(),
    )
    .unwrap();
    s.set(
        t3ui_core::quota_checks::CHECKS,
        &json!({
            "antigravity": {"harness":"antigravity","name":"Antigravity","checked_at":"2026-01-01T01:00:00.000Z","windows":[
                {"window":"seven_day_gemini","label":"Weekly · Gemini","window_minutes":10080,"used_percentage":35.0,"reset_at":"2026-01-05T10:00:00Z"},
                {"window":"seven_day_claude_and_gpt","label":"Weekly · Claude and GPT","window_minutes":10080,"used_percentage":0.0,"reset_at":null}]},
            "muse": {"harness":"muse","name":"Muse","checked_at":"2026-01-01T01:00:00.000Z","plan":"High Usage","windows":[],
                "unavailable":{"reason":"noUsageData","message":"Subscribed, but Meta sends no usage numbers yet"}}
        })
        .to_string(),
    )
    .unwrap();
    let sessions = home.join(".local/share/muse/sessions/2026/01/01/s1");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(
        sessions.join("session.jsonl"),
        "{\"record_json\":\"{\\\"recorded_at\\\":1767229200000000,\\\"payload\\\":{\\\"reason\\\":\\\"API error 429: Subscription quota exhausted. Your usage window resets at 2026-01-01T03:00:00Z. (rate_limit_error)\\\"}}\"}\n",
    )
    .unwrap();

    collect_from(&s, &home, Some(&caches)).unwrap();
    let live = analytics::query(&s, "quota/live", &Filter::default()).unwrap();
    let rows = live["data"].as_array().unwrap();
    let by = |h: &str| rows.iter().find(|r| r["harness"] == h).unwrap().clone();
    assert_eq!(
        rows.len(),
        3,
        "T3's muse row is replaced by Runtrace's, not repeated"
    );
    assert_eq!(by("codex-local")["unavailable"]["reason"], "local");
    assert_eq!(
        by("codex-local")["unavailable"]["message"],
        "Runs models on this machine through Ollama, so it has no limit"
    );
    assert_eq!(by("muse")["checked_by"], "runtrace");
    assert_eq!(by("muse")["plan"], "High Usage");
    assert_eq!(by("muse")["unavailable"]["reason"], "noUsageData");
    let ag = by("antigravity");
    assert_eq!(ag["windows"][0]["label"], "Weekly · Gemini");
    assert!(ag["windows"][1]["reset_at"].is_null());
    // Only the window with a running reset becomes a reading.
    let stored = s.rows("SELECT json_object('p',provider,'w',window_kind,'src',source)::VARCHAR FROM quota_samples ORDER BY 1", &[]).unwrap();
    assert_eq!(
        stored,
        vec![json!({"p":"antigravity","w":"seven_day_gemini","src":"runtrace_check"})]
    );
    let events = s.rows("SELECT json_object('p',provider,'w',window_kind,'at',happened_at,'r',reset_at)::VARCHAR FROM quota_events", &[]).unwrap();
    assert_eq!(
        events,
        vec![
            json!({"p":"muse","w":"usage_window","at":"2026-01-01T01:00:00.000Z","r":"2026-01-01T03:00:00Z"})
        ]
    );
}

/// A finished window is complete only when readings no more than 20 minutes apart cover it from start to reset.
#[test]
fn quota_windows_are_complete_only_when_readings_cover_them() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let add = |window: &str, reset: &str, minutes: &[i64]| {
        for m in minutes {
            let at = chrono::DateTime::parse_from_rfc3339(reset).unwrap()
                - chrono::Duration::minutes(300 - m);
            s.conn
                .execute(
                    "INSERT INTO quota_samples VALUES ('codex',?,?,?,?,300,NULL,'synthetic')",
                    duckdb::params![
                        window,
                        at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        *m as f64 / 10.0,
                        reset
                    ],
                )
                .unwrap();
        }
    };
    // Every 15 minutes from 5 minutes in to 5 minutes before the reset.
    add(
        "five_hour",
        "2026-01-01T05:00:00Z",
        &(0..20).map(|i| 5 + i * 15).collect::<Vec<_>>(),
    );
    // The same, but an hour without a reading in the middle.
    add(
        "five_hour",
        "2026-01-01T10:00:00Z",
        &(0..20)
            .map(|i| 5 + i * 15)
            .filter(|m| !(100..160).contains(m))
            .collect::<Vec<_>>(),
    );
    let windows = analytics::query(&s, "quota/windows", &Filter::default()).unwrap();
    let quality: Vec<_> = windows["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| {
            (
                w["reset_at"].as_str().unwrap().to_string(),
                w["capture_quality"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        quality,
        vec![
            ("2026-01-01T10:00:00Z".to_string(), "partial".to_string()),
            ("2026-01-01T05:00:00Z".to_string(), "complete".to_string()),
        ]
    );
    assert!(windows["data"][0].get("sample_times").is_none());
}

#[test]
fn review_purge_after_attribution_change_cannot_resurrect_cold_or_snapshot_content() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let at = "2026-01-01T00:00:00Z";
    s.put(
        "local",
        "tool",
        "review-entity",
        "project-a",
        "thread-a",
        "run-a",
        at,
        at,
        "partial",
        "v1",
        json!({"content_redacted":"Original neutral content"}),
    )
    .unwrap();
    t3ui_core::cold::compact(&c, &s).unwrap();
    let old_snapshot = t3ui_core::archive::run(&c, &s, "run").unwrap();
    s.put(
        "local",
        "tool",
        "review-entity",
        "project-b",
        "thread-b",
        "run-b",
        at,
        at,
        "partial",
        "v2",
        json!({"content_redacted":"Corrected neutral content"}),
    )
    .unwrap();
    s.purge("project", "project-b").unwrap();
    let filter = Filter {
        include_content: Some(true),
        ..Default::default()
    };
    assert!(
        analytics::query(&s, "tool-calls", &filter).unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty(),
        "purging a hot correction must not reveal its obsolete cold revision"
    );
    t3ui_core::archive::run(&c, &s, "verify")
        .expect("purge must not look like cold-index corruption");
    let after_snapshot = t3ui_core::archive::run(&c, &s, "run")
        .expect("purged data must remain snapshot-exportable");
    s.conn
        .execute_batch("BEGIN; DELETE FROM cold_record_keys")
        .unwrap();
    assert!(
        t3ui_core::cold::verify(&s).is_err(),
        "missing physical index entries must still fail corruption checks"
    );
    s.conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        s.stats().unwrap()["events"],
        0,
        "purge must hide older event metadata for the same identity"
    );
    let mut target = c.clone();
    target.storage.duckdb_path = format!("{}.purge-review-restore", c.storage.duckdb_path);
    let restored = Store::open(&target).unwrap();
    t3ui_core::archive::restore(
        &restored,
        std::path::Path::new(old_snapshot["path"].as_str().unwrap()),
    )
    .unwrap();
    assert!(
        analytics::query(&restored, "tool-calls", &filter).unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty(),
        "the current purge ledger must also protect a snapshot with the older attribution"
    );
    assert_eq!(
        restored.stats().unwrap()["events"],
        0,
        "older snapshot event metadata must respect identity tombstones"
    );
    target.storage.duckdb_path = format!("{}.post-purge-review-restore", c.storage.duckdb_path);
    let after_restore = Store::open(&target).unwrap();
    t3ui_core::archive::restore(
        &after_restore,
        std::path::Path::new(after_snapshot["path"].as_str().unwrap()),
    )
    .unwrap();
    assert!(
        analytics::query(&after_restore, "tool-calls", &filter).unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(after_restore.stats().unwrap()["events"], 0);
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    source.execute_batch("CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,updated_at TEXT,type TEXT,status TEXT,payload_json TEXT)").unwrap();
    let payload = json!({"id":"review-entity","threadId":"t","runId":"r","type":"command_execution","status":"completed","startedAt":at,"completedAt":at,"output":"Attempted neutral reimport"});
    source.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES('review-entity','t','r',?,'command_execution','completed',?)", rusqlite::params![at,payload.to_string()]).unwrap();
    drop(source);
    assert_eq!(
        importer::import(&c, &s, &Options::default()).unwrap()["partial_sync"],
        false
    );
    assert!(
        analytics::query(&s, "tool-calls", &filter).unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty(),
        "changing attribution in the source must not bypass the record purge"
    );
}

#[test]
fn review_repeated_payload_keeps_original_cold_event_fields() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let at = "2026-01-01T00:00:00Z";
    let put = |version: &str, value: &str| {
        s.put(
            "local",
            "tool",
            "review-event",
            "p",
            "t",
            "r",
            at,
            at,
            "partial",
            version,
            json!({"content_redacted":value}),
        )
        .unwrap()
    };
    put("v1", "Payload A");
    let original = s
        .rows("SELECT to_json(e) FROM events e", &[])
        .unwrap()
        .remove(0);
    t3ui_core::cold::compact(&c, &s).unwrap();
    put("v2", "Payload B");
    put("v3", "Payload A");
    let actual = {
        let _snapshot = t3ui_core::cold::read_snapshot(&s).unwrap();
        s.rows(
            "SELECT to_json(e) FROM events e WHERE event_id=?",
            &[&original["event_id"].as_str().unwrap()],
        )
        .unwrap()
    };
    assert!(
        actual == vec![original],
        "the first event's timestamp, attribution and source version must survive A/B/A corrections"
    );
}

#[test]
fn review_restore_applies_current_content_retention_before_hydration() {
    let (_tmp, mut c) = fixture();
    c.storage.content_retention_days = 90;
    let s = Store::open(&c).unwrap();
    let at = (t3ui_core::storage::clock() - chrono::Duration::days(40)).to_rfc3339();
    s.put("local", "tool", "review-expiry", "p", "t", "r", &at, &at, "partial", "v1", json!({"content_redacted":"Retained neutral value","content_ciphertext":"neutral-ciphertext"})).unwrap();
    t3ui_core::cold::compact(&c, &s).unwrap();
    let snapshot = t3ui_core::archive::run(&c, &s, "run").unwrap();
    drop(s);
    let mut current = c.clone();
    current.storage.content_retention_days = 30;
    let current_source = Store::open(&current).unwrap();
    let filter = Filter {
        include_content: Some(true),
        ..Default::default()
    };
    let expected = analytics::query(&current_source, "tool-calls", &filter).unwrap();
    let mut target = current.clone();
    target.storage.duckdb_path = format!("{}.expiry-review-restore", c.storage.duckdb_path);
    let restored = Store::open(&target).unwrap();
    t3ui_core::archive::restore(
        &restored,
        std::path::Path::new(snapshot["path"].as_str().unwrap()),
    )
    .unwrap();
    assert!(
        analytics::query(&restored, "tool-calls", &filter).unwrap() == expected,
        "restored content must expire under the current policy immediately"
    );
    let search = analytics::query(
        &restored,
        "search",
        &Filter {
            q: Some("Retained neutral".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        search["data"].as_array().unwrap().is_empty(),
        "expired text must not re-enter the search cache"
    );
}

#[test]
fn review_relative_archive_publication_persists_absolute_paths() {
    let (_tmp, mut c) = fixture();
    let cwd = std::env::current_dir().unwrap();
    let parent = cwd.join("target");
    std::fs::create_dir_all(&parent).unwrap();
    let relative_tmp = tempfile::Builder::new()
        .prefix("relative-cold-")
        .tempdir_in(&parent)
        .unwrap();
    c.storage.archive_path = relative_tmp
        .path()
        .strip_prefix(&cwd)
        .unwrap()
        .join("archive")
        .to_string_lossy()
        .into();
    assert!(std::path::Path::new(&c.storage.archive_path).is_relative());
    let s = Store::open(&c).unwrap();
    s.put(
        "local",
        "tool",
        "review-path",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "v1",
        json!({"content_redacted":"Neutral output"}),
    )
    .unwrap();
    t3ui_core::cold::compact(&c, &s).unwrap();
    let paths = s
        .rows(
            "SELECT to_json(struct_pack(path:=path)) FROM cold_segments",
            &[],
        )
        .unwrap();
    assert!(
        paths
            .iter()
            .all(|row| std::path::Path::new(row["path"].as_str().unwrap()).is_absolute()),
        "registered files must not depend on a future launch directory"
    );
}

#[test]
fn review_old_relative_manifest_reanchors_against_verified_archive_directory() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put(
        "local",
        "tool",
        "review-legacy-path",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "v1",
        json!({"content_redacted":"Neutral legacy output"}),
    )
    .unwrap();
    let filter = Filter {
        include_content: Some(true),
        ..Default::default()
    };
    let expected = analytics::query(&s, "tool-calls", &filter).unwrap();
    t3ui_core::cold::compact(&c, &s).unwrap();
    let paths = s
        .rows(
            "SELECT to_json(struct_pack(path:=path)) FROM cold_segments",
            &[],
        )
        .unwrap();
    for row in paths {
        let path = row["path"].as_str().unwrap();
        let relative = std::path::Path::new("old-launch-directory")
            .join(std::path::Path::new(path).file_name().unwrap())
            .to_string_lossy()
            .replace('\\', "/");
        s.conn
            .execute(
                "UPDATE cold_segments SET path=? WHERE path=?",
                duckdb::params![relative, path],
            )
            .unwrap();
    }
    drop(s);
    let reopened = Store::open(&c).unwrap();
    assert!(
        analytics::query(&reopened, "tool-calls", &filter).unwrap() == expected,
        "a verified configured archive directory must resolve legacy relative entries"
    );
}

#[test]
fn offline_backfill_bounds_small_recent_batches_and_keeps_logical_results() {
    let (_tmp, mut c) = fixture();
    c.storage.memory_limit_mb = 128;
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    source.execute_batch("CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,updated_at TEXT,type TEXT,status TEXT,payload_json TEXT)").unwrap();
    let date = t3ui_core::storage::now();
    let source_id = |n| {
        let padding = t3ui_core::privacy::hash(&format!("neutral-source-{n}"));
        format!("tool-{n}:{padding}{padding}")
            .chars()
            .take(128)
            .collect::<String>()
    };
    for n in 0..3005 {
        let id = source_id(n);
        let payload = json!({"id":id,"threadId":"t","runId":"r","type":"command_execution","status":"completed","startedAt":date,"completedAt":date,"output":format!("Neutral small output {n} {}", "x".repeat(1024))});
        source.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES(?,'t','r',?,'command_execution','completed',?)", rusqlite::params![id,date,payload.to_string()]).unwrap();
    }
    drop(source);
    let s = Store::open(&c).unwrap();
    s.conn.execute_batch("SET threads=1").unwrap();
    let options = Options {
        archive_batches: true,
        ..Default::default()
    };
    let report = importer::import(&c, &s, &options).unwrap();
    assert_eq!(report["partial_sync"], false);
    let hot: i64 = s
        .conn
        .query_row("SELECT count(*) FROM records WHERE kind='tool'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        hot, 0,
        "small recent outputs must not accumulate throughout offline backfill, including its final tail"
    );
    let mut outputs = std::collections::HashMap::new();
    for offset in (0..3005).step_by(500) {
        let page = analytics::query(
            &s,
            "tool-calls",
            &Filter {
                limit: Some(500),
                offset: Some(offset),
                include_content: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        for row in page["data"].as_array().unwrap() {
            outputs.insert(
                row["source_id"].as_str().unwrap().to_string(),
                row["data"]["content_redacted"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            );
        }
    }
    assert_eq!(outputs.len(), 3005);
    for n in 0..3005 {
        let expected = json!({"arguments":null,"result":format!("Neutral small output {n} {}", "x".repeat(1024)),"diff":null,"file":null}).to_string();
        assert_eq!(outputs[&source_id(n)], expected);
    }
    assert_eq!(importer::import(&c, &s, &options).unwrap()["changed"], 0);
    t3ui_core::cold::verify(&s).unwrap();
}

#[test]
fn offline_backfill_retries_a_committed_tail_and_acknowledges_publication_after_restart() {
    for thread_limited in [true, false] {
        let (_tmp, c) = fixture();
        let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
        source.execute_batch("CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,updated_at TEXT,type TEXT,status TEXT,payload_json TEXT)").unwrap();
        let date = t3ui_core::storage::now();
        let payload = json!({"id":"tail-retry","threadId":"t","runId":"r","type":"command_execution","status":"completed","startedAt":date,"completedAt":date,"output":"Neutral recoverable tail"});
        source.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES('tail-retry','t','r',?,'command_execution','completed',?)",rusqlite::params![date,payload.to_string()]).unwrap();
        drop(source);
        let s = Store::open(&c).unwrap();
        s.put(
            "local",
            "tool",
            "unrelated-hot",
            "other",
            "other",
            "other",
            &date,
            &date,
            "partial",
            "v1",
            json!({"content_redacted":"Unrelated neutral content"}),
        )
        .unwrap();
        std::fs::write(&c.storage.archive_path, "Publication must fail").unwrap();
        let options = Options {
            archive_batches: true,
            thread_limit: thread_limited.then_some(100),
            ..Default::default()
        };
        let failed = importer::import(&c, &s, &options);
        if thread_limited {
            assert!(failed.is_err());
        } else {
            assert_eq!(failed.unwrap()["partial_sync"], true);
        }
        let pending: (String, String) = s
            .conn
            .query_row(
                "SELECT key,value FROM settings WHERE starts_with(key,'cold:pending:')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("committed rows need a durable pending spill");
        assert_eq!(
            s.conn
                .query_row(
                    "SELECT count(*) FROM records WHERE source_id='tail-retry'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let other_queue = format!(
            "cold:pending:{}:unrelated",
            t3ui_core::privacy::hash("other-machine")
        );
        s.set(&other_queue, "This belongs to another instance")
            .unwrap();
        if !thread_limited {
            let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
            source
                .execute("UPDATE projection_projects SET deleted_at=?", [&date])
                .unwrap();
        }
        drop(s);
        std::fs::remove_file(&c.storage.archive_path).unwrap();
        let s = Store::open(&c).unwrap();
        // The normal retry deadline has arrived. Do not bypass revision skipping.
        s.conn
        .execute(
            "UPDATE settings SET value='{\"retry_at\":0}' WHERE starts_with(key,'source_retry:')",
            [],
        )
        .unwrap();
        let options = Options {
            archive_batches: true,
            ..Default::default()
        };
        let resumed = importer::import(&c, &s, &options).unwrap();
        assert_eq!(resumed["partial_sync"], false);
        assert_eq!(
            resumed["changed"], 0,
            "unchanged rows must resume their pending spill"
        );
        assert_eq!(
            s.conn
                .query_row(
                    "SELECT count(*) FROM records WHERE source_id='tail-retry'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            s.conn
                .query_row(
                    "SELECT count(*) FROM records WHERE source_id='unrelated-hot'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(s.setting(&pending.0).is_none());
        assert_eq!(
            s.setting(&other_queue).as_deref(),
            Some("This belongs to another instance")
        );
        let segments: i64 = s
            .conn
            .query_row("SELECT count(*) FROM cold_segments", [], |r| r.get(0))
            .unwrap();
        // A crash after publication but before acknowledgement leaves the same queue.
        s.set(&pending.0, &pending.1).unwrap();
        assert_eq!(importer::import(&c, &s, &options).unwrap()["changed"], 0);
        assert!(s.setting(&pending.0).is_none());
        assert_eq!(
            s.conn
                .query_row("SELECT count(*) FROM cold_segments", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            segments
        );
        t3ui_core::cold::verify(&s).unwrap();
    }
}

#[test]
fn structured_payload_metadata_stays_distinct_from_projection_revision_identity() {
    let (_tmp, c) = fixture();
    let source = rusqlite::Connection::open(&c.source.sqlite_path).unwrap();
    source.execute_batch("CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,updated_at TEXT,type TEXT,status TEXT,payload_json TEXT)").unwrap();
    let started = t3ui_core::storage::clock() - chrono::Duration::hours(2);
    let payload_updated = (started + chrono::Duration::hours(1)).to_rfc3339();
    let projection_updated = (started + chrono::Duration::minutes(30)).to_rfc3339();
    let payload = json!({"id":"payload-item","threadId":"t","runId":"r","type":"command_execution","status":"completed","startedAt":started.to_rfc3339(),"completedAt":payload_updated,"updatedAt":payload_updated,"output":"Neutral distinct metadata"});
    source.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES('projection-item','t','r',?,'command_execution','completed',?)",rusqlite::params![projection_updated,payload.to_string()]).unwrap();
    drop(source);
    let s = Store::open(&c).unwrap();
    assert_eq!(
        importer::import(
            &c,
            &s,
            &Options {
                archive_batches: true,
                ..Default::default()
            }
        )
        .unwrap()["partial_sync"],
        false
    );
    let row = analytics::query(
        &s,
        "tool-calls",
        &Filter {
            include_content: Some(true),
            ..Default::default()
        },
    )
    .unwrap()["data"][0]
        .clone();
    assert_eq!(row["source_id"], "payload-item");
    assert_eq!(row["source_updated_at"], payload_updated);
    assert_eq!(
        t3ui_core::storage::parse_time(row["occurred_at"].as_str().unwrap()),
        Some(started)
    );
    assert!(
        row["data"]["content_redacted"]
            .as_str()
            .unwrap()
            .contains("Neutral distinct metadata")
    );
    let revisions=s.rows("SELECT to_json(struct_pack(source_id:=source_id)) FROM source_revisions WHERE kind='tool'",&[]).unwrap();
    assert_eq!(revisions, vec![json!({"source_id":"projection-item"})]);
    assert_eq!(
        importer::import(&c, &s, &Options::default()).unwrap()["changed"],
        0
    );
}

#[test]
fn persisted_search_text_matches_native_json_extraction_for_all_value_shapes() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let values = vec![
        json!(null),
        json!(""),
        json!("Plain TEXT λ İ"),
        json!("prefix\u{0000}SUFFIX"),
        json!(42),
        json!(-0.0),
        json!(1e20),
        json!([1e20]),
        json!({"large": 1e20, "small": 1e-20}),
        json!(true),
        json!([null, "", 1.25, "λ"]),
        json!({"z":"Line\nQuote\"","a":true}),
    ];
    for (n, value) in values.into_iter().enumerate() {
        s.put(
            "local",
            "instance",
            &format!("search-shape-{n}"),
            "p",
            "t",
            "r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "v1",
            json!({"content_redacted":value}),
        )
        .unwrap();
    }
    s.put(
        "local",
        "instance",
        "search-missing",
        "p",
        "t",
        "r",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "partial",
        "v1",
        json!({}),
    )
    .unwrap();
    let mismatches:i64=s.conn.query_row("SELECT count(*) FROM records WHERE search_text IS DISTINCT FROM lower(json_extract_string(data,'$.content_redacted'))",[],|r|r.get(0)).unwrap();
    assert_eq!(
        mismatches, 0,
        "the write cache must preserve DuckDB JSON extraction and lowercase semantics"
    );
    let before = s
        .rows(
            "SELECT to_json(struct_pack(id:=id,search_text:=search_text)) FROM records ORDER BY id",
            &[],
        )
        .unwrap();
    s.conn
        .execute("UPDATE records SET search_version=0", [])
        .unwrap();
    t3ui_core::storage::hydrate_search(&s.conn).unwrap();
    let after = s
        .rows(
            "SELECT to_json(struct_pack(id:=id,search_text:=search_text)) FROM records ORDER BY id",
            &[],
        )
        .unwrap();
    assert_eq!(
        before, after,
        "search must stay stable after cache hydration"
    );
}

#[test]
fn canonical_payload_hash_preserves_legacy_utf8_ciphertext_and_scalar_goldens() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    let cases = [
        (
            r#"{"content_redacted":"quoted \" line\n λ 🟦","content_ciphertext":"neutral-cipher","repository_path_encrypted":null,"extra":[null,"",true,1.25]}"#,
            "2d6045980693eb29d283f6d996ff7d5764a5b8f3472ca05b4139c0ab06086121",
        ),
        (
            r#"{"content_redacted":"neutral","content_ciphertext":"","repository_path_encrypted":"neutral-path","_source_attribution":"replaced"}"#,
            "0f175ca5fb67558d0a38eb9695345915078be67e8bad4e29a55d7e27fa1df28d",
        ),
        (
            r#"["λ",null,"",9223372036854775807]"#,
            "1e8f1f883839c1ac85dbbe2a1decdbdca486030d43dd4c355454a8a2325873fd",
        ),
    ];
    for (n, (raw, expected)) in cases.into_iter().enumerate() {
        let source = format!("canonical-compat-{n}");
        s.put(
            "local",
            "instance",
            &source,
            "neutral-p",
            "neutral-t",
            "neutral-r",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "partial",
            "v1",
            serde_json::from_str(raw).unwrap(),
        )
        .unwrap();
        let actual: String = s
            .conn
            .query_row(
                "SELECT payload_hash FROM records WHERE source_id=?",
                [source],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(actual, expected);
    }
}
