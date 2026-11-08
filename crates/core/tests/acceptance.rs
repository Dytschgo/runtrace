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
    (tmp, c)
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
    let page = |limit: u32, include_content: Option<bool>| Filter { limit: Some(limit), include_content, ..Default::default() }.validate();
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
    assert_eq!(sum("completed") + sum("cancelled") + sum("failed") + sum("running") + sum("unknown"), 2);
    assert_eq!(sum("failed"), 1);
    let of_kind = |kind: &str| {
        analytics::query(&s, "timeline", &Filter { project: Some("p".into()), kind: Some(kind.into()), ..Default::default() }).unwrap()["data"]
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(of_kind("tool"), 2);
    assert_eq!(of_kind("prompt"), 0);
    assert!(analytics::query(&s, "timeline", &Filter { kind: Some("tool' OR 1=1".into()), ..Default::default() }).is_err());
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
        let expected: Vec<String> = s.conn.prepare("SELECT id FROM records WHERE json_extract_string(data,'$.content_redacted') ILIKE ? ORDER BY try_cast(occurred_at AS TIMESTAMPTZ) DESC NULLS LAST,id LIMIT 500").unwrap().query_map([pattern], |r|r.get(0)).unwrap().collect::<duckdb::Result<_>>().unwrap();
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
    s.conn.execute_batch("SET memory_limit='2GB'; INSERT INTO records(id,kind,instance_id,source_id,project_id,thread_id,run_id,occurred_at,source_updated_at,capture_quality,capture_source,source_version,captured_at,payload_hash,data) SELECT md5(i::VARCHAR),'tool','local',i::VARCHAR,'p','t','r','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','partial','synthetic','v','2026-01-01T00:00:00Z',md5(i::VARCHAR),json_object('content_redacted',repeat(md5(i::VARCHAR),256),'content_ciphertext','excluded') FROM range(3000) t(i); CHECKPOINT; SET memory_limit='128MB'").unwrap();
    let f = Filter {
        limit: Some(500),
        offset: Some(1500),
        ..Default::default()
    };
    let failed = analytics::query(&s, "timeline", &f).unwrap_err();
    assert_eq!(importer::error_category(&failed), "database_memory_limit");
    assert!(analytics::query(&s, "overview", &Filter::default()).is_ok());
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
        let expected:Vec<String>=s.conn.prepare("SELECT id FROM records WHERE json_extract_string(data,'$.content_redacted') ILIKE ? ORDER BY try_cast(occurred_at AS TIMESTAMPTZ) DESC NULLS LAST,id").unwrap().query_map([&pattern],|r|r.get(0)).unwrap().collect::<duckdb::Result<_>>().unwrap();
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
    s.put("local","model_turn","named","p","t","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"model":"gpt-6.1-sol","usage_status":"complete","total_tokens":10})).unwrap();
    s.put("local","model_turn","driver","p","t","r","2026-01-01T00:01:00Z","2026-01-01T00:01:00Z","partial","synthetic",json!({"model":null,"provider":"codex","usage_status":"complete","total_tokens":20})).unwrap();
    s.put("local","model_turn","thread-id","p","t","r","2026-01-01T00:02:00Z","2026-01-01T00:02:00Z","partial","synthetic",json!({"model":null,"provider":null,"provider_thread_id":"provider-thread:provider:codex:native-thread:x","usage_status":"complete","total_tokens":30})).unwrap();
    s.put("local","prompt","native","p","thread:provider:codex:native-thread:y","r","2026-01-01T00:03:00Z","2026-01-01T00:03:00Z","partial","synthetic",json!({})).unwrap();
    s.put("local","model_turn","claude","p","t","r","2026-01-01T00:04:00Z","2026-01-01T00:04:00Z","partial","synthetic",json!({"model":"claude-opus-5-5","usage_status":"complete","total_tokens":40})).unwrap();
    s.put("local","model_turn","unknown","p","t","r","2026-01-01T00:05:00Z","2026-01-01T00:05:00Z","partial","synthetic",json!({"usage_status":"complete","total_tokens":50})).unwrap();
    s.capture_source.set("session_logs");
    s.put("local","model_turn","log:x:1:m","p","","","2026-01-01T01:00:00Z","2026-01-01T02:00:00Z","partial","session_logs",json!({"model":"gpt-6.1-sol","usage_status":"complete","usage_source":"session_log","total_tokens":90})).unwrap();
    s.capture_source.set("t3_sqlite_v2");
    let count = |provider: Option<&str>, kind: &str| {
        let f = Filter { provider: provider.map(str::to_owned), ..Default::default() };
        analytics::query(&s, "overview", &f).unwrap()["data"].as_array().unwrap().iter().find(|r| r["kind"] == kind).map(|r| r["count"].as_i64().unwrap()).unwrap_or(0)
    };
    assert_eq!(count(Some("openai"), "model_turn"), 3, "named, by driver and by provider thread, never the session-log hour");
    assert_eq!(count(Some("openai"), "prompt"), 1);
    assert_eq!(count(Some("anthropic"), "model_turn"), 1);
    assert_eq!(count(None, "model_turn"), 5, "session-log hours are not provider turns");
    let models = analytics::query(&s, "models", &Filter { provider: Some("openai".into()), ..Default::default() }).unwrap();
    let total: i64 = models["data"].as_array().unwrap().iter().map(|r| r["total_tokens"].as_i64().unwrap_or(0)).sum();
    assert_eq!(total, 150, "tokens include the session-log hour");
    assert!(Filter { provider: Some("Open AI".into()), ..Default::default() }.validate().is_err());
}

// A lean turn carries the same values the dashboard reads from the full document, in far fewer bytes.
#[test]
fn lean_turns_match_the_full_document() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put("local","model_turn","full","p","thread:provider:codex:native-thread:x","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"model":null,"requested_model":"gpt-6.1-sol","provider":null,"provider_thread_id":"provider-thread:provider:codex:native-thread:x","node_id":"n".repeat(120),"usage_status":"complete","usage_scope":"main_agent","total_tokens":30,"input_tokens":20,"cached_input_tokens":5,"cache_write_tokens":1,"output_tokens":10,"reasoning_tokens":2,"has_subagents":true,"started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:02Z"})).unwrap();
    s.put("local","model_turn","partial","p","t","r","2026-01-01T00:01:00Z","2026-01-01T00:01:00Z","partial","synthetic",json!({"model":"claude-opus-5-5","provider":"claudeAgent","usage_status":"partial","total_tokens":99,"input_tokens":7,"duration_ms":40})).unwrap();
    let read = |shape: Option<&str>| analytics::query(&s, "model-turns", &Filter { shape: shape.map(str::to_owned), ..Default::default() }).unwrap()["data"].as_array().unwrap().clone();
    let (full, lean) = (read(None), read(Some("lean")));
    assert_eq!(full.len(), 2);
    for (a, b) in full.iter().zip(&lean) {
        assert_eq!(a["id"], b["id"]);
        assert_eq!(a["thread_id"], b["thread_id"]);
        for k in ["total_tokens", "input_tokens", "output_tokens", "usage_status"] { assert_eq!(a["data"][k], b["data"][k], "{k}"); }
        assert!(b["data"].get("node_id").is_none());
        assert!(b.to_string().len() < a.to_string().len());
    }
    let first = &lean[1];
    assert_eq!(first["data"]["provider"], "codex");
    assert_eq!(first["data"]["model"], "gpt-6.1-sol");
    assert_eq!(first["data"]["duration_ms"], 2000);
    assert_eq!(first["data"]["cache_write_tokens"], 1);
    assert_eq!(first["data"]["has_subagents"], true);
    assert_eq!(lean[0]["data"]["total_tokens"], serde_json::Value::Null, "a partial turn has no complete total");
    assert_eq!(lean[0]["data"]["provider"], "claudeAgent");
    assert!(Filter { shape: Some("wide".into()), ..Default::default() }.validate().is_err());
}

// Rows written before the second set of analytic columns, or restored from an older snapshot, are filled in one pass.
#[test]
fn older_rows_get_the_new_analytic_columns() {
    let (_tmp, c) = fixture();
    let s = Store::open(&c).unwrap();
    s.put("local","model_turn","old","p","t","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"model":"m","provider":"codex","cache_write_tokens":7,"started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:03Z","has_subagents":false,"usage_status":"complete","total_tokens":5})).unwrap();
    s.put("local","tool","t1","p","t","r","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z","partial","synthetic",json!({"tool_category":"shell","exit_code":2})).unwrap();
    s.conn.execute_batch("UPDATE records SET cache_write_tokens=NULL,exit_code=NULL,agent_provider=NULL,has_subagents=NULL,elapsed_ms=NULL,facts_version=1").unwrap();
    t3ui_core::storage::hydrate_more_facts(&s.conn).unwrap();
    let row: (i64, String, i64, bool, i32) = s.conn.query_row("SELECT cache_write_tokens,agent_provider,elapsed_ms,has_subagents,facts_version FROM records WHERE kind='model_turn'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap();
    assert_eq!(row, (7, "codex".into(), 3000, false, 2));
    let exit: i64 = s.conn.query_row("SELECT exit_code FROM records WHERE kind='tool'", [], |r| r.get(0)).unwrap();
    assert_eq!(exit, 2);
    let summary = analytics::query(&s, "usage/tool-summary", &Filter::default()).unwrap();
    assert_eq!(summary["data"][0]["nonZero"], 1);
}
